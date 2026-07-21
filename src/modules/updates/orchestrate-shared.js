// modules/updates/orchestrate-shared.js — lógica del BOTÓN ÚNICO de actualización
// orquestada. La ORQUESTA un runner desacoplado (bin/cwc-updates-runner.js, regla
// de oro/regla 2): el update dispara un reinicio del server, así que la
// orquestación NO puede vivir en el proceso que se va a reiniciar — corre detached
// con KillMode=process (sobrevive el reinicio que él mismo dispara, igual que los
// chat-runners) y estado PERSISTIDO/REANUDABLE en ~/.cwc-data/updates-job.json.
//
// Fases (principios del orquestador — planear el orden, drenar, aplicar, verificar,
// reiniciar, reanudar):
//   1 planning   → censo fresco + plan ordenado (reversibles primero, apt al final)
//   2 draining   → interfono a las sesiones + espera acotada a que el fondo repose
//   3 applying   → npm→wanted (estable, in-range) · claude update · apt upgrade
//   4 verifying  → node --check (falla ⇒ ABORTA, no reinicia) + Salud
//   5 restarting → el runner reinicia el server y sigue vivo esperando que vuelva
//   6 resuming   → interfono "listo, seguí" + job done
//
// Decisiones de Niko (PLAN-779): "estable conservador" = npm SOLO a `wanted`
// (dentro del rango de package.json); los saltos MAYORES se listan aparte, nunca
// se aplican solos. Alcance COMPLETO = incluye apt (avisa si pide reboot de
// máquina, pero NO reinicia la máquina). baileys excluido (su latest es un RC).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { config } from '../../core/config.js';
import { findZeroTierIp } from '../../core/zerotier.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { collectActiveRunners } from '../health/shared.js';
import { sendMessage } from '../../core/bus.js';
import { buildUpdatesCensus, installedVersion, run, ROOT } from './shared.js';
import { isPrerelease, riskKey } from './analyze-shared.js';

const DATA_DIR = path.join(config.home, '.cwc-data');
const JOB_FILE = path.join(DATA_DIR, 'updates-job.json');
const LOG_FILE = path.join(DATA_DIR, 'updates-orchestrate.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-updates-runner.js');

// Un job 'running' cuyo heartbeat quedó más viejo que esto = runner muerto (el
// generoso margen cubre npm installs lentos + la ventana del reinicio, ~2-3s en
// que el heartbeat no avanza). El status efectivo lo reporta como error, sin
// colgar el botón para siempre.
export const UPDATES_STALE_MS = 10 * 60 * 1000;

// El nombre de la unidad systemd de la consola (mismo que usa el resto del repo).
const SERVICE = 'claude-web-console';

