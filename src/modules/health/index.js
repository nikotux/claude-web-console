// modules/health/index.js — salud del sistema: chequeos rápidos + revisión IA.
//
// Dos niveles:
//   1. CHEQUEOS RÁPIDOS (gratis, en vivo): systemd/KillMode, tmux, runners,
//      observador, cert, git, sintaxis de TODO el código, disco, datos.
//      GET /api/health/checks
//   2. REVISIÓN PROFUNDA con Claude (SDK headless, READ-ONLY blindado como
//      tickets, CONSUME TOKENS → solo bajo demanda y admin-gated): lee
//      CLAUDE.md + el código y devuelve veredicto con hallazgos. Caché en
//      ~/.cwc-data/health.json.
//      GET /api/health/review · POST /api/health/review (admin)
import express from 'express';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { isAdmin } from '../../core/auth.js';
import {
  readReview, writeReview, isRunning, isFixing, writeFixLock, findingId, findingSig, readSolved,
  writeLock, clearLock,
  markFindingResolved,
  readDismissed, recordDismissed, removeDismissed,
  readProposals, writeProposals,
  readBatch, writeBatch, writeBatchLock, clearBatchLock, isBatchRunning,
  collectActiveRunners,
} from './shared.js';
import { appendLearnedInvariant } from './invariants.js';
import { classifyFinding } from './policy.js';
import { aiEnginesCensus, generateInventory, coherenceCensus } from '../../core/inventory.js';
import { systemSnapshot } from '../stats/index.js';
import { verifySync as verifyTolkienContextSync } from '../tickets/context-store.js';
import * as padLocal from '../../core/pad-service-client.js';
import {
  readOpt, writeOpt, isOptRunning, readOptLock, writeOptLock, OPT_LOG,
} from './optimize-shared.js';
import {
  readCoh, writeCoh, isCohRunning, readCohLock, writeCohLock, COH_LOG, evaluateCoherence,
} from './coherence-shared.js';
import {
  readScan, writeScan, scanStatus, isScanRunning, writeScanLock, clearScanLock,
  spawnScanRunner, createBugFromFinding,
} from './scan-shared.js';
import { createTaskFromProposal } from './pad-writeback-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del proyecto
const DATA_DIR = path.join(os.homedir(), '.cwc-data');

const run = (file, args, opts = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout: 15000, ...opts }, (err, out, errOut) => {
    resolve({ err, out: (out || '').trim(), errOut: (errOut || '').trim() });
  });
});

// ===== chequeos rápidos =====
// Cada check devuelve { id, label, status: ok|warn|fail, detail }.

async function checkSystemd() {
  const active = await run('systemctl', ['--user', 'is-active', 'claude-web-console']);
  const km = await run('systemctl', ['--user', 'show', 'claude-web-console', '-p', 'KillMode', '--value']);
  if (active.out !== 'active') {
    return { id: 'systemd', label: 'Servicio systemd', status: 'warn', detail: `unidad ${active.out || 'desconocida'} — el server corre fuera de systemd` };
  }
  if (km.out !== 'process') {
    return { id: 'systemd', label: 'Servicio systemd', status: 'fail', detail: `KillMode=${km.out || '?'} — DEBE ser process (si no, un restart mata tmux y runners)` };
  }
  return { id: 'systemd', label: 'Servicio systemd', status: 'ok', detail: 'activo · KillMode=process' };
}

async function checkTmux() {
  const r = await run('tmux', ['-L', config.tmuxSocket, 'list-sessions', '-F', '#{session_name}']);
  if (r.err) return { id: 'tmux', label: 'Servidor tmux (cwc)', status: 'ok', detail: 'sin sesiones (el server tmux arranca con la primera)' };
  const names = r.out.split('\n').filter(Boolean);
  const term = names.filter((n) => n.startsWith('cwc-')).length;
  const tui = names.filter((n) => n.startsWith('cwct-')).length;
  const otras = names.length - term - tui;
  return { id: 'tmux', label: 'Servidor tmux (cwc)', status: 'ok', detail: `${term} terminal(es) · ${tui} TUI(s) de chat${otras ? ` · ${otras} ajena(s)` : ''}` };
}

function checkRunners() {
  let socks = [];
  try { socks = fss.readdirSync(path.join(DATA_DIR, 'chats')).filter((f) => f.endsWith('.sock')); } catch { /* sin dir */ }
  return { id: 'runners', label: 'Runners de chat', status: 'ok', detail: socks.length ? `${socks.length} motor(es) vivo(s)` : 'ninguno corriendo (normal si no hay chats activos)' };
}

function checkObserver() {
  try {
    const s = fss.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    if (s.includes('cwc-observe.js')) return { id: 'observer', label: 'Observador de Claude Code', status: 'ok', detail: 'hooks instalados en ~/.claude/settings.json' };
    return { id: 'observer', label: 'Observador de Claude Code', status: 'warn', detail: 'no instalado — el estado de sesiones usa el fallback por transcript (bin/install-observer.js)' };
  } catch {
    return { id: 'observer', label: 'Observador de Claude Code', status: 'warn', detail: 'no pude leer ~/.claude/settings.json' };
  }
}

function checkCert() {
  try {
    const st = fss.statSync(path.join(ROOT, 'certs', 'cert.pem'));
    const days = Math.round((Date.now() - st.mtimeMs) / 86400000);
    return { id: 'cert', label: 'Certificado TLS', status: 'ok', detail: `generado hace ${days} día(s) (se regenera solo si cambia la IP)` };
  } catch {
    return { id: 'cert', label: 'Certificado TLS', status: 'warn', detail: 'certs/cert.pem no existe todavía (se genera al arrancar)' };
  }
}

