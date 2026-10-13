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
//   POST /api/tolkien/stack/up   -> claim + arranque N2 owner-scoped
//   POST /api/tolkien/stack/down -> baja solo sin claims vivos
//   GET  /api/tolkien/stack/status -> estado N2 persistido del owner
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
import { isAdmin, principalOf } from '../../core/auth.js';
import { systemScopeFor } from '../../core/system-scope.js';
import { fileRootFor, hostUser } from '../../core/user-space.js';
import { findZeroTierIp } from '../../core/zerotier.js';
import { isHostAdmin, HOST_ONLY_MSG } from './gates.js';
import {
  spawnRefreshRunner, readRefreshJob, writeRefreshJob, isRefreshRunning, refreshStatus,
  readTolkienDbName,
} from './refresh-shared.js';
import {
  maybeAutoRefresh,
  readSourcesJob,
  sourcesStatus,
  spawnSourcesRunner,
} from './sources-shared.js';
import { ensureLocalUsers, resolveTolkienLoginEmail } from './local-users.js';
import {
  listEnvs, getEnv, getEnvByChat, saveEnv, envIdForChat, dbNameFor, allocatePort, atCap, isEnvAlive, MAX_ENVS, PORT_RANGE,
} from './env-store.js';
import { teardownEnv, reattachEnvs, spawnEnvProvision, unitActive } from './env-shared.js';
import {
  spawnTemplateBuild, readTemplateJob, writeTemplateJob, templateStatus, isTemplateBuilding,
} from './template-shared.js';
import {
  isPostpullRunning,
  postpullStatus,
  readPostpullJob,
  spawnPostpullRunner,
  writePostpullJob,
} from './build-shared.js';
import {
  requestStackDown,
  requestStackUp,
  stackStatus,
} from './stack.js';
import { salaChat, salaVisiblePara } from '../visado/sala-access.js';

// La infraestructura de refresh/envs sigue siendo exclusiva del host; las
// operaciones git y local-enter resuelven el clon del principal por request.
const AUTO_STASH_MSG = 'cwc: auto antes de actualizar';
const DATA_DIR = path.join(config.home, '.cwc-data');
const LASTFETCH_FILE = path.join(DATA_DIR, 'tolkien-lastfetch.json');
const stackOwner = (req) => principalOf(req)?.username || hostUser();

// Función pura: no toca disco ni congela el workspace del host al importar.
// Replica el patrón owner-scoped de tickets/context-store.js.
export function tolkienRepoFor(req) {
  const scope = systemScopeFor(req);
  return scope.isHost ? config.projectDir : path.join(scope.workspace, 'tolkien');
}

const MISSING_REPO_MSG = 'Tu clon de Tolkien todavía no está preparado. Completá o reintentá la preparación de tu workspace y volvé a probar.';

function tolkienRepoOr404(req, res, { html = false } = {}) {
  const repoDir = tolkienRepoFor(req);
  try {
    if (fs.statSync(repoDir).isDirectory() && fs.existsSync(path.join(repoDir, '.git'))) return repoDir;
  } catch { /* fail-closed: nunca usar el repo del host como respaldo */ }
  if (html) res.status(404).type('html').send(localEnterErrPage('Clon de Tolkien no preparado', MISSING_REPO_MSG));
  else res.status(404).json({ error: MISSING_REPO_MSG });
  return null;
}

// El refresh de la DB LOCAL de Tolkien (TRUNCATE + reimport de importers Zoho)
// vive en refresh-shared.js + el runner desacoplado bin/cwc-tolkien-refresh-runner.js
// (regla de oro/regla 2: operación larga que debe sobrevivir a un reinicio de la
// web). Acá solo se lo dispara y se lee su estado del disco.

function runCmdAt(cwd, cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, env: process.env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal || typeof err.code !== 'number')) {
          return reject(err);
        }
        resolve({ code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
      });
  });
}

function gitAt(cwd, args, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout, env: process.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal || typeof err.code !== 'number')) {
          return reject(err);
        }
        resolve({ code: err ? err.code : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      });
  });
}

function gitFor(cwd) {
  return (args, options) => gitAt(cwd, args, options);
}

function isSafeEnvId(id) {
  return typeof id === 'string' && id !== '.' && id !== '..' && /^[A-Za-z0-9._-]+$/.test(id);
}

async function fanoutUpdateEnvs() {
  const results = [];
  for (const rec of listEnvs()) {
    if (!isEnvAlive(rec) || !rec?.worktree) continue;
    try {
      const dirty = await gitAt(rec.worktree, ['status', '--porcelain']);
      if (dirty.code !== 0) {
        results.push({ id: rec.id, branch: rec.branch, result: 'status-failed' });
        continue;
      }
      if (dirty.stdout) {
        const dirtyPaths = dirty.stdout.split('\n').filter(Boolean)
          .map((line) => line.slice(3).trim())
          .filter(Boolean);
        results.push({
          id: rec.id,
          branch: rec.branch,
          result: 'skipped-dirty',
          paths: dirtyPaths.slice(0, 3),
          dirtyCount: dirtyPaths.length,
        });
        continue;
      }
      const reb = await gitAt(rec.worktree, ['rebase', 'origin/main']);
      if (reb.code === 0) {
        results.push({ id: rec.id, branch: rec.branch, result: 'rebased' });
      } else {
        await gitAt(rec.worktree, ['rebase', '--abort']).catch(() => ({ code: 1, stdout: '', stderr: '' }));
        results.push({ id: rec.id, branch: rec.branch, result: 'conflict' });
      }
    } catch (err) {
      results.push({ id: rec?.id || null, branch: rec?.branch || null, result: 'error', detail: String(err?.message || err).slice(0, 300) });
    }
  }
  return results;
}

