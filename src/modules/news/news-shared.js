// modules/news/news-shared.js — persistencia, jobs y prompt de "Novedades".
//
// REGLA DE ORO: la generación IA corre en bin/cwc-news-runner.js, desacoplada
// del server. El backend solo deja un job en disco y spawnea el runner; el
// resultado se publica en news.json y el front se reengancha por polling.
//
// REGLA 6: el runner puede LEER el repo para ubicar dónde se prueba un cambio,
// pero no puede escribir ni ejecutar: Read/Grep/Glob/ToolSearch en dos capas.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { resolveDataDir } from '../../core/data-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..');

// Changelog, jobs y log son infraestructura global del host; el server admin y
// su runner comparten el fallback histórico de resolveDataDir(). La marca de
// lectura user-scoped NO usa esta constante: recibe su dataDir por operación.
const DATA_DIR = resolveDataDir();
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const NEWS_LOCK_FILE = `${NEWS_FILE}.lock`;
const NEWS_CURSOR_FILE = path.join(DATA_DIR, 'news-cursor.json');
const JOBS_DIR = path.join(DATA_DIR, 'news');
export const NEWS_LOG_FILE = path.join(DATA_DIR, 'news.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-news-runner.js');
const MAX_ENTRIES = 200;
const NEWS_LOCK_RETRY_MS = 40;
const NEWS_LOCK_WAIT_MS = 2_000;
const NEWS_LOCK_STALE_MS = 30_000;
// El prompt no puede listar cientos de archivos, y `git diff --name-only` los
// devuelve en orden alfabético: en un push grande el corte se comía enteras las
// rutas de la superficie que el usuario toca y dejaba solo `bin/`. Se ordena por
// relevancia antes de cortar, con el alfabético como desempate estable. El orden
// importa: `public/` es un prefijo genérico y ancho, así que va último; si queda
// antes que `.claude/skills/`, sus rutas de CSS e i18n agotan el cupo y las skills,
// superficie que el usuario invoca directo, no entran (push de 169 archivos: 0/8).
const MAX_PROMPT_FILES = 120;
const SURFACE_PREFIXES = ['public/js/modules/', 'src/modules/', '.claude/skills/', 'public/'];
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;

export const NEWS_TIMEOUT_MS = 8 * 60 * 1000;
export const NEWS_STALE_MS = NEWS_TIMEOUT_MS + 60 * 1000;
export const NEWS_ID_RE = /^[a-f0-9]{6,32}$/;
const TITLE_EMOJI_PREFIX_RE = /^(?:\p{Extended_Pictographic}\uFE0F?\u200D?)+\s+/u;

const CATEGORIES = new Set(['nuevo', 'mejora', 'arreglo']);

function surfaceRank(file) {
  const index = SURFACE_PREFIXES.findIndex((prefix) => file.startsWith(prefix));
  return index === -1 ? SURFACE_PREFIXES.length : index;
}

