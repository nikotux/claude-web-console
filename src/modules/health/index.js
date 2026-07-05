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
  markFindingResolved,
  readDismissed, recordDismissed, removeDismissed,
  readProposals, writeProposals,
  readBatch, writeBatch, writeBatchLock, isBatchRunning,
} from './shared.js';
import { appendLearnedInvariant } from './invariants.js';
import { classifyFinding } from './policy.js';
import { aiEnginesCensus, generateInventory } from '../../core/inventory.js';
import {
  readOpt, writeOpt, isOptRunning, readOptLock, writeOptLock, OPT_LOG,
} from './optimize-shared.js';

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
  const logFd = fss.openSync(HEALTH_LOG, 'a');
  const args = [HEALTH_RUNNER];
  if (full) args.push('--full'); // ignora la caché → re-audita TODO
  const child = spawn(process.execPath, args, {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
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
function spawnFix(findingIdArg) {
  if (isRunning() || isFixing()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFixLock(0); // placeholder inmediato; el runner lo pisa con su pid real al arrancar (heartbeat)
  const logFd = fss.openSync(HEALTHFIX_LOG, 'a');
  const child = spawn(process.execPath, [HEALTHFIX_RUNNER, findingIdArg], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
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

    // Censo del proyecto (módulos backend/frontend, runners, motores IA),
    // gratis (0 tokens, sin LLM) — reusa generateInventory() (core/inventory.js,
    // caché por fingerprint/mtime, la misma fuente que inventory.md). El front
    // lo muestra como chip compacto que se expande a pedido (2026-07-04):
    // así un módulo/motor NUEVO (p.ej. comunicación entre sesiones) aparece
    // solo, sin registrarlo a mano en ningún lado — salvo en registry.js, que
    // sigue siendo obligatorio para que el módulo CORRA (esto solo lo señala
    // si falta con `unregistered`). ?force=1 ignora el caché y re-escanea YA
    // (botón "refrescar" del front); sin el flag, sirve el caché si nada
    // cambió desde la última vez.
    r.get('/scan', (req, res) => {
      try {
        const { inventory, regenerated } = generateInventory({ force: req.query.force === '1' });
        const unregistered = inventory.modules.filter((m) => !m.registered).map((m) => m.name);
        res.json({
          generatedAt: inventory.generatedAt,
          regenerated,
          counts: inventory.counts,
          unregistered,
          modules: inventory.modules.map((m) => ({ name: m.name, registered: m.registered, purpose: m.purpose })),
          runners: inventory.runners.map((rr) => rr.file),
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
        if (!spawnFix(id)) {
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
    // que la aplica) o reject. NUNCA se aplica nada desde acá — solo se marca.
    r.post('/optimize-proposal', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      const action = req.body?.action;
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Acción inválida (accept|reject).' });
      const st = readOpt();
      const p = (st.propuestas || []).find((x) => x.id === id);
      if (!p) return res.status(404).json({ error: 'Propuesta inexistente (¿se re-analizó?).' });
      p.status = action === 'accept' ? 'accepted' : 'rejected';
      p.decidedAt = Date.now();
      writeOpt(st);
      res.json({ ok: true });
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

    router.use('/health', r);
  },
};
