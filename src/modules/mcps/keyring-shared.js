// modules/mcps/keyring-shared.js — el panel mostraba las PUERTAS (los MCP),
// pero nunca el LLAVERO. Casi todo lo que se rompe solo es una credencial que
// vence: Claude OAuth, Codex, gh, token de Pad, sesión de WhatsApp. Este módulo
// son las SONDAS: sin UI y sin estado global.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { TOLKIEN_EXPIRY_WARN_DAYS, tolkienStatus } from '../../core/connections-tolkien.js';
import { PAD_DEFAULT_URL } from '../../core/pad-url.js';
import {
  CODEX_TOKEN_TTL_MS,
  hostUser,
  readInfisicalAccountEmail,
  readUserPadToken,
  userCodexAuthPath,
  userSpace,
} from '../../core/user-space.js';
import {
  infisicalDependents,
  probeInfisicalProject,
  probeInfisicalStatus,
  readInfisicalIdentity,
} from './infisical-shared.js';
import { commandEnvFor } from './login-shared.js';

export const EXPIRY_WARN_MS = 2 * 24 * 60 * 60 * 1000; // < 2 días => preventivo
// Las credenciales auto-renovables no deben avisar antes de vencer: su ciclo
// normal es vivir pocos minutos. 30 min dan margen al refresco automático y,
// a la vez, detectan rápido cuando dejó de ocurrir.
export const AUTO_GRACE_MS = 30 * 60 * 1000;
export const KEYRING_EXPENSIVE_PROBES = new Set(['infisical']);

const DAY_MS = 24 * 60 * 60 * 1000;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const SHAPE = {
  id: '',
  family: 'keys',
  label: '',
  role: '',
  light: 'neutral',
  statusLabel: '',
  detail: '',
  autoRefresh: false,
  expiresAt: null,
  expiresInMs: null,
  warnMs: null,
  checkedAt: null,
  dependents: [],
  action: null,
  error: null,
};

// Cada credencial puede alinear su aviso con el umbral de su propio backend.
export function expiryLight(expiresAt, { autoRefresh = false, warnMs = EXPIRY_WARN_MS } = {}) {
  if (expiresAt == null || expiresAt === '') return 'neutral';
  const t = Number(expiresAt);
  if (!Number.isFinite(t) || t <= 0) return 'neutral';
  const left = t - Date.now();
  if (autoRefresh) {
    if (left > 0) return 'ok';
    if (left >= -AUTO_GRACE_MS) return 'warn';
    return 'danger';
  }
  if (left <= 0) return 'danger';
  if (left < warnMs) return 'warn';
  return 'ok';
}

function item(data) {
  return { ...SHAPE, ...data };
}

function cleanText(s) {
  return String(s || '').replace(ANSI_RE, '').trim();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function normIdentity(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function codexEmail(auth) {
  try {
    const encoded = auth?.tokens?.id_token?.split('.')?.[1];
    if (!encoded) return null;
    return normIdentity(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))?.email);
  } catch { return null; }
}

function sameNonEmptySecret(a, b) {
  return typeof a === 'string' && a.trim().length > 0
    && typeof b === 'string' && b.trim().length > 0 && a === b;
}

async function fetchPadIdentity(url, token, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${String(url).replace(/\/+$/, '')}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, network: false };
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, status: res.status, network: false, invalidJson: true };
    }
  } catch (e) {
    return { ok: false, network: true, error: String(e?.message || e || '').slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

function toMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function expiresIn(expiresAt) {
  const t = toMs(expiresAt);
  return t == null ? null : t - Date.now();
}

function durationText(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'sin vencimiento conocido';
  const abs = Math.abs(ms);
  const suffix = ms < 0 ? 'venció hace ' : 'vence en ';
  const days = Math.floor(abs / DAY_MS);
  const hours = Math.floor((abs % DAY_MS) / (60 * 60 * 1000));
  const mins = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000));
  if (days > 0) return `${suffix}${days}d ${hours}h`;
  if (hours > 0) return `${suffix}${hours}h ${mins}m`;
  return `${suffix}${mins}m`;
}

function statusFromLight(light, { autoRefresh = false } = {}) {
  if (light === 'danger') return 'Vencido';
  if (light === 'warn') return autoRefresh ? 'Renovando…' : 'Vence pronto';
  if (light === 'ok') return 'Conectado';
  return 'Sin vencimiento';
}

function dependentsWhat(dependents, fallback) {
  const text = Array.isArray(dependents) && dependents.length ? dependents.join(', ') : fallback;
  return `Qué se rompe si no lo hacés: ${text}.`;
}

