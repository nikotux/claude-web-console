// modules/news/index.js — backend de "🆕 Novedades".
//
// El changelog es compartido por todos los autenticados. Cada principal tiene
// su propia marca de lectura; solo los administradores generan, editan, ocultan
// o borran entradas.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { isAdmin, principalOf } from '../../core/auth.js';
import { systemScopeFor } from '../../core/system-scope.js';
import {
  ROOT,
  NEWS_ID_RE,
  deleteEntry,
  findRunningNewsJob,
  newsJobResult,
  parseNewsGitLog,
  readNews,
  readNewsJob,
  readSeen,
  sanitizeNewsDraft,
  setSeen,
  spawnNewsRunner,
  updateEntry,
  writeNewsJob,
} from './news-shared.js';

function principalKey(req) {
  const principal = principalOf(req);
  if (!principal) return null;
  return principal.type === 'user' ? principal.username : '__host__';
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  res.status(403).json({ error: 'Requiere administrador.' });
  return false;
}

function validId(req, res) {
  const id = String(req.params.id || '');
  if (NEWS_ID_RE.test(id)) return id;
  res.status(400).json({ error: 'Id inválido.' });
  return null;
}

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: ROOT,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || 'git falló').trim()));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function latestAutoCommit(entries) {
  const latest = [...entries]
    .filter((entry) => entry.source === 'auto' && Array.isArray(entry.tech?.commits))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];
  const commits = latest?.tech?.commits || [];
  return commits.length ? String(commits[commits.length - 1]?.sha || '') : '';
}

async function generationInput() {
  const since = latestAutoCommit(readNews());
  const format = '--format=%H%x09%s%x09%b';
  if (since) {
    const raw = await git(['log', '--reverse', format, `${since}..HEAD`]);
    const filesRaw = await git(['diff', '--name-only', `${since}..HEAD`]);
    return {
      commits: parseNewsGitLog(raw),
      files: filesRaw.split('\n').map((file) => file.trim()).filter(Boolean),
    };
  }

  const raw = await git(['log', '--reverse', '-10', format, 'HEAD']);
  const commits = parseNewsGitLog(raw);
  if (!commits.length) return { commits: [], files: [] };
  const oldest = commits[0].sha;
  let filesRaw;
  try {
    filesRaw = await git(['diff', '--name-only', `${oldest}^..HEAD`]);
  } catch {
    // Repo con un solo commit: el árbol vacío es el "desde" correcto.
    filesRaw = await git(['diff', '--name-only', '4b825dc642cb6eb9a060e54bf8d69288fbee4904..HEAD']);
  }
  return {
    commits,
    files: filesRaw.split('\n').map((file) => file.trim()).filter(Boolean),
  };
}

async function pendingCommitCount() {
  try {
    const since = latestAutoCommit(readNews());
    const out = since
      ? await git(['rev-list', '--count', `${since}..HEAD`])
      : await git(['rev-list', '--count', '-n', '10', 'HEAD']);
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

export default {
  name: 'news',

  registerHttp(router) {
    router.get('/news', async (req, res) => {
      const key = principalKey(req);
      if (!key) return res.status(401).json({ error: 'No autorizado.' });
      const admin = isAdmin(req);
      const lastSeen = Number(readSeen(systemScopeFor(req).dataDir)[key] || 0);
      const entries = readNews().filter((entry) => admin || entry.hidden !== true);
      const unread = entries.filter((entry) => Number(entry.createdAt || 0) > lastSeen).length;
      let job = null;
      let pending = 0;
      if (admin) {
        try {
          job = findRunningNewsJob();
          pending = await pendingCommitCount();
        } catch {
          job = null;
          pending = 0;
        }
      }
      res.json({ entries, unread, lastSeen, isAdmin: admin, job, pending });
    });

    router.post('/news/seen', (req, res) => {
      const key = principalKey(req);
      if (!key) return res.status(401).json({ error: 'No autorizado.' });
      const lastSeen = setSeen(key, Date.now(), systemScopeFor(req).dataDir);
      res.json({ ok: true, lastSeen });
    });

    router.patch('/news/:id', (req, res) => {
      if (!requireAdmin(req, res)) return;
      const id = validId(req, res);
      if (!id) return;
      const clean = sanitizeNewsDraft(req.body, { partial: true });
      if (!clean || !Object.keys(clean).length) {
        return res.status(400).json({ error: 'No hay campos válidos para actualizar.' });
      }
      const entry = updateEntry(id, {
        ...clean,
        editedAt: Date.now(),
        editedBy: principalKey(req),
      });
      if (!entry) return res.status(404).json({ error: 'La novedad no existe.' });
      res.json({ ok: true, entry });
    });

    router.delete('/news/:id', (req, res) => {
      if (!requireAdmin(req, res)) return;
      const id = validId(req, res);
      if (!id) return;
      if (!deleteEntry(id)) return res.status(404).json({ error: 'La novedad no existe.' });
      res.json({ ok: true });
    });

    router.post('/news/generate', async (req, res) => {
      if (!requireAdmin(req, res)) return;
      try {
        const { commits, files } = await generationInput();
        if (!commits.length && !files.length) {
          return res.status(409).json({ error: 'No hay cambios nuevos para convertir en novedades.' });
        }
        const id = crypto.randomBytes(12).toString('hex');
        writeNewsJob(id, {
          status: 'running',
          startedAt: Date.now(),
          commits,
          files,
          count: null,
          error: null,
        });
        spawnNewsRunner(id);
        res.json({ id });
      } catch (error) {
        res.status(500).json({ error: `No se pudo iniciar la generación: ${error?.message || error}` });
      }
    });

    router.get('/news/job/:id', (req, res) => {
      if (!requireAdmin(req, res)) return;
      const id = validId(req, res);
      if (!id) return;
      const job = readNewsJob(id);
      if (!job) return res.status(404).json({ error: 'Ese job no existe (¿se podó?).' });
      res.json(newsJobResult(job));
    });
  },
};
