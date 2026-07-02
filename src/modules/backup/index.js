// modules/backup/index.js — backup y restauración completa de la consola.
//
// Backup = tar.gz de TODO el proyecto (código, .env, users.json, sessions.json,
// certs) excluyendo node_modules (reinstalable y pesado). Se guardan FUERA del
// proyecto (~/.cwc-backups, modo 700) para que una restauración no los pise.
//
// Restaurar sobrescribe el proyecto en caliente y luego REINICIA el server
// (el código viejo sigue en memoria hasta reiniciar). Bajo systemd basta con
// salir (Restart=on-failure); lanzado a mano, se auto-relanza con un helper
// desacoplado. OJO: restaurar también repone users.json/sessions.json viejos,
// así que puede pedir re-login.
//
// HTTP (solo administradores):
//   GET  /api/backup/list             -> { backups: [{id, date, size}] }
//   POST /api/backup/create           -> { ok, backup }
//   POST /api/backup/restore {id}     -> { ok, restarting: true }
//   POST /api/backup/delete  {id}     -> { ok }
//
// Push a GitHub — ADEMÁS del commit+push, cada push exitoso:
//   1. Actualiza la sección "## Changelog" de README.md (marcadores
//      <!-- cwc:changelog:start/end -->) con una entrada EN INGLÉS de lo
//      cambiado desde la última versión pusheada (commits locales aún no
//      subidos + los archivos recién stageados). Si no hay nada nuevo que
//      contar, el README NO se toca (sin entradas vacías).
//   2. Intenta (best-effort, vía `gh repo edit`) dejar la descripción del
//      repo en GitHub sincronizada con GITHUB_DESCRIPTION (inglés, resume
//      toda la consola + sus módulos). Si falta `gh`/auth/red, NO rompe el
//      push (que ya ocurrió) — solo se informa en la respuesta.
import express from 'express';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdmin } from '../../core/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..', '..', '..');
const BACKUP_DIR = path.join(os.homedir(), '.cwc-backups');
const NAME_RE = /^cwc-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/;

// ===== Push del CÓDIGO a GitHub personal (backup off-site, SIN secretos) =====
// Guardas duras: solo el remote llamado exactamente `personal`, cuya URL NO
// puede contener 'Mordor-Staffing'; nunca se agregan archivos untracked (así un
// secreto nuevo jamás entra); se aborta si algún secreto quedó versionado.
const REMOTE = 'personal';
const FORBIDDEN_URL_RE = /mordor-staffing/i;
const SECRET_PATHS = ['.env', 'users.json', 'sessions.json', 'recents.json', 'titles.json'];
const SECRET_DIRS = ['certs'];

let busy = false; // evita crear/restaurar en paralelo

function git(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', PROJECT_DIR, ...args], { timeout: opts.timeout || 30000 }, (err, out, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: (out || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}
const lines = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean);

async function personalUrl() {
  const r = await git(['remote', 'get-url', REMOTE]);
  return r.code === 0 ? r.out : null;
}

// Valida TODAS las guardas de seguridad antes de cualquier push.
async function securityGuards() {
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.out !== 'true') return { ok: false, error: 'El proyecto no es un repositorio git.' };

  const url = await personalUrl();
  if (!url) return { ok: false, needsSetup: true, error: `No existe el remote "${REMOTE}". Configuralo vos (ver comandos).` };
  if (FORBIDDEN_URL_RE.test(url)) return { ok: false, error: `El remote "${REMOTE}" apunta a Mordor-Staffing (${url}). Push BLOQUEADO.` };

  // Ningún secreto versionado.
  const tracked = lines((await git(['ls-files'])).out);
  const leaked = tracked.filter((f) => SECRET_PATHS.includes(f) || SECRET_DIRS.some((d) => f === d || f.startsWith(`${d}/`)));
  if (leaked.length) return { ok: false, error: `Hay secretos versionados: ${leaked.join(', ')}. Push BLOQUEADO.` };

  // Cada secreto que existe en disco DEBE seguir ignorado (atrapa regresión de .gitignore).
  for (const p of [...SECRET_PATHS, ...SECRET_DIRS]) {
    if (!fs.existsSync(path.join(PROJECT_DIR, p))) continue;
    const ig = await git(['check-ignore', '-q', p]);
    if (ig.code !== 0) return { ok: false, error: `"${p}" existe pero NO está en .gitignore. Push BLOQUEADO.` };
  }
  return { ok: true, url };
}

