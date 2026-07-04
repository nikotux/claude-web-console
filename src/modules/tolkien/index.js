// modules/tolkien/index.js — panel del proyecto principal (git).
//
// Muestra la "versión" (SHA corto + estado vs origin) y permite actualizar
// desde GitHub. El repo puede tener cambios sin commitear, así que la
// actualización usa STASH -> PULL --ff-only -> STASH POP: nunca descarta tu
// trabajo (si algo falla, tus cambios quedan a salvo en el stash).
//
// HTTP:
//   GET  /api/tolkien/status  -> estado local (sin red)
//   POST /api/tolkien/fetch   -> git fetch (red) + estado
//   POST /api/tolkien/update  -> stash/pull/pop + estado
//
// El contexto (CLAUDE.md) y las memorias editables viven en el módulo
// GENÉRICO `projects` (src/modules/projects/), no acá: sirve tanto a este
// proyecto trackeado como a la propia consola. Ver projects/index.js.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { config } from '../../core/config.js';

const CWD = config.projectDir;
const REL = path.relative(config.home, CWD); // ruta relativa al home (para el árbol)
const AUTO_STASH_MSG = 'cwc: auto antes de actualizar';
const DATA_DIR = path.join(config.home, '.cwc-data');
const LASTFETCH_FILE = path.join(DATA_DIR, 'tolkien-lastfetch.json');

function git(args, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', CWD, ...args], { timeout, env: process.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Un `err` con exit code NUMÉRICO es git devolviendo un error normal
        // (ej. pull rechazado, push conflict): eso se resuelve como {code}.
        // Timeout (kill), señales, o fallos de spawn (ENOENT/EACCES) son
        // fallos de SISTEMA, no del comando git — ahí rechazamos en vez de
        // ocultarlos detrás de un {code} inventado.
        if (err && (err.killed || err.signal || typeof err.code !== 'number')) {
          return reject(err);
        }
        resolve({ code: err ? err.code : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      });
  });
}

// Timestamp del último fetch/pull exitoso (freshness del "N detrás"). Se
// persiste en DATA_DIR (CLAUDE.md regla 2: estado detectable tras reinicio
// sin depender solo de variables en memoria) y se cachea acá para no pegarle
// al disco en cada GET /status.
function loadLastFetchAt() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LASTFETCH_FILE, 'utf8'));
    return typeof parsed.lastFetchAt === 'number' ? parsed.lastFetchAt : null;
  } catch {
    return null; // no existe todavía (primer arranque) o está corrupto
  }
}

async function saveLastFetchAt(ts) {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(LASTFETCH_FILE, JSON.stringify({ lastFetchAt: ts }), 'utf8');
  } catch (err) {
    console.error('[tolkien] No se pudo persistir lastFetchAt:', err.message);
  }
}

let lastFetchAt = loadLastFetchAt();

async function status() {
  const branchRes = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRes.code !== 0) throw new Error(`git rev-parse HEAD falló: ${branchRes.stderr || 'código ' + branchRes.code}`);
  const branch = branchRes.stdout || 'HEAD';

  const headRes = await git(['rev-parse', '--short', 'HEAD']);
  if (headRes.code !== 0) throw new Error(`git rev-parse --short HEAD falló: ${headRes.stderr || 'código ' + headRes.code}`);
  const head = headRes.stdout;

  // Último commit: fecha ISO + autor + asunto (para el "pulso" del repo).
  const lastRes = await git(['log', '-1', '--format=%cI%x09%an%x09%s']);
  if (lastRes.code !== 0) throw new Error(`git log falló: ${lastRes.stderr || 'código ' + lastRes.code}`);
  const [date, author, subject] = lastRes.stdout.split('\t');

  const porcelainRes = await git(['status', '--porcelain']);
  if (porcelainRes.code !== 0) throw new Error(`git status falló: ${porcelainRes.stderr || 'código ' + porcelainRes.code}`);
  const porcelain = porcelainRes.stdout;
  const dirtyCount = porcelain ? porcelain.split('\n').length : 0;

  // ahead/behind vs origin/<branch> (usa lo ya fetchado; no toca la red).
  // Nota: esta llamada puede fallar legítimamente (sin remoto "origin", rama
  // todavía no trackeada, etc.) — no es indicio de repo roto, así que no se
  // propaga como error; se deja en 0/0 como antes.
  let behind = 0;
  let ahead = 0;
  const abRes = await git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
  if (abRes.code === 0 && abRes.stdout) {
    const [l, r] = abRes.stdout.split(/\s+/);
    behind = parseInt(l, 10) || 0;
    ahead = parseInt(r, 10) || 0;
  }
  // Si el proceso (o el host) murió a mitad de un stash->pull->pop, el stash
  // automático queda intacto en el repo (git lo persiste solo, no hace falta
  // estado propio) pero nadie lo señala tras un reinicio de la interfaz — se
  // detecta acá para que sobreviva al reinicio (CLAUDE.md regla 2).
  // Igual que abRes: un fallo acá (repo raro, permisos, etc.) no debe tirar
  // abajo /status. Se trata como "no hay stash pendiente" en vez de propagar
  // el error — fallback razonable, no un bug silencioso.
  const stashRes = await git(['stash', 'list']);
  const pendingAutoStash = stashRes.code === 0 && stashRes.stdout
    ? stashRes.stdout.split('\n').some((l) => l.includes(AUTO_STASH_MSG))
    : false;

  return {
    name: config.projectName, rel: REL, branch, head,
    subject: subject || '', author: author || '', date: date || '',
    dirty: dirtyCount > 0, dirtyCount, behind, ahead,
    lastFetch: lastFetchAt,
    pendingAutoStash,
  };
}

