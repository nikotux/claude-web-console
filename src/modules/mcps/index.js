// modules/mcps/index.js — pestaña "Conexiones (MCP)" de ⚙ Sistema: censo +
// ESTADO EN VIVO de los servidores MCP de Claude Code, agrupado por mundo
// (🏠 Mi Consola / 🌳 Tolkien). Hermano del módulo `skills`: mismo espíritu
// determinístico (0 tokens IA), pero además de las características muestra el
// semáforo de conexión y ofrece acciones para (re)conectar DESDE LA VENTANA.
//
// FUENTE DEL ESTADO: `claude mcp list` corrido con el cwd de cada mundo (los
// MCP son per-project, scope local en ~/.claude.json) — 0 tokens, subprocess
// CLI determinístico (como tolkien/refresh corre psql/git; NO es una corrida
// del SDK, la regla 6 no aplica). Se parsea `<name>: <endpoint> - <estado>`.
// Las CARACTERÍSTICAS (transporte/scope/args) se cruzan con ~/.claude.json y el
// .mcp.json del repo — SOLO LECTURA de esos archivos.
//
// ACCIONES (Regla 4: nunca editamos ~/.claude.json a mano — usamos la vía CLI
// oficial `claude mcp`, que gestiona su propio archivo, igual que el onboarding
// usa `claude setup-token`):
//   · Re-verificar          → invalida caché y re-corre `claude mcp list`.
//   · Reciclar runners      → el front llama a /api/admin/restart-runners (ya
//                             existe): un runner vivo re-lee credenciales/MCP.
//   · Desconectar (logout)  → `claude mcp logout <name>` (admin).
//   · Reconectar (OAuth)    → Fase 2, runner pty bin/cwc-mcp-login-runner.js
//                             (login-shared.js) — el server solo orquesta.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { isAdmin } from '../../core/auth.js';
import {
  spawnLogin, readLoginJob, writeLoginCode, worldCwd, WORLDS,
} from './login-shared.js';

const CONSOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Descripciones amigables de servidores conocidos — data no crítica, solo
// enriquece la tarjeta (si falta, se muestra sin "rol"). No se inventan roles
// para nombres desconocidos.
const KNOWN_ROLES = {
  pad: 'Tracker Pad (issues/planes/convenciones)',
  'pad-cloud-backup': 'Pad en la nube — respaldo pasivo',
  'pad-console': 'Puente al Pad local de Consola (mundo interno)',
  'tolkien-mordor': 'Backend del equipo: Zoho Desk · GitHub · Teams/Graph',
  honcho: 'Memoria de facts compartida',
  context7: 'Documentación de librerías (Upstash)',
};

// --- Parseo del estado que imprime `claude mcp list` ---
function classifyStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (raw.includes('✔') || s.includes('connected')) return { code: 'connected', light: 'ok', label: 'Conectado' };
  if (raw.includes('!') || s.includes('authentication') || s.includes('needs auth')) return { code: 'needs-auth', light: 'warn', label: 'Requiere reconexión' };
  if (raw.includes('⏸') || s.includes('pending')) return { code: 'pending', light: 'info', label: 'Pendiente de aprobación' };
  if (raw.includes('✘') || s.includes('failed') || s.includes('disconnect') || s.includes('error')) return { code: 'error', light: 'danger', label: 'Error de conexión' };
  return { code: 'unknown', light: 'neutral', label: raw.trim() || 'Desconocido' };
}

// name lazy hasta el primer ":", endpoint lazy, status anclado al final por su
// símbolo/keyword conocido (así un endpoint con " -- " no confunde el split).
// El status arranca por un símbolo (✔✘!⏸⚠) o keyword conocido tras " - ". Sin
// \b: ✔/! seguidos de espacio no forman word-boundary, y el \b anulaba el match.
const LINE_RE = /^(.+?):\s+(.*?)\s+-\s+((?:[✔✘!⏸⚠]|Connected|Failed|Needs|Pending|Disconnected).*)$/;

function parseList(stdout) {
  const servers = [];
  let hasWarnings = false;
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;
    if (/config diagnostics|conflicting scopes|multiple scopes|^[├└]/i.test(t)) { hasWarnings = true; continue; }
    const m = t.match(LINE_RE);
    if (!m) continue;
    servers.push({ name: m[1].trim(), endpoint: m[2].trim(), statusRaw: m[3].trim(), status: classifyStatus(m[3]) });
  }
  return { servers, hasWarnings };
}

function runMcpList(cwd) {
  return new Promise((resolve) => {
    execFile('claude', ['mcp', 'list'], { cwd, timeout: 30000, env: process.env, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // `claude mcp list` sale 0 aun con diagnostics; el health-check tarda por
        // los HTTP. Si falla del todo, devolvemos vacío + el error para la UI.
        if (err && !stdout) { resolve({ servers: [], hasWarnings: false, error: (stderr || err.message || '').trim().slice(0, 300) }); return; }
        resolve(parseList((stdout || '') + '\n' + (stderr || '')));
      });
  });
}

