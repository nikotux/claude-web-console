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
  readReview, isRunning, isFixing, findingId, findingSig, readSolved,
} from './shared.js';

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

function spawnReview() {
  if (isRunning()) return false;
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const logFd = fss.openSync(HEALTH_LOG, 'a');
  const child = spawn(process.execPath, [HEALTH_RUNNER], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  fss.closeSync(logFd);
  return true;
}

// Lanza el runner de auto-fix (resolución autónoma) para UN hallazgo (por id).
function spawnFix(findingIdArg) {
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const logFd = fss.openSync(HEALTHFIX_LOG, 'a');
  const child = spawn(process.execPath, [HEALTHFIX_RUNNER, findingIdArg], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  fss.closeSync(logFd);
}

// Enriquece los hallazgos de review.json con id/sig (derivados del contenido) y
// la marca de RECURRENCIA: el hallazgo coincide (por firma) con algo que YA se
// había resuelto ANTES de arrancar esta revisión → volvió a aparecer.
function enrichReview(state) {
  const startedAt = state.startedAt || 0;
  const solvedBySig = new Map(readSolved().map((e) => [e.sig, e]));
  const findings = (state.findings || []).map((f) => {
    const sig = findingSig(f);
    const solved = solvedBySig.get(sig);
    const recurrent = solved && solved.firstResolvedAt < startedAt
      ? { times: solved.count, firstResolvedAt: solved.firstResolvedAt }
      : null;
    return { ...f, id: findingId(f), sig, recurrent };
  });
  return { ...state, findings };
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
      const exists = (state.findings || []).some((f) => findingId(f) === id);
      if (!exists) return res.status(404).json({ error: 'Hallazgo inexistente (¿se re-analizó?).' });
      try {
        spawnFix(id);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: `No se pudo lanzar el auto-fix: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    // Lanza la revisión exhaustiva (runner detached, LENTA, consume tokens).
    // Responde INMEDIATO (arrancar+encuestar); el front encuesta GET /review.
    // Solo admin; el front confirma antes.
    r.post('/review', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        // spawnReview() devuelve false si YA había una revisión corriendo:
        // started refleja si ESTE POST lanzó una nueva o no.
        const started = spawnReview();
        res.json({ ...readReview(), running: true, started });
      } catch (err) {
        res.status(500).json({ error: `No se pudo lanzar la revisión: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    router.use('/health', r);
  },
};
