// modules/comms/pr-read-shared.js — LECTOR ÚNICO de un PR de GitHub (Fase C de
// la centralización 2026-07-05). Antes tres motores hacían su propio
// `gh pr view --json …` del MISMO PR (comms runner, bugfixes/prLive,
// investigate-runner) con cachés separadas → triple lectura de red.
//
// Ahora hay UN fetch con SUPERSET de campos (unión de lo que necesita cada
// consumidor) y UNA caché de archivo con TTL corto en ~/.cwc-data/comms/pr-cache/.
// Cada consumidor sigue parseando SOLO los campos que le importan (misma salida
// que antes); lo único que se unifica es el fetch+caché. Si dos consumidores
// piden el mismo PR dentro del TTL, el segundo no toca la red.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fss from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { COMMS_DIR, ensureDir } from './shared.js';

const PR_CACHE_DIR = path.join(COMMS_DIR, 'pr-cache');
export const PR_CACHE_TTL_MS = 60 * 1000;

// SUPERSET: unión de los --json de prLive + investigate + comms runner. Si un
// consumidor nuevo necesita otro campo, se agrega ACÁ (una sola fuente).
export const PR_RICH_FIELDS = [
  'number', 'title', 'url', 'state', 'headRefName', 'baseRefName', 'mergeable', 'reviewDecision',
  'updatedAt', 'createdAt', 'mergedAt', 'mergedBy', 'additions', 'deletions', 'changedFiles',
  'statusCheckRollup', 'reviews', 'comments', 'commits', 'author', 'reviewRequests',
  'body', 'isDraft', 'files',
].join(',');

function cachePath(n) { return path.join(PR_CACHE_DIR, `${String(n).replace(/[^\d]/g, '')}.json`); }

function readCache(n) {
  try {
    const o = JSON.parse(fss.readFileSync(cachePath(n), 'utf8'));
    if (o && o.ts && Date.now() - o.ts < PR_CACHE_TTL_MS) return o.data;
  } catch { /* miss */ }
  return null;
}
function writeCache(n, data) {
  try { ensureDir(); fss.mkdirSync(PR_CACHE_DIR, { recursive: true, mode: 0o700 }); fss.writeFileSync(cachePath(n), JSON.stringify({ ts: Date.now(), data }), { mode: 0o600 }); }
  catch { /* best-effort */ }
}

function ghView(prNumber, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'view', String(prNumber), '--json', PR_RICH_FIELDS], { cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh pr view #${prNumber}: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout));
    });
  });
}

// Devuelve el objeto RICO del PR (parseado). fresh=true fuerza red (igual
// escribe la caché para que otros reusen). Lanza si gh falla.
export async function fetchPrRich(prNumber, { fresh = false, cwd = config.projectDir } = {}) {
  if (!fresh) { const c = readCache(prNumber); if (c) return c; }
  const pr = JSON.parse(await ghView(prNumber, cwd));
  writeCache(prNumber, pr);
  return pr;
}

// DIFF de un PR (texto plano de `gh pr diff`). Vive acá para que TODA lectura
// de un PR salga de esta fuente (coherencia 2026-07-06; antes el
// investigate-runner tenía su propio execFile de gh). SIN caché a propósito:
// es pesado, tiene un solo consumidor hoy y siempre se quiere fresco; si
// aparece otro consumidor, cachear acá (patrón fetchPrRich). `cap` recorta el
// texto (el buffer amplio absorbe diffs grandes antes del recorte).
export function fetchPrDiff(prNumber, { cwd = config.projectDir, cap = null } = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'diff', String(prNumber)], { cwd, timeout: 90000, maxBuffer: 24 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh pr diff #${prNumber}: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(cap ? String(stdout).slice(0, cap) : String(stdout));
    });
  });
}