// --- Config declarada (SOLO LECTURA) para las características ---
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function declaredFor(cliCfg, projectMcp, cwd, name) {
  const proj = cliCfg?.projects?.[cwd]?.mcpServers?.[name];
  if (proj) return { decl: proj, scope: 'local' };
  const versioned = projectMcp?.[name];
  if (versioned) return { decl: versioned, scope: 'project' };
  const user = cliCfg?.mcpServers?.[name];
  if (user) return { decl: user, scope: 'user' };
  return { decl: null, scope: 'unknown' };
}
const SCOPE_LABEL = { local: 'local (privado)', project: 'proyecto (.mcp.json)', user: 'usuario (global)', unknown: '—' };

function enrich(server, cliCfg, projectMcp, cwd) {
  const { decl, scope } = declaredFor(cliCfg, projectMcp, cwd, server.name);
  const isHttp = decl?.type === 'http' || decl?.type === 'sse' || /^https?:\/\//i.test(server.endpoint);
  return {
    ...server,
    role: KNOWN_ROLES[server.name] || null,
    transport: decl?.type || (isHttp ? 'http' : 'stdio'),
    scope,
    scopeLabel: SCOPE_LABEL[scope],
    url: decl?.url || (isHttp ? server.endpoint : null),
    command: decl?.command || null,
    args: Array.isArray(decl?.args) ? decl.args : null,
    hasHeaders: !!(decl?.headers && Object.keys(decl.headers).length),
    // Solo un MCP HTTP/SSE con OAuth pendiente se "reconecta" con login guiado.
    reconnectable: server.status.code === 'needs-auth' && isHttp,
  };
}

// --- Caché en memoria (el health-check de claude mcp list es lento) ---
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

async function buildCensus() {
  const cliCfg = readJson(path.join(os.homedir(), '.claude.json')) || {};
  const worlds = [];
  for (const w of WORLDS) {
    const cwd = worldCwd(w.world) || CONSOLE_ROOT;
    const projectMcp = readJson(path.join(cwd, '.mcp.json'))?.mcpServers || null;
    const { servers, hasWarnings, error } = await runMcpList(cwd);
    worlds.push({
      world: w.world,
      label: w.label,
      cwd: '~/' + path.relative(os.homedir(), cwd),
      servers: servers.map((s) => enrich(s, cliCfg, projectMcp, cwd)),
      hasWarnings,
      error: error || null,
    });
  }
  return { worlds, generatedAt: Date.now() };
}

async function census({ fresh }) {
  if (!fresh && cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  cache = await buildCensus();
  cacheAt = Date.now();
  return cache;
}

export default {
  name: 'mcps',

  registerHttp(router) {
    // Censo + estado (autenticados; el estado no expone secretos).
    router.get('/mcps', async (req, res) => {
      try {
        const data = await census({ fresh: req.query.fresh === '1' });
        res.json(data);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Re-verificar: invalida caché (admin — consume un poco de CPU/red).
    router.post('/mcps/refresh', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      try { res.json(await census({ fresh: true })); }
      catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Desconectar: limpia las credenciales OAuth guardadas (vía CLI oficial).
    router.post('/mcps/logout', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      const { world, name } = req.body || {};
      const cwd = worldCwd(world);
      if (!cwd || !/^[A-Za-z0-9_-]+$/.test(String(name || ''))) return res.status(400).json({ error: 'parámetros inválidos' });
      execFile('claude', ['mcp', 'logout', name], { cwd, timeout: 20000, env: process.env }, (err, stdout, stderr) => {
        cache = null; // el estado cambió
        if (err) return res.status(500).json({ error: (stderr || err.message || '').trim().slice(0, 300) });
        res.json({ ok: true, output: String(stdout || '').trim().slice(0, 300) });
      });
    });

    // --- Fase 2: reconexión OAuth guiada (runner pty) ---
    router.post('/mcps/login', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      const { world, name } = req.body || {};
      const cwd = worldCwd(world);
      if (!cwd || !/^[A-Za-z0-9_-]+$/.test(String(name || ''))) return res.status(400).json({ error: 'parámetros inválidos' });
      try {
        const id = spawnLogin(world, name);
        res.json({ ok: true, id });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Pegar la URL de redirect (localhost:.../callback?code=...) al pty.
    router.post('/mcps/login-code', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      const { id, value } = req.body || {};
      try {
        writeLoginCode(id, value);
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // Poll del estado del login guiado (0 tokens, solo lee disco).
    router.get('/mcps/login/:id', (req, res) => {
      const job = readLoginJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'no existe' });
      if (job.status === 'done') cache = null; // reconectó: forzar recenso
      res.json(job);
    });
  },
};