export function readJob() {
  try { return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')); } catch { return null; }
}
export function writeJob(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeJsonAtomic(JOB_FILE, data);
}
export function isRunning(job) {
  return !!job && job.running === true && (Date.now() - (job.heartbeat || job.startedAt || 0)) <= UPDATES_STALE_MS;
}
// Estado EFECTIVO para el front: un job 'running' con heartbeat vencido ⇒ el
// runner se murió (no en un reinicio esperado) ⇒ error, no cuelga el botón.
export function effectiveStatus(job) {
  if (!job) return { running: false, phase: null, steps: [], plan: null, log: [], error: null };
  if (job.running && !isRunning(job)) {
    return { ...job, running: false, error: job.error || 'El proceso de actualización se interrumpió (heartbeat vencido). Revisá el estado y reintentá.' };
  }
  return job;
}

const now = () => Date.now();

// ───────── Plan ─────────
// A partir del censo arma el plan ordenado. `scope.apt` decide si el SO entra.
// `includeMajors` = nombres de paquetes cuyo SALTO MAYOR el usuario tildó para
// forzar (override explícito). `verdicts` = veredictos IA (analyze) por riskKey:
// un major 🟢 seguro + confianza ALTA se auto-incluye SIN que el usuario tilde
// nada. En AMBOS casos se aplican a `latest` DESPUÉS de los in-range con la misma
// verificación node --check + abort. Las betas/RC NUNCA entran (isPrerelease).
export function buildPlan(census, scope = { apt: true }, includeMajors = [], verdicts = {}) {
  const libs = census?.npm?.libs || [];
  const wantMajor = new Set((includeMajors || []).map(String));
  // In-range: hay una versión mayor DENTRO del rango de package.json (wanted) que
  // supera a la instalada, y no es una dependencia vigilada (baileys).
  const inRange = libs
    .filter((l) => l.risk !== 'watch' && l.wanted && l.current && l.wanted !== l.current)
    .map((l) => ({ name: l.name, from: l.current, to: l.wanted, risk: l.risk }));
  // Majors: existe una versión FUERA del rango (latest !== wanted) — potencialmente
  // breaking. Se LISTA para revisión; solo se aplica la que el usuario TILDÓ.
  const majors = libs
    .filter((l) => l.risk !== 'watch' && l.latest && l.wanted && l.latest !== l.wanted)
    .map((l) => ({ name: l.name, current: l.current, wanted: l.wanted, latest: l.latest }));
  const majorCandidates = libs
    .filter((l) => l.risk !== 'watch' && l.latest && l.current && l.latest !== l.current && !isPrerelease(l.latest))
    .map((l) => {
      const v = verdicts[riskKey(l.name, l.current, l.latest)];
      let blockedReason = null;
      if (!v) blockedReason = 'sin veredicto IA';
      else if (v.level === 'rompe') blockedReason = 'veredicto IA: rompe';
      else if (v.level === 'riesgoso' && v.confidence === 'baja') blockedReason = 'riesgoso con confianza baja';
      return { lib: l, verdict: v, blockedReason };
    });
  const prereleaseBlocked = libs
    .filter((l) => l.risk !== 'watch' && l.latest && l.current && l.latest !== l.current && isPrerelease(l.latest))
    .map((l) => ({ name: l.name, from: l.current, to: l.latest, reason: 'versión pre-release' }));
  const majorsBlocked = [
    ...majorCandidates
      .filter((c) => c.blockedReason)
      .map(({ lib, blockedReason }) => ({ name: lib.name, from: lib.current, to: lib.latest, reason: blockedReason })),
    ...prereleaseBlocked,
  ];
  // Majors a APLICAR: (a) AUTO — veredicto 🟢 seguro + confianza ALTA; o (b)
  // TILDABLE — cualquier otro veredicto no bloqueante, solo si el usuario lo
  // incluyó. NUNCA entran los bloqueados ni las betas/RC.
  const majorsToApply = majorCandidates
    .map(({ lib: l, verdict: v, blockedReason }) => {
      if (blockedReason) return null;
      const autoSafe = v && v.level === 'seguro' && v.confidence === 'alta';
      const forced = wantMajor.has(l.name);
      if (!autoSafe && !forced) return null;
      return { name: l.name, from: l.current, to: l.latest, auto: autoSafe && !forced, verdict: v ? { level: v.level, confidence: v.confidence } : null };
    })
    .filter(Boolean);
  const claudeCli = census?.claudeCli && census.claudeCli.manageable !== false && !census.claudeCli.upToDate && census.claudeCli.latest
    ? { from: census.claudeCli.current, to: census.claudeCli.latest }
    : null;
  const apt = scope.apt && census?.apt?.count
    ? { count: census.apt.count, pkgs: (census.apt.pkgs || []).map((p) => p.name) }
    : null;
  const watch = (census?.watched || []).map((w) => w.name);
  // Hay vulnerabilidades con fix seguro disponible → un paso `npm audit fix`.
  const vulnFix = (census?.npm?.vulns || []).some((v) => v.fixAvailable);
  return { inRange, majors, majorsToApply, majorsBlocked, claudeCli, apt, watch, vulnFix };
}

// Cuántas acciones REALES tiene el plan (para el confirm y para no reiniciar al
// pedo si no había nada que hacer).
export function planActionCount(plan) {
  return (plan?.vulnFix ? 1 : 0) + (plan?.inRange?.length || 0) + (plan?.majorsToApply?.length || 0) + (plan?.claudeCli ? 1 : 0) + (plan?.apt ? 1 : 0);
}

// ───────── Trabajo en segundo plano (para drenar) ─────────
// Runners de fondo vivos ahora mismo, EXCLUYENDO el propio runner de updates.
export function detectActiveWork() {
  try {
    return collectActiveRunners().filter((r) => r.key !== 'updates' && !String(r.key || '').startsWith('updates'));
  } catch { return []; }
}

// ───────── Interfono ─────────
export function notifyInterfono(text, kind = 'note') {
  try {
    sendMessage({ from: 'system:updates', fromName: '🔄 Actualizaciones', to: 'all', text, kind });
    return true;
  } catch { return false; }
}

// ───────── Aplicado ─────────
export async function applyNpm(name, version) {
  const r = await run('npm', ['install', `${name}@${version}`, '--save-exact=false'], { timeout: 180_000 });
  const ok = !r.failed && !(/npm error|ERR!/.test(r.stderr) && !r.ok);
  if (!ok) return { ok, detail: (r.stderr || r.stdout || 'npm install falló').trim().slice(0, 300) };
  const real = installedVersion(name);
  if (real !== version) {
    return { ok: false, detail: `npm reportó éxito pero quedó instalada la ${real || 'desconocida'}, se esperaba ${version}` };
  }
  return { ok: true, detail: `${name}@${version}` };
}
export async function applyClaudeCli() {
  const r = await run('claude', ['update'], { timeout: 180_000 });
  return { ok: r.ok, detail: (r.stdout || r.stderr || '').trim().slice(0, 400) };
}
// `npm audit fix` SIN --force: aplica solo arreglos DENTRO del rango semver
// (compatibles, reversibles con git) — nunca salta un major. Cierra las
// vulnerabilidades que tienen fix disponible sin romper nada.
export async function applyAuditFix() {
  const r = await run('npm', ['audit', 'fix'], { timeout: 180_000 });
  // npm audit fix sale con código ≠0 si quedan vulns sin fix seguro; eso NO es
  // un fallo del comando (aplicó lo que pudo). Solo es fallo si murió/no corrió.
  return { ok: !r.failed, detail: (r.stdout || r.stderr || '').trim().slice(-300) };
}
// apt necesita sudo. `sudo -n` = falla limpio si NO es passwordless (en vez de
// colgarse pidiendo contraseña). DEBIAN_FRONTEND=noninteractive evita prompts.
export async function applyApt() {
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  const upd = await run('sudo', ['-n', 'apt-get', 'update'], { timeout: 120_000, env });
  if (upd.failed || /a password is required|sudo:/i.test(upd.stderr)) {
    return { ok: false, detail: 'sudo no es passwordless o apt-get update falló: ' + (upd.stderr || '').trim().slice(0, 200), rebootRequired: false };
  }
  const up = await run('sudo', ['-n', 'apt-get', '-y', 'upgrade'], { timeout: 600_000, env });
  const ok = !up.failed && up.ok;
  const rebootRequired = fs.existsSync('/var/run/reboot-required');
  return { ok, detail: ok ? 'apt upgrade OK' : (up.stderr || up.stdout || 'apt upgrade falló').trim().slice(0, 300), rebootRequired };
}

// ───────── node --check (verificación) ─────────
// server.js importa todo el árbol de módulos → un error de sintaxis en cualquiera
// lo revienta al cargarse. Chequeamos server.js + los runners sueltos de bin/ que
// NO se importan desde server.js.
export async function verifySyntax() {
  const files = ['src/server.js'];
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'bin'))) {
      if (f.endsWith('.js')) files.push(path.join('bin', f));
    }
  } catch { /* noop */ }
  const results = [];
  for (const f of files) {
    const r = await run('node', ['--check', f], { timeout: 20_000 });
    results.push({ file: f, ok: r.ok, error: r.ok ? null : (r.stderr || '').trim().slice(0, 300) });
  }
  return { ok: results.every((r) => r.ok), results: results.filter((r) => !r.ok) };
}