function maybeStartPostpull(cwd, moved, popConflict = false) {
  const postBuild = { started: false };
  if (cwd !== config.projectDir || !moved || popConflict) return postBuild;
  try {
    if (!isPostpullRunning(readPostpullJob())) {
      writePostpullJob({
        running: true,
        result: null,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
      });
      spawnPostpullRunner();
      postBuild.started = true;
    }
  } catch (err) {
    console.error('[tolkien] No se pudo iniciar el post-pull:', err?.message || err);
  }
  return postBuild;
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

export async function status(cwd = config.projectDir) {
  const git = gitFor(cwd);
  // Las 6 lecturas de git son INDEPENDIENTES entre sí (ninguna usa el
  // resultado de otra) y son SOLO LECTURA → se disparan en paralelo con
  // Promise.all (regla de oro del proyecto: "paralelo lo que LEE, serial lo
  // que ESCRIBE"). Baja la latencia de GET /status, que el pie persistente de
  // Tolkien consulta seguido. Los chequeos de error/derivación quedan idénticos
  // (mismo orden, mismos mensajes): solo cambia el momento de ejecución, no la
  // lógica. Un fallo de SISTEMA en cualquiera (git rechaza la Promise) propaga
  // igual que antes; los code!==0 se evalúan en orden abajo.
  const [branchRes, headRes, lastRes, porcelainRes, abRes, stashRes, mainBehindRes] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-parse', '--short', 'HEAD']),
    // Último commit: fecha ISO + autor + asunto (para el "pulso" del repo).
    git(['log', '-1', '--format=%cI%x09%an%x09%s']),
    git(['status', '--porcelain']),
    // ahead/behind de HEAD vs origin/main (usa lo ya fetchado; no toca la red).
    git(['rev-list', '--left-right', '--count', 'origin/main...HEAD']),
    git(['stash', 'list']),
    // mainBehind = commits en origin/main que tu main LOCAL todavía no tiene.
    // Es la pregunta REAL del panel ("¿mi base está fresca para pushear?"),
    // independiente de en qué rama esté parado HEAD. Si estás en una rama
    // feature, HEAD..origin/main mezcla "lo de Chris" con "lo tuyo"; esto no.
    git(['rev-list', '--count', 'main..origin/main']),
  ]);

  if (branchRes.code !== 0) throw new Error(`git rev-parse HEAD falló: ${branchRes.stderr || 'código ' + branchRes.code}`);
  const branch = branchRes.stdout || 'HEAD';

  if (headRes.code !== 0) throw new Error(`git rev-parse --short HEAD falló: ${headRes.stderr || 'código ' + headRes.code}`);
  const head = headRes.stdout;

  if (lastRes.code !== 0) throw new Error(`git log falló: ${lastRes.stderr || 'código ' + lastRes.code}`);
  const [date, author, subject] = lastRes.stdout.split('\t');

  if (porcelainRes.code !== 0) throw new Error(`git status falló: ${porcelainRes.stderr || 'código ' + porcelainRes.code}`);
  const porcelain = porcelainRes.stdout;
  const dirtyCount = porcelain ? porcelain.split('\n').length : 0;

  // La ÚNICA pregunta de este panel es "¿mi copia local coincide con main?",
  // así que se compara SIEMPRE contra origin/main, sin importar en qué rama
  // esté parado HEAD (el detalle de PRs/ramas vive en la sección Tickets).
  //   behind = versiones nuevas en main que todavía no tengo → accionable (pull)
  //   ahead  = commits míos fuera de main → NO se muestra acá, es de Tickets
  // Nota: esta llamada puede fallar legítimamente (sin remoto "origin", main
  // todavía no fetchado, etc.) — no es indicio de repo roto, así que no se
  // propaga como error; se deja en 0/0 como antes.
  let behind = 0;
  let ahead = 0;
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
  const pendingAutoStash = stashRes.code === 0 && stashRes.stdout
    ? stashRes.stdout.split('\n').some((l) => l.includes(AUTO_STASH_MSG))
    : false;

  // mainBehind: cuántos commits de origin/main le faltan a tu main local. Si el
  // rev-list falla (sin rama main local, sin origin/main fetchado, etc.) se deja
  // en 0 — fallback razonable, no propaga error (igual criterio que ahead/behind).
  const mainBehind = mainBehindRes.code === 0 && mainBehindRes.stdout
    ? (parseInt(mainBehindRes.stdout, 10) || 0)
    : 0;

  return {
    // No puede usar config.home: el frontend reenvía rel como cwd y safeCwd/clampToRoot
    // lo ancla al file-root del inquilino, duplicando una ruta calculada desde el home.
    name: config.projectName, rel: path.relative(fileRootFor(cwd), cwd), branch, head,
    subject: subject || '', author: author || '', date: date || '',
    dirty: dirtyCount > 0, dirtyCount, behind, ahead, mainBehind,
    onMain: branch === 'main',
    lastFetch: lastFetchAt,
    pendingAutoStash,
  };
}

let busy = false;

// Extraída de la ruta POST /refresh-data para que el módulo visado/ pueda
// invocarla con la autoridad del aprobador sin volver a entrar por HTTP.
export function opRefreshData() {
  let templateBuild = false;
  try {
    if (!isTemplateBuilding(readTemplateJob())) {
      writeTemplateJob({ running: true, result: null, error: null, startedAt: Date.now(), finishedAt: null });
      spawnTemplateBuild();
      templateBuild = true;
    }
  } catch (err) {
    console.error('[tolkien] No se pudo iniciar el build de plantilla:', err.message || err);
  }
  if (isRefreshRunning(readRefreshJob())) return { status: 200, body: { started: false, running: true, templateBuild } };
  writeRefreshJob({ running: true, result: null, error: null, startedAt: Date.now(), finishedAt: null });
  spawnRefreshRunner();
  return { status: 200, body: { started: true, running: true, templateBuild } };
}

export function opProvisionEnv({ chatId, base, packageRef }) {
  if (!chatId) return { status: 400, body: { error: 'Falta chatId.' } };
  const id = envIdForChat(chatId);
  const rec = getEnv(id);
  if (rec && isEnvAlive(rec)) return { status: 200, body: { id, already: true, status: rec.status } };
  if (atCap()) return { status: 409, body: { error: `Se alcanzó el tope de entornos concurrentes (${MAX_ENVS}). Cerrá alguno.` } };
  const port = allocatePort();
  if (port === null) return { status: 503, body: { error: 'No hay puertos libres en el pool.' } };
  saveEnv({
    id,
    chatId,
    packageRef: packageRef || null,
    base: base || 'main',
    port,
    db: dbNameFor(id),
    branch: `cwc-env/${id}`,
    worktree: null,
    unit: `tolkien-env-${id}`,
    status: 'provisioning',
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    heartbeatAt: Date.now(),
  });
  spawnEnvProvision(id);
  return { status: 200, body: { id, status: 'provisioning', port } };
}