function reconnectActionFor(it) {
  const deps = Array.isArray(it?.dependents) ? it.dependents : [];
  if (it?.id === 'claude-oauth') return {
    // console:PLAN-2446 — dejó de ser "copiá este comando": el login corre en un
    // runner desacoplado y la consola guía el flujo. `setup-token` (lo que decía
    // antes) emite un token de larga duración y NO es lo que repara
    // ~/.claude/.credentials.json; eso lo hace `claude auth login --claudeai`,
    // que es lo que corre el runner.
    kind: 'claude-login',
    command: null,
    title: 'Reconectar Claude OAuth',
    what: 'Qué se rompe si no lo hacés: no funciona ningún chat ni motor.',
    steps: [
      'Tocá «Iniciar login» acá abajo.',
      'Abrí el link de autorización que aparece y autorizá con tu cuenta de Claude.',
      'Pegá acá el código que te muestra la pantalla de confirmación.',
      'Esperá la verificación automática.',
    ],
  };
  if (it?.id === 'codex-cli') return {
    kind: 'codex-login',
    command: null,
    title: 'Reconectar Codex CLI',
    what: 'Qué se rompe si no lo hacés: el modelo Tándem no puede delegar la ejecución.',
    steps: [
      'Tocá «Iniciar login» acá abajo.',
      'Abrí el enlace que aparece.',
      'Escribí en el navegador el código que muestra la consola.',
      'Esperá la verificación automática.',
    ],
  };
  if (it?.id === 'pad-cloud') return {
    // console:PLAN-2446 — CORRECCIÓN: antes decía que este OAuth sólo lo podía
    // refrescar Claude Code y que la consola no tenía forma de reconectarlo.
    // Era falso: `claude mcp login pad-cloud-backup` reautoriza el MCP HTTP, y
    // la consola ya lo corre por `bin/cwc-mcp-login-runner.js` con el mismo
    // wizard que usan los demás MCP del panel.
    kind: 'mcp-login',
    world: 'console',
    name: 'pad-cloud-backup',
    command: null,
    title: 'Reconectar Pad Cloud OAuth',
    what: dependentsWhat(deps, 'dashboard de PRs de Tolkien'),
    steps: [
      'Tocá «Reconectar» acá abajo.',
      'Abrí el enlace de autorización que aparece y aprobá el acceso.',
      'Pegá de vuelta la URL a la que te redirige el navegador.',
      'Esperá la verificación automática.',
    ],
  };
  if (it?.id === 'infisical') return {
    kind: 'infisical-login',
    title: 'Reconectar Infisical',
    what: dependentsWhat(deps, 'MCPs stdio que leen secretos'),
    steps: [
      'Abrí el login de Infisical desde esta consola.',
      'Completá la autorización en el navegador.',
      'Pegá el token de retorno si el navegador no puede hablar con la consola.',
      'Esperá la verificación automática.',
    ],
  };
  if (it?.id === 'github-cli') return {
    kind: 'github-login',
    command: null,
    title: 'Reconectar GitHub CLI',
    what: dependentsWhat(deps, 'PRs, comunicaciones y censo de actualizaciones'),
    steps: [
      'Tocá «Iniciar login» acá abajo.',
      'Abrí el enlace que aparece.',
      'Escribí en el navegador el código que muestra la consola.',
      'Esperá la verificación automática.',
    ],
  };
  if (it?.id === 'pad-local') return {
    kind: 'pad-login',
    command: null,
    title: 'Reconectar Pad local',
    what: 'Qué se rompe si no lo hacés: Pendientes, Aprendizaje y Mejora Continua degradan en silencio.',
    steps: [
      'Tocá «Iniciar login» acá abajo.',
      'Abrí el enlace que aparece.',
      'Autorizá en el navegador.',
      'Esperá la verificación automática.',
    ],
  };
  if (it?.id === 'tolkien-session') return {
    kind: 'tolkien-login',
    command: null,
    title: 'Conectar la sesión de Tolkien',
    what: dependentsWhat(deps, 'el censo y el cierre en masa de tickets de Tolkien'),
    steps: [
      'Tocá «Reconectar» acá abajo: abre el asistente de conexión.',
      'El asistente te muestra dónde copiar el valor de la cookie de sesión desde TU navegador.',
      'Pegalo en el campo del asistente.',
      'Esperá la verificación automática contra Tolkien.',
    ],
  };
  if (it?.id === 'whatsapp') return {
    kind: 'service-restart',
    serviceId: it.id,
    command: 'systemctl --user restart whatsapp-bridge',
    title: 'Reconectar WhatsApp bridge',
    what: dependentsWhat(deps, 'traer hilos y audios de WhatsApp'),
    steps: [
      'Tocá «Reiniciar y verificar» acá abajo.',
      'Esperá a que systemd levante el servicio.',
      'La consola confirma sola si quedó activo.',
      'Si la sesión de Baileys se perdió del todo, va a hacer falta re-emparejar WhatsApp con el QR: el reinicio solo no alcanza en ese caso.',
    ],
  };
  if (String(it?.id || '').startsWith('service-')) {
    const name = String(it.id).replace(/^service-/, '') || String(it.label || '');
    return {
      kind: 'service-restart',
      serviceId: it.id,
      command: `systemctl --user restart ${name}`,
      title: `Reconectar ${it.label || name}`,
      what: dependentsWhat(deps, `servicio ${it.label || name}`),
      steps: [
        'Tocá «Reiniciar y verificar» acá abajo.',
        'Esperá a que systemd levante el servicio.',
        'La consola confirma sola si quedó activo.',
      ],
    };
  }
  return it?.action || null;
}