async function checkGit() {
  const branch = await run('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.err) return { id: 'git', label: 'Git', status: 'warn', detail: 'el proyecto no es un repo git' };
  const sha = await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']);
  const dirty = await run('git', ['-C', ROOT, 'status', '--porcelain']);
  const n = dirty.out ? dirty.out.split('\n').length : 0;
  return {
    id: 'git', label: 'Git', status: n ? 'warn' : 'ok',
    detail: `${branch.out} @ ${sha.out}${n ? ` · ${n} cambio(s) sin commitear` : ' · limpio'}`,
  };
}

// Sintaxis de TODO el código propio (src/, bin/, public/js/): node --check
// respeta el type:module del package.json. Concurrencia limitada.
async function checkSyntax() {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fss.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  for (const d of ['src', 'bin', path.join('public', 'js')]) walk(path.join(ROOT, d));
  const bad = [];
  const POOL = 8;
  for (let i = 0; i < files.length; i += POOL) {
    await Promise.all(files.slice(i, i + POOL).map(async (f) => {
      const r = await run(process.execPath, ['--check', f]);
      if (r.err) bad.push(path.relative(ROOT, f));
    }));
  }
  if (bad.length) return { id: 'syntax', label: 'Sintaxis del código', status: 'fail', detail: `errores en: ${bad.join(', ')}` };
  return { id: 'syntax', label: 'Sintaxis del código', status: 'ok', detail: `${files.length} archivos verificados` };
}

async function checkDisk() {
  const r = await run('df', ['--output=pcent,avail', '-h', os.homedir()]);
  const line = r.out.split('\n')[1] || '';
  const [pcent, avail] = line.trim().split(/\s+/);
  const used = parseInt(pcent, 10);
  if (Number.isFinite(used) && used >= 90) return { id: 'disk', label: 'Disco', status: 'warn', detail: `${pcent} usado · ${avail} libre` };
  return { id: 'disk', label: 'Disco', status: 'ok', detail: line ? `${pcent} usado · ${avail} libre` : 'no pude leer df' };
}

function checkData() {
  const parts = [];
  try { parts.push(`${fss.readdirSync(path.join(os.homedir(), '.cwc-backups')).filter((f) => f.endsWith('.tar.gz')).length} backup(s)`); } catch { parts.push('0 backups'); }
  try {
    const chats = JSON.parse(fss.readFileSync(path.join(DATA_DIR, 'chats.json'), 'utf8'));
    parts.push(`${chats.length} conversación(es) persistida(s)`);
  } catch { parts.push('sin chats persistidos'); }
  return { id: 'data', label: 'Datos de runtime (~/.cwc-*)', status: 'ok', detail: parts.join(' · ') };
}

function checkDeps() {
  try {
    fss.accessSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'));
    return { id: 'deps', label: 'Dependencias', status: 'ok', detail: 'node_modules completo (Agent SDK presente)' };
  } catch {
    return { id: 'deps', label: 'Dependencias', status: 'fail', detail: 'falta el Agent SDK — correr npm install' };
  }
}

function checkServer() {
  const up = Math.round(process.uptime());
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const h = Math.floor(up / 3600); const m = Math.floor((up % 3600) / 60);
  return { id: 'server', label: 'Proceso del server', status: 'ok', detail: `node ${process.version} · pid ${process.pid} · up ${h}h ${m}m · ${mem} MB RSS` };
}

// El subset work+pr de "Tickets & Features" se espeja a ~/tolkien/
// CLAUDE.local.md (auto-carga en TODA sesión de Tolkien). Este check avisa si
// el espejo quedó viejo/ausente frente al master de la consola.
function checkTolkienContextSync() {
  const id = 'tolkien-context';
  const label = 'Contexto de Tolkien sincronizado';
  const s = verifyTolkienContextSync();
  if (s.status === 'ok') return { id, label, status: 'ok', detail: 'CLAUDE.local.md al día con el contexto de Tickets & Features' };
  if (s.status === 'stale') return { id, label, status: 'warn', detail: 'el espejo en CLAUDE.local.md quedó desactualizado — re-sincronizá desde Proyectos → Tickets & Features' };
  if (s.status === 'missing') return { id, label, status: 'warn', detail: 'falta la sección gestionada en CLAUDE.local.md — guardá/re-sincronizá el contexto para regenerarla' };
  return { id, label, status: 'warn', detail: 'no pude leer ~/tolkien/CLAUDE.local.md (¿Tolkien presente?)' };
}

// F7 (PLAN-373/PEND-466) — AUDIT de CRUCES ENTRE MUNDOS. GRANDFATHER de los
// cruces LEGÍTIMOS conocidos (los que hoy tocan el mundo externo Tolkien —
// mapeados en DOC-468) + DETECCIÓN de cualquier cruce NUEVO: un archivo que
// referencia el mundo externo (`config.projectDir` / `CLAUDE.local.md`) y NO está
// en el allowlist. Determinístico, 0 tokens, READ-ONLY: NO bloquea nada en
// runtime (los caños viejos siguen andando exactamente igual — apagarlos rompería
// comms/tickets/retro). Es la forma SEGURA de "un solo canal": lo viejo se
// grandfatherea, lo NUEVO se AVISA para que pase por el paquete-sesión (el canal
// canónico) o se sume acá con motivo explícito. Migrar los caños viejos al paquete
// es un proyecto per-caño aparte, no un hachazo.
const CROSS_WORLD_ALLOW = new Set([
  'src/core/bus.js',                       // interfono: etiqueta el MUNDO de una sesión por su cwd (PLAN-469), no cruza datos
  'src/modules/chat/index.js',             // EL canal del paquete-sesión (handoff/worldLabelFor) — canónico
  'src/modules/tickets/context-store.js',  // syncToTolkien → CLAUDE.local.md
  'src/modules/tickets/index.js',
  'src/modules/tickets/desk-mcp-client.js',
  'src/modules/retro/promote-shared.js',   // promueve lecciones a memoria/claude-md de Tolkien
  'src/modules/projects/index.js',         // edita CLAUDE.md/memorias de ambos proyectos
  'src/modules/comms/gateway-shared.js',
  'src/modules/comms/pr-read-shared.js',
  'src/modules/learning/explain-shared.js', // scope=tolkien lee código de Tolkien
  'src/modules/tolkien/index.js',
  'src/modules/tolkien/refresh-shared.js',
  'src/modules/skills/index.js',           // censo READ-ONLY de .claude/skills/ de Tolkien (pestaña Skills), no cruza datos
  'src/modules/mcps/login-shared.js',      // censo/estado READ-ONLY de MCP de Tolkien (pestaña Conexiones) + login OAuth guiado (claude mcp, vía CLI); no enlaza los Pad ni cruza datos
  'src/core/workspace-provision.js',       // clon read-only del repo de Tolkien por-inquilino (decisión 🆕1 de PLAN-500) — provisiona un checkout, no enlaza los Pad
  'src/modules/seguimientos/index.js',     // dashboard LIMBO (Regla dura #13 / PLAN-553): config.projectDir = cwd de la sesión-Limbo; aduana read-only + escritura solo a tickets con OK — no enlaza los Pad
  'src/modules/health/index.js',           // este audit + checkTolkienContextSync
  'bin/cwc-comms-runner.js',
  'bin/cwc-comms-chatbot-runner.js',
  'bin/cwc-comms-send-runner.js',
  'bin/cwc-comms-teams-runner.js',
  'bin/cwc-retro-email-runner.js',          // "Feedback de Chris" (retro): lee correo vía el MISMO MCP de Graph de Tolkien que ya usa Teams (allowlist read-only propia), no enlaza los Pad
  'bin/cwc-retro-teams-runner.js',          // "Feedback de Chris" (retro): lee el DM de Teams con Chris, mismo MCP/allowlist que el escaneo de Teams de Comunicaciones, no enlaza los Pad
]);
const CROSS_WORLD_RE = /config\.projectDir|CLAUDE\.local\.md/;
function checkCrossWorld() {
  const id = 'cross-world';
  const label = 'Cruces entre mundos (F7)';
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fss.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, p).split(path.sep).join('/');
      if (CROSS_WORLD_ALLOW.has(rel)) continue;
      let src = '';
      try { src = fss.readFileSync(p, 'utf8'); } catch { continue; }
      if (CROSS_WORLD_RE.test(src)) found.push(rel);
    }
  };
  for (const d of ['src', 'bin']) walk(path.join(ROOT, d));
  if (found.length) {
    return { id, label, status: 'warn', detail: `cruce cross-mundo NUEVO fuera del paquete en: ${found.join(', ')} — pasalo por el paquete-sesión (canal canónico) o, si es legítimo, sumalo al allowlist con motivo` };
  }
  return { id, label, status: 'ok', detail: `${CROSS_WORLD_ALLOW.size} cruces conocidos (grandfathered) · sin cruces nuevos fuera del paquete` };
}