export async function opTeardownEnv(id, force) {
  if (!isSafeEnvId(id)) return { status: 400, body: { error: 'Id de entorno inválido.' } };
  const r2 = await teardownEnv(id, { force });
  if (r2.dirty && !force) {
    return {
      status: 409,
      body: {
        ok: false,
        dirty: true,
        error: 'El entorno tiene cambios sin commitear. Confirmá para descartarlos (force).',
      },
    };
  }
  return { status: 200, body: r2 };
}

// Publica exclusivamente la rama nominal de un entorno en el origin de Tolkien
// y deja la propuesta como borrador. Comparte `busy` con fetch/update/rebase:
// todos operan sobre el mismo repositorio git y sus locks son comunes.
export async function opPushEnvBranch(id) {
  if (!isSafeEnvId(id)) return { status: 400, body: { error: 'Id de entorno inválido.' } };
  const rec = getEnv(id);
  if (!rec) return { status: 404, body: { error: 'Entorno no encontrado.' } };
  const expectedBranch = `cwc-env/${id}`;
  let worktreeExists = false;
  try { worktreeExists = !!rec.worktree && fs.statSync(rec.worktree).isDirectory(); } catch { /* ausente */ }
  if (!worktreeExists) {
    return { status: 409, body: { error: 'El worktree del entorno no está disponible.' } };
  }
  if (rec.branch !== expectedBranch) {
    return { status: 409, body: { error: `La rama registrada no es ${expectedBranch}.` } };
  }
  if (busy) return { status: 409, body: { error: 'Ya hay una operación git en curso.' } };

  busy = true;
  const git = gitFor(rec.worktree);
  try {
    const current = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (current.code !== 0 || current.stdout !== expectedBranch) {
      return { status: 409, body: { error: `El worktree no está parado en ${expectedBranch}.` } };
    }

    const origin = await git(['remote', 'get-url', 'origin']);
    if (origin.code !== 0 || !origin.stdout.includes('Mordor-Staffing/tolkien')) {
      return { status: 409, body: { error: 'El remote origin no pertenece a Mordor-Staffing/tolkien. Push bloqueado.' } };
    }
    const personal = await gitAt(config.projectDir, ['remote', 'get-url', 'personal']);
    if (personal.code === 0 && personal.stdout && origin.stdout === personal.stdout) {
      return { status: 409, body: { error: 'origin coincide con el remote personal de Mi Consola. Push bloqueado.' } };
    }

    const dirty = await git(['status', '--porcelain']);
    if (dirty.code !== 0) {
      return { status: 500, body: { error: dirty.stderr || 'No se pudo leer el estado del entorno.' } };
    }
    if (dirty.stdout) {
      const add = await git(['add', '-A']);
      if (add.code !== 0) {
        return { status: 500, body: { error: add.stderr || 'No se pudieron preparar los cambios.' } };
      }
      const commit = await git([
        'commit', '-m', `WIP: changes from Mi Consola preview env ${id}`,
      ]);
      if (commit.code !== 0) {
        return { status: 500, body: { error: commit.stderr || commit.stdout || 'No se pudo crear el commit.' } };
      }
    }

    const ahead = await git(['rev-list', '--count', `origin/main..${expectedBranch}`]);
    if (ahead.code !== 0) {
      return { status: 500, body: { error: ahead.stderr || 'No se pudo comparar la rama con origin/main.' } };
    }
    if ((Number.parseInt(ahead.stdout, 10) || 0) === 0) {
      return { status: 409, body: { error: 'Nada para publicar.' } };
    }

    const push = await git(['push', '-u', 'origin', expectedBranch], { timeout: 120000 });
    if (push.code !== 0) {
      const detail = push.stderr || push.stdout || 'git push falló';
      if (/non-fast-forward|fetch first/i.test(detail)) {
        return { status: 409, body: { error: `El push fue rechazado por non-fast-forward: ${detail}` } };
      }
      return { status: 500, body: { error: detail } };
    }

    const listed = await runCmdAt(rec.worktree, 'gh', [
      'pr', 'list', '--head', expectedBranch, '--json', 'url', '--limit', '1',
    ], { timeout: 20000 });
    if (listed.code !== 0) {
      return { status: 500, body: { error: listed.stderr || 'No se pudo consultar el PR de la rama.' } };
    }
    let prs;
    try { prs = JSON.parse(listed.stdout || '[]'); } catch { prs = null; }
    if (!Array.isArray(prs)) {
      return { status: 500, body: { error: 'gh devolvió una lista de PRs inválida.' } };
    }

    let prUrl = typeof prs[0]?.url === 'string' ? prs[0].url : '';
    if (!prUrl) {
      const created = await runCmdAt(rec.worktree, 'gh', [
        'pr', 'create', '--draft', '--base', 'main', '--head', expectedBranch,
        '--title', `WIP: preview env ${id}`,
        '--body', `Draft opened from a Mi Consola preview environment (sala ${rec.chatId}). Description pending — do not merge as-is.`,
      ], { timeout: 30000 });
      if (created.code !== 0) {
        return { status: 500, body: { error: created.stderr || 'No se pudo abrir el PR borrador.' } };
      }
      prUrl = created.stdout.trim();
      if (!prUrl) {
        return { status: 500, body: { error: 'gh creó el PR pero no devolvió su URL.' } };
      }
    }

    return {
      status: 200,
      body: { id, branch: expectedBranch, pushed: true, prUrl },
    };
  } catch (err) {
    return { status: 500, body: { error: String(err?.message || err) } };
  } finally {
    busy = false;
  }
}

export async function opFetch(cwd = config.projectDir) {
  const git = gitFor(cwd);
  // Comparte el flag `busy` con /update: un fetch y un pull simultáneos
  // sobre el mismo .git contienden por locks de git y fallan espurio.
  if (busy) return { status: 409, body: { error: 'Ya hay una operación git en curso.' } };
  busy = true;
  try {
    const f = await git(['fetch', '--prune', 'origin']);
    if (f.code === 0) { lastFetchAt = Date.now(); await saveLastFetchAt(lastFetchAt); }
    return { status: 200, body: { ok: f.code === 0, error: f.code === 0 ? undefined : (f.stderr || 'fetch falló'), status: await status(cwd) } };
  } catch {
    return { status: 500, body: { error: 'No se pudo leer el estado del repo.' } };
  } finally {
    busy = false;
  }
}