// ===== Changelog en inglés (README.md) + descripción del repo en GitHub =====
const README_PATH = path.join(PROJECT_DIR, 'README.md');
const CHANGELOG_START = '<!-- cwc:changelog:start -->';
const CHANGELOG_END = '<!-- cwc:changelog:end -->';
const MAX_CHANGELOG_ENTRIES = 60; // no-silent-cap: si se recorta, se anota en el propio README

// Resume TODA la consola + sus módulos, en inglés (la reafirmamos en cada
// push por si alguien la borró/editó a mano desde GitHub).
const GITHUB_DESCRIPTION = 'Personal web console for driving Claude Code from any browser (incl. phone) over ZeroTier: tmux-backed terminals, native Agent SDK chat, ticket triage, automated bugfix-to-PR workflow, backups, and admin/health dashboards.';

function ghCmd(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: opts.timeout || 20000 }, (err, out, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: (out || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

function ownerRepoFromUrl(url) {
  const m = String(url || '').match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// "M\tpath", "A\tpath", "D\tpath", "R100\told\tnew" (salida de --name-status).
function describeFileStatus(line) {
  const [code, ...rest] = line.split('\t');
  const letter = (code || '')[0];
  const label = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied' }[letter] || 'Changed';
  if ((letter === 'R' || letter === 'C') && rest.length > 1) return `${label} \`${rest[0]}\` → \`${rest[1]}\``;
  return `${label} \`${rest[0] || ''}\``;
}

function changelogTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Construye UNA entrada de changelog ("### fecha — branch" + bullets). Si no
// hay nada que contar (nada nuevo desde la última versión pusheada),
// devuelve null y el README no se toca.
function buildChangelogEntry({ branch, priorSubjects, fileStatuses, initial }) {
  const bullets = [];
  if (initial) bullets.push('Initial published version.');
  bullets.push(...priorSubjects, ...fileStatuses);
  if (!bullets.length) return null;
  return [`### ${changelogTimestamp()} — ${branch}`, ...bullets.map((b) => `- ${b}`)].join('\n');
}

// Inserta `entryText` como la entrada MÁS NUEVA dentro de los marcadores
// cwc:changelog en README.md. No falla el push si el README no existe o no
// tiene los marcadores (proyecto sin ese archivo) — simplemente no actualiza.
function updateReadmeChangelog(entryText) {
  if (!entryText || !fs.existsSync(README_PATH)) return false;
  const src = fs.readFileSync(README_PATH, 'utf8');
  const si = src.indexOf(CHANGELOG_START);
  const ei = src.indexOf(CHANGELOG_END);
  if (si === -1 || ei === -1 || ei < si) return false;

  const before = src.slice(0, si + CHANGELOG_START.length);
  const after = src.slice(ei);
  const existing = src.slice(si + CHANGELOG_START.length, ei).trim();
  const entries = existing ? existing.split(/\n(?=### )/).map((e) => e.trim()).filter(Boolean) : [];
  entries.unshift(entryText.trim());

  let trimmedNote = '';
  let kept = entries;
  if (entries.length > MAX_CHANGELOG_ENTRIES) {
    kept = entries.slice(0, MAX_CHANGELOG_ENTRIES);
    trimmedNote = '\n\n_(older entries trimmed — see `git log` for the full history)_';
  }
  fs.writeFileSync(README_PATH, `${before}\n\n${kept.join('\n\n')}${trimmedNote}\n\n${after}`);
  return true;
}

// Best-effort: deja la descripción del repo en GitHub sincronizada. Nunca
// bloquea el push (que ya ocurrió cuando se llama esto).
async function updateGithubDescription(remoteUrl) {
  const slug = ownerRepoFromUrl(remoteUrl);
  if (!slug) return { ok: false, skipped: 'no se pudo derivar owner/repo del remote' };
  const r = await ghCmd(['repo', 'edit', slug, '--description', GITHUB_DESCRIPTION]);
  if (r.code !== 0) return { ok: false, skipped: r.stderr || r.out || '"gh" no disponible o sin auth' };
  return { ok: true };
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
  next();
}

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
}

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => NAME_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { id: f, date: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.date - a.date);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function tar(args) {
  return new Promise((resolve) => {
    execFile('tar', args, { timeout: 120000 }, (err, _out, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stderr: (stderr || '').trim() });
    });
  });
}

// Reinicio tras restaurar: bajo systemd salimos con error (Restart=on-failure
// nos relevanta); lanzado a mano, un bash desacoplado espera y relanza npm.
function scheduleRestart() {
  setTimeout(() => {
    if (process.env.INVOCATION_ID) {
      process.exit(1); // systemd nos reinicia
    }
    const cmd = `sleep 1.5 && cd '${PROJECT_DIR}' && setsid npm start >/dev/null 2>&1 < /dev/null &`;
    spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => process.exit(0), 300);
  }, 400);
}

export default {
  name: 'backup',

  registerHttp(router) {
    const r = express.Router();
    r.use(requireAdmin);

    r.get('/list', (req, res) => {
      try { res.json({ backups: listBackups() }); }
      catch { res.status(500).json({ error: 'No se pudo listar los backups.' }); }
    });

    r.post('/create', async (req, res) => {
      if (busy) return res.status(409).json({ error: 'Ya hay una operación en curso.' });
      busy = true;
      try {
        ensureDir();
        const id = `cwc-backup-${stamp()}.tar.gz`;
        const out = path.join(BACKUP_DIR, id);
        const t = await tar(['-czf', out, '--exclude=./node_modules', '-C', PROJECT_DIR, '.']);
        if (t.code !== 0) {
          try { fs.rmSync(out, { force: true }); } catch { /* noop */ }
          return res.status(500).json({ error: `Falló el backup: ${t.stderr || 'tar error'}` });
        }
        const st = fs.statSync(out);
        res.json({ ok: true, backup: { id, date: st.mtimeMs, size: st.size } });
      } catch {
        res.status(500).json({ error: 'Falló el backup.' });
      } finally {
        busy = false;
      }
    });

    r.post('/restore', async (req, res) => {
      const { id } = req.body || {};
      if (!NAME_RE.test(id || '')) return res.status(400).json({ error: 'Backup inválido.' });
      const file = path.join(BACKUP_DIR, id);
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'Ese backup no existe.' });
      if (busy) return res.status(409).json({ error: 'Ya hay una operación en curso.' });
      busy = true;
      try {
        const t = await tar(['-xzf', file, '-C', PROJECT_DIR]);
        if (t.code !== 0) return res.status(500).json({ error: `Falló la restauración: ${t.stderr || 'tar error'}` });
        res.json({ ok: true, restarting: true });
        scheduleRestart(); // el server se reinicia para cargar lo restaurado
      } catch {
        res.status(500).json({ error: 'Falló la restauración.' });
      } finally {
        busy = false;
      }
    });

    r.post('/delete', (req, res) => {
      const { id } = req.body || {};
      if (!NAME_RE.test(id || '')) return res.status(400).json({ error: 'Backup inválido.' });
      try {
        fs.rmSync(path.join(BACKUP_DIR, id), { force: true });
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: 'No se pudo eliminar.' });
      }
    });

    // ===== Push del código a GitHub personal =====
    // Estado para la UI: remote, qué queda fuera, pendientes, comandos de setup.
    r.get('/git-info', async (req, res) => {
      const inside = await git(['rev-parse', '--is-inside-work-tree']);
      if (inside.code !== 0 || inside.out !== 'true') return res.json({ isRepo: false });
      const url = await personalUrl();
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'HEAD';
      const excluded = [...SECRET_PATHS, ...SECRET_DIRS].filter((p) => fs.existsSync(path.join(PROJECT_DIR, p)));
      const untracked = lines((await git(['ls-files', '--others', '--exclude-standard'])).out);
      const dirty = lines((await git(['diff', '--name-only'])).out);
      res.json({
        isRepo: true,
        branch,
        remote: url ? { name: REMOTE, url, forbidden: FORBIDDEN_URL_RE.test(url) } : null,
        excluded,
        untracked,
        dirtyCount: dirty.length,
        lastCommit: (await git(['log', '-1', '--format=%h %s'])).out || null,
        setupCommands: [
          'cd ~/claude-web-console',
          'git remote add personal git@github.com:<TU-USUARIO>/<TU-REPO>.git',
        ],
      });
    });

    r.post('/push', async (req, res) => {
      if (busy) return res.status(409).json({ error: 'Ya hay una operación en curso.' });
      busy = true;
      try {
        const g = await securityGuards();
        if (!g.ok) return res.status(g.needsSetup ? 428 : 403).json({ error: g.error, needsSetup: !!g.needsSetup });

        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main';
        // Los untracked NO se suben (evita filtrar un secreto nuevo sin ignorar).
        const untrackedSkipped = lines((await git(['ls-files', '--others', '--exclude-standard'])).out);

        // "última versión" = lo que el remote YA tiene, ANTES de este push
        // (si el branch remoto todavía no existe, es el primer push).
        const beforeRefRes = await git(['rev-parse', `${REMOTE}/${branch}`]);
        const beforeRef = beforeRefRes.code === 0 ? beforeRefRes.out : null;

        // Commit seguro: SOLO archivos ya trackeados (add -u), nunca untracked.
        await git(['add', '-u']);
        let staged = lines((await git(['diff', '--cached', '--name-only'])).out);

        // Changelog EN INGLÉS en README.md: commits locales hechos pero aún
        // no pusheados + los archivos recién stageados en este push. Si no
        // hay nada nuevo que contar, el README no se toca (sin entradas vacías).
        const priorSubjects = beforeRef
          ? lines((await git(['log', '--reverse', '--format=%s', `${beforeRef}..HEAD`])).out)
          : [];
        const fileStatuses = staged.length
          ? lines((await git(['diff', '--cached', '--name-status'])).out)
              .filter((l) => !l.endsWith('README.md'))
              .map(describeFileStatus)
          : [];
        const entry = buildChangelogEntry({ branch, priorSubjects, fileStatuses, initial: !beforeRef });
        const changelogUpdated = entry ? updateReadmeChangelog(entry) : false;
        if (changelogUpdated) {
          await git(['add', 'README.md']);
          staged = lines((await git(['diff', '--cached', '--name-only'])).out);
        }

        let committed = null;
        if (staged.length) {
          const c = await git(['commit', '-m', `cwc backup ${stamp()}`]);
          if (c.code !== 0) return res.status(500).json({ error: `No se pudo commitear: ${c.stderr || c.out}` });
          committed = (await git(['rev-parse', '--short', 'HEAD'])).out;
        }

        // Push EXCLUSIVAMENTE al remote personal, rama actual. Nunca --all/--force.
        const p = await git(['push', REMOTE, `HEAD:${branch}`], { timeout: 120000 });
        if (p.code !== 0) return res.status(500).json({ error: `Falló el push: ${p.stderr || p.out || 'error de git'}` });

        // Descripción del repo en GitHub: best-effort, NO rompe el push si falla.
        const description = await updateGithubDescription(g.url);

        res.json({
          ok: true, branch, remoteUrl: g.url, committed, staged,
          untrackedSkipped,
          changelogUpdated,
          description,
          output: (p.stderr || p.out || '').slice(0, 600),
        });
      } catch {
        res.status(500).json({ error: 'Falló el push.' });
      } finally {
        busy = false;
      }
    });

    router.use('/backup', r);
  },
};
