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
import { execFile } from 'node:child_process';
import { config } from '../../core/config.js';

const CWD = config.projectDir;
const REL = path.relative(config.home, CWD); // ruta relativa al home (para el árbol)

function git(args, { timeout = 90000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', CWD, ...args], { timeout, env: process.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      });
  });
}

// Timestamp del último fetch/pull exitoso (freshness del "N detrás"). En
// memoria: tras un reinicio queda null hasta que el front auto-fetchea (5 min).
let lastFetchAt = null;

async function status() {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || 'HEAD';
  const head = (await git(['rev-parse', '--short', 'HEAD'])).stdout;
  // Último commit: fecha ISO + autor + asunto (para el "pulso" del repo).
  const last = (await git(['log', '-1', '--format=%cI%x09%an%x09%s'])).stdout;
  const [date, author, subject] = last.split('\t');
  const porcelain = (await git(['status', '--porcelain'])).stdout;
  const dirtyCount = porcelain ? porcelain.split('\n').length : 0;

  // ahead/behind vs origin/<branch> (usa lo ya fetchado; no toca la red).
  let behind = 0;
  let ahead = 0;
  const ab = (await git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`])).stdout;
  if (ab) {
    const [l, r] = ab.split(/\s+/);
    behind = parseInt(l, 10) || 0;
    ahead = parseInt(r, 10) || 0;
  }
  return {
    name: config.projectName, rel: REL, branch, head,
    subject: subject || '', author: author || '', date: date || '',
    dirty: dirtyCount > 0, dirtyCount, behind, ahead,
    lastFetch: lastFetchAt,
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
      const f = await git(['fetch', '--prune', 'origin']);
      if (f.code === 0) lastFetchAt = Date.now();
      res.json({ ok: f.code === 0, error: f.code === 0 ? undefined : (f.stderr || 'fetch falló'), status: await status() });
    });

    r.post('/update', async (req, res) => {
      if (busy) return res.status(409).json({ error: 'Ya hay una actualización en curso.' });
      busy = true;
      const log = [];
      try {
        const dirty = (await git(['status', '--porcelain'])).stdout.length > 0;

        let stashed = false;
        if (dirty) {
          const s = await git(['stash', 'push', '-u', '-m', 'cwc: auto antes de actualizar']);
          log.push({ step: 'stash', code: s.code, out: s.stdout || s.stderr });
          stashed = s.code === 0 && !/No local changes/i.test(s.stdout + s.stderr);
        }

        const pull = await git(['pull', '--ff-only', 'origin']);
        log.push({ step: 'pull', code: pull.code, out: pull.stdout || pull.stderr });
        if (pull.code === 0) lastFetchAt = Date.now(); // pull incluye fetch

        let popConflict = false;
        if (stashed) {
          const pop = await git(['stash', 'pop']);
          log.push({ step: 'stash-pop', code: pop.code, out: pop.stdout || pop.stderr });
          popConflict = pop.code !== 0; // conflicto al reaplicar: queda en el stash
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