// Verifica el BACKBONE de Pad local (workspace `console`): hoy tasks/learning/
// retro/tickets-meta hablan contra él y si se cae DEGRADAN EN SILENCIO — este
// check lo hace visible en el semáforo. Además vigila que el ESPEJO de la Regla
// dura #12 (anti-colisión entre mundos) siga presente en las Conventions de Pad:
// señal concreta y automática de que CLAUDE.md y Pad no divergieron (Gap #3,
// TASK-296). Todo read-only por HTTP plano (NO MCP, no toca el blindaje regla 6),
// 0 tokens, best-effort — si Pad no responde, degrada a warn, nunca tira.
async function checkPadBackbone() {
  const id = 'pad-backbone';
  const label = 'Pad local (backbone console)';
  // OJO: el REST del Pad local devuelve `fields` como STRING JSON (no objeto,
  // a diferencia del MCP) — hay que parsearlo antes de leer priority/status.
  const field = (it, k) => {
    let f = it?.fields;
    if (typeof f === 'string') { try { f = JSON.parse(f); } catch { f = {}; } }
    return f?.[k] ?? it?.[k];
  };
  const r = await padLocal.listItems('conventions', { workspace: 'console' });
  if (!r.ok) {
    return { id, label, status: 'warn', detail: `Pad local no responde (${r.error || 'sin detalle'}) — tasks/learning/retro/tickets-meta degradan a best-effort. ¿pad-local.service arriba?` };
  }
  const items = Array.isArray(r.data) ? r.data : [];
  const musts = items.filter((c) => field(c, 'priority') === 'must' && field(c, 'status') !== 'disabled');
  const hasAnticollision = items.some((c) => {
    const t = `${c?.title || ''} ${c?.content || ''}`.toLowerCase();
    return /anti-?colisi[oó]n|plan-puente|regla dura #12|regla #12/.test(t);
  });
  if (!hasAnticollision) {
    return { id, label, status: 'warn', detail: 'Pad local OK pero FALTA en las Conventions el espejo de la Regla dura #12 (anti-colisión entre mundos) — CLAUDE.md y Pad divergieron; recrear la convención' };
  }
  return { id, label, status: 'ok', detail: `Pad local OK · ${musts.length} convención(es) must · espejo Regla #12 presente` };
}