// ===== LISTADO de PRs — FUENTE ÚNICA de `gh pr list` (coherencia 2026-07-10) =====
// Antes tres consumidores hacían su propio `gh pr list` del MISMO repo Tolkien
// sin coordinar: tickets/sources.js (getDevLanePRs state=open + refreshResolved
// state=merged, cada uno su wrapper `runGh` + caché) y bin/cwc-comms-runner.js
// (state=all, wrapper `run`, sin caché de listado). Misma clase de duplicación
// que ya se resolvió para el DETALLE con fetchPrRich — el listado quedó sin
// terminar. Ahora hay UN wrapper de `gh pr list` con SUPERSET de campos y una
// caché de archivo de TTL corto para que llamadas cercanas de procesos DISTINTOS
// (server de tickets vs runner de comms) con los mismos args no dupliquen la red.
// Cada consumidor sigue filtrando por state / sliceando y conservando su PROPIA
// caché de más alto nivel (prCache en memoria, tickets-resolved.json, gh-cache
// por PR); esto solo unifica el fetch crudo, igual que fetchPrRich.
const PR_LIST_CACHE_DIR = path.join(COMMS_DIR, 'pr-list-cache');
export const PR_LIST_CACHE_TTL_MS = 15 * 1000;

// SUPERSET: unión de los --json que hoy piden los 3 consumidores. Cada campo ya
// está probado válido en algún `gh pr list` existente. Campo nuevo → se agrega ACÁ.
export const PR_LIST_FIELDS = [
  'number', 'title', 'url', 'state', 'headRefName', 'author',
  'updatedAt', 'mergedAt', 'reviewDecision', 'statusCheckRollup', 'isDraft',
].join(',');

function listCacheKey({ state, limit, fields, cwd }) {
  return crypto.createHash('sha1').update(JSON.stringify({ state, limit, fields, cwd })).digest('hex').slice(0, 16);
}
function listCachePath(key) { return path.join(PR_LIST_CACHE_DIR, `${key}.json`); }
function readListCache(key) {
  try {
    const o = JSON.parse(fss.readFileSync(listCachePath(key), 'utf8'));
    if (o && o.ts && Date.now() - o.ts < PR_LIST_CACHE_TTL_MS) return o.data;
  } catch { /* miss */ }
  return null;
}
function writeListCache(key, data) {
  try { ensureDir(); fss.mkdirSync(PR_LIST_CACHE_DIR, { recursive: true, mode: 0o700 }); fss.writeFileSync(listCachePath(key), JSON.stringify({ ts: Date.now(), data }), { mode: 0o600 }); }
  catch { /* best-effort */ }
}

function ghList({ state, limit, fields, cwd }) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'list', '--state', state, '--limit', String(limit), '--json', fields], { cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh pr list (${state}): ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout));
    });
  });
}

// Devuelve el ARRAY de PRs parseado. fresh=true fuerza red (igual escribe la
// caché para que otros reusen). Lanza si gh falla — cada consumidor mantiene su
// propio try/catch como hoy.
export async function listPrs({ state = 'open', limit = 30, fields = PR_LIST_FIELDS, cwd = config.projectDir, fresh = false } = {}) {
  const key = listCacheKey({ state, limit, fields, cwd });
  if (!fresh) { const c = readListCache(key); if (c) return c; }
  const prs = JSON.parse(await ghList({ state, limit, fields, cwd }));
  writeListCache(key, prs);
  return prs;
}

// ===== HISTÓRICO por autor — insumo canónico de La Forja =================
// Esta lectura usa el repo explícito porque `--author app/...` y los historiales
// largos deben ser independientes del remote activo del cwd. La autenticación
// sigue siendo la del gh del HOST: no se inyecta HOME ni credencial de un
// principal. El cache conserva el último bueno aun vencido para que un hipo de
// GitHub no vacíe la progresión de un jugador.
const PR_AUTHOR_CACHE_DIR = path.join(COMMS_DIR, 'pr-author-cache');
export const PR_AUTHOR_CACHE_TTL_MS = 150 * 1000;
export const TOLKIEN_GITHUB_REPO = 'Mordor-Staffing/tolkien';
export const PR_AUTHOR_FIELDS = [
  'number', 'title', 'mergedAt', 'createdAt', 'additions', 'deletions', 'headRefName', 'url',
  'mergeCommit', 'headRefOid',
].join(',');