// ───────── Reinicio del servicio ─────────
// El runner SOBREVIVE esto (KillMode=process). Espera a que el server vuelva sano.
export async function restartService() {
  await run('systemctl', ['--user', 'restart', SERVICE], { timeout: 60_000 });
}
export async function waitServiceActive({ timeoutMs = 60_000 } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const r = await run('systemctl', ['--user', 'is-active', SERVICE], { timeout: 10_000 });
    if (r.stdout.trim() === 'active') return true;
    await sleep(1000);
  }
  return false;
}

function requestHealth(url, token) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { 'x-cwc-token': token },
      rejectUnauthorized: false,
      timeout: 5000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode === 200, reason: `HTTP ${res.statusCode || 'sin status'}` }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, reason: err?.message || 'error HTTP' }));
    req.end();
  });
}

// Chequeo REAL de que el server volvió a responder (no solo que systemd diga
// "active": en un crash-loop is-active reporta "active"/"activating" de forma
// transitoria). Usa node:https con rejectUnauthorized:false (cert self-signed).
export async function httpAlive({ attempts = 10, gapMs = 3000 } = {}) {
  const found = findZeroTierIp(config.ztIface);
  const token = process.env.CWC_TOKEN?.trim() || config.token;
  if (!found?.ip || !token) return { alive: null, reason: 'no verificable' };
  const url = new URL(`https://${found.ip}:${config.port}/api/health/checks`);
  let reason = 'sin respuesta';
  for (let i = 0; i < attempts; i += 1) {
    const r = await requestHealth(url, token);
    if (r.ok) return { alive: true };
    reason = r.reason;
    if (i < attempts - 1) await sleep(gapMs);
  }
  return { alive: false, reason };
}