function enrichAction(it) {
  const base = it?.action || reconnectActionFor(it);
  if (!base) return null;
  const full = reconnectActionFor(it) || {};
  return { ...full, ...base };
}

export function refreshDerived(items) {
  return (Array.isArray(items) ? items : []).map((raw) => {
    const out = item(raw || {});
    const expiresAt = toMs(out.expiresAt);
    if (expiresAt != null) {
      out.expiresAt = expiresAt;
      out.expiresInMs = expiresAt - Date.now();
      const warnMs = Number.isFinite(out.warnMs) && out.warnMs > 0 ? out.warnMs : EXPIRY_WARN_MS;
      out.light = expiryLight(expiresAt, { autoRefresh: !!out.autoRefresh, warnMs });
      out.statusLabel = statusFromLight(out.light, { autoRefresh: !!out.autoRefresh });
    }
    out.action = enrichAction(out);
    return out;
  });
}

function runFile(cmd, args, { cwd, timeout, env }) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function firstNonEmpty(...parts) {
  return parts.map((p) => String(p || '').trim()).find(Boolean) || '';
}

function hasSessionToken(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [k, v] of Object.entries(value)) {
    if (v && typeof v === 'object' && hasSessionToken(v)) return true;
    if (typeof v !== 'string' || !v.trim()) continue;
    if (/token|session/i.test(k)) return true;
  }
  return false;
}

function httpAlive(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (alive, error = null) => {
      if (done) return;
      done = true;
      resolve({ alive, error });
    };
    let req;
    try {
      req = http.get(url, (res) => {
        res.resume();
        finish(true);
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish(false, `timeout ${Math.round(timeoutMs / 1000)}s`);
      });
      req.on('error', (e) => finish(false, String(e?.message || e || '').slice(0, 200)));
    } catch (e) {
      finish(false, String(e?.message || e || '').slice(0, 200));
    }
  });
}

export async function serviceActive(scope, name) {
  try {
    const { stdout, stderr } = await runFile('systemctl', ['--user', 'is-active', name], {
      cwd: scope.home,
      timeout: 4000,
      env: commandEnvFor(scope),
    });
    return firstNonEmpty(cleanText(stdout), cleanText(stderr), 'unknown').split('\n')[0];
  } catch (e) {
    return String(e?.message || e || 'unknown').slice(0, 120);
  }
}

export async function probeClaudeOauth(scope) {
  try {
    const creds = readJson(path.join(scope.claudeDir, '.credentials.json'));
    const oauth = creds?.claudeAiOauth || {};
    const expiresAt = toMs(oauth.expiresAt);
    const expiresInMs = expiresIn(expiresAt);
    const autoRefresh = true;
    const isolatedToken = !scope.isHost && fs.existsSync(path.join(scope.claudeDir, 'oauth-token'));
    if (expiresAt == null && isolatedToken) {
      return item({
        id: 'claude-oauth',
        family: 'engines',
        label: 'Claude OAuth',
        role: 'credencial principal de Claude Code',
        light: 'ok',
        statusLabel: 'Configurado',
        detail: 'token propio del usuario presente · vencimiento no expuesto',
        dependents: ['todos los chats, runners y motores headless del usuario'],
        action: reconnectActionFor({ id: 'claude-oauth' }),
      });
    }
    const light = expiresAt == null ? 'danger' : expiryLight(expiresAt, { autoRefresh });
    const subscription = oauth.subscriptionType || 'sin plan detectado';
    return item({
      id: 'claude-oauth',
      family: 'engines',
      label: 'Claude OAuth',
      role: 'credencial principal de Claude Code',
      light,
      statusLabel: expiresAt == null ? 'Sin sesión' : statusFromLight(light, { autoRefresh }),
      detail: `${subscription} · se renueva solo (${durationText(expiresInMs)})`,
      autoRefresh,
      expiresAt,
      expiresInMs,
      dependents: ['todos los chats, runners y motores headless'],
      action: reconnectActionFor({ id: 'claude-oauth' }),
      error: expiresAt == null ? 'no hay vencimiento OAuth en ~/.claude/.credentials.json' : null,
    });
  } catch (e) {
    return item({ id: 'claude-oauth', family: 'engines', label: 'Claude OAuth', role: 'credencial principal de Claude Code', light: 'danger', statusLabel: 'Error de sonda', detail: 'No se pudo leer la sesión de Claude.', dependents: ['todos los chats, runners y motores headless'], action: reconnectActionFor({ id: 'claude-oauth' }), error: String(e?.message || e || '').slice(0, 300) });
  }
}