function authorCacheKey({ author, limit, repo }) {
  return crypto.createHash('sha1').update(JSON.stringify({ author: author.toLowerCase(), limit, repo })).digest('hex').slice(0, 20);
}

function authorCachePath(key) { return path.join(PR_AUTHOR_CACHE_DIR, `${key}.json`); }

function readAuthorCache(key, { allowStale = false } = {}) {
  try {
    const cached = JSON.parse(fss.readFileSync(authorCachePath(key), 'utf8'));
    if (!cached || !cached.ts || !Array.isArray(cached.data)) return null;
    if (!allowStale && Date.now() - cached.ts >= PR_AUTHOR_CACHE_TTL_MS) return null;
    return cached.data;
  } catch { return null; }
}

function writeAuthorCache(key, data) {
  try {
    ensureDir();
    fss.mkdirSync(PR_AUTHOR_CACHE_DIR, { recursive: true, mode: 0o700 });
    fss.chmodSync(PR_AUTHOR_CACHE_DIR, 0o700);
    writeJsonAtomic(authorCachePath(key), { ts: Date.now(), data }, { mode: 0o600 });
  } catch { /* cache best-effort */ }
}

function markListStale(prs, stale) {
  const result = Array.isArray(prs) ? prs : [];
  Object.defineProperty(result, '_stale', { value: stale, enumerable: false, configurable: true });
  return result;
}

function ghMergedByAuthor({ author, limit, repo, cwd }) {
  return new Promise((resolve, reject) => {
    const args = [
      'pr', 'list', '--repo', repo, '--author', author, '--state', 'merged',
      '--limit', String(limit), '--json', PR_AUTHOR_FIELDS,
    ];
    execFile('gh', args, { cwd, timeout: 90000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh pr list (${author}): ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout));
    });
  });
}

export async function listMergedPrsByAuthor(author, {
  limit = 1000,
  repo = TOLKIEN_GITHUB_REPO,
  cwd = config.projectDir,
  fresh = false,
} = {}) {
  const normalizedAuthor = String(author || '').trim();
  if (!normalizedAuthor) throw new Error('Autor de GitHub vacío');
  const normalizedLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 1000));
  const normalizedRepo = String(repo || TOLKIEN_GITHUB_REPO).trim() || TOLKIEN_GITHUB_REPO;
  const key = authorCacheKey({ author: normalizedAuthor, limit: normalizedLimit, repo: normalizedRepo });
  if (!fresh) {
    const cached = readAuthorCache(key);
    if (cached) return markListStale(cached, false);
  }

  try {
    const prs = JSON.parse(await ghMergedByAuthor({
      author: normalizedAuthor, limit: normalizedLimit, repo: normalizedRepo, cwd,
    }));
    if (!Array.isArray(prs)) throw new Error('gh devolvió un listado inválido');
    writeAuthorCache(key, prs);
    return markListStale(prs, false);
  } catch (error) {
    // Un pedido fresh se usa para decidir festejos de producción: devolver el
    // último bueno en ese caso podría adelantar prodSha y perder el festejo.
    if (fresh) throw error;
    const lastGood = readAuthorCache(key, { allowStale: true });
    if (lastGood) return markListStale(lastGood, true);
    throw error;
  }
}

// ===== Identidad GitHub + deploys de producción — insumos de La Forja =====
const GITHUB_USER_CACHE_DIR = path.join(COMMS_DIR, 'github-user-cache');
const PRODUCTION_CACHE_DIR = path.join(COMMS_DIR, 'production-deploy-cache');
const COMMIT_COMPARE_CACHE_DIR = path.join(COMMS_DIR, 'commit-compare-cache');
export const GITHUB_USER_CACHE_TTL_MS = 150 * 1000;
export const UNCLASSIFIED_DEPLOY_CACHE_TTL_MS = 10 * 60 * 1000;
export const MAX_DEPLOY_LOG_READS = 5;
const PERMANENT_UNCLASSIFIED_AFTER_MS = 60 * 60 * 1000;
const DEPLOY_WORKFLOW = 'deploy-v2.yml';
const SHA_RE = /^[0-9a-f]{40}$/;

