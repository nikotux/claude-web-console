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
//
// Commit SIN push (POST /api/backup/commit, admin) — commit local descriptivo
// de los cambios trackeados (+ untracked seleccionados con la MISMA guarda de
// 3 capas del push). No toca el remote, no actualiza el changelog (eso sigue
// siendo del push), no reinicia nada; reversible con git reset --soft. El
// mensaje puede generarse con IA (POST /commit-message → job + runner
// desacoplado bin/cwc-commitmsg-runner.js, haiku 1 turno CERO herramientas,
// regla 6; GET /commit-message/:id solo lee disco) — siempre editable, con
// fallback manual si la corrida falla.
//
// Pull desde GitHub (POST /api/backup/pull, admin) — restauración del CÓDIGO
// desde el remote `personal` (la inversa del push): mismas guardas duras,
// fetch + stash→merge --ff-only→pop (patrón de tolkien/update: NUNCA
// descarta trabajo local; si las historias divergieron falla con 409 y el
// stash se repone — nada de --force ni reset --hard). Si package(-lock).json
// cambió, corre `npm install` ANTES de reiniciar (el server nuevo puede
// necesitar deps nuevas). Con HEAD actualizado y árbol sano → scheduleRestart
// (igual que restaurar un tar.gz: el código viejo sigue en RAM). Si el pop
// del stash conflictuó o npm falló, NO se reinicia (un server que arranca
// sobre archivos con marcas de conflicto entra en crash-loop) — se avisa.
import express from 'express';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdmin } from '../../core/auth.js';
import {
  commitMsgJobId, readCommitMsgJob, writeCommitMsgJob, spawnCommitMsgRunner,
  isFreshRunning, jobResult,
} from './commitmsg-shared.js';

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

// Distingue terminación ANORMAL (matado por timeout/señal, binario ausente)
// de un exit code real del comando: devuelve un Error para RECHAZAR la
// promesa en esos casos, en vez de disfrazarlos de {code:1} (indistinguible
// de un fallo normal, p.ej. exit 1 real de git). Invariante 10.
function abnormalExec(err, cmd, timeoutMs) {
  if (!err) return null;
  if (err.killed || err.signal) {
    return new Error(`"${cmd}" interrumpido (${err.signal || 'señal'}) — probable timeout de ${Math.round(timeoutMs / 1000)}s`);
  }
  if (typeof err.code !== 'number') {
    return new Error(`"${cmd}" no se pudo ejecutar (${err.code || err.message})`);
  }
  return null;
}

