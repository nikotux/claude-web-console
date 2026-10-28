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
  'mergeCommit',
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
export const PRODUCTION_DEPLOY_CACHE_TTL_MS = 150 * 1000;
const DEPLOY_WORKFLOW = 'deploy-v2.yml';
const SHA_RE = /^[0-9a-f]{40}$/i;

function safeCacheName(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 24);
}

function readTimedCache(file, ttl, { allowStale = false } = {}) {
  try {
    const cached = JSON.parse(fss.readFileSync(file, 'utf8'));
    if (!cached || !cached.ts || !Object.hasOwn(cached, 'data')) return null;
    if (!allowStale && Date.now() - cached.ts >= ttl) return null;
    return cached.data;
  } catch { return null; }
}

function writeTimedCache(dir, file, data) {
  try {
    ensureDir();
    fss.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fss.chmodSync(dir, 0o700);
    writeJsonAtomic(file, { ts: Date.now(), data }, { mode: 0o600 });
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
      if (err) reject(new Error(`${label}: ${String(stderr || err.message).trim().slice(0, 500)}`));
      else resolve(String(stdout));
    });
  });
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

function deployedShaFromTitle(title) {
  const value = String(title || '');
  if (!/deploy/i.test(value)) return null;
  return value.match(/\b([0-9a-f]{40})\b/i)?.[1]?.toLowerCase() || null;
}

function deployedShaFromLog(log) {
  if (!/(?:^|\s)OPERATION:\s*deploy(?:\s|$)/im.test(log)) return null;
  return log.match(/EXPECTED_ARTIFACT_JSON:.*?"sourceSha"\s*:\s*"([0-9a-f]{40})"/i)?.[1]?.toLowerCase()
    || log.match(/(?:DEPLOYED_SHA|SOURCE_SHA|MAIN_SHA):\s*([0-9a-f]{40})/i)?.[1]?.toLowerCase()
    || null;
}

async function classifyDeployRun(run, { cwd, repo }) {
  const titleSha = deployedShaFromTitle(run?.display_title);
  if (titleSha) return titleSha;
  const runId = Number(run?.id);
  if (!Number.isSafeInteger(runId)) return null;
  const detailFile = path.join(PRODUCTION_CACHE_DIR, `run-${runId}.json`);
  const cached = readTimedCache(detailFile, Number.MAX_SAFE_INTEGER, { allowStale: true });
  if (cached) return cached.deployedSha || null;
  const log = await ghText(['run', 'view', String(runId), '--repo', repo, '--log'], {
    cwd, label: `gh run view ${runId} --log`,
  });
  const deployedSha = deployedShaFromLog(log);
  writeTimedCache(PRODUCTION_CACHE_DIR, detailFile, { deployedSha });
  return deployedSha;
}

function markDeployListStale(deploys, stale) {
  const result = Array.isArray(deploys) ? deploys : [];
  Object.defineProperty(result, '_stale', { value: stale, enumerable: false, configurable: true });
  return result;
}

export async function listProductionDeploys({
  limit = 5,
  repo = TOLKIEN_GITHUB_REPO,
  cwd = config.projectDir,
  fresh = false,
} = {}) {
  const normalizedLimit = Math.max(1, Math.min(20, Number(limit) || 5));
  const listFile = path.join(PRODUCTION_CACHE_DIR, `deploys-${safeCacheName(repo)}.json`);
  if (!fresh) {
    const cached = readTimedCache(listFile, PRODUCTION_DEPLOY_CACHE_TTL_MS);
    if (cached) return markDeployListStale(cached.slice(0, normalizedLimit), false);
  }
  try {
    const scanLimit = Math.min(100, Math.max(20, normalizedLimit * 5));
    const response = await ghJson([
      'api', `repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/runs?status=success&per_page=${scanLimit}`,
    ], { cwd, label: `gh api ${DEPLOY_WORKFLOW} runs` });
    const candidates = (Array.isArray(response?.workflow_runs) ? response.workflow_runs : [])
      .filter((run) => run?.event === 'workflow_dispatch' && run?.conclusion === 'success')
      .sort((a, b) => Date.parse(b.updated_at || '') - Date.parse(a.updated_at || ''));
    const deploys = [];
    for (const run of candidates) {
      const deployedSha = await classifyDeployRun(run, { cwd, repo });
      if (!SHA_RE.test(deployedSha || '')) continue;
      deploys.push({
        runId: Number(run.id),
        deployedSha,
        completedAt: run.updated_at || run.created_at || null,
        displayTitle: String(run.display_title || run.name || DEPLOY_WORKFLOW),
      });
      if (deploys.length >= normalizedLimit) break;
    }
    writeTimedCache(PRODUCTION_CACHE_DIR, listFile, deploys);
    return markDeployListStale(deploys, false);
  } catch (error) {
    const lastGood = readTimedCache(listFile, PRODUCTION_DEPLOY_CACHE_TTL_MS, { allowStale: true });
    if (lastGood) return markDeployListStale(lastGood.slice(0, normalizedLimit), true);
    throw error;
  }
}

export async function isCommitIncluded(baseSha, headSha, {
  repo = TOLKIEN_GITHUB_REPO,
  cwd = config.projectDir,
} = {}) {
  const base = String(baseSha || '').trim().toLowerCase();
  const head = String(headSha || '').trim().toLowerCase();
  if (!SHA_RE.test(base) || !SHA_RE.test(head)) throw new Error('SHA inválido para comparar');
  const cacheFile = path.join(COMMIT_COMPARE_CACHE_DIR, `${safeCacheName(`${repo}:${base}:${head}`)}.json`);
  const cached = readTimedCache(cacheFile, Number.MAX_SAFE_INTEGER, { allowStale: true });
  if (cached && typeof cached.included === 'boolean') return cached.included;
  const comparison = await ghJson(['api', `repos/${repo}/compare/${base}...${head}`], {
    cwd, label: `gh api compare ${base.slice(0, 8)}...${head.slice(0, 8)}`,
  });
  const status = String(comparison?.status || '');
  const included = status === 'ahead' || status === 'identical';
  writeTimedCache(COMMIT_COMPARE_CACHE_DIR, cacheFile, { status, included });
  return included;
}
