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
import { runAdaptivePool } from '../../core/pool.js';
import { isAdmin, principalOf } from '../../core/auth.js';
import { hostUser, readInfisicalAccountEmail, readUserPadToken, requesterSdkEnv, userClaudeDir, userSpace } from '../../core/user-space.js';
import { listUsers } from '../../core/users.js';
import { PAD_DEFAULT_URL } from '../../core/pad-url.js';
import { ownerForSession } from '../../core/session-names.js';
import {
  readReview, writeReview, isRunning, isFixing, writeFixLock, findingId, findingSig, readSolved,
  writeLock, clearLock,
  markFindingResolved,
  readDismissed, recordDismissed, removeDismissed,
  readProposals, writeProposals,
  readBatch, writeBatch, writeBatchLock, clearBatchLock, isBatchRunning,
  collectActiveRunners,
  discoverUnits,
} from './shared.js';
import { appendLearnedInvariant } from './invariants.js';
import { facetsForUnit, loadFacetsSnapshot } from './facets.js';
import { classifyFinding } from './policy.js';
import { rulesStatus } from './finding-rules.js';
import { attemptStats } from '../../core/closed-envelope.js';
import { aiEnginesCensus, generateInventory, coherenceCensus } from '../../core/inventory.js';
import { systemSnapshot } from '../stats/index.js';
import { verifySync as verifyTolkienContextSync } from '../tickets/context-store.js';
import { listEnvs, ENVS_DIR } from '../tolkien/env-store.js';
import { CAPABILITIES, requiredFor } from '../onboard/capabilities.js';
import { listProvisionStates } from '../onboard/provision-state.js';
import { verifyEnvContext } from '../tolkien/env-shared.js';
import { tmuxArgs } from '../terminal/sessions.js';
import * as padLocal from '../../core/pad-service-client.js';
import {
  readOpt, writeOpt, isOptRunning, readOptLock, writeOptLock, clearOptLock, OPT_LOG,
} from './optimize-shared.js';
import {
  readCoh, writeCoh, isCohRunning, readCohLock, writeCohLock, clearCohLock, COH_LOG, evaluateCoherence,
} from './coherence-shared.js';
import {
  readScan, writeScan, scanStatus, isScanRunning, writeScanLock, clearScanLock,
  spawnScanRunner, createBugFromFinding,
} from './scan-shared.js';
import { createTaskFromProposal } from './pad-writeback-shared.js';
import { checkSponsoredUsage } from './sponsored-usage.js';
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
const MAX_BATCH = 400;
const inflightProposals = new Set();
const DOCKER_HYGIENE_REPORT = path.join(DATA_DIR, 'docker-hygiene', 'report.json');
const DOCKER_HYGIENE_FRESH_MS = 24 * 60 * 60 * 1000;
const DOCKER_HYGIENE_VOLUME_WARN = 20;
const DOCKER_HYGIENE_BYTES_WARN = 5 * 1000 ** 3;
const VENDOR_PACKAGE_BY_DIR = new Map([
  ['marked', 'marked'],
  ['mermaid', 'mermaid'],
  ['chartjs', 'chart.js'],
  ['hljs', 'highlight.js'],
  ['xterm', '@xterm/xterm'],
]);