function git(args, opts = {}) {
  const timeout = opts.timeout || 30000;
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', PROJECT_DIR, ...args], { timeout }, (err, out, stderr) => {
      const bad = abnormalExec(err, `git ${args[0] || ''}`, timeout);
      if (bad) return reject(bad);
      resolve({ code: err ? err.code : 0, out: (out || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}
const lines = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean);

async function personalUrl() {
  const r = await git(['remote', 'get-url', REMOTE]);
  return r.code === 0 ? r.out : null;
}

// Guardas de repo + secretos (sin remote): las necesita también el commit
// local, que no toca GitHub. `verb` solo ajusta el texto del error.
async function repoSecretGuards(verb = 'Push') {
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.out !== 'true') return { ok: false, error: 'El proyecto no es un repositorio git.' };

  // Ningún secreto versionado.
  const tracked = lines((await git(['ls-files'])).out);
  const leaked = tracked.filter((f) => SECRET_PATHS.includes(f) || SECRET_DIRS.some((d) => f === d || f.startsWith(`${d}/`)));
  if (leaked.length) return { ok: false, error: `Hay secretos versionados: ${leaked.join(', ')}. ${verb} BLOQUEADO.` };

  // Cada secreto que existe en disco DEBE seguir ignorado (atrapa regresión de .gitignore).
  for (const p of [...SECRET_PATHS, ...SECRET_DIRS]) {
    if (!fs.existsSync(path.join(PROJECT_DIR, p))) continue;
    const ig = await git(['check-ignore', '-q', p]);
    if (ig.code !== 0) return { ok: false, error: `"${p}" existe pero NO está en .gitignore. ${verb} BLOQUEADO.` };
  }
  return { ok: true };
}

// Valida TODAS las guardas de seguridad antes de cualquier push (repo +
// secretos + remote personal válido).
async function securityGuards() {
  const url = await personalUrl();
  if (!url) return { ok: false, needsSetup: true, error: `No existe el remote "${REMOTE}". Configuralo vos (ver comandos).` };
  if (FORBIDDEN_URL_RE.test(url)) return { ok: false, error: `El remote "${REMOTE}" apunta a Mordor-Staffing (${url}). Push BLOQUEADO.` };

  const base = await repoSecretGuards('Push');
  if (!base.ok) return base;
  return { ok: true, url };
}

// Selección de untracked (compartida por push y commit): 3 capas — (1) solo lo
// que git YA lista como untracked no-ignorado; (2) re-validación anti-secretos;
// (3) nada viaja sin selección humana explícita (la lista viene del diálogo).
function selectUntracked(requested, untrackedNow) {
  const req = Array.isArray(requested) ? requested.map(String).slice(0, 200) : [];
  const includable = req.filter((f) => untrackedNow.includes(f));
  const blockedSecrets = includable.filter(
    (f) => SECRET_PATHS.includes(f) || SECRET_DIRS.some((d) => f === d || f.startsWith(`${d}/`)),
  );
  return { includable, blockedSecrets };
}

// Sanea el mensaje de commit: sin caracteres de control (salvo saltos de
// línea), tope de tamaño; vacío => null.
function sanitizeCommitMessage(raw) {
  const m = String(raw ?? '')
    .replace(/\r/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 2000);
  return m || null;
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
  const timeout = opts.timeout || 20000;
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout }, (err, out, stderr) => {
      // ENOENT (falta gh) / timeout: RECHAZA — quien lo llame decide si es
      // best-effort (updateGithubDescription lo atrapa) o error real.
      const bad = abnormalExec(err, `gh ${args[0] || ''}`, timeout);
      if (bad) return reject(bad);
      resolve({ code: err ? err.code : 0, out: (out || '').trim(), stderr: (stderr || '').trim() });
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
  let r;
  try {
    r = await ghCmd(['repo', 'edit', slug, '--description', GITHUB_DESCRIPTION]);
  } catch (e) {
    // ghCmd rechaza si falta gh o hubo timeout: acá sigue siendo best-effort.
    return { ok: false, skipped: String(e?.message || e) };
  }
  if (r.code !== 0) return { ok: false, skipped: r.stderr || r.out || '"gh" no disponible o sin auth' };
  return { ok: true };
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
  next();
}

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  // mkdirSync solo aplica `mode` al CREAR: si el directorio ya existía con
  // permisos laxos (instalación anterior), hay que forzarlos igual — los
  // backups contienen secretos (.env, certs).
  try { fs.chmodSync(BACKUP_DIR, 0o700); } catch { /* best-effort */ }
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
  const timeout = 120000;
  return new Promise((resolve, reject) => {
    execFile('tar', args, { timeout }, (err, _out, stderr) => {
      const bad = abnormalExec(err, `tar ${args[0] || ''}`, timeout);
      if (bad) return reject(bad);
      resolve({ code: err ? err.code : 0, stderr: (stderr || '').trim() });
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
      } catch (e) {
        res.status(500).json({ error: `Falló el backup: ${e?.message || e}` });
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
      } catch (e) {
        res.status(500).json({ error: `Falló la restauración: ${e?.message || e}` });
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
      try {
        const inside = await git(['rev-parse', '--is-inside-work-tree']);
        if (inside.code !== 0 || inside.out !== 'true') return res.json({ isRepo: false });
        const url = await personalUrl();
        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'HEAD';
        const excluded = [...SECRET_PATHS, ...SECRET_DIRS].filter((p) => fs.existsSync(path.join(PROJECT_DIR, p)));
        const untracked = lines((await git(['ls-files', '--others', '--exclude-standard'])).out);
        // Contra HEAD (no solo el working tree): incluye también lo ya
        // stageado — es lo que un commit va a llevarse. Formato name-status
        // ("M\tpath") para que el diálogo de Commit muestre QUÉ cambia.
        const dirty = lines((await git(['diff', 'HEAD', '--name-status'])).out);
        res.json({
          isRepo: true,
          branch,
          remote: url ? { name: REMOTE, url, forbidden: FORBIDDEN_URL_RE.test(url) } : null,
          excluded,
          untracked,
          dirty,
          dirtyCount: dirty.length,
          lastCommit: (await git(['log', '-1', '--format=%h %s'])).out || null,
          setupCommands: [
            'cd ~/claude-web-console',
            'git remote add personal git@github.com:<TU-USUARIO>/<TU-REPO>.git',
          ],
        });
      } catch (e) {
        res.status(500).json({ error: 'No se pudo leer el estado de git: ' + (e?.message || e) });
      }
    });

    r.post('/push', async (req, res) => {
      if (busy) return res.status(409).json({ error: 'Ya hay una operación en curso.' });
      busy = true;
      try {
        const g = await securityGuards();
        if (!g.ok) return res.status(g.needsSetup ? 428 : 403).json({ error: g.error, needsSetup: !!g.needsSetup });

        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main';
        // Los untracked NO se suben (evita filtrar un secreto nuevo sin ignorar).
        const untrackedNow = lines((await git(['ls-files', '--others', '--exclude-standard'])).out);

        // Untracked SELECCIONADOS explícitamente desde el diálogo de push
        // (checkbox por archivo). Guarda anti-secretos de 3 capas en
        // selectUntracked() — compartida con el commit sin push.
        const { includable, blockedSecrets } = selectUntracked(req.body?.includeUntracked, untrackedNow);
        if (blockedSecrets.length) {
          return res.status(403).json({ error: `Secreto(s) en la selección: ${blockedSecrets.join(', ')}. Push BLOQUEADO.` });
        }
        for (const f of includable) {
          const a = await git(['add', '--', f]);
          if (a.code !== 0) return res.status(500).json({ error: `No se pudo agregar "${f}": ${a.stderr || a.out}` });
        }
        const untrackedSkipped = untrackedNow.filter((f) => !includable.includes(f));

        // "última versión" = lo que el remote YA tiene, ANTES de este push
        // (si el branch remoto todavía no existe, es el primer push).
        const beforeRefRes = await git(['rev-parse', `${REMOTE}/${branch}`]);
        const beforeRef = beforeRefRes.code === 0 ? beforeRefRes.out : null;

        // Commit: los trackeados modificados/borrados (add -u) + los untracked
        // recién seleccionados (ya stageados arriba).
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
              // Excluir el README raíz (lo toca el propio changelog) mirando los
              // campos de path exactos: cubre también renombrados DESDE/HACIA él
              // y no filtra de más (p.ej. docs/README.md sí se lista).
              .filter((l) => !l.split('\t').slice(1).includes('README.md'))
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
          includedUntracked: includable,
          untrackedSkipped,
          changelogUpdated,
          description,
          output: (p.stderr || p.out || '').slice(0, 600),
        });
      } catch (e) {
        // Rechazo de git()/ghCmd() (timeout/señal/binario ausente): el motivo
        // real llega al usuario en vez de un genérico indistinguible.
        res.status(500).json({ error: `Falló el push: ${e?.message || e}` });
      } finally {
        busy = false;
      }
    });

    // ===== Commit SIN push (ver bloque de decisiones en la cabecera) =====
    // Generación IA del mensaje: el POST captura el estado del árbol (diff +
    // archivos) EN NODE, escribe el job y spawnea el runner desacoplado
    // (regla de oro — sobrevive a un reinicio); el GET solo lee disco.
    r.post('/commit-message', async (req, res) => {
      try {
        const g = await repoSecretGuards('Commit');
        if (!g.ok) return res.status(403).json({ error: g.error });

        const files = lines((await git(['diff', 'HEAD', '--name-status'])).out);
        const untrackedNow = lines((await git(['ls-files', '--others', '--exclude-standard'])).out);
        const { includable } = selectUntracked(req.body?.includeUntracked, untrackedNow);
        if (!files.length && !includable.length) {
          return res.status(409).json({ error: 'No hay cambios para describir.' });
        }

        // Diff para el prompt: tope de 30k chars (haiku no necesita más). Un
        // diff gigante puede reventar el maxBuffer default de execFile — en
        // ese caso se cae al resumen --stat (la lista de archivos ya viaja).
        let diff = '';
        try { diff = (await git(['diff', 'HEAD'])).out.slice(0, 30000); }
        catch { try { diff = (await git(['diff', 'HEAD', '--stat'])).out.slice(0, 30000); } catch { /* sin diff */ } }

        // Identidad determinística por estado del árbol: doble click o retry
        // apuntan al MISMO job (sin runner duplicado); si ya terminó, se reusa.
        const id = commitMsgJobId(`${files.join('|')}::${includable.join('|')}::${diff}`);
        const existing = readCommitMsgJob(id);
        if (existing && (isFreshRunning(existing) || existing.status === 'done')) {
          return res.json({ ok: true, id, reused: true });
        }
        writeCommitMsgJob(id, {
          status: 'running', startedAt: Date.now(),
          files, untracked: includable, diff,
        });
        spawnCommitMsgRunner(id);
        res.json({ ok: true, id });
      } catch (e) {
        res.status(500).json({ error: `No se pudo lanzar la generación: ${e?.message || e}` });
      }
    });

    r.get('/commit-message/:id', (req, res) => {
      const id = String(req.params.id || '');
      if (!/^[a-f0-9]{24}$/.test(id)) return res.status(400).json({ error: 'Id inválido.' });
      const job = readCommitMsgJob(id);
      if (!job) return res.status(404).json({ error: 'Ese job no existe (¿se limpió?).' });
      res.json(jobResult(job));
    });

    r.post('/commit', async (req, res) => {
      if (busy) return res.status(409).json({ error: 'Ya hay una operación en curso.' });
      busy = true;
      try {
        const g = await repoSecretGuards('Commit');
        if (!g.ok) return res.status(403).json({ error: g.error });

        const message = sanitizeCommitMessage(req.body?.message);
        if (!message) return res.status(400).json({ error: 'Falta el mensaje del commit.' });

        // Untracked seleccionados: mismas 3 capas anti-secretos que el push.
        const untrackedNow = lines((await git(['ls-files', '--others', '--exclude-standard'])).out);
        const { includable, blockedSecrets } = selectUntracked(req.body?.includeUntracked, untrackedNow);
        if (blockedSecrets.length) {
          return res.status(403).json({ error: `Secreto(s) en la selección: ${blockedSecrets.join(', ')}. Commit BLOQUEADO.` });
        }
        for (const f of includable) {
          const a = await git(['add', '--', f]);
          if (a.code !== 0) return res.status(500).json({ error: `No se pudo agregar "${f}": ${a.stderr || a.out}` });
        }

        // Trackeados modificados/borrados + untracked recién stageados.
        await git(['add', '-u']);
        const staged = lines((await git(['diff', '--cached', '--name-only'])).out);
        if (!staged.length) return res.status(409).json({ error: 'No hay cambios para commitear.' });

        const c = await git(['commit', '-m', message]);
        if (c.code !== 0) return res.status(500).json({ error: `No se pudo commitear: ${c.stderr || c.out}` });
        const committed = (await git(['rev-parse', '--short', 'HEAD'])).out;
        res.json({ ok: true, committed, staged, includedUntracked: includable });
      } catch (e) {
        res.status(500).json({ error: `Falló el commit: ${e?.message || e}` });
      } finally {
        busy = false;
      }
    });

    // Pull desde GitHub: restauración del código desde el remote personal.
    // Ver el bloque de decisiones en la cabecera del archivo.
    r.post('/pull', async (req, res) => {
      if (busy) return res.status(409).json({ error: 'Ya hay una operación en curso.' });
      busy = true;
      const log = [];
      try {
        const g = await securityGuards();
        if (!g.ok) return res.status(g.needsSetup ? 428 : 403).json({ error: g.error, needsSetup: !!g.needsSetup });

        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main';
        const f = await git(['fetch', REMOTE], { timeout: 120000 });
        if (f.code !== 0) return res.status(500).json({ error: `Falló el fetch: ${f.stderr || 'error de red o de git'}` });

        const local = (await git(['rev-parse', 'HEAD'])).out;
        const remoteRef = await git(['rev-parse', `${REMOTE}/${branch}`]);
        if (remoteRef.code !== 0) {
          return res.status(409).json({ error: `El remote no tiene la rama "${branch}" — nada desde donde restaurar.` });
        }
        // "Nada que traer" = el remote es ancestro de HEAD (mismo commit O el
        // local va adelante con commits sin pushear). Comparar solo HEAD ==
        // remote NO alcanza: con el local adelante, el merge --ff-only diría
        // "Already up to date" y reiniciaríamos el server para nada.
        const isAncestor = await git(['merge-base', '--is-ancestor', remoteRef.out, local]);
        if (isAncestor.code === 0) {
          const ahead = parseInt((await git(['rev-list', '--count', `${remoteRef.out}..${local}`])).out, 10) || 0;
          return res.json({ ok: true, upToDate: true, head: local.slice(0, 7), ahead });
        }

        // Cambios locales sin commitear: a salvo en el stash antes de mover HEAD.
        const dirty = (await git(['status', '--porcelain'])).out.length > 0;
        let stashed = false;
        if (dirty) {
          const s = await git(['stash', 'push', '-u', '-m', 'cwc: auto antes de pull desde GitHub']);
          log.push({ step: 'stash', code: s.code, out: (s.out || s.stderr).slice(0, 200) });
          stashed = s.code === 0 && !/No local changes/i.test(s.out + s.stderr);
        }

        // Solo fast-forward: si las historias divergieron NO se fuerza nada.
        const merge = await git(['merge', '--ff-only', `${REMOTE}/${branch}`], { timeout: 60000 });
        log.push({ step: 'merge', code: merge.code, out: (merge.out || merge.stderr).slice(0, 200) });

        let popConflict = false;
        if (stashed) {
          const pop = await git(['stash', 'pop']);
          log.push({ step: 'stash-pop', code: pop.code, out: (pop.out || pop.stderr).slice(0, 200) });
          popConflict = pop.code !== 0; // conflicto al reaplicar: queda en el stash
        }

        if (merge.code !== 0) {
          return res.status(409).json({
            error: 'El historial local divergió del de GitHub (hay commits locales que el remote no tiene). No se fuerza nada: resolvelo a mano (push primero, o rebase).',
            log,
          });
        }

        const to = (await git(['rev-parse', 'HEAD'])).out;
        const changed = lines((await git(['diff', '--name-only', `${local}..${to}`])).out);

        // Deps nuevas: npm install ANTES del restart (el server nuevo puede requerirlas).
        let npm = null;
        if (changed.includes('package.json') || changed.includes('package-lock.json')) {
          npm = await new Promise((resolve) => {
            execFile('npm', ['install'], { cwd: PROJECT_DIR, timeout: 300000 }, (err, _o, stderr) => {
              resolve({ ok: !err, error: err ? String(stderr || err.message).slice(0, 300) : null });
            });
          });
          log.push({ step: 'npm-install', code: npm.ok ? 0 : 1, out: npm.error || 'ok' });
        }

        // Reinicio SOLO con árbol sano: con conflicto del pop o npm roto, un
        // restart puede dejar el server en crash-loop — mejor avisar.
        const restarting = !popConflict && (!npm || npm.ok);
        res.json({
          ok: true, updated: true,
          from: local.slice(0, 7), to: to.slice(0, 7),
          files: changed.length, stashed, popConflict,
          npmRan: !!npm, npmOk: npm ? npm.ok : null,
          restarting, log,
        });
        if (restarting) scheduleRestart(); // el server viejo sigue en RAM hasta reiniciar
      } catch (e) {
        res.status(500).json({ error: `Falló el pull: ${e?.message || e}`, log });
      } finally {
        busy = false;
      }
    });

    router.use('/backup', r);
  },
};