function safeCacheName(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 24);
}

function readTimedCache(file, ttl, { allowStale = false, now = Date.now() } = {}) {
  try {
    const cached = JSON.parse(fss.readFileSync(file, 'utf8'));
    if (!cached || !cached.ts || !Object.hasOwn(cached, 'data')) return null;
    if (!allowStale && now - cached.ts >= ttl) return null;
    return cached.data;
  } catch { return null; }
}

function writeTimedCache(dir, file, data, { now = Date.now() } = {}) {
  try {
    fss.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fss.chmodSync(dir, 0o700);
    writeJsonAtomic(file, { ts: now, data }, { mode: 0o600 });
  } catch { /* cache best-effort */ }
}

function ghJson(args, { cwd = config.projectDir, label = 'gh api' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, timeout: 90000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).trim().slice(0, 500);
        const error = new Error(`${label}: ${detail}`);
        error.notFound = /(?:HTTP\s+404|status(?: code)?\s+404|Not Found)/i.test(detail);
        reject(error);
        return;
      }
      try { resolve(JSON.parse(String(stdout))); }
      catch { reject(new Error(`${label}: respuesta JSON inválida`)); }
    });
  });
}

function ghText(args, { cwd = config.projectDir, label = 'gh' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, timeout: 90000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(String(stdout));
        return;
      }
      const detail = String(stderr || err.message).trim().slice(0, 500);
      const error = new Error(`${label}: ${detail}`);
      error.unavailable = /(?:HTTP\s+(?:404|410)|status(?: code)?\s+(?:404|410)|\bNot Found\b|\bGone\b|logs?\s+(?:have\s+)?expired)/i.test(detail);
      reject(error);
    });
  });
}

export async function getLatestMergedActivity({
  repo = TOLKIEN_GITHUB_REPO,
  cwd = config.projectDir,
} = {}) {
  const normalizedRepo = String(repo || TOLKIEN_GITHUB_REPO).trim() || TOLKIEN_GITHUB_REPO;
  const prs = await ghJson([
    'pr', 'list', '--repo', normalizedRepo, '--state', 'merged',
    '--search', 'sort:updated-desc', '--limit', '1', '--json', 'number,updatedAt',
  ], { cwd, label: 'gh pr list (latest merged activity)' });
  if (!Array.isArray(prs)) throw new Error('gh devolvió un listado de actividad inválido');
  if (!prs.length) return null;
  const number = Number(prs[0]?.number);
  const updatedAt = typeof prs[0]?.updatedAt === 'string' ? prs[0].updatedAt : '';
  if (!Number.isSafeInteger(number) || !updatedAt) throw new Error('gh devolvió actividad de merge inválida');
  // Mergear actualiza updatedAt y deja el merge nuevo arriba; un comentario
  // viejo solo causa un falso positivo seguro y activa la consulta completa.
  return { number, updatedAt };
}

export async function githubUserExists(login, { cwd = config.projectDir, fresh = false } = {}) {
  const normalized = String(login || '').trim();
  if (!normalized) throw new Error('Login de GitHub vacío');
  const cacheFile = path.join(GITHUB_USER_CACHE_DIR, `${safeCacheName(normalized.toLowerCase())}.json`);
  if (!fresh) {
    const cached = readTimedCache(cacheFile, GITHUB_USER_CACHE_TTL_MS);
    if (cached) return cached;
  }
  try {
    const profile = await ghJson(['api', `users/${encodeURIComponent(normalized)}`], {
      cwd, label: `gh api users/${normalized}`,
    });
    const result = {
      exists: true,
      canonicalLogin: String(profile?.login || normalized),
      name: typeof profile?.name === 'string' ? profile.name.trim() : '',
    };
    writeTimedCache(GITHUB_USER_CACHE_DIR, cacheFile, result);
    return result;
  } catch (error) {
    if (error?.notFound) {
      const result = { exists: false, canonicalLogin: null, name: '' };
      writeTimedCache(GITHUB_USER_CACHE_DIR, cacheFile, result);
      return result;
    }
    const lastGood = readTimedCache(cacheFile, GITHUB_USER_CACHE_TTL_MS, { allowStale: true });
    if (lastGood) return { ...lastGood, _stale: true };
    throw error;
  }
}