export async function probeCodexCli(scope) {
  try {
    const auth = readJson(path.join(scope.home, '.codex', 'auth.json'));
    const dependents = ['modelo Tándem (codex exec)', 'límites de Codex en el panel Uso'];
    const action = reconnectActionFor({ id: 'codex-cli' });
    if (!scope.isHost) {
      const email = codexEmail(auth);
      const hostAuth = readJson(userCodexAuthPath(hostUser()));
      const hostEmail = codexEmail(hostAuth);
      const sameToken = sameNonEmptySecret(auth?.tokens?.refresh_token, hostAuth?.tokens?.refresh_token)
        || sameNonEmptySecret(auth?.tokens?.access_token, hostAuth?.tokens?.access_token);
      if (!email || !hostEmail) {
        const detail = 'No se pudo verificar de quién es la sesión de Codex.';
        return item({ id: 'codex-cli', family: 'engines', label: 'Codex CLI', role: 'sesión del motor Tándem', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action, error: detail });
      }
      if (email === hostEmail || sameToken) {
        const detail = 'Es la cuenta de Codex del anfitrión: entrá con la tuya.';
        return item({ id: 'codex-cli', family: 'engines', label: 'Codex CLI', role: 'sesión del motor Tándem', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action, error: detail });
      }
    }
    const lastRefresh = toMs(auth?.last_refresh);
    const expiresAt = lastRefresh == null ? null : lastRefresh + CODEX_TOKEN_TTL_MS;
    const expiresInMs = expiresIn(expiresAt);
    const light = expiresAt == null ? 'danger' : expiryLight(expiresAt);
    const mode = auth?.auth_mode || 'sin modo detectado';
    const refreshed = lastRefresh == null ? 'sin refresh registrado' : `refresh ${new Date(lastRefresh).toISOString()}`;
    return item({
      id: 'codex-cli',
      family: 'engines',
      label: 'Codex CLI',
      role: 'sesión del motor Tándem',
      light,
      statusLabel: expiresAt == null ? 'Sin sesión' : statusFromLight(light),
      detail: `${mode} · ${refreshed} · vencimiento estimado: ${durationText(expiresInMs)}`,
      expiresAt,
      expiresInMs,
      dependents,
      action,
      error: expiresAt == null ? 'no hay last_refresh en ~/.codex/auth.json' : null,
    });
  } catch (e) {
    return item({ id: 'codex-cli', family: 'engines', label: 'Codex CLI', role: 'sesión del motor Tándem', light: 'danger', statusLabel: 'Error de sonda', detail: 'No se pudo leer la sesión de Codex.', dependents: ['modelo Tándem (codex exec)', 'límites de Codex en el panel Uso'], action: reconnectActionFor({ id: 'codex-cli' }), error: String(e?.message || e || '').slice(0, 300) });
  }
}

export async function probePadCloud(scope) {
  try {
    const creds = readJson(path.join(scope.claudeDir, '.credentials.json'));
    const oauth = creds?.mcpOAuth || {};
    const entries = Object.entries(oauth);
    const found = entries.find(([k]) => k.startsWith('pad|')) || entries.find(([k]) => k.startsWith('pad-cloud-backup|'));
    const expiresAt = toMs(found?.[1]?.expiresAt);
    const expiresInMs = expiresIn(expiresAt);
    const autoRefresh = true;
    const light = found ? expiryLight(expiresAt, { autoRefresh }) : 'danger';
    const detail = found && light === 'danger'
      ? `${durationText(expiresInMs)} · se renueva solo mientras se usa el MCP; si hace falta, reconectalo desde este panel`
      : `${durationText(expiresInMs)} · se renueva solo mientras se usa el MCP`;
    return item({
      id: 'pad-cloud',
      family: 'keys',
      label: 'Pad Cloud OAuth',
      role: 'credencial MCP del Pad remoto',
      light,
      statusLabel: found ? statusFromLight(light, { autoRefresh }) : 'Sin sesión',
      detail: found ? detail : 'No hay OAuth de Pad registrado; reconectalo desde este panel.',
      autoRefresh,
      expiresAt,
      expiresInMs,
      dependents: ['dashboard de PRs de Tolkien (tickets/pad-client.js)'],
      action: reconnectActionFor({ id: 'pad-cloud', dependents: ['dashboard de PRs de Tolkien (tickets/pad-client.js)'] }),
      error: found ? null : 'no hay entrada pad| ni pad-cloud-backup| en mcpOAuth',
    });
  } catch (e) {
    return item({ id: 'pad-cloud', family: 'keys', label: 'Pad Cloud OAuth', role: 'credencial MCP del Pad remoto', light: 'danger', statusLabel: 'Error de sonda', detail: 'No se pudo leer el OAuth MCP de Pad.', dependents: ['dashboard de PRs de Tolkien (tickets/pad-client.js)'], action: reconnectActionFor({ id: 'pad-cloud', dependents: ['dashboard de PRs de Tolkien (tickets/pad-client.js)'] }), error: String(e?.message || e || '').slice(0, 300) });
  }
}