// Estado del BACKBONE de Pad local para el Dashboard del proyecto (Gap #5,
// 2026-07-12): 1 sola llamada HTTP (listCollections trae active_item_count +
// item_count por colección), 0 tokens, best-effort. Da la foto del TRACKER
// (bugs/roads/tasks/planes/temas vivos) para verla junto al censo del CÓDIGO.
async function padBackboneStats() {
  try {
    const r = await padLocal.listCollections('console');
    if (!r.ok || !Array.isArray(r.data)) return { ok: false, error: r.error || 'sin datos' };
    const cols = r.data.map((c) => ({
      slug: c.slug, name: c.name, icon: c.icon,
      active: c.active_item_count ?? 0, total: c.item_count ?? 0,
    }));
    const totals = cols.reduce((a, c) => ({ active: a.active + c.active, total: a.total + c.total }), { active: 0, total: 0 });
    return { ok: true, workspace: 'console', collections: cols, totals };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}

async function runChecks() {
  const checks = await Promise.all([
    Promise.resolve(checkServer()),
    checkSystemd(),
    checkTmux(),
    Promise.resolve(checkRunners()),
    Promise.resolve(checkObserver()),
    Promise.resolve(checkCert()),
    checkGit(),
    checkSyntax(),
    checkDisk(),
    Promise.resolve(checkData()),
    Promise.resolve(checkDeps()),
    Promise.resolve(checkTolkienContextSync()),
    Promise.resolve(checkCrossWorld()),
    checkPadBackbone(),
  ]);
  const count = (s) => checks.filter((c) => c.status === s).length;
  return { checkedAt: Date.now(), ok: count('ok'), warn: count('warn'), fail: count('fail'), checks };
}

// ===== revisión EXHAUSTIVA con Claude (runner desacoplado, READ-ONLY) =====
// La corrida ya NO vive en este proceso: la hace bin/cwc-health-runner.js
// (barrido módulo por módulo con haiku + síntesis con sonnet, ver
// health/shared.js). Un reinicio del server a mitad NO la mata (regla 2).
// Interfaz por archivos: health-review.json (progreso+resultado) +
// health-review.lock (heartbeat => running). Los endpoints solo lanzan el
// runner y sirven su estado.
const HEALTH_RUNNER = path.join(ROOT, 'bin', 'cwc-health-runner.js');
const HEALTH_LOG = path.join(DATA_DIR, 'health-review.log');
const HEALTHFIX_RUNNER = path.join(ROOT, 'bin', 'cwc-healthfix-runner.js');
const HEALTHFIX_LOG = path.join(DATA_DIR, 'healthfix.log');

function spawnReview(full) {
  if (isRunning()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // Placeholder de lock SINCRÓNICO (mismo turno JS que isRunning(), sin await de
  // por medio): cierra la ventana TOCTOU por la que dos POST /review casi
  // simultáneos spawneaban dos runners que se pisaban review.json (BUG-48). El
  // runner pisa el pid:0 con su pid real al arrancar; readLock() le hace reconocer
  // el placeholder como reserva propia y NO suicidarse (ver cwc-health-runner.js).
  writeLock(0);
  const logFd = fss.openSync(HEALTH_LOG, 'a');
  const args = [HEALTH_RUNNER];
  if (full) args.push('--full'); // ignora la caché → re-audita TODO
  const child = spawn(process.execPath, args, {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.on('error', () => { try { clearLock(); } catch { /* noop */ } }); // spawn falló → liberar la reserva
  child.unref();
  fss.closeSync(logFd);
  return true;
}

// Lanza el runner de auto-fix (resolución autónoma) para UN hallazgo (por id).
// El runner (proceso hijo, bin/cwc-healthfix-runner.js) recién escribe SU lock
// al arrancar — y arrancar tarda (fork+exec, init de Node, carga de módulos).
// Si dos requests llegan casi juntos, ambos podrían pasar el isFixing() del
// endpoint ANTES de que el primer hijo alcance a escribir su lock (TOCTOU) →
// dos runners concurrentes, el segundo pisando el lock del primero. Por eso
// el chequeo+escritura del lock se hace ACÁ, sincrónico, en el mismo turno de
// JS que decide spawnear (Node es single-threaded y esta función no tiene
// ningún `await` de por medio, así que ninguna otra request puede intercalarse
// entre el chequeo y la escritura): cierra la ventana de carrera sin depender
// de que el hijo llegue a tiempo. Devuelve false si ya había una revisión o un
// auto-fix en curso (no spawnea nada en ese caso).
function spawnFix(findingIdArg, tandem = false) {
  if (isRunning() || isFixing()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFixLock(0); // placeholder inmediato; el runner lo pisa con su pid real al arrancar (heartbeat)
  const logFd = fss.openSync(HEALTHFIX_LOG, 'a');
  const args = [HEALTHFIX_RUNNER, findingIdArg];
  if (tandem) args.push('--tandem'); // opt-in (2026-07-19): Codex ejecuta, Claude verifica
  const child = spawn(process.execPath, args, {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.on('error', () => { try { clearFixLock(); } catch { /* noop */ } }); // spawn falló → liberar la reserva ya (BUG-44), no esperar los 20s
  child.unref();
  fss.closeSync(logFd);
  return true;
}

// Lanza el ORQUESTADOR de batch (Fase B): resuelve varios hallazgos en paralelo
// aislado + integración serial. Estado en healthfix-batch.json (lo escribe el
// endpoint antes de spawnear). Lock atómico como spawnFix (cierra la carrera
// sin depender de que el hijo llegue a escribir su lock).
const ORCHESTRATOR = path.join(ROOT, 'bin', 'cwc-healthfix-orchestrator.js');
const ORCH_LOG = path.join(DATA_DIR, 'healthfix-batch.log');
function spawnOrchestrator() {
  if (isRunning() || isFixing() || isBatchRunning()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeBatchLock(0); // placeholder; el runner lo pisa con su pid real (heartbeat)
  const logFd = fss.openSync(ORCH_LOG, 'a');
  const child = spawn(process.execPath, [ORCHESTRATOR], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.on('error', () => { try { clearBatchLock(); } catch { /* noop */ } }); // spawn falló → liberar la reserva (BUG-44)
  child.unref();
  fss.closeSync(logFd);
  return true;
}

// Lanza el runner de OPTIMIZACIÓN IA (bin/cwc-optimize-runner.js): censo de
// motores + consumo real + análisis con sonnet → propuestas. Mismo cierre de
// carrera que spawnFix: la RESERVA del lock (pid:0) se escribe acá, sincrónica,
// en el mismo turno de JS que decide spawnear; el runner la reclama con su pid.
const OPT_RUNNER = path.join(ROOT, 'bin', 'cwc-optimize-runner.js');
function spawnOptimize() {
  if (isOptRunning()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeOptLock({ pid: 0, phase: 'arrancando…' }); // reserva; el runner la pisa con su pid real
  const logFd = fss.openSync(OPT_LOG, 'a');
  const child = spawn(process.execPath, [OPT_RUNNER], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  fss.closeSync(logFd);
  return true;
}

// Lanza el runner del MÓDULO DE COHERENCIA (bin/cwc-coherence-runner.js): grafo
// de dependencias + hallazgos de cableado + análisis con sonnet → propuestas.
// Mismo cierre de carrera que spawnOptimize (reserva pid:0 sincrónica).
const COH_RUNNER = path.join(ROOT, 'bin', 'cwc-coherence-runner.js');
function spawnCoherence() {
  if (isCohRunning()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeCohLock({ pid: 0, phase: 'arrancando…' }); // reserva; el runner la pisa con su pid real
  const logFd = fss.openSync(COH_LOG, 'a');
  const child = spawn(process.execPath, [COH_RUNNER], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  fss.closeSync(logFd);
  return true;
}

// Enriquece los hallazgos de review.json con id/sig (derivados del contenido) y
// la marca de RECURRENCIA: el hallazgo coincide (por firma) con algo que YA se
// había resuelto ANTES de arrancar esta revisión → volvió a aparecer.
function enrichReview(state) {
  const startedAt = state.startedAt || 0;
  const solvedBySig = new Map(readSolved().map((e) => [e.sig, e]));
  const dismissedBySig = new Map(readDismissed().map((e) => [e.sig, e]));
  const findings = (state.findings || []).map((f) => {
    const sig = findingSig(f);
    const solved = solvedBySig.get(sig);
    const recurrent = solved && solved.firstResolvedAt < startedAt
      ? { times: solved.count, firstResolvedAt: solved.firstResolvedAt }
      : null;
    // FALSO POSITIVO conocido: si la firma está en el registro durable y el
    // hallazgo no está ya resuelto, se marca dismissed → sale de la cola "por
    // resolver" aunque el motor lo haya vuelto a reportar (corta el bucle).
    const known = dismissedBySig.get(sig);
    const dismiss = known && f.fixStatus !== 'resolved'
      ? { fixStatus: 'dismissed', knownFalsePositive: true, dismissReason: f.dismissReason || known.reason || '' }
      : null;
    // Política de riesgo (Fase A): el front bloquea "Automático" en los críticos.
    return { ...f, ...dismiss, id: findingId(f), sig, recurrent, policy: classifyFinding(f) };
  });
  // VEREDICTO EN VIVO (0 tokens, determinístico): el `verdict` de state es una
  // FOTO de la síntesis (sonnet) al terminar la revisión y NUNCA se recalcula;
  // a medida que se resuelven/descartan hallazgos, ese chip quedaba clavado en
  // CRÍTICO aunque ya no quedara nada abierto. Acá derivamos el veredicto REAL
  // desde los hallazgos ABIERTOS (ni resueltos ni descartados; los 'fixing'
  // cuentan como abiertos) usando el MISMO criterio que la síntesis y el
  // fallback del runner: critical/high ⇒ critico · medium ⇒ atencion · solo low
  // o vacío ⇒ ok. Solo se calcula si hubo una revisión (state.verdict presente).
  const open = findings.filter((f) => f.fixStatus !== 'resolved' && f.fixStatus !== 'dismissed');
  const resolvedCount = findings.length - open.length;
  let liveVerdict = null;
  if (state.verdict) {
    const sev = new Set(open.map((f) => String(f.severity)));
    liveVerdict = sev.has('critical') || sev.has('high') ? 'critico' : sev.has('medium') ? 'atencion' : 'ok';
  }
  return { ...state, findings, liveVerdict, openCount: open.length, resolvedCount };
}

export default {
  name: 'health',

  registerHttp(router) {
    const r = express.Router();

    // Chequeos rápidos, en vivo (cualquier usuario autenticado).
    r.get('/checks', async (req, res) => {
      try { res.json(await runChecks()); }
      catch (err) { res.status(500).json({ error: String(err?.message || err).slice(0, 300) }); }
    });

    // Censo del proyecto (módulos backend/frontend, runners, motores IA) +
    // recursos del servidor, gratis (0 tokens, sin LLM) — reusa
    // generateInventory() (core/inventory.js, caché por fingerprint/mtime, la
    // misma fuente que inventory.md) y systemSnapshot() (modules/stats, misma
    // fuente que el gauge del pie). El front lo muestra como resumen compacto
    // + botón "Ver dashboard completo →" (system/inventory-modal.js, censo con
    // detalle real: endpoints/registro por módulo backend, montaje por módulo
    // frontend, núcleos/CPU/RAM/disco) — así un módulo/motor NUEVO (p.ej.
    // comunicación entre sesiones) aparece solo, sin registrarlo a mano en
    // ningún lado salvo en registry.js, que sigue siendo obligatorio para que
    // el módulo CORRA (esto solo lo señala si falta con `unregistered`).
    // ?force=1 ignora el caché del inventario y re-escanea YA (botón
    // "refrescar" del front); sin el flag, sirve el caché si nada cambió.
    r.get('/scan', async (req, res) => {
      try {
        const { inventory, regenerated } = generateInventory({ force: req.query.force === '1' });
        const unregistered = inventory.modules.filter((m) => !m.registered).map((m) => m.name);
        let resources = null;
        try { resources = await systemSnapshot(); } catch { /* el dashboard igual muestra el resto */ }
        const pad = await padBackboneStats(); // backbone de Pad local (0 tokens, best-effort)
        res.json({
          generatedAt: inventory.generatedAt,
          regenerated,
          counts: inventory.counts,
          unregistered,
          resources,
          pad,
          modules: inventory.modules.map((m) => ({
            name: m.name,
            registered: m.registered,
            purpose: m.purpose,
            registryLine: m.registryLine,
            endpoints: m.endpoints,
            fileCount: m.files.length,
          })),
          frontend: inventory.frontend.map((f) => ({
            name: f.name, dir: f.dir, mounted: f.mounted, fileCount: f.files.length,
          })),
          runners: inventory.runners.map((rr) => ({ file: rr.file, purpose: rr.purpose })),
          aiEngines: inventory.aiEngines.map((e) => ({
            file: e.file, purpose: e.purpose, models: e.models, modelDynamic: e.modelDynamic,
          })),
        });
      } catch (err) { res.status(500).json({ error: String(err?.message || err).slice(0, 300) }); }
    });

    // Estado de la revisión: progreso + hallazgos (lo escribe el runner) +
    // si hay una corriendo (lock fresco). El front encuesta esto en vivo.
    r.get('/review', (req, res) => {
      res.json({ ...enrichReview(readReview()), running: isRunning(), fixing: isFixing() });
    });

    // Foto EN VIVO de los procesos/runners en segundo plano (panel de Actividad
    // en Segundo Plano). 0 tokens, solo lectura de locks/jobs en ~/.cwc-data. Los
    // SUBAGENTES (chats delegando) NO salen de acá: el front los toma de
    // /api/chat/list que ya encuesta. `dominantModel` = el modelo más frecuente
    // entre los procesos con modelo (para el semáforo). Abierto a autenticados.
    r.get('/active-runners', (req, res) => {
      const processes = collectActiveRunners();
      const counts = {};
      for (const p of processes) if (p.model) counts[p.model] = (counts[p.model] || 0) + 1;
      const dominantModel = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      res.json({ processes, processCount: processes.length, dominantModel });
    });

    // Registro DURABLE de bugs resueltos (historial + recurrencias). Abierto a
    // autenticados; es solo lectura de lo ya arreglado.
    r.get('/solved', (req, res) => {
      const solved = readSolved().sort((a, b) => (b.lastResolvedAt || 0) - (a.lastResolvedAt || 0));
      res.json({ solved });
    });

    // Restaurar un FALSO POSITIVO: lo saca del registro durable y limpia su
    // fixStatus en review.json → vuelve a la cola "por resolver" (por si se
    // descartó mal). Admin: reactiva un hallazgo que se auto-resolvería.
    r.post('/dismiss-restore', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      const state = readReview();
      const f = (state.findings || []).find((x) => findingId(x) === id);
      if (!f) return res.status(404).json({ error: 'Hallazgo inexistente.' });
      removeDismissed(findingSig(f));
      if (f.fixStatus === 'dismissed') {
        delete f.fixStatus; delete f.dismissReason; delete f.dismissedAt;
        state.updatedAt = Date.now(); writeReview(state);
      }
      res.json({ ok: true });
    });

    // Invariantes PROPUESTOS por el auto-fix, PENDIENTES de aprobación (Fase 5).
    r.get('/invariant-proposals', (req, res) => {
      res.json({ proposals: readProposals().filter((p) => p.status !== 'done') });
    });
    // Aprobar (→ invariants-learned.json, se verifica el regex) o descartar.
    r.post('/invariant-proposals/:id', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.params.id || '');
      const action = req.body?.action;
      const list = readProposals();
      const p = list.find((x) => x.id === id);
      if (!p) return res.status(404).json({ error: 'Propuesta inexistente.' });
      if (action === 'approve') {
        try {
          appendLearnedInvariant({ match: p.match || (p.fromFinding?.file || '').split(':')[0], text: p.text });
        } catch (err) {
          return res.status(400).json({ error: `No se pudo aprobar: ${String(err?.message || err).slice(0, 160)}` });
        }
      } else if (action !== 'reject') {
        return res.status(400).json({ error: 'Acción inválida (approve|reject).' });
      }
      writeProposals(list.filter((x) => x.id !== id));
      res.json({ ok: true });
    });

    // Resolución AUTÓNOMA de un hallazgo (runner detached; excepción de
    // escritura de la regla 6, ver bin/cwc-healthfix-runner.js). Responde
    // inmediato; el front polea GET /review y ve fixStatus fixing→resolved|failed.
    r.post('/finding-fix', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      if (!id) return res.status(400).json({ error: 'Falta el id del hallazgo.' });
      if (isRunning()) return res.status(409).json({ error: 'Hay una revisión en curso; esperá a que termine.' });
      if (isFixing()) return res.status(409).json({ error: 'Ya hay una resolución automática en curso (una a la vez).' });
      const state = readReview();
      const target = (state.findings || []).find((f) => findingId(f) === id);
      if (!target) return res.status(404).json({ error: 'Hallazgo inexistente (¿se re-analizó?).' });
      // GATE de política (defensa en profundidad; el front ya deshabilita el
      // botón, pero acá está la guarda REAL). Bloquea por SUPERFICIE crítica
      // (pol.risk: toca server/auth/registry/…) O por SEVERIDAD crítica del bug
      // (decisión del usuario 2026-07-04: un bug crítico es delicado, su fix
      // probablemente sutil → siempre a chat supervisado, toque el archivo que
      // toque). Antes solo miraba pol.risk → un severity=critical en archivo
      // común se auto-resolvía sin supervisión.
      const pol = classifyFinding(target);
      if (pol.risk === 'critical' || String(target.severity) === 'critical') {
        const why = pol.risk === 'critical' ? pol.reason : 'severidad crítica del bug (fix delicado)';
        return res.status(409).json({ error: `No se auto-resuelve (${why}): resolvelo en chat, supervisado.` });
      }
      try {
        // spawnFix() re-chequea y escribe el lock atómicamente (mismo turno de
        // JS, sin await de por medio): es la guarda REAL contra la carrera; el
        // isFixing() de arriba es solo un short-circuit rápido para el caso
        // común (evita el mkdir/spawn si ya sabemos que hay uno corriendo).
        // `tandem` (opt-in, 2026-07-19): el toggle del front — Claude verifica,
        // Codex escribe el diff (bin/cwc-healthfix-runner.js --tandem).
        if (!spawnFix(id, req.body?.tandem === true)) {
          return res.status(409).json({ error: 'Ya hay una resolución automática en curso (una a la vez).' });
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: `No se pudo lanzar el auto-fix: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    // Marca un hallazgo como RESUELTO manualmente (botón "Marcar resuelto" del
    // modal, red de seguridad del camino "En chat"). Misma lógica que el runner
    // mini bin/cwc-health-resolve.js: escribe fixStatus:'resolved' en review.json
    // + recordSolved. NO edita código ni corre nada — solo marca el estado.
    r.post('/finding-resolve', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      if (!id) return res.status(400).json({ error: 'Falta el id del hallazgo.' });
      const summary = String(req.body?.summary || 'Marcado como resuelto manualmente.').slice(0, 400);
      const f = markFindingResolved(id, summary);
      if (!f) return res.status(404).json({ error: 'Hallazgo inexistente (¿se re-analizó?).' });
      res.json({ ok: true });
    });

    // Estado del BATCH de resolución (Fase B). El front lo polea; sobrevive al
    // reinicio de la web (runner desacoplado + archivo).
    r.get('/batch', (req, res) => {
      res.json({ batch: readBatch(), running: isBatchRunning() });
    });

    // Lanza el ORQUESTADOR sobre un batch de hallazgos (paralelo aislado +
    // integración serial). Excluye los CRÍTICOS (gate de política, defensa real).
    r.post('/finding-fix-batch', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      if (!ids.length) return res.status(400).json({ error: 'Faltan ids de hallazgos.' });
      if (isRunning()) return res.status(409).json({ error: 'Hay una revisión en curso; esperá a que termine.' });
      if (isFixing() || isBatchRunning()) return res.status(409).json({ error: 'Ya hay una resolución en curso.' });
      const state = readReview();
      const byId = new Map((state.findings || []).map((f) => [findingId(f), f]));
      const dismissedSigs = new Set(readDismissed().map((e) => e.sig));
      const items = [];
      const rejected = [];
      for (const id of ids) {
        const f = byId.get(id);
        if (!f) continue;
        // FALSO POSITIVO conocido: nunca se re-encola (defensa en profundidad,
        // aunque el front ya lo excluye de "activos").
        if (dismissedSigs.has(findingSig(f))) {
          rejected.push({ id, area: f.area, reason: 'falso positivo ya descartado' });
          continue;
        }
        // Mismo gate que el auto-fix de a uno: superficie crítica O severidad
        // crítica quedan FUERA del batch (no se auto-resuelven).
        const pol = classifyFinding(f);
        if (pol.risk === 'critical' || String(f.severity) === 'critical') {
          rejected.push({ id, area: f.area, reason: pol.risk === 'critical' ? pol.reason : 'severidad crítica del bug' });
          continue;
        }
        items.push({
          id, area: f.area, module: f.module, file: f.file, detail: f.detail,
          suggestedFix: f.suggestedFix, severity: f.severity, kind: f.kind,
          policy: pol, status: 'pending',
        });
      }
      if (!items.length) return res.status(400).json({ error: 'Ningún hallazgo elegible (¿todos críticos?).', rejected });
      writeBatch({ startedAt: Date.now(), updatedAt: Date.now(), running: true, phase: 'arrancando…', done: 0, total: items.length, items, rejected });
      try {
        if (!spawnOrchestrator()) {
          return res.status(409).json({ error: 'Ya hay una resolución en curso.' });
        }
        res.json({ ok: true, queued: items.length, rejected });
      } catch (err) {
        res.status(500).json({ error: `No se pudo lanzar el orquestador: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    // ===== Optimización IA (censo de motores + análisis con propuestas) =====
    // CENSO determinístico (0 tokens, en vivo): qué modelo/turnos/blindaje usa
    // cada corrida del SDK. Abierto a autenticados (solo lee el repo con regex).
    r.get('/ai-census', (req, res) => {
      try { res.json({ generatedAt: Date.now(), engines: aiEnginesCensus() }); }
      catch (err) { res.status(500).json({ error: String(err?.message || err).slice(0, 300) }); }
    });

    // Estado del análisis: resultado persistido (lo escribe el runner) + si hay
    // uno corriendo (lock fresco, con fase). El front encuesta esto. 0 tokens.
    r.get('/optimization', (req, res) => {
      res.json({ ...readOpt(), running: isOptRunning(), progress: readOptLock() });
    });

    // Lanza el análisis (runner detached, CONSUME TOKENS → admin + confirm en
    // el front). Responde INMEDIATO (arrancar+encuestar, patrón triage/health).
    r.post('/optimize', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      if (isOptRunning()) return res.status(409).json({ error: 'Ya hay un análisis de optimización en curso.' });
      try {
        if (!spawnOptimize()) return res.status(409).json({ error: 'Ya hay un análisis de optimización en curso.' });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: `No se pudo lanzar el análisis: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    // Decisión sobre UNA propuesta: accept (el front abre el chat supervisado
    // que la aplica) o reject. NUNCA se aplica CÓDIGO desde acá — solo se marca.
    // PAD WRITE-BACK (2026-07-19): al aceptar, se crea la TAREA en Pad
    // (`pendientes`, best-effort — si Pad no responde la aprobación sigue
    // igual, solo sin padRef) para que el circuito de seguimiento se cierre sin
    // depender de que alguien se acuerde de registrarla a mano.
    r.post('/optimize-proposal', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      const action = req.body?.action;
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Acción inválida (accept|reject).' });
      const st = readOpt();
      const p = (st.propuestas || []).find((x) => x.id === id);
      if (!p) return res.status(404).json({ error: 'Propuesta inexistente (¿se re-analizó?).' });
      p.status = action === 'accept' ? 'accepted' : 'rejected';
      p.decidedAt = Date.now();
      let padRef = null;
      if (action === 'accept') {
        try { padRef = await createTaskFromProposal(p, 'optimize'); p.padRef = padRef; }
        catch (err) { console.error('[health] no pude crear tarea en Pad (optimize):', err?.message); }
      }
      writeOpt(st);
      res.json({ ok: true, padRef });
    });

    // ===== Coherencia (grafo de dependencias + cableado entre motores) =====
    // CENSO determinístico (0 tokens, en vivo): grafo quién-usa-a-quién + uso de
    // los servicios transversales + hallazgos de cableado. Autenticados.
    r.get('/coherence-census', (req, res) => {
      try {
        const census = coherenceCensus();
        res.json({ generatedAt: Date.now(), census, findings: evaluateCoherence(census) });
      } catch (err) { res.status(500).json({ error: String(err?.message || err).slice(0, 300) }); }
    });

    // Estado del análisis IA: resultado persistido (lo escribe el runner) + si
    // hay uno corriendo (lock fresco, con fase). El front encuesta esto. 0 tokens.
    r.get('/coherence', (req, res) => {
      res.json({ ...readCoh(), running: isCohRunning(), progress: readCohLock() });
    });

    // Lanza el análisis (runner detached, CONSUME TOKENS → admin + confirm en el
    // front). Responde INMEDIATO (arrancar+encuestar, patrón optimize).
    r.post('/coherence', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      if (isCohRunning()) return res.status(409).json({ error: 'Ya hay un análisis de coherencia en curso.' });
      try {
        if (!spawnCoherence()) return res.status(409).json({ error: 'Ya hay un análisis de coherencia en curso.' });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: `No se pudo lanzar el análisis: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    // Decisión sobre UNA propuesta de coherencia: accept (el front abre el chat
    // supervisado que la aplica) o reject. NUNCA se aplica CÓDIGO desde acá.
    // PAD WRITE-BACK (2026-07-19, mismo patrón que optimize-proposal arriba).
    r.post('/coherence-proposal', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      const action = req.body?.action;
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Acción inválida (accept|reject).' });
      const st = readCoh();
      const p = (st.propuestas || []).find((x) => x.id === id);
      if (!p) return res.status(404).json({ error: 'Propuesta inexistente (¿se re-analizó?).' });
      p.status = action === 'accept' ? 'accepted' : 'rejected';
      p.decidedAt = Date.now();
      let padRef = null;
      if (action === 'accept') {
        try { padRef = await createTaskFromProposal(p, 'coherence'); p.padRef = padRef; }
        catch (err) { console.error('[health] no pude crear tarea en Pad (coherence):', err?.message); }
      }
      writeCoh(st);
      res.json({ ok: true, padRef });
    });

    // Lanza la revisión exhaustiva (runner detached, LENTA, consume tokens).
    // Responde INMEDIATO (arrancar+encuestar); el front encuesta GET /review.
    // Solo admin; el front confirma antes.
    r.post('/review', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        // full=true → re-audita TODO (ignora caché); default = INCREMENTAL
        // (solo lo que cambió por fingerprint). spawnReview devuelve false si
        // YA había una revisión corriendo.
        const started = spawnReview(req.body?.full === true);
        res.json({ ...readReview(), running: true, started });
      } catch (err) {
        res.status(500).json({ error: `No se pudo lanzar la revisión: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    // ===== ESCANEO DE SALUD UNIFICADO (2026-07-12) =====
    // Un solo botón: corre Revisión + Optimización + Coherencia bajo UN pool +
    // cross-check con Pad, en un orquestador desacoplado. Escribe los MISMOS
    // archivos de resultado (review/optimization/coherence.json) + el overlay
    // health-scan.json. Arrancar+encuestar (patrón /review).
    r.get('/scan-all', (req, res) => {
      res.json(scanStatus(readScan()));
    });
    r.post('/scan-all', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'El escaneo consume tokens (requiere administrador).' });
      if (isScanRunning()) return res.status(409).json({ error: 'Ya hay un escaneo de salud en curso.' });
      try {
        const mode = req.body?.full === true ? 'full' : 'incremental';
        // Reserva SINCRÓNICA del lock (pid:0) antes del spawn — cierra la ventana
        // TOCTOU (el runner la reclama con su pid, patrón BUG-48).
        writeScanLock(0);
        writeScan({ running: true, startedAt: Date.now(), updatedAt: Date.now(), mode, phase: 'arrancando', progress: null, pad: null, verdict: null, error: null });
        spawnScanRunner(mode);
        res.json({ ok: true, running: true, mode });
      } catch (err) {
        clearScanLock();
        res.status(500).json({ error: `No se pudo lanzar el escaneo: ${String(err?.message || err).slice(0, 200)}` });
      }
    });
    // Write-back: crear un BUG en Pad desde un hallazgo NUEVO confirmado (con OK
    // del humano en el front). 0 tokens (HTTP a Pad).
    r.post('/scan-pad-bug', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        const ref = await createBugFromFinding(req.body?.finding || {});
        res.json({ ok: true, ref });
      } catch (err) {
        res.status(502).json({ error: `No se pudo crear el BUG en Pad: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    router.use('/health', r);
  },
};