function outputRecord(line) {
  const parts = String(line || '').split('\t');
  if (parts.length < 3) {
    return { job: '', step: '', record: parts.join('\t').trim() };
  }
  return {
    job: parts[0].trim(),
    step: parts[1].trim(),
    // gh puede separar timestamp y mensaje o entregarlos juntos en la tercera
    // columna. Unir desde esa columna conserva tabs del payload y cubre ambos.
    record: parts.slice(2).join('\t')
      .replace(/^\d{4}-\d{2}-\d{2}T\S+\s*/, '')
      .trim(),
  };
}

function classifyDeployLog(log) {
  const recordsByJob = new Map();
  for (const line of String(log || '').split(/\r?\n/)) {
    const { job, step, record } = outputRecord(line);
    if (!recordsByJob.has(job)) recordsByJob.set(job, { operations: new Set(), artifactShas: new Set() });
    const jobRecords = recordsByJob.get(job);
    const operationMatch = record.match(/^OPERATION:\s*([^\s]+)\s*$/);
    if (operationMatch) jobRecords.operations.add(operationMatch[1].toLowerCase());
    const artifactMatch = record.match(/^EXPECTED_ARTIFACT_JSON:\s*(.+)$/);
    if (!artifactMatch) continue;
    try {
      const artifact = JSON.parse(artifactMatch[1]);
      const sourceSha = typeof artifact?.sourceSha === 'string'
        ? artifact.sourceSha.trim().toLowerCase()
        : '';
      if (SHA_RE.test(sourceSha)) jobRecords.artifactShas.add(sourceSha);
    } catch { /* solo un registro con JSON estricto satisface el contrato */ }
  }

  const operations = new Set();
  const artifactShas = new Set();
  for (const records of recordsByJob.values()) {
    for (const operation of records.operations) operations.add(operation);
    for (const sha of records.artifactShas) artifactShas.add(sha);
  }
  if (operations.size > 1 || artifactShas.size > 1) {
    return {
      kind: 'unclassifiable', confirmed: false, operation: null, sha: null, deployedSha: null,
    };
  }

  const operation = operations.values().next().value || null;
  const artifactSha = artifactShas.values().next().value || null;
  const correlatedDeploy = operation === 'deploy' && [...recordsByJob.values()].some((records) => (
    records.operations.has('deploy') && records.artifactShas.has(artifactSha)
  ));
  if (correlatedDeploy) {
    return {
      kind: 'deploy', confirmed: true, operation: 'deploy', sha: artifactSha, deployedSha: artifactSha,
    };
  }
  if (operation === 'deploy' || !operation) {
    return {
      kind: 'unclassifiable', confirmed: false, operation, sha: null, deployedSha: null,
    };
  }
  return {
    kind: 'non-deploy', confirmed: true, operation, sha: null, deployedSha: null,
  };
}

function normalizeCachedRun(data) {
  if (data?.kind === 'deploy' && SHA_RE.test(data.sha || '')) return data;
  if (['non-deploy', 'unavailable'].includes(data?.kind)) return data;
  if (data?.kind === 'unclassifiable') return data;
  // Compatibilidad con clasificaciones confirmadas de la caché anterior.
  if (data?.confirmed === true && SHA_RE.test(data.deployedSha || '')) {
    return { kind: 'deploy', sha: data.deployedSha, operation: 'deploy', permanent: true };
  }
  if (data?.confirmed === true) {
    return { kind: 'non-deploy', sha: null, operation: data.operation || 'other', permanent: true };
  }
  // Los `confirmed:false` legacy también podían ser fallos de red: no son confiables.
  return null;
}