function readObject(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function trimEmoji(value) {
  const emoji = typeof value === 'string' ? value.trim() : '';
  return emoji && Array.from(emoji).length <= 4 ? emoji : '✨';
}

function trimStringList(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value.slice(0, 6).map((item) => item.trim().slice(0, 300)).filter(Boolean);
}

// Saneador compartido entre la respuesta del runner y el PATCH administrativo.
// En modo parcial solo procesa las claves presentes; title/summary vacíos y
// arrays con valores no-string invalidan el payload.
export function sanitizeNewsDraft(value, { partial = false } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(source, key);

  for (const key of ['title', 'summary']) {
    if (!partial || has(key)) {
      if (typeof source[key] !== 'string' || !source[key].trim()) return null;
      const text = source[key].trim();
      out[key] = key === 'title' ? text.replace(TITLE_EMOJI_PREFIX_RE, '').trim() : text;
    }
  }

  for (const key of ['bullets', 'tryIt']) {
    if (!partial || has(key)) {
      const list = has(key) ? trimStringList(source[key]) : [];
      if (!list) return null;
      if (!partial && key === 'tryIt' && list.length === 0) return null;
      out[key] = list;
    }
  }

  if (!partial || has('category')) {
    out.category = CATEGORIES.has(source.category) ? source.category : 'mejora';
  }
  if (!partial || has('emoji')) out.emoji = trimEmoji(source.emoji);
  if (partial && has('hidden')) {
    if (typeof source.hidden !== 'boolean') return null;
    out.hidden = source.hidden;
  }

  return out;
}

export function makePublishedNewsEntry(draft, tech = {}) {
  const clean = sanitizeNewsDraft(draft);
  if (!clean) return null;
  return {
    id: crypto.randomBytes(6).toString('hex'),
    createdAt: Date.now(),
    emoji: clean.emoji,
    category: clean.category,
    title: clean.title,
    summary: clean.summary,
    bullets: clean.bullets,
    tryIt: clean.tryIt,
    tech: {
      commits: Array.isArray(tech.commits)
        ? tech.commits.map((commit) => ({
            sha: String(commit?.sha || '').slice(0, 7),
            subject: String(commit?.subject || '').trim(),
          })).filter((commit) => commit.sha && commit.subject)
        : [],
      files: Array.isArray(tech.files) ? tech.files.map(String).filter(Boolean) : [],
    },
    source: 'auto',
    hidden: false,
    editedAt: null,
    editedBy: null,
  };
}

export function readNews() {
  const store = readObject(NEWS_FILE, { entries: [] });
  return Array.isArray(store.entries) ? store.entries : [];
}

export function readNewsCursor() {
  const cursor = readObject(NEWS_CURSOR_FILE, {});
  const sha = String(cursor.sha || '').trim();
  return /^[a-f0-9]{7,40}$/i.test(sha)
    ? { sha, updatedAt: Number(cursor.updatedAt) || 0 }
    : null;
}

export function writeNewsCursor(sha) {
  const clean = String(sha || '').trim();
  if (!/^[a-f0-9]{7,40}$/i.test(clean)) throw new Error('SHA de cursor de Novedades inválido.');
  const cursor = { sha: clean, updatedAt: Date.now() };
  writeJsonAtomic(NEWS_CURSOR_FILE, cursor);
  return cursor;
}

export function writeNews(list) {
  const entries = (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry === 'object')
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, MAX_ENTRIES);
  writeJsonAtomic(NEWS_FILE, { entries });
  return entries;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireNewsLock() {
  fs.mkdirSync(path.dirname(NEWS_LOCK_FILE), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + NEWS_LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    const token = crypto.randomBytes(12).toString('hex');
    let fd;
    try {
      fd = fs.openSync(NEWS_LOCK_FILE, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ token, ts: Date.now() }));
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stale = readObject(NEWS_LOCK_FILE, null);
      let staleByAge = false;
      try { staleByAge = Date.now() - fs.statSync(NEWS_LOCK_FILE).mtimeMs > NEWS_LOCK_STALE_MS; } catch { /* reintentar */ }
      if (staleByAge) {
        const current = readObject(NEWS_LOCK_FILE, null);
        try {
          if (current?.token === stale?.token && current?.ts === stale?.ts) fs.unlinkSync(NEWS_LOCK_FILE);
        } catch { /* otro proceso ganó la carrera */ }
      }
      await wait(NEWS_LOCK_RETRY_MS);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }

  const error = new Error('Otra escritura de Novedades sigue en curso. Reintentá.');
  error.conflict = true;
  throw error;
}

async function withNewsLock(operation) {
  const token = await acquireNewsLock();
  try {
    return await operation();
  } finally {
    const current = readObject(NEWS_LOCK_FILE, null);
    if (current?.token === token) {
      try { fs.unlinkSync(NEWS_LOCK_FILE); } catch { /* noop */ }
    }
  }
}

export function appendEntries(arr) {
  return withNewsLock(() => writeNews([...(Array.isArray(arr) ? arr : []), ...readNews()]));
}

export function updateEntry(id, patch) {
  return withNewsLock(() => {
    const entries = readNews();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    entries[index] = { ...entries[index], ...patch, id: entries[index].id };
    writeNews(entries);
    return entries[index];
  });
}

export function deleteEntry(id) {
  return withNewsLock(() => {
    const entries = readNews();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    writeNews(next);
    return true;
  });
}

function seenFile(dataDir = resolveDataDir()) {
  return path.join(dataDir, 'news-seen.json');
}

export function readSeen(dataDir = resolveDataDir()) {
  return readObject(seenFile(dataDir), {});
}

export function setSeen(key, ts, dataDir = resolveDataDir()) {
  const seen = readSeen(dataDir);
  const value = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
  seen[String(key)] = value;
  writeJsonAtomic(seenFile(dataDir), seen);
  return value;
}

function ensureJobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
}