function requesterFor(req) {
  return principalOf(req)?.username || hostUser();
}

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
  ['tolkien-refresh', 'tolkien-refresh.json'],
  ['whatsapp', 'comms/whatsapp-daemon.json'],
  ['retro-curate', 'retro-curation.json'],
  ['health-scan', 'health-scan.lock'],
]);
const RUNNER_STATE_DIRS = new Map([
  ['commitmsg', 'commitmsg'],
  ['projects-analyze', 'projects-analyze'],
  ['comms-analyze', 'comms/analyze'],
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

// BUG-2350: el server tmux conserva un entorno GLOBAL independiente del
// proceso Node. Si HOME queda apuntando al espacio de un inquilino, una sesión
// posterior puede heredar sus credenciales. Auditamos tanto la causa latente
// (HOME global) como el HOME efectivo de cada pane, siempre contra el owner
// durable de session-owners.json.
export async function checkTmuxOwner() {
  const id = 'tmux-owner';
  const label = 'Aislamiento HOME de tmux';
  try {
    let expectedHostHome;
    try {
      expectedHostHome = userSpace(hostUser());
    } catch (err) {
      return {
        id,
        label,
        status: 'warn',
        detail: `no pude resolver el HOME esperado del host: ${String(err?.message || err).slice(0, 180)}`,
      };
    }

    const [panesResult, globalResult] = await Promise.all([
      run('tmux', tmuxArgs('list-panes', '-a', '-F', '#{session_name}|#{pane_pid}')),
      run('tmux', tmuxArgs('show-environment', '-g')),
    ]);
    const uncertainty = [];
    let globalIssue = null;

    if (globalResult.err) {
      const reason = globalResult.errOut || globalResult.err?.message || 'error desconocido';
      uncertainty.push(`no pude leer el entorno global de tmux: ${String(reason).replace(/\s+/g, ' ').slice(0, 180)}`);
    } else {
      const homeLine = globalResult.out.split('\n').find((line) => line.startsWith('HOME='));
      if (homeLine) {
        const actualGlobalHome = homeLine.slice('HOME='.length);
        if (actualGlobalHome !== expectedHostHome) {
          globalIssue = `HOME global=${actualGlobalHome || '<vacío>'} (esperado ${expectedHostHome}) — fuga latente`;
        }
      } else {
        globalIssue = `HOME global ausente (esperado ${expectedHostHome}) — medición irresoluble`;
      }
    }

    const panesReason = panesResult.errOut || panesResult.err?.message || 'error desconocido';
    // Un server tmux persistente pero sin sesiones responde `no current target`
    // incluso con el socket correcto y `list-panes -a`: es un inventario vacío,
    // no una medición fallida. Cualquier otro error sigue degradando el check.
    const noPanes = panesResult.err && /^no current target$/i.test(String(panesReason).trim());
    if (panesResult.err && !noPanes) {
      const reason = panesReason;
      uncertainty.unshift(`no pude enumerar los panes de tmux: ${String(reason).replace(/\s+/g, ' ').slice(0, 180)}`);
      if (globalIssue) uncertainty.push(globalIssue);
      return { id, label, status: 'warn', detail: uncertainty.join(' · ') };
    }

    const paneLines = noPanes ? [] : panesResult.out.split('\n').filter(Boolean);
    const mismatches = [];
    for (const line of paneLines) {
      const separator = line.lastIndexOf('|');
      const sessionName = separator === -1 ? '' : line.slice(0, separator);
      const panePid = separator === -1 ? '' : line.slice(separator + 1);
      if (!sessionName || !/^\d+$/.test(panePid)) {
        uncertainty.push(`pane ilegible en la salida de tmux: ${line.slice(0, 160)}`);
        continue;
      }

      let sessionId = sessionName;
      if (sessionName.startsWith('cwct-')) sessionId = sessionName.slice('cwct-'.length);
      else if (sessionName.startsWith('cwc-')) sessionId = sessionName.slice('cwc-'.length);

      let owner = null;
      try { owner = ownerForSession(sessionId); } catch { /* helper durable best-effort */ }
      if (!owner) {
        uncertainty.push(`${sessionName}: dueño no resuelto en session-owners.json`);
        continue;
      }

      let expectedHome;
      try {
        expectedHome = userSpace(owner);
      } catch (err) {
        uncertainty.push(`${sessionName}: dueño declarado ${owner}, HOME esperado no resoluble (${String(err?.message || err).slice(0, 120)})`);
        continue;
      }

      let actualHome;
      try {
        const entries = fss.readFileSync(path.join('/proc', panePid, 'environ')).toString('utf8').split('\0');
        const homeEntry = entries.find((entry) => entry.startsWith('HOME='));
        actualHome = homeEntry ? homeEntry.slice('HOME='.length) : null;
      } catch (err) {
        uncertainty.push(`${sessionName}: dueño declarado ${owner}, no pude leer /proc/${panePid}/environ (${String(err?.code || err?.message || err).slice(0, 120)})`);
        continue;
      }

      if (actualHome !== expectedHome) {
        mismatches.push(`${sessionName}: dueño declarado ${owner}, HOME real=${actualHome ?? '<ausente>'} (esperado ${expectedHome})`);
      }
    }

    if (mismatches.length) {
      const extras = [...(globalIssue ? [globalIssue] : []), ...uncertainty];
      return {
        id,
        label,
        status: 'fail',
        detail: `${mismatches.join(' · ')}${extras.length ? ` · ${extras.join(' · ')}` : ''}`,
      };
    }
    if (globalIssue || uncertainty.length) {
      return { id, label, status: 'warn', detail: [globalIssue, ...uncertainty].filter(Boolean).join(' · ') };
    }
    if (!paneLines.length) {
      return { id, label, status: 'ok', detail: 'sin panes que auditar · HOME global sano' };
    }
    return { id, label, status: 'ok', detail: `${paneLines.length} pane(s) con HOME acorde a su dueño · HOME global sano` };
  } catch (err) {
    return {
      id,
      label,
      status: 'warn',
      detail: `auditoría tmux-owner degradada: ${String(err?.message || err).replace(/\s+/g, ' ').slice(0, 200)}`,
    };
  }
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

// Vigila la credencial OAuth del HOST (~/.claude/.credentials.json). Sin esto,
// un archivo con los tokens vaciados sólo se descubre cuando ningún chat abre
// (console:BUG-2438). NUNCA loguea ni devuelve material de credencial: sólo
// longitudes, booleanos y fechas.
function checkClaudeCred() {
  const id = 'claude-cred';
  const label = 'Credencial de Claude (host)';
  const file = path.join(userClaudeDir(hostUser()), '.credentials.json');
  let oauth;
  try {
    oauth = JSON.parse(fss.readFileSync(file, 'utf8'))?.claudeAiOauth;
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return { id, label, status: 'fail', detail: 'no existe ~/.claude/.credentials.json — corré `claude /login`' };
    }
    return { id, label, status: 'fail', detail: 'no pude leer ~/.claude/.credentials.json (¿JSON corrupto?) — corré `claude /login`' };
  }
  if (!oauth) {
    return { id, label, status: 'fail', detail: 'el archivo no tiene claudeAiOauth — corré `claude /login`' };
  }
  const hasAccess = typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0;
  const hasRefresh = typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
  if (!hasAccess && !hasRefresh) {
    return { id, label, status: 'fail', detail: 'accessToken y refreshToken VACÍOS — ningún chat nuevo puede arrancar; corré `claude /login`' };
  }
  const expiresAt = Number(oauth.expiresAt) || 0;
  const left = expiresAt - Date.now();
  const hs = (ms) => Math.round(ms / 3600000);
  if (!hasAccess) {
    return { id, label, status: 'warn', detail: 'accessToken vacío pero hay refreshToken — se renovará solo en la próxima llamada' };
  }
  if (expiresAt && left <= 0) {
    return hasRefresh
      ? { id, label, status: 'warn', detail: `accessToken vencido hace ${hs(-left)}h — hay refreshToken, se renueva solo` }
      : { id, label, status: 'fail', detail: `accessToken vencido hace ${hs(-left)}h y SIN refreshToken — corré \`claude /login\`` };
  }
  if (expiresAt && left < 24 * 3600 * 1000 && !hasRefresh) {
    return { id, label, status: 'warn', detail: `vence en ${hs(left)}h y no hay refreshToken — vas a tener que correr \`claude /login\`` };
  }
  const rte = Number(oauth.refreshTokenExpiresAt) || 0;
  if (rte && rte - Date.now() < 7 * 24 * 3600 * 1000) {
    return { id, label, status: 'warn', detail: `el refreshToken vence en ${Math.round((rte - Date.now()) / 86400000)} día(s)` };
  }
  const venc = expiresAt ? `vence en ${hs(left)}h` : 'sin vencimiento declarado';
  return { id, label, status: 'ok', detail: `${oauth.subscriptionType || 'cuenta'} · ${venc}${hasRefresh ? ' · refresh disponible' : ''}` };
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
  await runAdaptivePool(files, async (f) => {
    const r = await run(process.execPath, ['--check', f]);
    // Seguro sin lock: los workers comparten el event loop de Node.
    if (r.err) bad.push(path.relative(ROOT, f));
  }, {
    // Cada item spawnea node --check: la rampa adaptativa no debe superar 16 procesos.
    min: 4, start: 8, max: 16,
  });
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

function vendorPackageForDir(dirname) {
  return VENDOR_PACKAGE_BY_DIR.get(dirname)
    || (dirname.startsWith('addon-') ? `@xterm/${dirname}` : null);
}

function vendoredHljsVersion(source) {
  const patterns = [
    /highlight(?:\.js)?(?:\s+version)?\s+v?(\d+\.\d+\.\d+)/i,
    /\bversionString\s*[:=]\s*["'](\d+\.\d+\.\d+)["']/,
    /\b(?:var|let|const)\s+[$\w]+\s*=\s*["'](\d+\.\d+\.\d+)["'](?=\s*,\s*[$\w]+\s*=\s*class\s+extends\s+Error)/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// highlight.js es la única excepción aceptada: npm no publica un bundle de
// navegador. Las demás librerías declaradas deben montarse desde node_modules
// para que una actualización por npm llegue al frontend y no genere drift.
export function checkVendorDrift() {
  const id = 'vendor-drift';
  const label = 'Deriva de librerías frontend';
  let manifest;
  let vendorDirs;
  try {
    manifest = JSON.parse(fss.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    vendorDirs = fss.readdirSync(path.join(ROOT, 'public', 'vendor'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    return { id, label, status: 'warn', detail: `no pude leer package.json o public/vendor (${String(err?.message || err).slice(0, 160)}) — verificá el árbol y montá las librerías migrables desde node_modules` };
  }

  const declared = {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
    ...(manifest.optionalDependencies || {}),
    ...(manifest.peerDependencies || {}),
  };
  const migratable = vendorDirs.filter((dirname) => {
    const packageName = vendorPackageForDir(dirname);
    return dirname !== 'hljs' && packageName && Object.hasOwn(declared, packageName);
  });
  const warnings = [];

  if (migratable.length) {
    warnings.push(`copias estáticas migrables: ${migratable.join(', ')} — borralas y montalas desde node_modules como marked/mermaid/chartjs/xterm`);
  }

  if (!vendorDirs.includes('hljs')) {
    warnings.push('falta public/vendor/hljs — restaurá el bundle vendorizado; highlight.js no publica uno de navegador en npm');
  } else if (!Object.hasOwn(declared, 'highlight.js')) {
    warnings.push('highlight.js no está declarado en package.json — declaralo para poder controlar la versión del bundle vendorizado');
  } else {
    try {
      const installed = JSON.parse(fss.readFileSync(path.join(ROOT, 'node_modules', 'highlight.js', 'package.json'), 'utf8')).version;
      const source = fss.readFileSync(path.join(ROOT, 'public', 'vendor', 'hljs', 'hljs.min.js'), 'utf8');
      const vendored = vendoredHljsVersion(source);
      if (!vendored) {
        warnings.push('no pude determinar la versión de public/vendor/hljs/hljs.min.js — regenerá el bundle dejando su versión declarada');
      } else if (!installed) {
        warnings.push('node_modules/highlight.js no declara versión — corregí la instalación y volvé a comparar el bundle vendorizado');
      } else if (vendored !== installed) {
        warnings.push(`hljs vendorizado ${vendored} != highlight.js instalado ${installed} — actualizá manualmente public/vendor/hljs (no se puede montar desde npm)`);
      }
    } catch (err) {
      warnings.push(`no pude comparar la versión de hljs (${String(err?.message || err).slice(0, 160)}) — revisá node_modules y el bundle vendorizado`);
    }
  }

  if (warnings.length) return { id, label, status: 'warn', detail: warnings.join(' · ') };
  const installed = JSON.parse(fss.readFileSync(path.join(ROOT, 'node_modules', 'highlight.js', 'package.json'), 'utf8')).version;
  return { id, label, status: 'ok', detail: `sin copias estáticas migrables · hljs ${installed} coincide con node_modules` };
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

// El subset work+pr del contexto de trabajo se espeja a ~/tolkien/
// CLAUDE.local.md (auto-carga en TODA sesión de Tolkien). Este check avisa si
// el espejo quedó viejo/ausente frente al master de la consola.
function checkTolkienContextSync() {
  const id = 'tolkien-context';
  const label = 'Contexto de Tolkien sincronizado';
  const s = verifyTolkienContextSync();
  if (s.status === 'ok') return { id, label, status: 'ok', detail: 'CLAUDE.local.md al día con el contexto de trabajo (Proyectos → Contexto de trabajo)' };
  if (s.status === 'stale') return { id, label, status: 'warn', detail: 'el espejo en CLAUDE.local.md quedó desactualizado — re-sincronizá el contexto de trabajo (Proyectos → Contexto de trabajo)' };
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

// CONVE-2279: comprueba que las unidades auditadas tengan clase declarada y
// que no haya código de src/ fuera del radar estructural de discoverUnits().
// Es determinístico, local y no consume tokens.
export function checkFacetas() {
  const id = 'facetas';
  const label = 'Facetas del Edificio (invariantes por clase)';
  const snapshot = loadFacetsSnapshot();
  if (!snapshot) {
    return {
      id,
      label,
      status: 'warn',
      detail: 'sin snapshot de facetas: toda unidad recibe el trato más restrictivo · regeneralo con `node bin/cwc-facets-snapshot.js`',
    };
  }

  const units = discoverUnits();
  const unknown = units.filter((unit) => !facetsForUnit(unit, snapshot).known).map((unit) => unit.name);
  const orphans = [];
  const srcEntries = fss.readdirSync(path.join(ROOT, 'src'), { withFileTypes: true });
  for (const entry of srcEntries) {
    if (entry.isDirectory() && entry.name !== 'core' && entry.name !== 'modules') {
      orphans.push(`src/${entry.name}`);
    } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'server.js') {
      orphans.push(`src/${entry.name}`);
    }
  }

  if (unknown.length || orphans.length) {
    const sample = (items) => {
      const names = items.slice(0, 5).join(', ');
      return items.length > 5 ? `${names} y ${items.length - 5} más` : names;
    };
    const problems = [];
    if (unknown.length) problems.push(`unidades sin facetas: ${sample(unknown)}`);
    if (orphans.length) problems.push(`código huérfano: ${sample(orphans)}`);
    return {
      id,
      label,
      status: 'warn',
      detail: `${problems.join(' · ')} · declarar las facetas del nodo en el Pad (\`node bin/cwc-pad-facets.js --apply\`) y regenerar el snapshot con \`node bin/cwc-facets-snapshot.js\``,
    };
  }

  return {
    id,
    label,
    status: 'ok',
    detail: `${units.length} unidad(es) con facetas declaradas · ${Object.keys(snapshot.entries).length} entradas en el snapshot`,
  };
}

// La auditoría i18n es deliberadamente degradable: t() cae al español cuando
// falta una traducción, así que los hallazgos y los errores del auditor son
// siempre warn, nunca fail.
export async function checkI18n(loadAudit = () => import('./i18n-shared.js')) {
  const id = 'i18n';
  const label = 'Traducciones y ayuda';
  try {
    const { auditI18n } = await loadAudit();
    const result = auditI18n();
    if (result.ok === true) {
      const { used, translated, missing, orphaned } = result.i18n.totals;
      return {
        id,
        label,
        status: 'ok',
        detail: `${used} claves usadas · ${translated} traducidas · ${missing} faltantes · ${orphaned} huérfanas`,
      };
    }

    const messages = Array.isArray(result.problems)
      ? result.problems.map((problem) => problem?.message).filter(Boolean)
      : [];
    const shown = messages.slice(0, 4);
    const remainder = messages.length - shown.length;
    return {
      id,
      label,
      status: 'warn',
      detail: shown.length
        ? `${shown.join(' · ')}${remainder ? ` · …y ${remainder} más` : ''}`
        : 'la auditoría i18n encontró problemas sin detalle',
    };
  } catch (err) {
    const reason = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 200);
    return { id, label, status: 'warn', detail: `no pude cargar la auditoría i18n (${reason})` };
  }
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
  'src/modules/retro/promote-shared.js',   // promueve lecciones a memoria/claude-md de Tolkien
  'src/modules/projects/index.js',         // edita CLAUDE.md/memorias de ambos proyectos
  'src/modules/comms/gateway-shared.js',
  'src/modules/comms/pr-read-shared.js',
  'src/modules/tolkien/index.js',
  'src/modules/tolkien/refresh-shared.js',
  'src/modules/tolkien/build-shared.js',    // build serializado de packages/* del repo propio de Tolkien (pnpm install + turbo build con cwd config.projectDir, lock en ~/.cwc-data) antes de refresh/plantilla y tras un pull (console:BUG-3373); no enlaza los Pad
  'src/modules/tolkien/sources-shared.js',  // refresh completo de fuentes de la DB LOCAL de Tolkien (console:PLAN-3236 D): corre los importers del repo propio con cwd config.projectDir contra localhost:5435; el Pad cloud de Tolkien se LEE (pad-sync) y nunca se escribe; no enlaza los Pad
  'src/modules/tolkien/template-shared.js', // construcción de la DB plantilla de entornos efímeros: corre `prisma migrate deploy` del repo propio de Tolkien con cwd config.projectDir (portable, hallazgo Salud #197); no enlaza los Pad
  'src/modules/skills/index.js',           // censo READ-ONLY de .claude/skills/ de Tolkien (pestaña Skills), no cruza datos
  'src/modules/mcps/login-shared.js',      // censo/estado READ-ONLY de MCP de Tolkien (pestaña Conexiones) + login OAuth guiado (claude mcp, vía CLI); no enlaza los Pad ni cruza datos
  'src/modules/mcps/infisical-shared.js',  // sonda de Infisical: corre el CLI con el cwd del proyecto externo y lee su .infisical.json (solo lectura, no cruza datos)
  'src/core/workspace-provision.js',       // clon read-only del repo de Tolkien por-inquilino (decisión 🆕1 de PLAN-500) — provisiona un checkout, no enlaza los Pad
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
// `pendientes` reemplazó a `tasks` acá el 2026-07-29 (console:PEND-2286): la
// fusión dejó `tasks` vacía, y auditar una colección vacía es perder cobertura
// en silencio. `pendientes` es la colección canónica de trabajo.
const ANCLA_COLLECTIONS = ['planes', 'pendientes', 'bugs'];
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

// PLAN-2337 C7: foto determinística de los pasos requeridos del wizard para
// cada inquilino. Reusa el catálogo y los detectores reales del onboarding:
// duplicar acá una lista o mirar solo presencia volvería a introducir falsos
// verdes. La colisión Infisical host↔inquilino es una regresión confirmada y
// tiene prioridad sobre cualquier `warn` por pasos pendientes. Usa `fail` y no
// un estado propio porque el frontend deriva la clase CSS como
// `hp-dot--${status}`: un estado nuevo se renderiza sin color en silencio.
export async function checkOnboarding() {
  const id = 'onboarding';
  const label = 'Onboarding de inquilinos';
  let tenants;
  try {
    const host = hostUser();
    tenants = listUsers().filter((user) => user?.username && user.username !== host);
  } catch {
    return { id, label, status: 'warn', detail: 'no pude enumerar los inquilinos para auditar su onboarding' };
  }
  if (!tenants.length) return { id, label, status: 'ok', detail: 'sin inquilinos' };

  let hostEmail = null;
  try { hostEmail = readInfisicalAccountEmail(hostUser()); } catch { /* identidad desconocida: no afirmar colisión */ }

  const incomplete = [];
  const infisicalCollisions = [];
  for (const tenant of tenants) {
    const user = tenant.username;
    const missing = [];
    for (const capability of [...CAPABILITIES].sort((a, b) => a.order - b.order)) {
      let required = true;
      try { required = requiredFor(capability, user); } catch { /* fail-closed: exigir el paso */ }
      if (!required) continue;
      let complete = false;
      try { complete = !!(await capability.detect(user)); } catch { /* fail-closed: paso no cumplido */ }
      if (!complete) missing.push(capability.labelEs || capability.id);
    }
    if (missing.length) incomplete.push({ user, missing });

    let tenantEmail = null;
    try { tenantEmail = readInfisicalAccountEmail(user); } catch { /* sin identidad verificable */ }
    if (hostEmail && tenantEmail && tenantEmail === hostEmail) infisicalCollisions.push(user);
  }

  const missingText = incomplete
    .map(({ user, missing }) => `${user}: ${missing.join(', ')} pendientes`)
    .join(' · ');
  if (infisicalCollisions.length) {
    const collisionText = infisicalCollisions
      .map((user) => `${user}: credencial Infisical del host en espacio ajeno`)
      .join(' · ');
    return {
      id,
      label,
      status: 'fail',
      detail: `${collisionText}${missingText ? ` · pasos requeridos: ${missingText}` : ''}`,
    };
  }
  if (incomplete.length) {
    return { id, label, status: 'warn', detail: missingText };
  }
  return {
    id,
    label,
    status: 'ok',
    detail: `${tenants.length} inquilino(s) con capacidades requeridas completas`,
  };
}

// PLAN-2268: Salud solo lee la foto generada por el runner desacoplado. Nunca
// consulta el daemon Docker desde el request rápido ni barre automáticamente.
function checkDockerHygiene() {
  const id = 'docker-hygiene';
  const label = 'Higiene de Docker';
  let report;
  try {
    report = JSON.parse(fss.readFileSync(DOCKER_HYGIENE_REPORT, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { id, label, status: 'ok', detail: 'sin reporte todavía · Docker es opcional; generar con node bin/cwc-docker-hygiene-runner.js --report' };
    }
    return { id, label, status: 'warn', detail: 'report.json ilegible · regenerar con node bin/cwc-docker-hygiene-runner.js --report' };
  }
  if (report?.status === 'unavailable') {
    return { id, label, status: 'ok', detail: 'Docker no disponible · no afecta la salud de la consola' };
  }

  const danglingVolumes = Number(report?.volumes?.dangling);
  const danglingImages = Number(report?.images?.dangling);
  const volumeBytes = Number(report?.volumes?.bytes);
  const imageBytes = Number(report?.images?.bytes);
  const ts = Number(report?.ts);
  if (![danglingVolumes, danglingImages, volumeBytes, imageBytes, ts].every(Number.isFinite)) {
    return { id, label, status: 'warn', detail: 'report.json incompleto · regenerar con node bin/cwc-docker-hygiene-runner.js --report' };
  }

  const reclaimableBytes = volumeBytes + imageBytes;
  const humanBytes = (bytes) => `${(bytes / 1000 ** 3).toFixed(2)} GB (${bytes} bytes)`;
  if (danglingVolumes >= DOCKER_HYGIENE_VOLUME_WARN || reclaimableBytes >= DOCKER_HYGIENE_BYTES_WARN) {
    return {
      id,
      label,
      status: 'warn',
      detail: `${danglingVolumes} volumen(es) y ${danglingImages} imagen(es) dangling · ${humanBytes(reclaimableBytes)} reclamables · simular con node bin/cwc-docker-hygiene-runner.js --prune; el barrido humano exige --prune --yes`,
    };
  }
  const age = Date.now() - ts;
  if (age < 0 || age > DOCKER_HYGIENE_FRESH_MS) {
    return { id, label, status: 'warn', detail: `reporte viejo (${Math.max(0, Math.floor(age / 3600000))} h) · actualizar con node bin/cwc-docker-hygiene-runner.js --report` };
  }
  return {
    id,
    label,
    status: 'ok',
    detail: `reporte fresco · ${danglingVolumes} volumen(es) y ${danglingImages} imagen(es) dangling · ${humanBytes(reclaimableBytes)} reclamables`,
  };
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

// Verifica el BACKBONE de Pad local (workspace `console`): hoy learning/store,
// retro y tickets/meta-store hablan contra él y si se cae DEGRADAN EN SILENCIO — este
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
    if (r.status === 401 || /invalid or expired session/i.test(r.error || '')) {
      return { id, label, status: 'warn', detail: `Credencial del Pad local vencida o inválida (401) — no es el servicio: corré \`pad auth login --url ${PAD_DEFAULT_URL}\` y aprobá el link en el navegador; las sesiones abiertas recuperan su MCP de Pad con ⚙ Sistema → Backup → 🔄 Reiniciar sesiones.` };
    }
    return { id, label, status: 'warn', detail: `Pad local no responde (${r.error || 'sin detalle'}) — learning/store, retro y tickets/meta-store degradan a best-effort. ¿pad-local.service arriba?` };
  }

  // El host ya respondió: validar también las sesiones tenant, una por una y
  // best-effort. Un error de red no convierte este check en una falsa alarma.
  const invalidTenantTokens = [];
  for (const user of listUsers()) {
    const userId = user?.username;
    if (!userId || userId === hostUser()) continue;
    const token = readUserPadToken(userId, PAD_DEFAULT_URL);
    if (!token) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const probe = await fetch(`${PAD_DEFAULT_URL}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (probe.status === 401) invalidTenantTokens.push(userId);
    } catch { /* sondeo best-effort: ignorar timeout y errores de red */ }
    finally { clearTimeout(timer); }
  }

  const items = Array.isArray(r.data) ? r.data : [];
  const musts = items.filter((c) => padField(c, 'priority') === 'must' && padField(c, 'status') !== 'disabled');
  const hasAnticollision = items.some((c) => {
    const t = `${c?.title || ''} ${c?.content || ''}`.toLowerCase();
    return /anti-?colisi[oó]n|plan-puente|regla dura #12|regla #12/.test(t);
  });
  let status = hasAnticollision ? 'ok' : 'warn';
  let detail = hasAnticollision
    ? `Pad local OK · ${musts.length} convención(es) must · espejo Regla #12 presente`
    : 'Pad local OK pero FALTA en las Conventions el espejo de la Regla dura #12 (anti-colisión entre mundos) — CLAUDE.md y Pad divergieron; recrear la convención';
  if (invalidTenantTokens.length) {
    status = 'warn';
    detail += ` · ⚠️ token de Pad inválido: ${invalidTenantTokens.join(', ')} (se re-loguea solo en su próximo uso)`;
  }
  return { id, label, status, detail };
}

// Materializa las leyes de conectividad de docs/pad-grafo.md directamente
// sobre SQLite. Es deliberadamente read-only, 0 tokens y NUNCA usa MCP; como
// todo check advisory del Pad, cualquier incompatibilidad degrada a warn.
async function checkPadGrafo() {
  const id = 'pad-grafo';
  const label = 'Grafo de Pad (leyes de conectividad)';
  const dbPath = path.join(os.homedir(), '.pad', 'pad.db');
  if (!fss.existsSync(dbPath)) {
    return { id, label, status: 'warn', detail: 'pad.db no encontrado; no se pudieron verificar las leyes del grafo' };
  }

  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const workspace = db.prepare("SELECT id FROM workspaces WHERE slug = 'console' AND deleted_at IS NULL").get();
    if (!workspace?.id) {
      return { id, label, status: 'warn', detail: 'workspace console no encontrado en pad.db' };
    }

    const vivosCte = `
      WITH vivos AS (
        SELECT i.id, i.parent_id, i.item_number, i.fields, i.tags,
               c.slug AS collection_slug, c.prefix
        FROM items i
        JOIN collections c ON c.id = i.collection_id
        WHERE i.workspace_id = ?
          AND i.deleted_at IS NULL
          AND c.deleted_at IS NULL
      )`;
    const candidatosHuerfanos = db.prepare(`${vivosCte},
      conectados AS (
        SELECT hijo.id
        FROM vivos hijo JOIN vivos padre ON padre.id = hijo.parent_id
        UNION
        SELECT padre.id
        FROM vivos hijo JOIN vivos padre ON padre.id = hijo.parent_id
        UNION
        SELECT l.source_id
        FROM item_links l
        JOIN vivos origen ON origen.id = l.source_id
        JOIN vivos destino ON destino.id = l.target_id
        UNION
        SELECT l.target_id
        FROM item_links l
        JOIN vivos origen ON origen.id = l.source_id
        JOIN vivos destino ON destino.id = l.target_id
        UNION
        SELECT w.source_item_id
        FROM item_wiki_links w
        JOIN vivos origen ON origen.id = w.source_item_id
        JOIN vivos destino ON destino.id = w.target_item_id
        UNION
        SELECT w.target_item_id
        FROM item_wiki_links w
        JOIN vivos origen ON origen.id = w.source_item_id
        JOIN vivos destino ON destino.id = w.target_item_id
      )
      SELECT v.id, v.item_number, v.prefix, v.tags
      FROM vivos v
      LEFT JOIN conectados a ON a.id = v.id
      WHERE a.id IS NULL
      ORDER BY v.item_number`).all(workspace.id);
    const tieneTagIsla = (item) => {
      try {
        const tags = JSON.parse(item.tags || '[]');
        return Array.isArray(tags) && tags.includes('isla');
      } catch {
        return false;
      }
    };
    // Una isla declarada es legítimamente grado 0; el tag es la declaración explícita.
    const huerfanos = candidatosHuerfanos.filter((item) => !tieneTagIsla(item));
    const raicesArquitectura = db.prepare(`${vivosCte}
      SELECT v.id, v.item_number, v.prefix
      FROM vivos v
      WHERE v.collection_slug = 'arquitectura'
        AND NOT EXISTS (SELECT 1 FROM vivos padre WHERE padre.id = v.parent_id)
        AND NOT EXISTS (
          SELECT 1 FROM item_links l
          JOIN vivos destino ON destino.id = l.target_id
          WHERE l.source_id = v.id AND l.link_type = 'parent'
        )
      ORDER BY v.item_number`).all(workspace.id);
    const candidatosSol = db.prepare(`${vivosCte}
      SELECT v.id, v.item_number, v.prefix, v.tags
      FROM vivos v
      WHERE v.collection_slug = 'planes'
        AND json_extract(v.fields, '$.status') = 'active'
        AND v.parent_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM item_links l
          JOIN vivos destino ON destino.id = l.target_id
          WHERE l.source_id = v.id AND l.link_type IN ('parent', 'implements')
        )
      ORDER BY v.item_number`).all(workspace.id);
    const solesSinAncla = candidatosSol.filter((item) => !tieneTagIsla(item));
    const refDe = (item) => `${item.prefix}-${item.item_number}`;
    const raizEsperada = raicesArquitectura.length === 1 && refDe(raicesArquitectura[0]) === 'ARQUI-1258';
    const detail = `grado-0 (sin islas): ${huerfanos.length} · raíces arquitectura: ${raicesArquitectura.length} · soles activos sin ancla: ${solesSinAncla.length}`;
    if (huerfanos.length === 0 && raizEsperada && solesSinAncla.length === 0) {
      return { id, label, status: 'ok', detail };
    }
    const ejemplos = [
      ...(huerfanos.length ? huerfanos : []),
      ...(!raizEsperada ? raicesArquitectura : []),
      ...(solesSinAncla.length ? solesSinAncla : []),
    ]
      .map(refDe)
      .filter((ref, index, refs) => refs.indexOf(ref) === index)
      .slice(0, 5);
    const raizDetail = raicesArquitectura.length === 1 && !raizEsperada
      ? ` · raíz esperada ARQUI-1258, encontrada ${refDe(raicesArquitectura[0])}`
      : '';
    return {
      id,
      label,
      status: 'warn',
      detail: `${detail}${raizDetail}${ejemplos.length ? ` · ejemplos: ${ejemplos.join(', ')}` : ''}`,
    };
  } catch (err) {
    return { id, label, status: 'warn', detail: `no se pudo verificar pad.db (${String(err?.message || err).slice(0, 180)})` };
  } finally {
    try { db?.close(); } catch { /* best-effort: Salud nunca tira por Pad */ }
  }
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
// original se declara una sola vez en la raíz: planes/pendientes/bugs hijos lo heredan
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
    checkTmuxOwner(),
    Promise.resolve(checkRunners()),
    Promise.resolve(checkObserver()),
    Promise.resolve(checkClaudeCred()),
    Promise.resolve(checkCert()),
    checkGit(),
    checkSyntax(),
    checkDisk(),
    Promise.resolve(checkData()),
    Promise.resolve(checkDeps()),
    Promise.resolve(checkVendorDrift()),
    checkUnifiBridge(),
    Promise.resolve(checkTolkienContextSync()),
    Promise.resolve(checkFichasModulo()),
    Promise.resolve(checkFacetas()),
    checkI18n(),
    Promise.resolve(checkCrossWorld()),
    Promise.resolve(checkTolkienEnvs()),
    Promise.resolve(checkOnboardProvisioning()),
    checkOnboarding(),
    Promise.resolve(checkDockerHygiene()),
    checkPadBackbone(),
    checkPadGrafo(),
    checkPadIndex(),
    checkPadBootstrap(),
    checkAncla(),
    checkSponsoredUsage(),
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

function spawnReview(full, requester) {
  const env = requesterSdkEnv(requester);
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
    detached: true, stdio: ['ignore', logFd, logFd], env,
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
function spawnFix(findingIdArg, tandem = false, requester) {
  const env = requesterSdkEnv(requester);
  if (isRunning() || isFixing()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFixLock(0); // placeholder inmediato; el runner lo pisa con su pid real al arrancar (heartbeat)
  const logFd = fss.openSync(HEALTHFIX_LOG, 'a');
  const args = [HEALTHFIX_RUNNER, findingIdArg];
  if (tandem) args.push('--tandem'); // opt-in (2026-07-19): Codex ejecuta, Claude verifica
  const child = spawn(process.execPath, args, {
    detached: true, stdio: ['ignore', logFd, logFd], env,
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
function spawnOrchestrator(requester) {
  const env = requesterSdkEnv(requester);
  if (isRunning() || isFixing() || isBatchRunning()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeBatchLock(0); // placeholder; el runner lo pisa con su pid real (heartbeat)
  let logFd = null;
  try {
    logFd = fss.openSync(ORCH_LOG, 'a');
    const child = spawn(process.execPath, [ORCHESTRATOR], {
      detached: true, stdio: ['ignore', logFd, logFd], env,
    });
    child.on('error', () => { try { clearBatchLock(); } catch { /* noop */ } }); // spawn falló → liberar la reserva (BUG-44)
    child.unref();
    fss.closeSync(logFd);
    logFd = null;
    return true;
  } catch (err) {
    if (logFd != null) try { fss.closeSync(logFd); } catch { /* noop */ }
    try { clearBatchLock(); } catch { /* noop */ }
    throw err;
  }
}

// Lanza el runner de OPTIMIZACIÓN IA (bin/cwc-optimize-runner.js): censo de
// motores + consumo real + análisis con sonnet → propuestas. Mismo cierre de
// carrera que spawnFix: la RESERVA del lock (pid:0) se escribe acá, sincrónica,
// en el mismo turno de JS que decide spawnear; el runner la reclama con su pid.
const OPT_RUNNER = path.join(ROOT, 'bin', 'cwc-optimize-runner.js');
function spawnOptimize(requester) {
  const env = requesterSdkEnv(requester);
  if (isOptRunning()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeOptLock({ pid: 0, phase: 'arrancando…' }); // reserva; el runner la pisa con su pid real
  let logFd = null;
  try {
    logFd = fss.openSync(OPT_LOG, 'a');
    const child = spawn(process.execPath, [OPT_RUNNER], {
      detached: true, stdio: ['ignore', logFd, logFd], env,
    });
    child.on('error', () => { try { clearOptLock(); } catch { /* noop */ } });
    child.unref();
    fss.closeSync(logFd);
    logFd = null;
    return true;
  } catch (err) {
    if (logFd != null) try { fss.closeSync(logFd); } catch { /* noop */ }
    try { clearOptLock(); } catch { /* noop */ }
    throw err;
  }
}

// Lanza el runner del MÓDULO DE COHERENCIA (bin/cwc-coherence-runner.js): grafo
// de dependencias + hallazgos de cableado + análisis con sonnet → propuestas.
// Mismo cierre de carrera que spawnOptimize (reserva pid:0 sincrónica).
const COH_RUNNER = path.join(ROOT, 'bin', 'cwc-coherence-runner.js');
function spawnCoherence(requester) {
  const env = requesterSdkEnv(requester);
  if (isCohRunning()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeCohLock({ pid: 0, phase: 'arrancando…' }); // reserva; el runner la pisa con su pid real
  let logFd = null;
  try {
    logFd = fss.openSync(COH_LOG, 'a');
    const child = spawn(process.execPath, [COH_RUNNER], {
      detached: true, stdio: ['ignore', logFd, logFd], env,
    });
    child.on('error', () => { try { clearCohLock(); } catch { /* noop */ } });
    child.unref();
    fss.closeSync(logFd);
    logFd = null;
    return true;
  } catch (err) {
    if (logFd != null) try { fss.closeSync(logFd); } catch { /* noop */ }
    try { clearCohLock(); } catch { /* noop */ }
    throw err;
  }
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
      // ?mine=1 → filtrar SIEMPRE por dueño, incluso siendo admin. Lo usa la Vista
      // Raw, que es un monitor personal. Sin el flag, el comportamiento no cambia:
      // el modal "Trabajos en segundo plano" sigue mostrándole todo al admin.
      const onlyMine = req.query.mine === '1' || req.query.mine === 'true';
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
      if (onlyMine) {
        const me = principal?.username || hostUser();
        processes = processes.filter((p) => {
          const owner = activeRunnerOwner(p);
          return owner === me || (owner == null && me === hostUser());
        });
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
          return res.status(err?.badRequest ? 400 : 500).json({ error: `No se pudo aprobar: ${String(err?.message || err).slice(0, 160)}` });
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
        if (!spawnFix(id, req.body?.tandem === true, requesterFor(req))) {
          return res.status(409).json({ error: 'Ya hay una resolución automática en curso (una a la vez).' });
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(err?.conflict ? 409 : 500).json({ error: `No se pudo lanzar el auto-fix: ${String(err?.message || err).slice(0, 200)}` });
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
      if (ids.length > MAX_BATCH) return res.status(400).json({ error: `Demasiados hallazgos en un batch (máx ${MAX_BATCH}).` });
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
      const requester = requesterFor(req);
      try { requesterSdkEnv(requester); }
      catch (err) { return res.status(err?.conflict ? 409 : 500).json({ error: String(err?.message || err).slice(0, 200) }); }
      writeBatch({ startedAt: Date.now(), updatedAt: Date.now(), running: true, phase: 'arrancando…', done: 0, total: items.length, items, rejected });
      try {
        if (!spawnOrchestrator(requester)) {
          return res.status(409).json({ error: 'Ya hay una resolución en curso.' });
        }
        res.json({ ok: true, queued: items.length, rejected });
      } catch (err) {
        writeBatch({ ...(readBatch() || {}), running: false, phase: 'error', error: String(err?.message || err).slice(0, 200), updatedAt: Date.now() });
        res.status(err?.conflict ? 409 : 500).json({ error: `No se pudo lanzar el orquestador: ${String(err?.message || err).slice(0, 200)}` });
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
        if (!spawnOptimize(requesterFor(req))) return res.status(409).json({ error: 'Ya hay un análisis de optimización en curso.' });
        res.json({ ok: true });
      } catch (err) {
        res.status(err?.conflict ? 409 : 500).json({ error: `No se pudo lanzar el análisis: ${String(err?.message || err).slice(0, 200)}` });
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
      if ((p.status && p.status !== 'pending') || p.padRef) return res.status(409).json({ error: 'La propuesta ya fue decidida.' });
      const key = `optimize:${id}`;
      if (inflightProposals.has(key)) return res.status(409).json({ error: 'La propuesta ya se está procesando.' });
      inflightProposals.add(key);
      let padRef = null;
      try {
        if (action === 'accept') {
          try { padRef = await createTaskFromProposal(p, 'optimize'); }
          catch (err) { console.error('[health] no pude crear tarea en Pad (optimize):', err?.message); }
        }
        const fresh = readOpt();
        const freshProposal = (fresh.propuestas || []).find((x) => x.id === id);
        if (!freshProposal) return res.status(409).json({ error: 'La propuesta cambió durante la decisión (¿se re-analizó?).', padRef });
        freshProposal.status = action === 'accept' ? 'accepted' : 'rejected';
        freshProposal.decidedAt = Date.now();
        if (padRef) freshProposal.padRef = padRef;
        writeOpt(fresh);
        return res.json({ ok: true, padRef });
      } finally {
        inflightProposals.delete(key);
      }
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
        if (!spawnCoherence(requesterFor(req))) return res.status(409).json({ error: 'Ya hay un análisis de coherencia en curso.' });
        res.json({ ok: true });
      } catch (err) {
        res.status(err?.conflict ? 409 : 500).json({ error: `No se pudo lanzar el análisis: ${String(err?.message || err).slice(0, 200)}` });
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
      if ((p.status && p.status !== 'pending') || p.padRef) return res.status(409).json({ error: 'La propuesta ya fue decidida.' });
      const key = `coherence:${id}`;
      if (inflightProposals.has(key)) return res.status(409).json({ error: 'La propuesta ya se está procesando.' });
      inflightProposals.add(key);
      let padRef = null;
      try {
        if (action === 'accept') {
          try { padRef = await createTaskFromProposal(p, 'coherence'); }
          catch (err) { console.error('[health] no pude crear tarea en Pad (coherence):', err?.message); }
        }
        const fresh = readCoh();
        const freshProposal = (fresh.propuestas || []).find((x) => x.id === id);
        if (!freshProposal) return res.status(409).json({ error: 'La propuesta cambió durante la decisión (¿se re-analizó?).', padRef });
        freshProposal.status = action === 'accept' ? 'accepted' : 'rejected';
        freshProposal.decidedAt = Date.now();
        if (padRef) freshProposal.padRef = padRef;
        writeCoh(fresh);
        return res.json({ ok: true, padRef });
      } finally {
        inflightProposals.delete(key);
      }
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
        const started = spawnReview(req.body?.full === true, requesterFor(req));
        res.json({ ...readReview(), running: true, started });
      } catch (err) {
        res.status(err?.conflict ? 409 : 500).json({ error: `No se pudo lanzar la revisión: ${String(err?.message || err).slice(0, 200)}` });
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
      const requester = requesterFor(req);
      try { requesterSdkEnv(requester); }
      catch (err) { return res.status(err?.conflict ? 409 : 500).json({ error: `No se pudo lanzar el escaneo: ${String(err?.message || err).slice(0, 200)}` }); }
      try {
        const mode = req.body?.full === true ? 'full' : 'incremental';
        // Reserva SINCRÓNICA del lock (pid:0) antes del spawn — cierra la ventana
        // TOCTOU (el runner la reclama con su pid, patrón BUG-48).
        writeScanLock(0);
        writeScan({ running: true, startedAt: Date.now(), updatedAt: Date.now(), mode, phase: 'arrancando', progress: null, pad: null, verdict: null, error: null });
        spawnScanRunner(mode, requester);
        res.json({ ok: true, running: true, mode });
      } catch (err) {
        clearScanLock();
        writeScan({ ...(readScan() || {}), running: false, updatedAt: Date.now(), finishedAt: Date.now(), error: String(err?.message || err).slice(0, 200) });
        res.status(err?.conflict ? 409 : 500).json({ error: `No se pudo lanzar el escaneo: ${String(err?.message || err).slice(0, 200)}` });
      }
    });
    // Write-back: crear un BUG en Pad desde un hallazgo NUEVO confirmado (con OK
    // del humano en el front). 0 tokens (HTTP a Pad).
    r.post('/scan-pad-bug', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const finding = req.body?.finding;
      const validFinding = finding && typeof finding === 'object' && !Array.isArray(finding)
        && ([finding.area, finding.detail].some((value) => typeof value === 'string' && value.trim()));
      if (!validFinding) return res.status(400).json({ error: 'Falta un hallazgo válido (finding con area o detail).' });
      try {
        const ref = await createBugFromFinding(finding);
        res.json({ ok: true, ref });
      } catch (err) {
        const status = err?.upstream ? 502 : 500;
        const prefix = err?.upstream ? 'No se pudo crear el BUG en Pad' : 'No se pudo crear el BUG';
        res.status(status).json({ error: `${prefix}: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    router.use('/health', r);
  },
};