async function classifyDeployRun(run, {
  cwd,
  repo,
  cacheDir,
  now,
  logBudget,
  readLog,
  retryExpired = true,
}) {
  const runId = Number(run?.id);
  if (!Number.isSafeInteger(runId)) return { classification: { kind: 'unavailable' }, logRead: false };
  const detailFile = path.join(cacheDir, `run-v2-${runId}.json`);
  const cached = normalizeCachedRun(readTimedCache(detailFile, Number.MAX_SAFE_INTEGER, {
    allowStale: true, now,
  }));
  if (cached?.permanent === true || ['deploy', 'non-deploy', 'unavailable'].includes(cached?.kind)) {
    return { classification: cached, logRead: false };
  }
  const temporary = normalizeCachedRun(readTimedCache(detailFile, UNCLASSIFIED_DEPLOY_CACHE_TTL_MS, { now }));
  if (temporary?.kind === 'unclassifiable') return { classification: temporary, logRead: false };
  if (cached?.kind === 'unclassifiable' && !retryExpired) {
    return { classification: null, logRead: false, retryDeferred: true };
  }
  if (logBudget <= 0) return { classification: null, logRead: false, budgetExhausted: true };

  let log;
  try {
    log = await readLog(runId);
  } catch (error) {
    if (!error?.unavailable) throw error;
    const unavailable = { kind: 'unavailable', sha: null, operation: null, permanent: true };
    writeTimedCache(cacheDir, detailFile, unavailable, { now });
    return { classification: unavailable, logRead: true };
  }
  const classification = classifyDeployLog(log);
  const completedAt = Date.parse(run?.updated_at || run?.created_at || '');
  const isOld = Number.isFinite(completedAt) && now - completedAt > PERMANENT_UNCLASSIFIED_AFTER_MS;
  const cachedClassification = classification.kind === 'unclassifiable'
    ? { ...classification, permanent: isOld }
    : { ...classification, permanent: true };
  writeTimedCache(cacheDir, detailFile, cachedClassification, { now });
  return { classification: cachedClassification, logRead: true };
}

export function __classifyDeployLogForTests(log) {
  return classifyDeployLog(log);
}

function markProductionStale(production, stale) {
  const result = production ? { ...production } : null;
  if (!result) return null;
  Object.defineProperty(result, '_stale', { value: stale, enumerable: false, configurable: true });
  return result;
}