let busy = false;

export default {
  name: 'tolkien',

  registerHttp(router) {
    const r = express.Router();

    r.get('/status', async (req, res) => {
      try { res.json(await status()); }
      catch { res.status(500).json({ error: 'No se pudo leer el estado del repo.' }); }
    });

    r.post('/fetch', async (req, res) => {
      try {
        const f = await git(['fetch', '--prune', 'origin']);
        if (f.code === 0) { lastFetchAt = Date.now(); await saveLastFetchAt(lastFetchAt); }
        res.json({ ok: f.code === 0, error: f.code === 0 ? undefined : (f.stderr || 'fetch falló'), status: await status() });
      } catch {
        res.status(500).json({ error: 'No se pudo leer el estado del repo.' });
      }
    });

    r.post('/update', async (req, res) => {
      if (busy) return res.status(409).json({ error: 'Ya hay una actualización en curso.' });
      busy = true;
      const log = [];
      try {
        const dirtyRes = await git(['status', '--porcelain']);
        if (dirtyRes.code !== 0) throw new Error(`git status falló: ${dirtyRes.stderr || 'código ' + dirtyRes.code}`);
        const dirty = dirtyRes.stdout.length > 0;

        let stashed = false;
        if (dirty) {
          const s = await git(['stash', 'push', '-u', '-m', AUTO_STASH_MSG]);
          log.push({ step: 'stash', code: s.code, out: s.stdout || s.stderr });
          const noLocalChanges = /No local changes/i.test(s.stdout + s.stderr);
          if (s.code !== 0 && !noLocalChanges) {
            // El stash falló de verdad (lock tomado, permisos, disco lleno, etc.)
            // y NO es el caso benigno de "no había nada que stashear": abortamos
            // ANTES del pull para no arriesgar los cambios locales sin respaldo.
            const st = await status();
            return res.status(409).json({
              ok: false,
              stashFailed: true,
              log,
              status: st,
              error: 'No se pudo guardar los cambios locales (git stash) antes de actualizar: se abortó antes del pull para no arriesgar tu trabajo sin respaldo. Revisá el error y volvé a intentar.',
            });
          }
          stashed = s.code === 0 && !noLocalChanges;
        }

        const pull = await git(['pull', '--ff-only', 'origin']);
        log.push({ step: 'pull', code: pull.code, out: pull.stdout || pull.stderr });
        if (pull.code === 0) { lastFetchAt = Date.now(); await saveLastFetchAt(lastFetchAt); } // pull incluye fetch

        let popConflict = false;
        if (stashed) {
          const pop = await git(['stash', 'pop']);
          log.push({ step: 'stash-pop', code: pop.code, out: pop.stdout || pop.stderr });
          popConflict = pop.code !== 0; // conflicto al reaplicar: queda en el stash
          if (popConflict) {
            // El pull ya avanzó la rama (ff-only exitoso) pero el stash no se
            // pudo reaplicar limpio: revertimos el avance (git reset --hard
            // @{1} vuelve HEAD a la posición previa al pull, según el reflog)
            // para no dejar el repo a mitad de camino. El stash NO se toca —
            // sigue intacto para reintentar a mano.
            const reset = await git(['reset', '--hard', '@{1}']);
            log.push({ step: 'reset-rollback', code: reset.code, out: reset.stdout || reset.stderr });
            const resetFailed = reset.code !== 0;
            const st = await status();
            return res.status(409).json({
              ok: false,
              popConflict: true,
              resetFailed,
              stashed,
              log,
              status: st,
              error: resetFailed
                ? 'No se pudieron reaplicar los cambios locales (stash) tras el pull y ADEMÁS falló el intento de revertir el avance del pull (git reset --hard): la rama puede haber quedado adelantada a mitad de camino. Tus cambios siguen en el stash — revisá el estado del repo manualmente antes de continuar.'
                : 'No se pudieron reaplicar los cambios locales (stash) tras el pull: se revirtió la actualización para no dejar el repo a mitad de camino. Tus cambios siguen a salvo en el stash — resolvelo a mano (git stash pop).',
            });
          }
        }

        const st = await status();
        const ok = pull.code === 0 && !popConflict;
        res.json({ ok, popConflict, stashed, log, status: st });
      } catch {
        res.status(500).json({ error: 'Falló la actualización.', log });
      } finally {
        busy = false;
      }
    });

    router.use('/tolkien', r);
  },
};