// Mis PRs abiertos (ramas que propuse, sin mergear aún). Le pregunta a GitHub
// (gh) cuáles de MIS PRs siguen ABIERTOS con base main y calcula cuántos commits
// de main le faltan a cada rama remota. Best-effort: si gh no está / no está
// autenticado / falla, devuelve lista vacía + error. SOLO LECTURA.
export async function opBranches(cwd = config.projectDir) {
  const git = gitFor(cwd);
  try {
    const gh = await runCmdAt(cwd, 'gh', [
      'pr', 'list', '--author', '@me', '--state', 'open', '--limit', '30',
      '--json', 'number,title,headRefName,baseRefName,url',
    ], { timeout: 20000 });
    if (gh.code !== 0) {
      return { status: 200, body: { ok: false, branches: [], error: (gh.stderr || 'gh falló').split('\n')[0].slice(0, 200) } };
    }
    let prs = [];
    try { prs = JSON.parse(gh.stdout || '[]'); } catch { prs = []; }
    const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || '';
    const withBase = prs.filter((p) => p && p.baseRefName === 'main');
    // Los rev-list son lecturas independientes → en paralelo (regla de oro).
    const branches = await Promise.all(withBase.map(async (pr) => {
      const bh = await git(['rev-list', '--count', `origin/${pr.headRefName}..origin/main`]);
      const behindMain = bh.code === 0 && bh.stdout ? (parseInt(bh.stdout, 10) || 0) : null;
      return {
        number: pr.number,
        title: pr.title || '',
        branch: pr.headRefName,
        url: pr.url || '',
        behindMain, // null = no se pudo medir (rama remota no fetchada)
        isCurrent: pr.headRefName === current,
      };
    }));
    return { status: 200, body: { ok: true, branches, current } };
  } catch {
    return { status: 500, body: { ok: false, branches: [], error: 'No se pudo consultar tus PRs.' } };
  }
}

export async function opUpdate(cwd = config.projectDir) {
  const git = gitFor(cwd);
  if (busy) return { status: 409, body: { error: 'Ya hay una actualización en curso.' } };
  busy = true;
  const log = [];
  try {
    // 0) Refrescar SIEMPRE las remote-tracking refs (origin/main incluido).
    //    Así el ff de main y el mainBehind del status ven lo último de Chris.
    const fetch = await git(['fetch', '--prune', 'origin']);
    log.push({ step: 'fetch', code: fetch.code, out: fetch.stdout || fetch.stderr || '(ok)' });
    if (fetch.code === 0) { lastFetchAt = Date.now(); await saveLastFetchAt(lastFetchAt); }

    const branchRes = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    // Igual que status(): si no se pudo determinar la rama, abortar explícito
    // en vez de asumir 'HEAD' y bifurcar CASO A/B sobre una premisa falsa.
    if (branchRes.code !== 0) {
      log.push({ step: 'branch', code: branchRes.code, out: branchRes.stderr || 'git rev-parse falló' });
      return { status: 500, body: { ok: false, error: 'No se pudo determinar la rama actual (git rev-parse falló).', log } };
    }
    const branch = branchRes.stdout || 'HEAD';

    // CASO A: estás parado en una RAMA FEATURE. El objetivo #1 del panel es
    // que tu main LOCAL == origin/main (base fresca para pushear). Lo logramos
    // SIN checkout y SIN tocar tu rama ni tu working tree: `git fetch origin
    // main:main` adelanta el ref local `main` SOLO si es fast-forward (git se
    // niega si main divergió — nunca lo forzamos). Tu trabajo queda intacto.
    if (branch !== 'main') {
      // `mainUpdated` conserva su semántica histórica (el ff fue válido). Para
      // el post-pull usamos el criterio más estricto y simple: SHA de main
      // antes/después, así un fetch no-op no dispara un build innecesario.
      const mainBefore = await git(['rev-parse', 'main']);
      const ff = await git(['fetch', 'origin', 'main:main']);
      log.push({ step: 'ff-main', code: ff.code, out: ff.stdout || ff.stderr || '(ya al día)' });
      const mainAfter = await git(['rev-parse', 'main']);
      const st = await status(cwd);
      const mainUpdated = ff.code === 0;
      const mainMoved = mainUpdated
        && mainAfter.code === 0 && mainAfter.stdout
        && mainBefore.stdout !== mainAfter.stdout;
      const envs = cwd === config.projectDir ? await fanoutUpdateEnvs() : [];
      const postBuild = maybeStartPostpull(cwd, mainMoved);
      return {
        status: 200,
        body: {
          ok: true,
          onMain: false,
          mainUpdated,
          log,
          status: st,
          envs,
          postBuild,
          warn: mainUpdated ? undefined
            : 'Tu main local no se pudo adelantar solo (puede tener commits propios o haber divergido de origin/main). Tu rama actual quedó intacta; revisá main a mano si hace falta.',
        },
      };
    }

    // CASO B: estás parado en MAIN → stash → pull --ff-only → pop (flujo
    // cuidadoso de siempre, que nunca arriesga tus cambios sin commitear).
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
        const st = await status(cwd);
        return {
          status: 409,
          body: {
            ok: false,
            stashFailed: true,
            log,
            status: st,
            error: 'No se pudo guardar los cambios locales (git stash) antes de actualizar: se abortó antes del pull para no arriesgar tu trabajo sin respaldo. Revisá el error y volvé a intentar.',
          },
        };
      }
      stashed = s.code === 0 && !noLocalChanges;
    }

    // SHA de HEAD ANTES del pull: si después hay que revertir, se vuelve a
    // este punto EXACTO. No se usa @{1} del reflog porque solo es "el
    // estado previo al pull" cuando el pull de verdad movió la rama; si el
    // pull falló (o fue no-op "Already up to date") @{1} apunta a un
    // movimiento de HEAD anterior y AJENO — un reset --hard ahí
    // descartaría trabajo real (hallazgo de salud 2026-07-05).
    const headBefore = await git(['rev-parse', 'HEAD']);

    const pull = await git(['pull', '--ff-only', 'origin']);
    log.push({ step: 'pull', code: pull.code, out: pull.stdout || pull.stderr });
    if (pull.code === 0) { lastFetchAt = Date.now(); await saveLastFetchAt(lastFetchAt); } // pull incluye fetch

    let popConflict = false;
    if (stashed) {
      const pop = await git(['stash', 'pop']);
      log.push({ step: 'stash-pop', code: pop.code, out: pop.stdout || pop.stderr });
      popConflict = pop.code !== 0; // conflicto al reaplicar: queda en el stash
      if (popConflict) {
        // El stash no se pudo reaplicar limpio. Revertir el avance del
        // pull SOLO si el pull fue exitoso Y movió HEAD de verdad: con
        // pull fallido (rama divergida, red) o no-op, HEAD no se movió y
        // no hay nada que revertir — resetear igual pisaría estados
        // legítimos anteriores. El stash NO se toca en ningún caso:
        // sigue intacto para reintentar a mano.
        const headNow = await git(['rev-parse', 'HEAD']);
        const pullMovedHead = pull.code === 0
          && headBefore.code === 0 && headNow.code === 0
          && headBefore.stdout && headBefore.stdout !== headNow.stdout;

        let resetFailed = false;
        if (pullMovedHead) {
          const reset = await git(['reset', '--hard', headBefore.stdout]);
          log.push({ step: 'reset-rollback', code: reset.code, out: reset.stdout || reset.stderr });
          resetFailed = reset.code !== 0;
        } else {
          log.push({ step: 'reset-rollback', code: 0, out: 'omitido: el pull no movió HEAD, no hay avance que revertir' });
        }
        const st = await status(cwd);
        return {
          status: 409,
          body: {
            ok: false,
            popConflict: true,
            resetFailed,
            stashed,
            log,
            status: st,
            error: resetFailed
              ? 'No se pudieron reaplicar los cambios locales (stash) tras el pull y ADEMÁS falló el intento de revertir el avance del pull (git reset --hard): la rama puede haber quedado adelantada a mitad de camino. Tus cambios siguen en el stash — revisá el estado del repo manualmente antes de continuar.'
              : pullMovedHead
                ? 'No se pudieron reaplicar los cambios locales (stash) tras el pull: se revirtió la actualización para no dejar el repo a mitad de camino. Tus cambios siguen a salvo en el stash — resolvelo a mano (git stash pop).'
                : 'El pull no avanzó la rama y encima los cambios locales (stash) no se pudieron reaplicar limpios. No se revirtió nada (HEAD no se movió). Tus cambios siguen a salvo en el stash — resolvelo a mano (git stash pop).',
          },
        };
      }
    }

    const st = await status(cwd);
    const ok = pull.code === 0 && !popConflict;
    const envs = cwd === config.projectDir ? await fanoutUpdateEnvs() : [];
    const headAfter = await git(['rev-parse', 'HEAD']);
    const pullMovedHead = ok
      && headBefore.code === 0 && headAfter.code === 0
      && headBefore.stdout && headBefore.stdout !== headAfter.stdout;
    const postBuild = maybeStartPostpull(cwd, pullMovedHead, popConflict);
    return { status: 200, body: { ok, onMain: true, popConflict, stashed, log, status: st, envs, postBuild } };
  } catch {
    return { status: 500, body: { error: 'Falló la actualización.', log } };
  } finally {
    busy = false;
  }
}

