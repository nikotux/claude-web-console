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
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../core/config.js';
import { isAdmin } from '../../core/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del proyecto
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const CACHE_FILE = path.join(DATA_DIR, 'health.json');
const REVIEW_TIMEOUT_MS = 8 * 60 * 1000; // leer un repo entero lleva minutos
const MAX_TURNS = 80;

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

// ===== revisión profunda con Claude (READ-ONLY blindada) =====

const VERDICTS = new Set(['ok', 'atencion', 'critico']);
const SEVERITY = new Set(['critical', 'high', 'medium', 'low']);

function toolAllowed(name) {
  return ['Read', 'Grep', 'Glob', 'TodoWrite'].includes(name); // SOLO lecturas locales
}

function reviewPrompt(checksSummary) {
  return [
    'Sos el AUDITOR DE SALUD de Claude Web Console. Corrida NO interactiva y de',
    'SOLO LECTURA (no intentes modificar nada ni correr comandos).',
    '',
    'Tarea: leé PRIMERO el CLAUDE.md de la raíz (reglas duras, mapa, convenciones)',
    'y después auditá el código verificando que el proyecto las CUMPLE:',
    '- que src/core/registry.js registre todos los módulos de src/modules/',
    '- que el bind del server sea exclusivo a la IP ZeroTier (nunca 0.0.0.0)',
    '- que la resiliencia se respete (runners desacoplados, tmux para TUIs)',
    '- que las corridas headless del SDK sigan read-only (canUseTool allowlist)',
    '- endpoints sensibles admin-gated; validación de entradas en rutas nuevas',
    '- consistencia frontend (tokens.css, ui/dialog.js, icons.js, guard [hidden])',
    '- deudas o riesgos evidentes (código muerto, TODOs peligrosos, secretos',
    '  versionados, dependencias raras)',
    '',
    'Resultado de los chequeos rápidos automáticos (contexto, no lo repitas):',
    '```json',
    JSON.stringify(checksSummary),
    '```',
    '',
    'Cuando termines respondé ÚNICAMENTE con un bloque ```json con este objeto:',
    '{',
    '  "verdict": "ok" | "atencion" | "critico",',
    '  "summary": "2-4 líneas en criollo sobre el estado general",',
    '  "findings": [ { "area": "string corto (módulo/tema)",',
    '                  "severity": "critical|high|medium|low",',
    '                  "detail": "qué encontraste y por qué importa",',
    '                  "file": "ruta relativa o \'\'" } ]',
    '}',
    'Si está todo bien, verdict "ok" y findings []. Sin texto fuera del bloque.',
  ].join('\n');
}

function parseReview(text) {
  if (!text) return null;
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1].trim() : (text.match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  return {
    verdict: VERDICTS.has(o.verdict) ? o.verdict : 'atencion',
    summary: String(o.summary ?? '').slice(0, 1000),
    findings: (Array.isArray(o.findings) ? o.findings : []).slice(0, 40).map((f) => ({
      area: String(f.area ?? '').slice(0, 80),
      severity: SEVERITY.has(f.severity) ? f.severity : 'medium',
      detail: String(f.detail ?? '').slice(0, 800),
      file: String(f.file ?? '').slice(0, 200),
    })),
  };
}

function readCache() {
  try { return JSON.parse(fss.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { updatedAt: null, verdict: null, summary: null, findings: [], error: null }; }
}
function writeCache(data) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(CACHE_FILE, JSON.stringify(data), { mode: 0o600 });
  } catch (err) { console.error('[health] no pude escribir la caché:', err?.message); }
}

let inFlight = null;

async function runReview() {
  const checksSummary = await runChecks();
  const q = query({
    prompt: reviewPrompt(checksSummary),
    options: {
      cwd: ROOT,
      permissionMode: 'default',
      maxTurns: MAX_TURNS,
      // Doble capa como en tickets: el hook PreToolUse deniega ANTES de la
      // evaluación de permisos (inmune a reglas `allow` de settings, aunque
      // acá no se cargan settingSources); canUseTool cubre el resto.
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => (toolAllowed(input.tool_name)
            ? {}
            : {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Revisión de salud read-only: herramienta no permitida.',
              },
            })],
        }],
      },
      canUseTool: async (name, input) => (toolAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Revisión de salud read-only: herramienta no permitida.' }),
    },
  });

  let text = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`La revisión tardó demasiado (timeout ${Math.round(REVIEW_TIMEOUT_MS / 60000)} min).`)), REVIEW_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
      } else if (m.type === 'result') break;
    }
  })();

  try {
    await Promise.race([pump, timeout]);
  } finally {
    clearTimeout(timer);
    // OJO: close() SIN await — si el subproceso no muere al toque, un await
    // acá deja inFlight colgado para siempre (running:true eterno).
    try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }

  const review = parseReview(text);
  if (!review) throw new Error('No pude interpretar el resultado de la revisión.');
  return review;
}

function refreshReview() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const review = await runReview();
      const data = { updatedAt: Date.now(), ...review, error: null };
      writeCache(data);
      return data;
    } catch (err) {
      const prev = readCache();
      const data = { ...prev, error: String(err?.message || err).slice(0, 300) };
      writeCache(data);
      return data;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
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

    // Última revisión IA (caché) + si hay una corriendo.
    r.get('/review', (req, res) => {
      res.json({ ...readCache(), running: !!inFlight });
    });

    // Corre la revisión IA (LENTA, consume tokens). Solo admin; el front confirma.
    r.post('/review', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const data = await refreshReview();
      res.json({ ...data, running: false });
    });

    router.use('/health', r);
  },
};