export function newsJobPath(id) {
  if (!NEWS_ID_RE.test(String(id || ''))) throw new Error('Id de job inválido.');
  return path.join(JOBS_DIR, `${id}.json`);
}

export function readNewsJob(id) {
  if (!NEWS_ID_RE.test(String(id || ''))) return null;
  try {
    return JSON.parse(fs.readFileSync(newsJobPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function pruneOldJobs() {
  let files = [];
  try { files = fs.readdirSync(JOBS_DIR); } catch { return; }
  const now = Date.now();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(JOBS_DIR, file);
    try {
      if (now - fs.statSync(full).mtimeMs > MAX_JOB_AGE_MS) fs.unlinkSync(full);
    } catch { /* poda best-effort */ }
  }
}

export function writeNewsJob(id, data) {
  ensureJobsDir();
  writeJsonAtomic(newsJobPath(id), data);
  pruneOldJobs();
}

export function newsJobResult(job) {
  if (!job) return null;
  let result;
  if (job.status === 'running' && Date.now() - Number(job.startedAt || 0) > NEWS_STALE_MS) {
    result = {
      status: 'error',
      count: null,
      error: 'La generación no respondió a tiempo (el runner se interrumpió). Reintentá.',
    };
  } else {
    result = {
      status: job.status,
      count: job.count ?? null,
      error: job.error ?? null,
    };
  }
  if (Object.prototype.hasOwnProperty.call(job, 'rawTail')) result.rawTail = job.rawTail;
  return result;
}

// El front se re-engancha por polling al estado persistido en disco, no a una
// variable de memoria que desaparece al cerrar el panel.
export function findRunningNewsJob() {
  let files;
  try {
    files = fs.readdirSync(JOBS_DIR);
  } catch {
    return null;
  }

  let latest = null;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    if (!NEWS_ID_RE.test(id)) continue;
    const job = readNewsJob(id);
    if (!job) continue;
    const startedAt = Number(job.startedAt) || 0;
    if (job.status !== 'running' || Date.now() - startedAt > NEWS_STALE_MS) continue;
    if (!latest || startedAt > latest.startedAt) latest = { id, startedAt };
  }
  return latest;
}

export function spawnNewsRunner(jobId) {
  ensureJobsDir();
  fs.mkdirSync(path.dirname(NEWS_LOG_FILE), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(NEWS_LOG_FILE, 'a');
  const markSpawnError = (error) => {
    const message = `No se pudo iniciar el runner: ${error?.message || error}`.slice(0, 300);
    try {
      fs.appendFileSync(NEWS_LOG_FILE, `[${new Date().toISOString()}] FAIL spawn job ${jobId}: ${message}\n`);
      const job = readNewsJob(jobId);
      if (job?.status === 'running') {
        writeNewsJob(jobId, {
          ...job,
          status: 'error',
          count: null,
          error: message,
          updatedAt: Date.now(),
        });
      }
    } catch (markError) {
      console.error('[news] no se pudo persistir el fallo del runner:', markError?.message || markError);
    }
  };

  try {
    const child = spawn(process.execPath, [RUNNER, jobId], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.on('error', markSpawnError);
    child.unref();
  } catch (error) {
    markSpawnError(error);
    throw error;
  } finally {
    fs.closeSync(logFd);
  }
}

// Parsea el formato pedido para git log. Las líneas posteriores al encabezado
// pertenecen al body del commit actual.
export function parseNewsGitLog(raw) {
  const commits = [];
  let current = null;
  for (const line of String(raw || '').split('\n')) {
    const match = line.match(/^([a-f0-9]{40})\t([^\t]*)(?:\t([\s\S]*))?$/i);
    if (match) {
      current = { sha: match[1], subject: match[2].trim(), body: (match[3] || '').trim() };
      commits.push(current);
    } else if (current) {
      current.body = `${current.body}${current.body ? '\n' : ''}${line}`.trim();
    }
  }
  return commits.filter((commit) => commit.sha && commit.subject);
}

function firstJsonArray(text) {
  const source = String(text || '');
  for (let start = source.indexOf('['); start !== -1; start = source.indexOf('[', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '[') depth++;
      else if (char === ']') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(start, i + 1));
            if (Array.isArray(parsed)) return parsed;
          } catch { /* buscar el siguiente bloque */ }
          break;
        }
      }
    }
  }
  return null;
}

