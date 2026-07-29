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
import { isAdmin, principalOf } from '../../core/auth.js';
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
import { rulesStatus } from './finding-rules.js';
import { attemptStats } from '../../core/closed-envelope.js';
import { aiEnginesCensus, generateInventory, coherenceCensus } from '../../core/inventory.js';
import { systemSnapshot } from '../stats/index.js';
import { verifySync as verifyTolkienContextSync } from '../tickets/context-store.js';
import { listEnvs, ENVS_DIR } from '../tolkien/env-store.js';
import { listProvisionStates } from '../onboard/provision-state.js';
import { verifyEnvContext } from '../tolkien/env-shared.js';
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
import { getSites } from '../unifi/client.js';
import {
  collect as collectPadIndex,
  computeCeiling,
  DEFAULT_PROFILE as PAD_INDEX_PROFILE,
  renderIndex,
} from '../../core/pad-index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del proyecto
const DATA_DIR = path.join(os.homedir(), '.cwc-data');

// collectActiveRunners() conserva la forma pública histórica y no expone el
// owner ni el archivo que respalda cada fila. Para scopear sin tocar esa
// respuesta, recuperamos el owner del MISMO lock/job que el collector leyó.
const RUNNER_STATE_FILES = new Map([
  ['health-review', 'health-review.lock'],
  ['healthfix', 'healthfix.lock'],
  ['healthfix-batch', 'healthfix-batch.lock'],
  ['optimize', 'optimize.lock'],
  ['coherence', 'coherence.lock'],
  ['comms-scan', 'comms/comms.lock'],
  ['comms-teams', 'comms/teams.lock'],
  ['comms-chatbot', 'comms/chatbot.lock'],
  ['learning-analyze', 'learning-analysis.json'],
  ['tolkien-refresh', 'tolkien-refresh.json'],
  ['whatsapp', 'comms/whatsapp-daemon.json'],
  ['retro-curate', 'retro-curation.json'],
  ['health-scan', 'health-scan.lock'],
  ['desk', 'desk.lock'],
  ['investigate', 'investigate.lock'],
  ['ticket-investigate', 'ticket-investigate.lock'],
]);
const RUNNER_STATE_DIRS = new Map([
  ['tasks-analyze', ''],
  ['learning-explain', ''],
  ['learning-context', ''],
  ['commitmsg', 'commitmsg'],
  ['projects-analyze', 'projects-analyze'],
  ['audio', 'audio'],
  ['comms-analyze', 'comms/analyze'],
  ['ticket-context', 'ticket-context'],
  ['retro', 'retro'],
]);

function activeRunnerOwner(runner) {
  if (typeof runner?.owner === 'string' && runner.owner) return runner.owner;
  const key = String(runner?.key || '');
  const colon = key.indexOf(':');
  const family = colon === -1 ? key : key.slice(0, colon);
  let relative = RUNNER_STATE_FILES.get(family);
  if (!relative && colon !== -1 && RUNNER_STATE_DIRS.has(family)) {
    const basename = key.slice(colon + 1);
    if (!basename || path.basename(basename) !== basename) return null;
    relative = path.join(RUNNER_STATE_DIRS.get(family), `${basename}.json`);
  }
  if (!relative) return null;
  try {
    const state = JSON.parse(fss.readFileSync(path.join(DATA_DIR, relative), 'utf8'));
    return typeof state?.owner === 'string' && state.owner ? state.owner : null;
  } catch {
    return null;
  }
}

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