export async function probeInfisicalKey(scope) {
  try {
    const cliCfg = readJson(path.join(scope.home, '.claude.json')) || {};
    const dependents = infisicalDependents(cliCfg);
    const identity = readInfisicalIdentity(scope);
    const [status, project] = await Promise.all([probeInfisicalStatus(scope), probeInfisicalProject(scope)]);
    if (!scope.isHost && status?.ok) {
      const email = normIdentity(status.email);
      const hostEmail = normIdentity(readInfisicalAccountEmail(hostUser()));
      if (!email || !hostEmail) {
        const detail = 'No se pudo verificar de quién es la sesión de Infisical.';
        return item({ id: 'infisical', family: 'keys', label: 'Infisical', role: 'llave de secretos para MCPs stdio', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action: reconnectActionFor({ id: 'infisical', dependents }), error: detail });
      }
      if (email === hostEmail) {
        const detail = 'Es la cuenta de Infisical del anfitrión: entrá con la tuya.';
        return item({ id: 'infisical', family: 'keys', label: 'Infisical', role: 'llave de secretos para MCPs stdio', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action: reconnectActionFor({ id: 'infisical', dependents }), error: detail });
      }
    }
    const expiresAt = status?.ok && status.expiresInMs != null ? Date.now() + status.expiresInMs : null;
    const expiresInMs = status?.ok ? status.expiresInMs : null;
    let light = 'danger';
    let statusLabel = 'Sin sesión';
    if (status?.ok && project?.ok) {
      const expLight = expiryLight(expiresAt);
      light = expLight === 'neutral' ? 'ok' : expLight;
      statusLabel = statusFromLight(light);
    } else if (status?.ok && !project?.ok) {
      statusLabel = 'Sin acceso';
    }
    const account = status?.email || identity.email || 'cuenta no detectada';
    const domain = status?.domain || identity.domain || 'dominio no detectado';
    const secretText = project?.ok && project.secretCount != null ? `${project.secretCount} secretos disponibles` : (project?.error || 'proyecto no verificado');
    const detail = status?.ok
      ? `${account} · ${domain} · ${durationText(expiresInMs)} · ${secretText}`
      : `${account} · ${domain} · ${status?.error || 'sin sesión activa'}`;
    return item({
      id: 'infisical',
      family: 'keys',
      label: 'Infisical',
      role: 'llave de secretos para MCPs stdio',
      light,
      statusLabel,
      detail,
      expiresAt,
      expiresInMs,
      dependents,
      action: reconnectActionFor({ id: 'infisical', dependents }),
      error: !status?.ok ? status?.error || null : (!project?.ok ? project?.error || null : null),
    });
  } catch (e) {
    return item({ id: 'infisical', family: 'keys', label: 'Infisical', role: 'llave de secretos para MCPs stdio', light: 'danger', statusLabel: 'Error de sonda', detail: 'No se pudo verificar Infisical.', action: reconnectActionFor({ id: 'infisical' }), error: String(e?.message || e || '').slice(0, 300) });
  }
}

export async function probeGithubCli(scope) {
  try {
    const dependents = ['PRs y su investigación', 'Comunicaciones', 'censo de Actualizaciones'];
    const action = reconnectActionFor({ id: 'github-cli', dependents });
    const { err, stdout, stderr } = await runFile('gh', ['auth', 'status'], {
      cwd: scope.home,
      timeout: 8000,
      env: commandEnvFor(scope),
    });
    const out = cleanText(`${stdout}\n${stderr}`).split('\n').filter((line) => !/Token:/i.test(line)).join('\n');
    const login = out.match(/Logged in to\s+(\S+)\s+account\s+([^\s]+)/);
    const scopes = out.match(/^\s*-\s*Token scopes:\s*(.+)$/m)?.[1]?.trim() || null;
    if (err || !login) {
      return item({
        id: 'github-cli',
        family: 'keys',
        label: 'GitHub CLI',
        role: 'credencial local de gh',
        light: 'danger',
        statusLabel: 'Sin sesión',
        detail: cleanText(out).slice(0, 300) || 'gh auth status falló',
        dependents,
        action,
        error: cleanText(out).slice(0, 300) || 'gh auth status falló',
      });
    }
    if (!scope.isHost) {
      const ownLogin = normIdentity(login[2]);
      let hostLogins = new Set();
      try {
        const hosts = fs.readFileSync(path.join(userSpace(hostUser()), '.config', 'gh', 'hosts.yml'), 'utf8');
        hostLogins = new Set([...hosts.matchAll(/^\s*user:\s*(\S+)/gm)].map((m) => normIdentity(m[1])).filter(Boolean));
      } catch { /* la duda se trata como sesión no verificada */ }
      if (!ownLogin || hostLogins.size === 0) {
        const detail = 'No se pudo verificar de quién es la sesión de GitHub.';
        return item({ id: 'github-cli', family: 'keys', label: 'GitHub CLI', role: 'credencial local de gh', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action, error: detail });
      }
      if (hostLogins.has(ownLogin)) {
        const detail = 'Es la cuenta de GitHub del anfitrión: entrá con la tuya.';
        return item({ id: 'github-cli', family: 'keys', label: 'GitHub CLI', role: 'credencial local de gh', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action, error: detail });
      }
    }
    return item({
      id: 'github-cli',
      family: 'keys',
      label: 'GitHub CLI',
      role: 'credencial local de gh',
      light: 'ok',
      statusLabel: 'Conectado',
      detail: `${login[2]} @ ${login[1]}${scopes ? ` · scopes: ${scopes}` : ''}`,
      dependents,
      action,
    });
  } catch (e) {
    return item({ id: 'github-cli', family: 'keys', label: 'GitHub CLI', role: 'credencial local de gh', light: 'danger', statusLabel: 'Error de sonda', detail: 'No se pudo ejecutar gh auth status.', dependents: ['PRs y su investigación', 'Comunicaciones', 'censo de Actualizaciones'], action: reconnectActionFor({ id: 'github-cli', dependents: ['PRs y su investigación', 'Comunicaciones', 'censo de Actualizaciones'] }), error: String(e?.message || e || '').slice(0, 300) });
  }
}