// NRestarts de systemd: si subió tras nuestro reinicio, hubo crash-loop.
export async function serviceRestartCount() {
  const r = await run('systemctl', ['--user', 'show', '-p', 'NRestarts', '--value', SERVICE], { timeout: 10_000 });
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function revertNpmChanges() {
  const co = await run('git', ['checkout', '--', 'package.json', 'package-lock.json'], { timeout: 30_000 });
  if (!co.ok) return { ok: false, detail: (co.stderr || co.stdout || 'git checkout falló').trim().slice(0, 300) };
  const inst = await run('npm', ['install'], { timeout: 600_000 });
  const ok = !inst.failed && inst.ok;
  return { ok, detail: ok ? 'package.json/package-lock.json revertidos y npm install OK' : (inst.stderr || inst.stdout || 'npm install falló').trim().slice(0, 300) };
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Tras APLICAR updates, el censo cacheado (updates-census.json) quedó viejo — si
// no se borra, el server (tras el reinicio, con mem=null) sirve el snapshot
// PRE-update y la UI sigue mostrando cosas "por actualizar" que ya se aplicaron
// (bug reportado por Niko). El runner lo llama al terminar de aplicar.
export function invalidateCensusCache() {
  try { fs.rmSync(path.join(DATA_DIR, 'updates-census.json'), { force: true }); } catch { /* best-effort */ }
}

// ───────── Spawn del runner ─────────
export function spawnUpdatesRunner() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(LOG_FILE, 'a');
  try {
    const child = spawn(process.execPath, [RUNNER], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
    child.on('error', (err) => {
      try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`); } catch { /* noop */ }
      const j = readJob();
      if (j && j.running) writeJob({ ...j, running: false, phase: 'error', error: 'No se pudo iniciar el runner de actualización.', finishedAt: now() });
    });
    child.unref();
  } catch (err) {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn THROW: ${err?.message || err}\n`); } catch { /* noop */ }
    const j = readJob();
    if (j && j.running) writeJob({ ...j, running: false, phase: 'error', error: 'No se pudo iniciar el runner de actualización.', finishedAt: now() });
    throw err;
  }
}

// Spawn del runner de ANÁLISIS DE RIESGO (Fase B). Mismo patrón detached+unref.
const ANALYZE_RUNNER = path.join(ROOT, 'bin', 'cwc-updates-analyze-runner.js');
const ANALYZE_LOG = path.join(DATA_DIR, 'updates-analyze.log');
export function spawnAnalyzeRunner() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(ANALYZE_LOG, 'a');
  try {
    const child = spawn(process.execPath, [ANALYZE_RUNNER], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
    child.on('error', (err) => { try { fs.appendFileSync(ANALYZE_LOG, `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`); } catch { /* noop */ } });
    child.unref();
  } catch (err) {
    try { fs.appendFileSync(ANALYZE_LOG, `[${new Date().toISOString()}] spawn THROW: ${err?.message || err}\n`); } catch { /* noop */ }
    throw err;
  }
}

export { JOB_FILE, LOG_FILE, DATA_DIR, SERVICE };