// ───────── Poner al día la rama ACTUAL sobre el main fresco (rebase) ─────────
// Rebasa la rama en la que estás parado sobre origin/main para seguir
// trabajando en paralelo sobre lo último de Chris. SEGURO por diseño:
//   • Solo rebasa la rama ACTUAL (no hace checkout de otra).
//   • Conflicto ⇒ `git rebase --abort` ⇒ la rama queda EXACTAMENTE como estaba.
//   • Cambios sin commitear ⇒ stash antes, pop después.
// Tras un rebase exitoso el PR necesita force-push al re-enviarlo (se avisa).
export async function opRebaseBranch(branch, cwd = config.projectDir) {
  const git = gitFor(cwd);
  if (busy) return { status: 409, body: { error: 'Ya hay una operación git en curso.' } };
  // Validación estricta del nombre de rama (nunca texto arbitrario a git).
  if (!branch || branch.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    return { status: 400, body: { error: 'Nombre de rama inválido.' } };
  }
  busy = true;
  const log = [];
  try {
    const cur = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || '';
    if (cur === 'main') {
      return { status: 400, body: { error: 'No se rebasa main sobre sí mismo — usá Actualizar.' } };
    }
    if (branch !== cur) {
      return { status: 409, body: { error: `Por seguridad solo rebaso la rama en la que estás parado. Cambiate a "${branch}" primero (ahora estás en "${cur}").` } };
    }

    const f = await git(['fetch', '--prune', 'origin']);
    log.push({ step: 'fetch', code: f.code, out: f.stdout || f.stderr || '(ok)' });
    if (f.code === 0) { lastFetchAt = Date.now(); await saveLastFetchAt(lastFetchAt); }

    // ¿Hace falta? Si la rama ya tiene todo main, no hay nada que rebasar.
    const bh = await git(['rev-list', '--count', 'HEAD..origin/main']);
    const behindMain = bh.code === 0 && bh.stdout ? (parseInt(bh.stdout, 10) || 0) : 0;
    if (behindMain === 0) {
      return { status: 200, body: { ok: true, noop: true, log, status: await status(cwd), message: 'Tu rama ya está al día sobre main.' } };
    }

    // Working tree limpio para rebasar: si hay cambios sin commitear, stash.
    const dirtyRes = await git(['status', '--porcelain']);
    const dirty = dirtyRes.code === 0 && dirtyRes.stdout.length > 0;
    let stashed = false;
    if (dirty) {
      const s = await git(['stash', 'push', '-u', '-m', AUTO_STASH_MSG]);
      log.push({ step: 'stash', code: s.code, out: s.stdout || s.stderr });
      const noLocalChanges = /No local changes/i.test(s.stdout + s.stderr);
      if (s.code !== 0 && !noLocalChanges) {
        return {
          status: 409,
          body: {
            ok: false, stashFailed: true, log, status: await status(cwd),
            error: 'No se pudo guardar tus cambios sin commitear (git stash) antes de rebasar. Abortado sin tocar nada.',
          },
        };
      }
      stashed = s.code === 0 && !noLocalChanges;
    }

    // Rebase sobre origin/main. Conflicto ⇒ abort ⇒ rama intacta.
    const reb = await git(['rebase', 'origin/main']);
    log.push({ step: 'rebase', code: reb.code, out: (reb.stdout || reb.stderr || '').split('\n').slice(0, 4).join(' | ') });
    if (reb.code !== 0) {
      const ab = await git(['rebase', '--abort']);
      log.push({ step: 'rebase-abort', code: ab.code, out: ab.stdout || ab.stderr || '(abortado)' });
      const abortFailed = ab.code !== 0;
      let popConflict = false;
      if (stashed) {
        const pop = await git(['stash', 'pop']);
        log.push({ step: 'stash-pop', code: pop.code, out: pop.stdout || pop.stderr });
        popConflict = pop.code !== 0;
      }
      // El mensaje depende del RESULTADO real del abort/pop: si el abort falló
      // la rama pudo quedar a mitad del rebase (NO "como estaba"); si el pop
      // conflictuó, tus cambios quedaron en el stash. No asumir éxito.
      let error;
      if (abortFailed) {
        error = 'El rebase tuvo conflictos y ADEMÁS falló el abort: tu rama pudo quedar a mitad del rebase. Revisá a mano: git status / git rebase --abort.';
      } else if (popConflict) {
        error = 'El rebase se abortó (tu rama quedó como estaba), pero al reaplicar tus cambios sin commitear (git stash pop) hubo conflicto. Resolvelos: git status — tu trabajo está en el stash (git stash list).';
      } else {
        error = 'El rebase tuvo conflictos con lo nuevo de main. Aborté: tu rama quedó EXACTAMENTE como estaba (nada perdido). Resolvelo a mano cuando puedas: git rebase origin/main.';
      }
      return {
        status: 409,
        body: {
          ok: false, conflict: true, abortFailed, popConflict, log, status: await status(cwd), error,
        },
      };
    }

    // Rebase OK. Reaplicar los cambios stasheados (si los había).
    let popConflict = false;
    if (stashed) {
      const pop = await git(['stash', 'pop']);
      log.push({ step: 'stash-pop', code: pop.code, out: pop.stdout || pop.stderr });
      popConflict = pop.code !== 0;
    }
    return {
      status: 200,
      body: {
        ok: true, rebased: true, needsForcePush: true, popConflict, log, status: await status(cwd),
        message: popConflict
          ? 'Rama rebasada sobre main. OJO: tus cambios sin commitear tuvieron conflicto al reaplicarse y quedaron en el stash (git stash list). El PR necesitará force-push al re-enviarlo.'
          : 'Rama rebasada sobre main. El PR va a necesitar force-push cuando lo re-envíes.',
      },
    };
  } catch {
    return { status: 500, body: { error: 'Falló el rebase.', log } };
  } finally {
    busy = false;
  }
}