export async function probePadLocal(scope) {
  try {
    const dependents = ['Pendientes', 'Aprendizaje', 'Mejora Continua', 'contexto de tickets'];
    const action = reconnectActionFor({ id: 'pad-local' });
    const url = PAD_DEFAULT_URL;
    if (!scope.isHost) {
      const token = readUserPadToken(scope.user, url);
      if (!token) {
        return item({ id: 'pad-local', family: 'keys', label: 'Pad local', role: 'token de sesión y servicio Pad', light: 'danger', statusLabel: 'Sin token', detail: 'No hay token de Pad para este usuario.', dependents, action, error: 'no hay token de Pad para este usuario' });
      }
      const hostToken = readUserPadToken(hostUser(), url);
      if (!hostToken) {
        const detail = 'No se pudo verificar que la sesión de Pad no sea la del anfitrión.';
        return item({ id: 'pad-local', family: 'keys', label: 'Pad local', role: 'token de sesión y servicio Pad', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action, error: detail });
      }
      if (token === hostToken) {
        const detail = 'Es la cuenta de Pad del anfitrión: entrá con la tuya.';
        return item({ id: 'pad-local', family: 'keys', label: 'Pad local', role: 'token de sesión y servicio Pad', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action, error: detail });
      }
      const [ownSession, hostSession] = await Promise.all([
        fetchPadIdentity(url, token),
        fetchPadIdentity(url, hostToken),
      ]);
      if (!ownSession.ok) {
        const statusLabel = ownSession.network ? 'Caído' : 'Sin sesión';
        const detail = ownSession.network
          ? `El servicio Pad no responde en ${url}.`
          : `La sesión de Pad no fue aceptada por ${url}.`;
        return item({ id: 'pad-local', family: 'keys', label: 'Pad local', role: 'token de sesión y servicio Pad', light: 'danger', statusLabel, detail, dependents, action, error: ownSession.network ? ownSession.error : `HTTP ${ownSession.status || 'inválido'}` });
      }
      const ownId = String(ownSession.body?.id || '').trim() || null;
      const ownEmail = normIdentity(ownSession.body?.email);
      if (!ownId && !ownEmail) {
        const detail = 'No se pudo verificar de quién es la sesión de Pad.';
        return item({ id: 'pad-local', family: 'keys', label: 'Pad local', role: 'token de sesión y servicio Pad', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action, error: detail });
      }
      const hostId = hostSession.ok ? String(hostSession.body?.id || '').trim() || null : null;
      const hostEmail = hostSession.ok ? normIdentity(hostSession.body?.email) : null;
      if (!hostSession.ok || (!hostId && !hostEmail)) {
        const detail = 'No se pudo verificar que la sesión de Pad no sea la del anfitrión.';
        return item({ id: 'pad-local', family: 'keys', label: 'Pad local', role: 'token de sesión y servicio Pad', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action, error: detail });
      }
      if ((ownId && hostId && ownId === hostId) || (ownEmail && hostEmail && ownEmail === hostEmail)) {
        const detail = 'Es la cuenta de Pad del anfitrión: entrá con la tuya.';
        return item({ id: 'pad-local', family: 'keys', label: 'Pad local', role: 'token de sesión y servicio Pad', light: 'danger', statusLabel: 'Sin sesión', detail, dependents, action, error: detail });
      }
      const identity = ownEmail || String(ownSession.body?.username || '').trim() || ownId;
      return item({
        id: 'pad-local',
        family: 'keys',
        label: 'Pad local',
        role: 'token de sesión y servicio Pad',
        light: 'ok',
        statusLabel: 'Activo',
        detail: `sesión propia verificada (${identity}) · servicio responde en ${url}`,
        dependents,
        action,
      });
    }
    const creds = readJson(path.join(scope.home, '.pad', 'credentials.json'));
    const hasToken = hasSessionToken(creds);
    const live = await httpAlive(url, 3000);
    const light = hasToken && live.alive ? 'ok' : 'danger';
    return item({
      id: 'pad-local',
      family: 'keys',
      label: 'Pad local',
      role: 'token de sesión y servicio Pad',
      light,
      statusLabel: live.alive ? (hasToken ? 'Activo' : 'Sin token') : 'Caído',
      detail: `${hasToken ? 'token de sesión presente' : 'sin token de sesión'} · ${live.alive ? `servicio responde en ${url}` : `servicio no responde en ${url}`}`,
      dependents,
      action,
      error: live.alive ? (hasToken ? null : 'no hay token de sesión en ~/.pad/credentials.json') : live.error,
    });
  } catch (e) {
    return item({ id: 'pad-local', family: 'keys', label: 'Pad local', role: 'token de sesión y servicio Pad', light: 'danger', statusLabel: 'Error de sonda', detail: 'No se pudo verificar Pad local.', dependents: ['Pendientes', 'Aprendizaje', 'Mejora Continua', 'contexto de tickets'], action: reconnectActionFor({ id: 'pad-local' }), error: String(e?.message || e || '').slice(0, 300) });
  }
}