export function parseNewsResponse(text) {
  // El scanner ignora naturalmente el fence y conserva la semántica pedida:
  // tomar el PRIMER bloque array del texto final.
  return firstJsonArray(text);
}

export function buildNewsPrompt({ commits, files, published }) {
  const descriptive = (Array.isArray(commits) ? commits : [])
    .filter((commit) => !String(commit?.subject || '').startsWith('cwc backup '));
  const commitList = descriptive.length
    ? descriptive.map((commit) => {
        const head = `${String(commit.sha || '').slice(0, 7)} — ${String(commit.subject || '').trim()}`;
        const body = String(commit.body || '').trim();
        return body ? `${head}\n${body}` : head;
      }).join('\n')
    : '(ninguno)';
  const allFiles = (Array.isArray(files) ? files.map(String).filter(Boolean) : [])
    .sort((a, b) => surfaceRank(a) - surfaceRank(b) || a.localeCompare(b));
  const shownFiles = allFiles.slice(0, MAX_PROMPT_FILES);
  const fileList = [
    ...(shownFiles.length ? shownFiles : ['(ninguno)']),
    ...(allFiles.length > MAX_PROMPT_FILES ? [`… y ${allFiles.length - MAX_PROMPT_FILES} más`] : []),
  ].join('\n');
  const publishedTitles = published === undefined
    ? readNews().slice(0, 30).map((entry) => entry.title).filter(Boolean)
    : (Array.isArray(published) ? published : []);
  const publishedList = publishedTitles.map(String).filter(Boolean).join('\n') || '(ninguna)';

  return `Sos el redactor de "Novedades" de Mi Consola: una consola web personal donde varias personas trabajan con Claude Code desde el navegador.

Tu trabajo es convertir los cambios que se acaban de publicar en 1 a 6 novedades ALEGRES y ÚTILES para los OTROS usuarios de la consola — gente que la USA, no que escribió el código.

CAMBIOS PUBLICADOS EN ESTE PUSH:
${commitList}

ARCHIVOS TOCADOS:
${fileList}

NOVEDADES YA PUBLICADAS (no las repitas):
${publishedList}

Podés LEER el código del repo (Read, Grep, Glob) para entender qué hace cada cambio y, sobre todo, DÓNDE se prueba: en qué menú, botón, panel o comando quedó. No podés escribir, editar ni ejecutar nada.

Reglas de redacción:
- Español neutro, cercano y con energía. Nada de jerga de commit, nombres de archivo, refs de tickets ni SHAs en el texto visible.
- Cada novedad es UNA cosa que el usuario puede notar o usar. Si el push trae tres cosas distintas, devolvé tres entradas; si trae un solo tema, devolvé una.
- Cubrí TODO lo que un usuario pueda notar o usar, no solo los cambios más recientes: si el push trae seis cosas visibles, devolvé seis entradas. Lo que descartes, descartalo porque no es novedad para un usuario, nunca por falta de cupo.
- Trabajá con pocas lecturas bien elegidas (unas veinte como mucho): mirá primero los \`CLAUDE.md\` de las carpetas tocadas y el archivo del panel o comando donde queda la función, que es lo que necesitás para escribir los pasos de prueba.
- Los cambios puramente internos (refactors, backups automáticos, documentación, arreglos invisibles) NO son novedad. Si el push no trae NADA que un usuario pueda ver o probar, devolvé exactamente [].
- NO repitas algo que ya se publicó. Estas novedades ya están en el tablero; si un cambio de este push ya está contado ahí, omitilo y contá lo que falta.
- "tryIt" es lo más importante de todo: pasos concretos y clickeables para probarlo hoy mismo (por ejemplo "Abrí ⚙ Sistema → 🆕 Novedades" o "Escribí /graficar en el chat"). Verificá en el código dónde quedó de verdad; si no lográs determinar la ruta exacta, describilo en términos generales — NUNCA inventes un menú o un botón que no existe.
- Usá emojis como anclas visuales: uno en el campo "emoji" (que se muestra aparte, así que NO lo repitas al principio del título) y, si ayuda, uno al inicio de cada viñeta. Sin exagerar.
- "category" es "nuevo" si aparece algo que antes no existía, "mejora" si algo que ya existía quedó mejor, "arreglo" si se corrigió algo que molestaba.

Devolvé SOLO un JSON válido, sin texto ni markdown alrededor:
[{"emoji":"✨","category":"nuevo","title":"…","summary":"…","bullets":["…"],"tryIt":["…"]}]`;
}