// El estado del refresh de datos vive en DISCO (~/.cwc-data/tolkien-refresh.json,
// ver refresh-shared.js), NO en una variable del proceso: así sobrevive a un
// reinicio de la web (regla de oro/regla 2) y el front lo observa por polling.

export default {
  name: 'tolkien',

  init() {
    if (process.env.CWC_TOLKIEN_SOURCES_AUTO === '0') return;
    const decide = () => {
      try { maybeAutoRefresh(); }
      catch (error) { console.error('[tolkien] No se pudo decidir el refresh automático de fuentes:', error?.message || error); }
    };
    setInterval(decide, 5 * 60 * 1000).unref();
  },

  registerHttp(router) {
    const r = express.Router();

    // Stack N2 owner-scoped: el usuario del body nunca decide el dueño. Cada
    // sesión viva reclama el stack propio del principal autenticado; el trabajo
    // de Docker queda en el runner desacoplado y este request vuelve enseguida.
    r.post('/stack/up', async (req, res) => {
      const sessionId = String(req.body?.sessionId || '');
      if (!sessionId) return res.status(400).json({ error: 'Falta sessionId para reclamar el stack.' });
      try {
        const owner = stackOwner(req);
        const result = await requestStackUp(owner, sessionId, { tmuxSocket: config.tmuxSocket });
        return res.status(result.started ? 202 : 200).json({
          ok: true,
          started: result.started,
          stack: stackStatus(owner),
        });
      } catch (err) {
        const message = String(err?.message || err);
        const conflict = /sesión .*no está confirmada|GUARD DURO|puertos/i.test(message);
        return res.status(conflict ? 409 : 500).json({ error: message });
      }
    });

    // "Apagar" no equivale a liberar a la fuerza: primero reconcilia TODOS los
    // claims con la autoridad de liveness existente. Si queda uno vivo o hay
    // incertidumbre, el stack se conserva y se informa sin ejecutar down.
    r.post('/stack/down', async (req, res) => {
      try {
        const owner = stackOwner(req);
        const result = await requestStackDown(owner, { tmuxSocket: config.tmuxSocket });
        return res.status(result.started ? 202 : 200).json({
          ok: true,
          started: result.started,
          pending: !!result.pending,
          claimed: !!result.claimed,
          checks: result.checks || [],
          stack: stackStatus(owner),
        });
      } catch (err) {
        return res.status(500).json({ error: String(err?.message || err) });
      }
    });

    r.get('/stack/status', (req, res) => {
      try {
        return res.json(stackStatus(stackOwner(req)));
      } catch (err) {
        return res.status(500).json({ error: String(err?.message || err) });
      }
    });

    // Arranca el refresh en un RUNNER DESACOPLADO (idempotente si ya corre).
    // Vuelve al toque; el estado se persiste en disco y se consulta por GET.
    // Admin-only: escribe/trunca la DB LOCAL de Tolkien.
    r.post('/refresh-data', (req, res) => {
      try {
        if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
        const r2 = opRefreshData();
        res.status(r2.status).json(r2.body);
      } catch (e) {
        res.status(500).json({ error: 'No se pudo iniciar el refresh de datos: ' + (e.message || e) });
      }
    });

    // Estado del último/actual refresh (para el polling del frontend) — solo lee disco.
    r.get('/refresh-data/status', (req, res) => {
      if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
      res.json(refreshStatus(readRefreshJob()));
    });

    // Estado del build+restart post-pull; el trabajo corre en runner detached.
    r.get('/postpull-status', (req, res) => {
      if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
      res.json(postpullStatus(readPostpullJob()));
    });

    // Refresh completo del workboard: el request solo reserva y lanza el runner
    // desacoplado; el trabajo y su resultado viven en disco.
    r.post('/sources-refresh', (req, res) => {
      if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
      try {
        const started = spawnSourcesRunner();
        res.json({ started, ...sourcesStatus(readSourcesJob()) });
      } catch (error) {
        res.status(500).json({ error: 'No se pudo iniciar el refresh de fuentes: ' + (error?.message || error) });
      }
    });

    r.get('/sources-refresh/status', (req, res) => {
      if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
      res.json(sourcesStatus(readSourcesJob()));
    });

    r.get('/envs', (req, res) => {
      if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
      const envs = listEnvs()
        .slice()
        .sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0))
        .map((e) => ({
          id: e.id,
          chatId: e.chatId,
          packageRef: e.packageRef,
          branch: e.branch,
          port: e.port,
          db: e.db,
          status: e.status,
          error: e.error,
          worktree: e.worktree,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          heartbeatAt: e.heartbeatAt,
        }));
      res.json({ envs, max: MAX_ENVS, portRange: PORT_RANGE });
    });

    r.get('/envs/:id', (req, res) => {
      if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
      const id = String(req.params.id || '');
      if (!isSafeEnvId(id)) return res.status(400).json({ error: 'Id de entorno inválido.' });
      const rec = getEnv(id);
      if (!rec) return res.status(404).json({ error: 'Entorno no encontrado.' });
      res.json(rec);
    });

    r.post('/envs/provision', (req, res) => {
      if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
      const r2 = opProvisionEnv({ chatId: req.body?.chatId, base: req.body?.base, packageRef: req.body?.packageRef });
      res.status(r2.status).json(r2.body);
    });

    r.post('/envs/:id/teardown', async (req, res) => {
      if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
      const r2 = await opTeardownEnv(String(req.params.id || ''), req.body?.force === true);
      res.status(r2.status).json(r2.body);
    });

    r.post('/envs/:id/push', async (req, res) => {
      if (!isHostAdmin(req)) return res.status(403).json({ error: HOST_ONLY_MSG });
      const r2 = await opPushEnvBranch(String(req.params.id || ''));
      res.status(r2.status).json(r2.body);
    });

    // Operaciones sobre el clon propio del usuario → cualquier usuario autenticado;
    // identidad real de Tolkien e infra compartida → admin / host-admin.
    r.get('/status', async (req, res) => {
      const cwd = tolkienRepoOr404(req, res);
      if (!cwd) return;
      try { res.json(await status(cwd)); }
      catch { res.status(500).json({ error: 'No se pudo leer el estado del repo.' }); }
    });

    r.post('/fetch', async (req, res) => {
      const cwd = tolkienRepoOr404(req, res);
      if (!cwd) return;
      const r2 = await opFetch(cwd);
      res.status(r2.status).json(r2.body);
    });

    r.post('/update', async (req, res) => {
      const cwd = tolkienRepoOr404(req, res);
      if (!cwd) return;
      const r2 = await opUpdate(cwd);
      res.status(r2.status).json(r2.body);
    });

    r.get('/branches', async (req, res) => {
      const cwd = tolkienRepoOr404(req, res);
      if (!cwd) return;
      const r2 = await opBranches(cwd);
      res.status(r2.status).json(r2.body);
    });

    r.post('/rebase-branch', async (req, res) => {
      const cwd = tolkienRepoOr404(req, res);
      if (!cwd) return;
      const r2 = await opRebaseBranch(String(req.body?.branch || '').trim(), cwd);
      res.status(r2.status).json(r2.body);
    });

    // ───────── Acceso "un clic" al Tolkien local (inyección de sesión) ─────────
    // Problema: el server de Tolkien corre con NEXTAUTH_URL=http://localhost:3003
    // (su default de dev). Desde un dispositivo por ZeroTier el login se rompe
    // (callback a localhost, host no confiable en Auth.js v5) y la landing sólo
    // ofrece Microsoft SSO (cuyo callback de Azure no incluye la IP ZeroTier) +
    // magic-link. El dev-login (Credentials, activo con DEV_AUTH_ENABLED=1) NO
    // tiene botón en la landing y sufriría el mismo problema de host.
    //
    // Solución (SIN tocar Tolkien, sobrevive a sus updates): la CONSOLA — ya
    // autenticada y servida por ZeroTier — hace el dev-login contra localhost
    // para el server base y contra ZeroTier para las envs, que sólo escuchan allí.
    // En el base el host coincide con NEXTAUTH_URL, así Auth.js no rechaza;
    // captura la cookie de sesión `tolkien.session` (un JWT auto-validable, no
    // atado a host) y redirige el navegador a la IP ZeroTier INSTALANDO esa
    // cookie. Como las cookies van por HOST y no por puerto, la que setea la
    // consola (:8092) vale para Tolkien (:3003) del mismo host. Un clic → adentro.
    //
    // Seguridad: la base conserva el gate admin y el clon propio. Un entorno de
    // sala admite además al host-admin o a un participante de ESA sala y usa el
    // worktree del record. La identidad siempre se resuelve por principal.
    r.get('/local-enter', async (req, res) => {
      const envs = listEnvs();
      const requestedPort = (typeof req.query.port === 'string' ? req.query.port.trim() : '');
      const envRec = envs
        .filter(isEnvAlive)
        .find((env) => String(env.port) === requestedPort);
      const sala = envRec ? salaChat(envRec.chatId) : null;
      const principal = principalOf(req);
      const user = principal?.username || hostUser();
      const puedeEntrarASala = !!principal && !!sala
        && (isHostAdmin(req) || !!salaVisiblePara(envRec.chatId, user));

      if (!puedeEntrarASala && !isAdmin(req)) {
        res.status(403).type('html').send(localEnterErrPage(
          'Acceso denegado',
          'Sólo un administrador puede entrar al Tolkien local desde la consola.',
        ));
        return;
      }
      if (!puedeEntrarASala && !tolkienRepoOr404(req, res, { html: true })) return;
      const ALLOWED_LOCAL_PORTS = ['3010', ...envs.filter(isEnvAlive).map((e) => String(e.port)).filter(Boolean)];
      const defaultPort = (process.env.CWC_TOLKIEN_LOCAL_PORT?.trim() || '3003');
      if (requestedPort && !ALLOWED_LOCAL_PORTS.includes(requestedPort)) {
        res.status(400).type('html').send(localEnterErrPage(
          'Puerto no permitido',
          `Puerto no permitido: ${requestedPort}. Permitidos: ${ALLOWED_LOCAL_PORTS.join(', ')}.`,
        ));
        return;
      }
      const port = requestedPort || defaultPort;

      const ownEmail = resolveTolkienLoginEmail(systemScopeFor(req).user);
      if (!ownEmail) {
        res.status(400).type('html').send(localEnterErrPage(
          'Sin identidad para Tolkien',
          'No encontramos tu email de Mordor para entrar al Tolkien local. Cargalo en ⚙ Sistema → Identidad (email) y volvé a probar.',
        ));
        return;
      }
      const requestedEmail = (typeof req.query.email === 'string' ? req.query.email.trim() : '');
      if (
        requestedEmail
        && requestedEmail !== ownEmail
        && !/^[^@\s]+@phase3val\.test$/.test(requestedEmail)
      ) {
        res.status(400).type('html').send(localEnterErrPage(
          'Email no permitido',
          `Email no permitido para local-enter: ${requestedEmail}. `
            + 'Solo el email real o un usuario de validación @phase3val.test.',
        ));
        return;
      }
      const email = requestedEmail || ownEmail;
      const selectedEnv = envs.find((env) => String(env.port) === port);
      const isEnvPort = Boolean(selectedEnv && port !== '3010');
      const host = isEnvPort ? findZeroTierIp()?.ip : 'localhost';
      if (!host) {
        res.status(502).type('html').send(localEnterErrPage(
          'No se pudo entrar al Tolkien local',
          'No se detectó la IP ZeroTier',
        ));
        return;
      }
      const base = `http://${host}:${port}`;
      const dbName = port === defaultPort || port === '3010'
        ? readTolkienDbName()
        : selectedEnv?.db;

      const tryDevLogin = async () => {
        // Cada intento usa un jar nuevo. Acumula Set-Cookie dedupeando POR NOMBRE
        // (última ocurrencia gana, como browser/curl): /api/auth/csrf devuelve DOS
        // cookies csrf y reenviar ambas provoca MissingCSRF.
        const jar = {};
        const addCookies = (setCookies) => {
          for (const cookie of (setCookies || [])) {
            const nameValue = cookie.split(';')[0];
            const separator = nameValue.indexOf('=');
            if (separator > 0) jar[nameValue.slice(0, separator)] = nameValue.slice(separator + 1);
          }
        };
        const cookieHeader = () => Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; ');

        // Tomamos el token de la COOKIE (no del JSON) para garantizar que
        // coincide con la cookie enviada: su valor tiene forma "token|hash".
        const csrfRes = await fetch(`${base}/api/auth/csrf`, { headers: { accept: 'application/json' } });
        if (!csrfRes.ok) throw new Error(`csrf HTTP ${csrfRes.status}`);
        addCookies(csrfRes.headers.getSetCookie?.());
        const csrfToken = decodeURIComponent(jar['authjs.csrf-token'] || '').split('|')[0];
        if (!csrfToken) throw new Error('no se obtuvo el csrfToken de Tolkien');

        const body = new URLSearchParams({
          email, csrfToken, callbackUrl: `${base}/welcome`, json: 'true',
        });
        const loginRes = await fetch(`${base}/api/auth/callback/dev-login`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
          body,
        });
        return (loginRes.headers.getSetCookie?.() || [])
          .find((cookie) => /^tolkien\.session=/.test(cookie)) || null;
      };

      try {
        let sessionCookieRaw = await tryDevLogin();
        let repair = null;
        if (!sessionCookieRaw && !email.endsWith('@phase3val.test') && dbName) {
          repair = await ensureLocalUsers(dbName);
          sessionCookieRaw = await tryDevLogin();
        }
        if (!sessionCookieRaw) {
          // Sin cookie de sesión = el login no prosperó. Causas típicas:
          // dev-login apagado (DEV_AUTH_ENABLED≠1), email inexistente/inactivo.
          throw new Error(
            `el dev-login no devolvió sesión para "${email}". `
            + 'Verificá que DEV_AUTH_ENABLED=1 en el server de Tolkien y que ese '
            + 'email exista como usuario activo (o cambiá CWC_TOLKIEN_LOGIN_EMAIL).'
            + (repair
              ? ` (auto-reparación de usuarios: ${repair.ok ? 'aplicada' : `falló: ${repair.detail}`})`
              : ''),
          );
        }

        // 3) Redirigir a la IP ZeroTier INSTALANDO la sesión. La cookie es
        // host-only (sin Domain) → el navegador la asocia al host de la consola
        // y, como las cookies ignoran el puerto, la envía también a :3003. Sin
        // `Secure` porque Tolkien dev sirve por HTTP. Cookie de sesión (sin
        // Expires): se limpia al cerrar el navegador — un clic la repone.
        const ztIp = (findZeroTierIp()?.ip) || req.hostname;
        const nameValue = sessionCookieRaw.split(';')[0]; // "tolkien.session=<jwt>"
        res.setHeader('Set-Cookie', `${nameValue}; Path=/; HttpOnly; SameSite=Lax`);
        res.redirect(302, `http://${ztIp}:${port}/welcome`);
      } catch (err) {
        const isConn = /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(err?.message || '');
        res.status(isConn ? 502 : 500).type('html').send(localEnterErrPage(
          'No se pudo entrar al Tolkien local',
          isConn
            ? `El server de Tolkien no responde en ${host}:${port}. ¿Está corriendo? `
              + '(next dev). Si usa otro puerto, seteá CWC_TOLKIEN_LOCAL_PORT.'
            : (err?.message || 'Error desconocido en el flujo de login.'),
        ));
      }
    });

    router.use('/tolkien', r);
  },
};

// Página de error mínima para /local-enter (se abre en pestaña nueva, así que
// un JSON crudo sería inútil: el usuario necesita ver qué pasó).
function localEnterErrPage(title, detail) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  // Colores desde tokens.css (convención: nada de hex hardcodeado). La página se
  // sirve por el mismo server, así que el <link> a /css/tokens.css resuelve las
  // var(--cwc-*); si no cargara, degrada a los defaults del navegador (es una
  // pantalla de error de una sola vista, aceptable).
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title>`
    + `<link rel="stylesheet" href="/css/tokens.css">`
    + `<style>body{font-family:system-ui,sans-serif;background:var(--cwc-bg);color:var(--cwc-text);`
    + `display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:1.5rem}`
    + `.c{max-width:32rem}h1{color:var(--cwc-accent);font-size:1.2rem}p{line-height:1.5;color:var(--cwc-text-dim)}`
    + `code{background:var(--cwc-bg-elevated);padding:.1rem .3rem;border-radius:4px}</style></head>`
    + `<body><div class="c"><h1>⚠️ ${esc(title)}</h1><p>${esc(detail)}</p></div></body></html>`;
}