export async function probeTolkienSession(scope) {
  try {
    const DEPENDENTS = ['censo y cierre en masa de tickets de Tolkien'];
    const warnMs = TOLKIEN_EXPIRY_WARN_DAYS * DAY_MS;
    const action = reconnectActionFor({ id: 'tolkien-session', dependents: DEPENDENTS });
    const st = tolkienStatus(scope.dataDir);
    if (!st.connected) {
      return item({
        id: 'tolkien-session',
        family: 'keys',
        label: 'Sesión de Tolkien',
        role: 'sesión de app.tolkien.mordorstaffing.com',
        light: 'danger',
        statusLabel: 'Sin sesión',
        detail: 'Todavía no conectaste tu cuenta de Tolkien en esta consola.',
        expiresAt: null,
        warnMs,
        dependents: DEPENDENTS,
        action,
        error: 'no hay sesión de Tolkien guardada para este usuario',
      });
    }
    const light = st.expired ? 'danger' : (st.expiresAt == null ? 'ok' : expiryLight(st.expiresAt, { warnMs }));
    const cuenta = st.account || 'cuenta no detectada';
    const vencimiento = st.expiresAt == null
      ? 'sin vencimiento conocido'
      : `${durationText(st.expiresAt - Date.now())}${st.expiresAtSource === 'estimated' ? ' (estimado, no confirmado por Tolkien)' : ''}`;
    return item({
      id: 'tolkien-session',
      family: 'keys',
      label: 'Sesión de Tolkien',
      role: 'sesión de app.tolkien.mordorstaffing.com',
      light,
      statusLabel: st.expired ? 'Vencida' : statusFromLight(light),
      detail: `${cuenta} · ${vencimiento}`,
      expiresAt: st.expiresAt,
      warnMs,
      dependents: DEPENDENTS,
      action,
      error: st.expired ? 'la sesión de Tolkien venció; volvé a conectarla desde el panel' : null,
    });
  } catch (e) {
    const DEPENDENTS = ['censo y cierre en masa de tickets de Tolkien'];
    const warnMs = TOLKIEN_EXPIRY_WARN_DAYS * DAY_MS;
    return item({
      id: 'tolkien-session',
      family: 'keys',
      label: 'Sesión de Tolkien',
      role: 'sesión de app.tolkien.mordorstaffing.com',
      light: 'danger',
      statusLabel: 'Error de sonda',
      detail: 'No se pudo verificar la sesión de Tolkien.',
      warnMs,
      dependents: DEPENDENTS,
      action: reconnectActionFor({ id: 'tolkien-session', dependents: DEPENDENTS }),
      error: String(e?.message || e || '').slice(0, 300),
    });
  }
}

function parseHeartbeatTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts < 1e12 ? ts * 1000 : ts;
  const parsed = Date.parse(String(ts || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export async function probeWhatsapp(scope) {
  try {
    const hb = readJson(path.join(scope.dataDir, 'comms', 'whatsapp-daemon.json')) || {};
    const service = await serviceActive(scope, 'whatsapp-bridge.service');
    const ts = parseHeartbeatTs(hb.ts);
    const ageMs = ts == null ? null : Date.now() - ts;
    const heartbeatOk = hb.state === 'ready' && ageMs != null && ageMs < 5 * 60 * 1000;
    const active = service === 'active';
    const light = !active || hb.state !== 'ready' ? 'danger' : (heartbeatOk ? 'ok' : 'warn');
    const statusLabel = light === 'ok' ? 'Activo' : (light === 'warn' ? 'Sin latido' : 'Caído');
    const heartbeat = ageMs == null
      ? 'sin latido registrado'
      : (ageMs < 0 ? 'latido con fecha futura' : `${heartbeatOk ? 'latido hace' : '⚠ sin latido desde hace'} ${durationText(-ageMs).replace('venció hace ', '')}`);
    return item({
      id: 'whatsapp',
      family: 'services',
      label: 'WhatsApp bridge',
      role: 'daemon de hilos y audios',
      light,
      statusLabel,
      detail: `estado ${hb.state || 'desconocido'} · ${heartbeat} · servicio ${service}`,
      dependents: ['traer hilos y audios de WhatsApp'],
      action: reconnectActionFor({ id: 'whatsapp', dependents: ['traer hilos y audios de WhatsApp'] }),
      error: light === 'ok' ? null : `state=${hb.state || 'desconocido'}, service=${service}`,
    });
  } catch (e) {
    return item({ id: 'whatsapp', family: 'services', label: 'WhatsApp bridge', role: 'daemon de hilos y audios', light: 'danger', statusLabel: 'Error de sonda', detail: 'No se pudo verificar WhatsApp bridge.', dependents: ['traer hilos y audios de WhatsApp'], action: reconnectActionFor({ id: 'whatsapp', dependents: ['traer hilos y audios de WhatsApp'] }), error: String(e?.message || e || '').slice(0, 300) });
  }
}

export async function probeServices(scope) {
  try {
    const names = ['claude-web-console', 'pad-local', 'tolkien-console'];
    const states = await Promise.all(names.map(async (name) => [name, await serviceActive(scope, name)]));
    return states.map(([name, state]) => item({
      id: `service-${name}`,
      family: 'services',
      label: name,
      role: 'servicio systemd de usuario',
      light: state === 'active' ? 'ok' : 'danger',
      statusLabel: state === 'active' ? 'Activo' : 'Caído',
      detail: `systemctl --user is-active => ${state}`,
      dependents: [],
      action: reconnectActionFor({ id: `service-${name}`, label: name }),
      error: state === 'active' ? null : state,
    }));
  } catch (e) {
    return [item({ id: 'services', family: 'services', label: 'Servicios systemd', role: 'servicios base de la consola', light: 'danger', statusLabel: 'Error de sonda', detail: 'No se pudo verificar systemd de usuario.', error: String(e?.message || e || '').slice(0, 300) })];
  }
}

export async function probeZeroTier() {
  try {
    const ifaces = networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!name.startsWith('zt')) continue;
      const ipv4 = (addrs || []).find((a) => a.family === 'IPv4' && !a.internal);
      if (!ipv4) continue;
      return item({
        id: 'zerotier',
        family: 'services',
        label: 'ZeroTier',
        role: 'red privada de acceso',
        light: 'ok',
        statusLabel: 'Conectado',
        detail: `${name} · IPv4 ${ipv4.address}`,
        dependents: ['el acceso mismo a esta consola'],
        action: null,
      });
    }
    return item({
      id: 'zerotier',
      family: 'services',
      label: 'ZeroTier',
      role: 'red privada de acceso',
      light: 'danger',
      statusLabel: 'Sin red',
      detail: 'sin red ZeroTier',
      dependents: ['el acceso mismo a esta consola'],
      action: null,
      error: 'no hay interfaz zt* con IPv4',
    });
  } catch (e) {
    return item({ id: 'zerotier', family: 'services', label: 'ZeroTier', role: 'red privada de acceso', light: 'danger', statusLabel: 'Error de sonda', detail: 'No se pudo verificar ZeroTier.', dependents: ['el acceso mismo a esta consola'], error: String(e?.message || e || '').slice(0, 300) });
  }
}

export function itemsForProbe(items, probeKey) {
  const list = Array.isArray(items) ? items : [];
  if (probeKey === 'services') return list.filter((it) => String(it?.id || '').startsWith('service-'));
  return list.filter((it) => it?.id === probeKey);
}

// Corre las sondas en paralelo. Las que llegan en `reuse` conservan sus items
// y checkedAt; un fallo de cualquier otra se convierte en su tarjeta en rojo.
export async function buildKeyring(scope, { reuse = null } = {}) {
  const probes = [
    ['claude-oauth', () => probeClaudeOauth(scope)],
    ['codex-cli', () => probeCodexCli(scope)],
    ['pad-cloud', () => probePadCloud(scope)],
    ['infisical', () => probeInfisicalKey(scope)],
    ['github-cli', () => probeGithubCli(scope)],
    ['pad-local', () => probePadLocal(scope)],
    ['tolkien-session', () => probeTolkienSession(scope)],
  ];
  // Servicios e interfaz de red pertenecen a la instalación del host, no al
  // llavero de un inquilino. El host conserva exactamente sus tarjetas previas.
  if (scope.isHost) {
    probes.push(
      ['whatsapp', () => probeWhatsapp(scope)],
      ['services', () => probeServices(scope)],
      ['zerotier', probeZeroTier],
    );
  }
  const settled = await Promise.allSettled(probes.map(([probeKey, fn]) => {
    const reused = reuse?.[probeKey];
    return Array.isArray(reused) && reused.length > 0 ? reused : fn();
  }));
  const items = settled.flatMap((r, i) => {
    if (r.status === 'fulfilled') return Array.isArray(r.value) ? r.value : [r.value];
    const id = probes[i][0];
    return [item({
      id,
      family: 'services',
      label: id,
      role: 'sonda del llavero',
      light: 'danger',
      statusLabel: 'Error de sonda',
      detail: 'La sonda falló antes de devolver estado.',
      error: String(r.reason?.message || r.reason || '').slice(0, 300),
    })];
  });
  const generatedAt = Date.now();
  return { items: refreshDerived(items).map((it) => ({ ...it, checkedAt: it.checkedAt || generatedAt })), generatedAt };
}