async function checkUnifiBridge() {
  const id = 'unifi-bridge';
  const label = 'Puente UniFi';
  try {
    if (!config.unifi?.host || !config.unifi?.apiKey) {
      return { id, label, status: 'skip', detail: 'puente UniFi no configurado' };
    }
    const sites = await getSites();
    return { id, label, status: 'ok', detail: `API responde · ${Array.isArray(sites) ? sites.length : 0} site(s)` };
  } catch (err) {
    return { id, label, status: 'warn', detail: `UniFi no responde (${String(err?.message || err).slice(0, 200)})` };
  }
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

// Módulos que legítimamente NO llevan ficha propia. Vacío desde 2026-07-26:
// `files`, `stats`, `tmux` y `admin` estaban acá por no tenerla y ya la tienen
// (F6 de PLAN-1940). Si algún día se agrega un nombre, documentar el motivo:
// una exclusión sin motivo es un punto ciego del chequeo.
const MODULES_WITHOUT_FICHA = new Set([]);

// Regla 14 / PLAN-1862: sin este check, un módulo nuevo puede nacer sin ficha
// CLAUDE.md y su contexto se pierde en silencio.
function checkFichasModulo() {
  const id = 'fichas-modulo';
  const label = 'Fichas de módulo (CLAUDE.md por carpeta)';
  const moduleDirs = fss.readdirSync(path.join(ROOT, 'src', 'modules'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !MODULES_WITHOUT_FICHA.has(name))
    .sort();
  const required = [
    ...moduleDirs.map((name) => path.join('src', 'modules', name, 'CLAUDE.md')),
    path.join('src', 'core', 'CLAUDE.md'),
    path.join('bin', 'CLAUDE.md'),
    path.join('public', 'CLAUDE.md'),
    path.join('public', 'js', 'ui', 'CLAUDE.md'),
    path.join('public', 'js', 'modules', 'CLAUDE.md'),
  ];
  const missing = required.filter((rel) => !fss.existsSync(path.join(ROOT, rel)))
    .map((rel) => rel.split(path.sep).join('/'));
  if (missing.length) {
    return {
      id,
      label,
      status: 'warn',
      detail: `faltan fichas: ${missing.join(', ')} · Regla 14: crear un módulo nuevo incluye crear su ficha`,
    };
  }
  return { id, label, status: 'ok', detail: `${required.length} fichas presentes` };
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
  'src/core/worlds.js',                    // fuente ÚNICA de worldLabelFor(cwd): etiqueta el MUNDO de un cwd comparando paths, no cruza datos (extraído de bus.js + chat/index.js, que tenían copias divergentes)
  'src/modules/health/invariants.js',      // solo TEXTOS de auditoría: la familia «Aduana — suelo neutral» NOMBRA config.projectDir para PROHIBIR que una sala lo use como cwd (Regla 16); no lee ni escribe nada de otro mundo
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
  'src/modules/mcps/infisical-shared.js',  // sonda de Infisical: corre el CLI con el cwd del proyecto externo y lee su .infisical.json (solo lectura, no cruza datos)
  'src/core/workspace-provision.js',       // clon read-only del repo de Tolkien por-inquilino (decisión 🆕1 de PLAN-500) — provisiona un checkout, no enlaza los Pad
  'src/modules/seguimientos/index.js',     // dashboard LIMBO (Regla dura #13 / PLAN-553): config.projectDir = cwd de la sesión-Limbo; aduana read-only + escritura solo a tickets con OK — no enlaza los Pad
  'src/modules/health/index.js',           // este audit + checkTolkienContextSync
  'src/modules/tolkien/env-shared.js',      // entornos Tolkien efímeros: gestiona git worktrees off config.projectDir (repo propio de Tolkien), no enlaza los Pad
  'src/modules/onboard/tolkien-mcp-shared.js',  // provisioning del MCP HTTP per-dev del inquilino: usa config.projectDir solo como cwd de `infisical run` para acuñar su bearer, no enlaza los Pad
  'bin/cwc-comms-runner.js',
  'bin/cwc-comms-chatbot-runner.js',
  'bin/cwc-comms-send-runner.js',
  'bin/cwc-comms-teams-runner.js',
  'bin/cwc-retro-email-runner.js',          // "Feedback de Chris" (retro): lee correo vía el MISMO MCP de Graph de Tolkien que ya usa Teams (allowlist read-only propia), no enlaza los Pad
  'bin/cwc-retro-teams-runner.js',          // "Feedback de Chris" (retro): lee el DM de Teams con Chris, mismo MCP/allowlist que el escaneo de Teams de Comunicaciones, no enlaza los Pad
]);
const CROSS_WORLD_RE = /config\.projectDir|CLAUDE\.local\.md/;

// Instante de adopción de la Regla dura 15 (ancla del pedido original) = la
// creación de CONVE-1957 en Pad. Es un timestamp exacto y no la medianoche a
// propósito: los ítems abiertos ESA misma mañana nacieron cuando la convención
// todavía no existía, y marcarlos sería reprochar historia.
const ANCLA_SINCE = '2026-07-26T15:09:20Z';
const ANCLA_COLLECTIONS = ['planes', 'tasks', 'bugs'];
const ANCLA_MAX_PARENT_DEPTH = 12;
// Medido el 2026-07-26 sobre la respuesta real de `pad_set_workspace console`:
// 72.751 B. Redondeo inmediato hacia arriba = 73.000 B (249 B de margen);
// detecta crecimiento, no pretende declarar un tamaño ideal.
const PAD_BOOTSTRAP_LIMIT_BYTES = 73_000;
const ANCLA_TERMINAL = new Set([
  'done', 'hecha', 'hecho', 'closed', 'cerrada', 'fixed', 'wontfix',
  'archived', 'cancelled', 'canceled', 'descartada',
]);
const hasPedidoOriginal = (content) => /^##\s+.*Pedido original/mi.test(String(content || ''));
const hasCriteriosAceptacion = (content) => /^##\s+.*Criterios de aceptación/mi.test(String(content || ''));

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

// console:BUG-2118: el provisioning de un inquilino (su Pad + el clon de su
// workspace) corre DESPUÉS de que /register respondió ok:true. Si falla, el
// wizard ya dijo "listo" y el único rastro era el journal. Acá el admin lo ve
// sin leer logs. Un `pending` viejo también cuenta: si el server murió a mitad
// del provisioning, ese inquilino quedó a medias y nadie lo va a reintentar.
const PROVISION_STALE_MS = 10 * 60 * 1000;

function checkOnboardProvisioning() {
  const id = 'onboard-provisioning';
  const label = 'Provisioning de inquilinos';
  let states = [];
  try { states = listProvisionStates(); } catch { return { id, label, status: 'warn', detail: 'no pude leer el estado de provisioning' }; }
  if (!states.length) return { id, label, status: 'ok', detail: 'sin altas registradas' };
  const failed = states.filter((s) => s.status === 'failed');
  const stuck = states.filter((s) => s.status === 'pending' && Date.now() - (s.ts || 0) > PROVISION_STALE_MS);
  const describe = (s) => {
    const bad = Object.entries(s.steps || {})
      .filter(([, v]) => v.status !== 'ok')
      .map(([k, v]) => `${k}: ${v.error || v.status}`);
    return `${s.user}${bad.length ? ` (${bad.join(' · ')})` : ''}`;
  };
  if (failed.length || stuck.length) {
    const parts = [];
    if (failed.length) parts.push(`${failed.length} alta(s) con provisioning FALLIDO: ${failed.slice(0, 3).map(describe).join(' | ')}`);
    if (stuck.length) parts.push(`${stuck.length} colgada(s) en pending hace más de 10 min: ${stuck.slice(0, 3).map((s) => s.user).join(', ')}`);
    return { id, label, status: 'warn', detail: `${parts.join(' · ')} — ese inquilino quedó sin su Pad o sin el clon de su workspace` };
  }
  return { id, label, status: 'ok', detail: `${states.length} alta(s) con provisioning completo` };
}

function checkTolkienEnvs() {
  const id = 'tolkien-envs';
  const label = 'Entornos Tolkien de sesión';
  let recs = [];
  try { recs = listEnvs(); } catch { recs = []; }
  let dirs = [];
  try {
    dirs = fss.readdirSync(ENVS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { dirs = []; }
  const ids = new Set(recs.map((r) => r?.id).filter(Boolean));
  const orphanDirs = dirs.filter((d) => !ids.has(d));
  const errored = recs.filter((r) => r?.status === 'error');
  const incomplete = [];
  let verifiedAlive = 0;
  for (const r of recs) {
    // NO filtramos por isEnvAlive: 'down'/'error' describen el dev-server, no si hay una sesión trabajando en el worktree. El caso que originó este check tenía status 'down' y una sesión adentro.
    if (!r.worktree || !fss.existsSync(r.worktree)) continue;
    try {
      const context = verifyEnvContext(r.worktree);
      verifiedAlive += 1;
      if (context.ok === false) incomplete.push({ id: r.id, missing: context.missing });
    } catch { /* un check de salud nunca debe romper el endpoint */ }
  }
  if (incomplete.length || orphanDirs.length || errored.length) {
    const parts = [];
    if (incomplete.length) {
      const sample = incomplete.slice(0, 3).map(({ id: envId, missing }) => {
        const artifacts = Array.isArray(missing) ? missing.slice(0, 3).join(', ') : 'sin detalle';
        return `${envId}: ${artifacts || 'sin detalle'}`;
      }).join('; ');
      parts.push(`${incomplete.length} entorno(s) SIN el marco de Tolkien (${sample}) — la sesión trabaja sin reglas; recreá el entorno o corré el sembrado`);
    }
    parts.push(`${recs.length} entorno(s)`);
    if (errored.length) parts.push(`${errored.length} en error`);
    if (orphanDirs.length) parts.push(`${orphanDirs.length} worktree(s) huérfano(s) sin registro (${orphanDirs.slice(0, 3).join(', ')})`);
    return { id, label, status: 'warn', detail: parts.join(' · ') };
  }
  const detail = recs.length ? `${recs.length} entorno(s) registrado(s), todos sanos` : 'sin entornos activos';
  return { id, label, status: 'ok', detail: verifiedAlive ? `${detail} · marco de Tolkien completo` : detail };
}

// OJO: el REST del Pad local devuelve `fields` como STRING JSON (no objeto,
// a diferencia del MCP) — hay que parsearlo antes de leer sus atributos.
function padField(item, key) {
  let fields = item?.fields;
  if (typeof fields === 'string') {
    try { fields = JSON.parse(fields); } catch { fields = {}; }
  }
  return fields?.[key] ?? item?.[key];
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
  const r = await padLocal.listItems('conventions', { workspace: 'console' });
  if (!r.ok) {
    return { id, label, status: 'warn', detail: `Pad local no responde (${r.error || 'sin detalle'}) — tasks/learning/retro/tickets-meta degradan a best-effort. ¿pad-local.service arriba?` };
  }
  const items = Array.isArray(r.data) ? r.data : [];
  const musts = items.filter((c) => padField(c, 'priority') === 'must' && padField(c, 'status') !== 'disabled');
  const hasAnticollision = items.some((c) => {
    const t = `${c?.title || ''} ${c?.content || ''}`.toLowerCase();
    return /anti-?colisi[oó]n|plan-puente|regla dura #12|regla #12/.test(t);
  });
  if (!hasAnticollision) {
    return { id, label, status: 'warn', detail: 'Pad local OK pero FALTA en las Conventions el espejo de la Regla dura #12 (anti-colisión entre mundos) — CLAUDE.md y Pad divergieron; recrear la convención' };
  }
  return { id, label, status: 'ok', detail: `Pad local OK · ${musts.length} convención(es) must · espejo Regla #12 presente` };
}

// Verifica que el índice enrutador respete su techo y que todos sus destinos
// bloqueantes existan y tengan cuerpo. Read-only, HTTP plano y 0 tokens.
async function checkPadIndex() {
  const id = 'pad-index';
  const label = 'Índice enrutador de Pad';
  try {
    const conventions = await padLocal.listItems('conventions', {
      workspace: PAD_INDEX_PROFILE.workspace,
    });
    if (!conventions.ok) {
      return { id, label, status: 'warn', detail: 'Pad no responde, no se pudo verificar el índice' };
    }

    const data = await collectPadIndex(PAD_INDEX_PROFILE);
    const indexText = renderIndex(data, PAD_INDEX_PROFILE);
    const ceiling = computeCeiling(indexText, data);
    const lockedRefs = [...new Set(
      indexText.split('\n')
        .filter((line) => line.startsWith('- 🔒 |'))
        .map((line) => line.match(/\bpad_item get\s+([^\s(]+)/)?.[1])
        .filter(Boolean),
    )];
    const items = Array.isArray(conventions.data)
      ? conventions.data
      : (Array.isArray(conventions.data?.items) ? conventions.data.items : []);
    const byRef = new Map(items.map((item) => [item?.ref, item]));
    const badRefs = lockedRefs.filter((ref) => {
      const item = byRef.get(ref);
      return !item || !String(item.content || '').trim();
    });
    const errors = [];
    if (!ceiling.ok) {
      errors.push(`techo excedido por ${ceiling.total - ceiling.limit} caracteres (${ceiling.total}/${ceiling.limit})`);
    }
    if (badRefs.length) errors.push(`refs bloqueantes inexistentes o vacías: ${badRefs.join(', ')}`);
    if (errors.length) return { id, label, status: 'fail', detail: errors.join(' · ') };
    return {
      id,
      label,
      status: 'ok',
      detail: `techo ${ceiling.total}/${ceiling.limit} · ${lockedRefs.length} ref(s) bloqueante(s) resueltas`,
    };
  } catch {
    return { id, label, status: 'warn', detail: 'Pad no responde, no se pudo verificar el índice' };
  }
}

function bootstrapComponentBytes(value) {
  if (value === undefined) return 0;
  // Incluye el separador del campo en el blob. Este criterio reproduce el
  // desglose medido sobre la respuesta real sin contar el nombre del campo.
  return Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
}

// Check hermano de pad-index: el índice es texto controlado por este repo; este
// blob lo genera Pad server. Mantenerlos separados deja visible cuál de los dos
// canales creció. Read-only por HTTP plano, 0 tokens, nunca MCP.
export async function checkPadBootstrap(fetchBootstrap = padLocal.getBootstrap) {
  const id = 'pad-bootstrap';
  const label = 'Bootstrap de Pad (console)';
  try {
    const result = await fetchBootstrap({ workspace: 'console' });
    if (!result?.ok) {
      return {
        id,
        label,
        status: 'warn',
        detail: `Pad local no responde (${result?.error || 'sin detalle'}); no se pudo medir el bootstrap`,
      };
    }
    const bootstrap = result.data?.bootstrap || result.data;
    if (!bootstrap || typeof bootstrap !== 'object') {
      return { id, label, status: 'warn', detail: 'Pad local respondió sin un bootstrap medible' };
    }
    const total = Number(result.bytes)
      || Buffer.byteLength(JSON.stringify(result.data), 'utf8');
    const components = {
      playbooks: bootstrapComponentBytes(bootstrap.playbooks),
      conventions: bootstrapComponentBytes(bootstrap.conventions),
      collections: bootstrapComponentBytes(bootstrap.collections),
      dashboard: bootstrapComponentBytes(bootstrap.dashboard),
    };
    const parts = Object.entries(components).map(([name, bytes]) => {
      const pct = total ? Math.round((bytes / total) * 100) : 0;
      return `${name} ${bytes.toLocaleString('es-AR')} B (${pct}%)`;
    });
    return {
      id,
      label,
      status: total > PAD_BOOTSTRAP_LIMIT_BYTES ? 'warn' : 'ok',
      detail: `${total.toLocaleString('es-AR')}/${PAD_BOOTSTRAP_LIMIT_BYTES.toLocaleString('es-AR')} B · ${parts.join(' · ')}`,
    };
  } catch (err) {
    return {
      id,
      label,
      status: 'warn',
      detail: `Pad local no responde (${String(err?.message || err).slice(0, 160)}); no se pudo medir el bootstrap`,
    };
  }
}

// Audita la Regla dura 15 (ancla del pedido original, CONVE-1957/CONVE-1958):
// todo trabajo no trivial guarda en Pad el pedido VERBATIM + sus criterios de
// aceptación, y sin eso el contraste final no tiene contra qué medir. El pedido
// original se declara una sola vez en la raíz: planes/tasks/bugs hijos lo heredan
// de cualquier ancestro unido por links `parent` reales. Read-only por HTTP plano
// (NO MCP, no toca el blindaje de la regla 6), 0 tokens.
// GRANDFATHERING: solo audita los ítems creados a partir de ANCLA_SINCE (la
// fecha de adopción de la convención). Los ítems anteriores nacieron sin ancla y
// marcarlos sería ruido permanente — el check tiene que señalar deriva NUEVA.
async function anclaEnAncestros(ref, itemCache, linksCache) {
  const visited = new Set([ref]);
  let frontier = [ref];
  let incomplete = false;

  for (let depth = 0; depth < ANCLA_MAX_PARENT_DEPTH && frontier.length; depth += 1) {
    const next = [];
    for (const currentRef of frontier) {
      if (!linksCache.has(currentRef)) {
        linksCache.set(currentRef, padLocal.listLinks(currentRef, { workspace: 'console' }));
      }
      const linksResult = await linksCache.get(currentRef);
      if (!linksResult.ok) {
        incomplete = true;
        continue;
      }
      const links = Array.isArray(linksResult.data)
        ? linksResult.data
        : (Array.isArray(linksResult.data?.links) ? linksResult.data.links : []);
      const parentRefs = links
        .filter((link) => (
          link?.link_type === 'parent'
          && link?.source_ref === currentRef
          && link?.target_ref
        ))
        .map((link) => link.target_ref);

      for (const parentRef of parentRefs) {
        if (visited.has(parentRef)) continue;
        visited.add(parentRef);
        if (!itemCache.has(parentRef)) {
          itemCache.set(parentRef, padLocal.getItem(parentRef, { workspace: 'console' }));
        }
        const parentResult = await itemCache.get(parentRef);
        if (!parentResult.ok || !parentResult.data) {
          incomplete = true;
          continue;
        }
        if (
          hasPedidoOriginal(parentResult.data.content)
          && hasCriteriosAceptacion(parentResult.data.content)
        ) {
          return { found: true, incomplete: false };
        }
        next.push(parentRef);
      }
    }
    frontier = next;
  }

  // Una frontera todavía abierta al alcanzar el tope equivale a topología
  // incompleta: jamás convertirla en un incumplimiento falso.
  if (frontier.length) incomplete = true;
  return { found: false, incomplete };
}

async function checkAncla() {
  const id = 'ancla';
  const label = 'Ancla del pedido original';
  try {
    const listed = await Promise.all(ANCLA_COLLECTIONS.map(async (collection) => ({
      collection,
      result: await padLocal.listItems(collection, { workspace: 'console' }),
    })));
    const unavailable = listed.filter(({ result }) => !result.ok).map(({ collection }) => collection);
    if (unavailable.length) {
      return {
        id,
        label,
        status: 'warn',
        detail: `Pad local no responde para ${unavailable.join(', ')}; no se pudo auditar el ancla del trabajo activo`,
      };
    }
    const items = listed.flatMap(({ collection, result }) => {
      const rows = Array.isArray(result.data)
        ? result.data
        : (Array.isArray(result.data?.items) ? result.data.items : []);
      return rows.map((item) => ({ ...item, _anclaCollection: collection }));
    });
    const audited = items.filter((item) => {
      const status = String(padField(item, 'status') || '').toLowerCase();
      return item.created_at && item.created_at >= ANCLA_SINCE && !ANCLA_TERMINAL.has(status);
    });
    const auditCounts = Object.fromEntries(
      ANCLA_COLLECTIONS.map((collection) => [
        collection,
        audited.filter((item) => item._anclaCollection === collection).length,
      ]),
    );
    const countsText = ANCLA_COLLECTIONS.map((collection) => `${collection} ${auditCounts[collection]}`).join(' · ');
    if (!audited.length) {
      return { id, label, status: 'ok', detail: 'sin trabajo activo posterior a la adopción de la Regla 15' };
    }
    const itemCache = new Map(items.map((item) => [
      item.ref,
      Promise.resolve({ ok: true, data: item }),
    ]));
    const linksCache = new Map();
    const evaluated = await Promise.all(audited.map(async (item) => {
      const ownAncla = hasPedidoOriginal(item.content) && hasCriteriosAceptacion(item.content);
      const inherited = ownAncla
        ? { found: true, incomplete: false }
        : await anclaEnAncestros(item.ref, itemCache, linksCache);
      return {
        item,
        missing: !inherited.found && !inherited.incomplete,
        incomplete: !inherited.found && inherited.incomplete,
      };
    }));
    const sinAncla = evaluated.filter((entry) => entry.missing).map((entry) => entry.item);
    const incompletos = evaluated.filter((entry) => entry.incomplete).map((entry) => entry.item);
    if (!sinAncla.length) {
      if (incompletos.length) {
        return {
          id,
          label,
          status: 'warn',
          detail: `${audited.length} ítem(es) activo(s) auditado(s) (${countsText}) · ${incompletos.length} cadena(s) parent no se pudieron completar`,
        };
      }
      return {
        id,
        label,
        status: 'ok',
        detail: `${audited.length} ítem(es) activo(s) auditado(s) (${countsText}) · todos anclados, por bloque propio o ancestro`,
      };
    }
    const firstRefs = sinAncla.slice(0, 5).map((it) => it.ref).join(', ');
    const refs = sinAncla.length > 5 ? `${firstRefs} y ${sinAncla.length - 5} más` : firstRefs;
    const missingCounts = Object.fromEntries(
      ANCLA_COLLECTIONS.map((collection) => [
        collection,
        sinAncla.filter((item) => item._anclaCollection === collection).length,
      ]),
    );
    const missingText = ANCLA_COLLECTIONS
      .map((collection) => `${collection} ${missingCounts[collection]}/${auditCounts[collection]}`)
      .join(' · ');
    const incompleteText = incompletos.length
      ? ` · ${incompletos.length} cadena(s) parent adicionales no se pudieron completar`
      : '';
    return {
      id,
      label,
      status: 'warn',
      detail: `${sinAncla.length}/${audited.length} ítem(es) activo(s) SIN ancla completa (Regla 15; ${missingText}): ${refs}${incompleteText} — corré la skill \`anclar\` sobre ${sinAncla.length === 1 ? 'ese ítem' : 'esos ítems'}`,
    };
  } catch {
    return { id, label, status: 'warn', detail: 'no pude auditar el ancla (Pad local no responde)' };
  }
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
    checkUnifiBridge(),
    Promise.resolve(checkTolkienContextSync()),
    Promise.resolve(checkFichasModulo()),
    Promise.resolve(checkCrossWorld()),
    Promise.resolve(checkTolkienEnvs()),
    Promise.resolve(checkOnboardProvisioning()),
    checkPadBackbone(),
    checkPadIndex(),
    checkPadBootstrap(),
    checkAncla(),
  ]);
  const count = (s) => checks.filter((c) => c.status === s).length;
  return {
    checkedAt: Date.now(),
    ok: count('ok'),
    warn: count('warn'),
    fail: count('fail'),
    checks,
  };
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
  // o vacío ⇒ ok. También se calcula cuando la síntesis fue RECHAZADA por
  // catálogo: el veredicto determinístico por severidad cubre justamente ese
  // hueco; sin esto el front fabricaría 'atencion' al recibir liveVerdict:null.
  const open = findings.filter((f) => f.fixStatus !== 'resolved' && f.fixStatus !== 'dismissed');
  const resolvedCount = findings.length - open.length;
  let liveVerdict = null;
  if (state.verdict || state.verdictOmitted) {
    const sev = new Set(open.map((f) => String(f.severity)));
    liveVerdict = sev.has('critical') || sev.has('high') ? 'critico' : sev.has('medium') ? 'atencion' : 'ok';
  }
  return { ...state, findings, liveVerdict, openCount: open.length, resolvedCount };
}

export default {
  name: 'health',

  registerHttp(router) {
    const r = express.Router();

    // Chequeos rápidos, en vivo (admin-only: diagnóstico del server).
    r.get('/checks', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
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
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        const { inventory, regenerated } = generateInventory({ force: req.query.force === '1' });
        // Fuente única: inventory.js ya calcula unregistered con la regla correcta
        // (una carpeta SIN index.js — p.ej. `comms`, librerías shared — no cuenta).
        // Fallback con la MISMA regla (hasIndex) para caches viejos sin `completeness`.
        const unregistered = inventory.completeness?.unregistered
          ?? inventory.modules.filter((m) => m.hasIndex && !m.registered).map((m) => m.name);
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
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      res.json({ ...enrichReview(readReview()), running: isRunning(), fixing: isFixing() });
    });

    // Foto EN VIVO de los procesos/runners en segundo plano, consumida por el
    // panel de Sesiones de TODOS los usuarios. Owner-scoped: admin/host/token
    // maestro ve la foto histórica completa; un inquilino ve solo sus jobs.
    // Los SUBAGENTES no salen de acá: el front los toma de /api/chat/list.
    // `dominantModel` = el modelo más frecuente entre los procesos visibles.
    r.get('/active-runners', (req, res) => {
      const principal = principalOf(req);
      const admin = isAdmin(req);
      let processes = collectActiveRunners();
      if (!admin) {
        // FAIL-CLOSED: si el job no declara dueño o no podemos leerlo, jamás se
        // muestra a un no-admin. La capa global de auth conserva el 401 vigente.
        processes = principal?.username
          ? processes.filter((p) => activeRunnerOwner(p) === principal.username)
          : [];
      }
      const counts = {};
      for (const p of processes) if (p.model) counts[p.model] = (counts[p.model] || 0) + 1;
      const dominantModel = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      res.json({ processes, processCount: processes.length, dominantModel });
    });

    // Registro DURABLE de bugs resueltos (historial + recurrencias). Admin-only.
    r.get('/solved', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
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
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
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
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
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
    // cada corrida del SDK. Admin-only (solo lee el repo con regex).
    r.get('/ai-census', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try { res.json({ generatedAt: Date.now(), engines: aiEnginesCensus() }); }
      catch (err) { res.status(500).json({ error: String(err?.message || err).slice(0, 300) }); }
    });

    // Estado del análisis: resultado persistido (lo escribe el runner) + si hay
    // uno corriendo (lock fresco, con fase). El front encuesta esto. 0 tokens.
    r.get('/optimization', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
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
    // los servicios transversales + hallazgos de cableado. Admin-only.
    r.get('/coherence-census', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        const census = coherenceCensus();
        res.json({ generatedAt: Date.now(), census, findings: evaluateCoherence(census) });
      } catch (err) { res.status(500).json({ error: String(err?.message || err).slice(0, 300) }); }
    });

    // Estado del análisis IA: resultado persistido (lo escribe el runner) + si
    // hay uno corriendo (lock fresco, con fase). El front encuesta esto. 0 tokens.
    r.get('/coherence', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
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
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const scan = scanStatus(readScan());
      // VEREDICTO EN VIVO también para el Escaneo unificado (mismo problema que
      // /review ya resolvía): `scan.verdict` es una FOTO de la síntesis (sonnet)
      // al terminar y NUNCA se recalcula, así que a medida que se resuelven/
      // descartan hallazgos el chip quedaba clavado en CRÍTICO aunque no quedara
      // nada abierto. El escaneo comparte review.json con la Revisión, así que
      // reusamos el liveVerdict de enrichReview (0 tokens, determinístico, mismo
      // criterio critical/high⇒critico · medium⇒atencion · resto⇒ok) para que el
      // badge refleje el estado REAL. Solo cuando el escaneo NO está corriendo.
      if (scan && scan.verdict && !scan.running) {
        const rev = enrichReview(readReview());
        if (rev.liveVerdict) {
          scan.verdict = rev.liveVerdict;
          scan.openCount = rev.openCount;
          scan.resolvedCount = rev.resolvedCount;
        }
      }
      // Superficie observable del sobre cerrado (0 tokens): hoy se consulta por
      // curl; renderizar rules/ledger en public/ queda como contrato FORWARD.
      // Ambos son best-effort para que su telemetría jamás tumbe el endpoint.
      try { scan.rules = rulesStatus(); } catch { scan.rules = null; }
      try { scan.ledger = attemptStats({ limit: 2000 }); } catch { scan.ledger = null; }
      res.json(scan);
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