export async function getCurrentProductionSha({
  repo = TOLKIEN_GITHUB_REPO,
  cwd = config.projectDir,
  cacheDir = PRODUCTION_CACHE_DIR,
  now = Date.now(),
  diagnostics = null,
  readRuns = null,
  readLog = null,
} = {}) {
  const currentFile = path.join(cacheDir, `current-v2-${safeCacheName(repo)}.json`);
  const stats = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
  stats.runsInspected = 0;
  stats.logReads = 0;
  const loadRuns = readRuns || (async () => ghJson([
    'run', 'list', '--repo', repo, '--workflow', DEPLOY_WORKFLOW,
    '--status', 'success', '--limit', '100',
    '--json', 'databaseId,conclusion,createdAt,updatedAt',
  ], { cwd, label: `gh run list ${DEPLOY_WORKFLOW}` }));
  const loadLog = readLog || ((runId) => ghText([
    'run', 'view', String(runId), '--repo', repo, '--log',
  ], { cwd, label: `gh run view ${runId} --log` }));
  try {
    const response = await loadRuns();
    const listedRuns = Array.isArray(response)
      ? response.map((run) => ({
        id: run?.databaseId,
        conclusion: run?.conclusion,
        created_at: run?.createdAt,
        updated_at: run?.updatedAt,
      }))
      : (Array.isArray(response?.workflow_runs) ? response.workflow_runs : []);
    const candidates = listedRuns
      .filter((run) => run?.conclusion === 'success')
      .sort((a, b) => Date.parse(b.updated_at || '') - Date.parse(a.updated_at || ''));
    const expiredRetries = [];
    for (const run of candidates) {
      stats.runsInspected += 1;
      const classified = await classifyDeployRun(run, {
        cwd, repo, cacheDir, now, logBudget: MAX_DEPLOY_LOG_READS - stats.logReads,
        readLog: loadLog, retryExpired: false,
      });
      if (classified.logRead) stats.logReads += 1;
      if (classified.budgetExhausted) throw new Error('Escaneo de producción incompleto: límite de logs alcanzado');
      if (classified.retryDeferred) {
        expiredRetries.push(run);
        continue;
      }
      if (classified.classification?.kind !== 'deploy') continue;
      const production = {
        sha: classified.classification.sha,
        runId: Number(run.id),
        completedAt: run.updated_at || run.created_at || null,
      };
      writeTimedCache(cacheDir, currentFile, production, { now });
      return markProductionStale(production, false);
    }
    // Solo después de recorrer los nunca inspeccionados se gasta el remanente
    // en reintentos de clasificaciones temporales vencidas, también de nuevo a viejo.
    for (const run of expiredRetries) {
      const classified = await classifyDeployRun(run, {
        cwd, repo, cacheDir, now, logBudget: MAX_DEPLOY_LOG_READS - stats.logReads,
        readLog: loadLog, retryExpired: true,
      });
      if (classified.logRead) stats.logReads += 1;
      if (classified.budgetExhausted) throw new Error('Escaneo de producción incompleto: límite de logs alcanzado');
      if (classified.classification?.kind !== 'deploy') continue;
      const production = {
        sha: classified.classification.sha,
        runId: Number(run.id),
        completedAt: run.updated_at || run.created_at || null,
      };
      writeTimedCache(cacheDir, currentFile, production, { now });
      return markProductionStale(production, false);
    }
    return null;
  } catch (error) {
    const lastGood = readTimedCache(currentFile, Number.MAX_SAFE_INTEGER, { allowStale: true, now });
    if (lastGood && SHA_RE.test(lastGood.sha || '')) return markProductionStale(lastGood, true);
    throw error;
  }
}

export async function listCommitsBetween(baseSha, headSha, {
  repo = TOLKIEN_GITHUB_REPO,
  cwd = config.projectDir,
  cacheDir = COMMIT_COMPARE_CACHE_DIR,
  readComparison = null,
} = {}) {
  const base = String(baseSha || '').trim().toLowerCase();
  const head = String(headSha || '').trim().toLowerCase();
  if (!SHA_RE.test(base) || !SHA_RE.test(head)) throw new Error('SHA inválido para comparar');
  const cacheFile = path.join(cacheDir, `v2-${safeCacheName(`${repo}:${base}:${head}`)}.json`);
  const cached = readTimedCache(cacheFile, Number.MAX_SAFE_INTEGER, { allowStale: true });
  if (cached && Array.isArray(cached.commits)) return cached.commits;
  const loadComparison = readComparison || ((page) => ghJson([
    'api', `repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}`,
  ], { cwd, label: `gh api compare ${base.slice(0, 8)}...${head.slice(0, 8)} page ${page}` }));

  const commits = [];
  let status = '';
  let page = 1;
  let totalCommits = Infinity;
  while (page <= 100 && commits.length < totalCommits) {
    const comparison = await loadComparison(page);
    if (page === 1) {
      status = String(comparison?.status || '');
      if (status === 'behind') break;
      totalCommits = Math.max(0, Number(comparison?.total_commits) || 0);
      if (status === 'identical' || totalCommits === 0) break;
    }
    const pageCommits = Array.isArray(comparison?.commits) ? comparison.commits : [];
    for (const commit of pageCommits) {
      const sha = typeof commit?.sha === 'string' ? commit.sha.trim().toLowerCase() : '';
      if (SHA_RE.test(sha)) commits.push(sha);
    }
    if (pageCommits.length < 100) break;
    page += 1;
  }
  const uniqueCommits = status === 'behind' ? [] : [...new Set(commits)];
  writeTimedCache(cacheDir, cacheFile, { status, commits: uniqueCommits });
  return uniqueCommits;
}
