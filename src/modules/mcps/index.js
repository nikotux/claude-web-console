// modules/mcps/index.js — pestaña "Conexiones (MCP)" de ⚙ Sistema: censo +
// ESTADO EN VIVO de los servidores MCP de Claude Code, agrupado por mundo
// (🏠 Mi Consola / 🌳 Tolkien). Hermano del módulo `skills`: mismo espíritu
// determinístico (0 tokens IA), pero además de las características muestra el
// semáforo de conexión y ofrece acciones para (re)conectar DESDE LA VENTANA.
//
// FUENTE DEL CENSO: la config declarada (~/.claude.json + .mcp.json), sin
// subprocess en el handler. El estado se refresca por item con
// `claude mcp get <name>` en segundo plano y queda persistido en disco para que
// un reinicio del server no deje el panel sin nada que mostrar.
//
// ACCIONES (Regla 4: nunca editamos ~/.claude.json a mano — usamos la vía CLI
// oficial `claude mcp`, que gestiona su propio archivo, igual que el onboarding
// usa `claude setup-token`):
//   · Re-verificar          → invalida caché y re-corre `claude mcp list`.
//   · Reciclar runners      → el front llama a /api/admin/restart-runners (ya
//                             existe): un runner vivo re-lee credenciales/MCP.
//   · Desconectar (logout)  → `claude mcp logout <name>` en el HOME del dueño.
//   · Reconectar (OAuth)    → Fase 2, runner pty bin/cwc-mcp-login-runner.js
//                             (login-shared.js) — el server solo orquesta.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { isAdmin } from '../../core/auth.js';
import { runAdaptivePool } from '../../core/pool.js';
import { systemScopeFor } from '../../core/system-scope.js';
import {
  commandEnvFor, spawnLogin, readLoginJob, writeLoginCode, worldCwd, WORLDS, runMcpGet,
} from './login-shared.js';
import { buildKeyring, refreshDerived } from './keyring-shared.js';
import {
  spawnInfisicalLogin,
  readInfisicalLoginJob,
  writeInfisicalLoginToken,
} from './infisical-shared.js';

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

// classifyStatus/parseList/runMcpList (parseo de `claude mcp list`) viven en
// login-shared.js — FUENTE ÚNICA compartida con el runner de login, que la
// necesita para verificar una reconexión antes de reportar éxito.

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

function discoverNames(cliCfg, projectMcp, cwd) {
  const names = new Set();
  Object.keys(cliCfg?.projects?.[cwd]?.mcpServers || {}).forEach((n) => names.add(n));
  Object.keys(projectMcp || {}).forEach((n) => names.add(n));
  Object.keys(cliCfg?.mcpServers || {}).forEach((n) => names.add(n));
  return [...names].sort((a, b) => a.localeCompare(b));
}

// Un mismo nombre definido en >1 scope con ENDPOINTS DISTINTOS: los tokens OAuth
// se guardan por endpoint, así que autenticar en un contexto no sirve en el otro.
function endpointOf(decl) {
  if (!decl) return '';
  if (decl.url) return String(decl.url);
  return [decl.command, ...(Array.isArray(decl.args) ? decl.args : [])].filter(Boolean).join(' ');
}

function scopeConflicts(cliCfg, projectMcp, cwd) {
  const local = cliCfg?.projects?.[cwd]?.mcpServers || {};
  const project = projectMcp || {};
  const user = cliCfg?.mcpServers || {};
  const names = new Set([...Object.keys(local), ...Object.keys(project), ...Object.keys(user)]);
  const out = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const scopes = [
      local[name] ? { scope: 'local', endpoint: endpointOf(local[name]) } : null,
      project[name] ? { scope: 'project', endpoint: endpointOf(project[name]) } : null,
      user[name] ? { scope: 'user', endpoint: endpointOf(user[name]) } : null,
    ].filter(Boolean);
    if (scopes.length < 2) continue;
    if (new Set(scopes.map((s) => s.endpoint)).size <= 1) continue;
    out.push({
      name,
      scopes,
      fixCommands: scopes.map((s) => `claude mcp remove ${name} -s ${s.scope}`),
    });
  }
  return out;
}

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

export function mcpsPathsFor(scope) {
  return {
    store: path.join(scope.dataDir, 'mcps-census.json'),
    keyring: path.join(scope.dataDir, 'keyring.json'),
    claudeJson: path.join(scope.home, '.claude.json'),
  };
}

const CHECK_TIMEOUT_MS = 15000;
// Abrir el panel no debe costar consultas de red ni subprocesos: el estado de
// una conexión no cambia minuto a minuto, y para urgencias existe Re-verificar.
const AUTO_RECHECK_MS = 12 * 60 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9_-]+$/;
// Allowlist CERRADA de unidades systemd reiniciables desde el panel. El nombre
// de la unidad NUNCA sale del request: se resuelve contra este mapa por una
// clave conocida. Interpolar `req.body.name` en el execFile sería ejecución
// arbitraria de comandos, aunque "parezca" validado por una regex.
const RESTARTABLE_UNITS = {
  whatsapp: 'whatsapp-bridge',
  'service-pad-local': 'pad-local',
  'service-tolkien-console': 'tolkien-console',
  'service-claude-web-console': 'claude-web-console',
};
// Todo estado en memoria queda particionado por usuario. Nunca una promesa,
// snapshot o Set de chequeos de un principal puede satisfacer a otro.
const runtimeByUser = new Map();

function runtimeFor(scope) {
  let state = runtimeByUser.get(scope.user);
  if (!state) {
    state = {
      checking: new Set(),
      storeMemo: null,
      keyringMemo: null,
      keyringInFlight: null,
    };
    runtimeByUser.set(scope.user, state);
  }
  return state;
}

function itemKey(world, name) {
  return `${world}:${name}`;
}

function loadStore(scope) {
  const state = runtimeFor(scope);
  if (state.storeMemo) return state.storeMemo;
  const raw = readJson(mcpsPathsFor(scope).store);
  state.storeMemo = raw && raw.items && typeof raw.items === 'object' ? { items: raw.items, savedAt: raw.savedAt } : { items: {} };
  return state.storeMemo;
}

function saveStore(scope) {
  try {
    const store = loadStore(scope);
    store.savedAt = Date.now();
    writeJsonAtomic(mcpsPathsFor(scope).store, store, { space: 2 });
  } catch { /* best-effort: el request nunca depende del store persistido */ }
}

function scheduleChecks(scope, targets) {
  const { checking } = runtimeFor(scope);
  const list = [];
  try {
    for (const t of targets || []) {
      const world = String(t.world || '');
      const name = String(t.name || '');
      const cwd = t.cwd || worldCwd(scope, world);
      if (!cwd || !name) continue;
      const key = itemKey(world, name);
      if (checking.has(key)) continue;
      checking.add(key);
      list.push({ world, cwd, name, key });
    }
    if (!list.length) return;
    // Fire-and-forget: si el proceso reinicia, el próximo poll re-dispara estos
    // chequeos idempotentes. No es un job de usuario que requiera runner aparte.
    runAdaptivePool(list, async ({ cwd, name, key }) => {
      try {
        const r = await runMcpGet(scope, cwd, name, CHECK_TIMEOUT_MS);
        const entry = { status: r.status, statusRaw: r.statusRaw || '', checkedAt: Date.now() };
        if (r.error) entry.error = r.error;
        if (r.timedOut) entry.timedOut = true;
        if (r.timeoutMs) entry.timeoutMs = r.timeoutMs;
        loadStore(scope).items[key] = entry;
        saveStore(scope);
      } catch (e) {
        loadStore(scope).items[key] = {
          status: { code: 'error', light: 'danger', label: 'Error de conexión' },
          statusRaw: '',
          checkedAt: Date.now(),
          error: String(e.message || e || '').trim().slice(0, 300),
        };
        saveStore(scope);
      } finally {
        checking.delete(key);
      }
    }, { max: 4 }).then(() => saveStore(scope)).catch(() => {
      for (const t of list) checking.delete(t.key);
    });
  } catch {
    for (const t of list) checking.delete(t.key);
  }
}

function targetsFromCensus(scope, data, pred) {
  const out = [];
  for (const w of data.worlds || []) {
    const cwd = worldCwd(scope, w.world);
    if (!cwd) continue;
    for (const s of w.servers || []) {
      if (!pred || pred(s, w)) out.push({ world: w.world, cwd, name: s.name });
    }
  }
  return out;
}

function refreshCheckingFlags(scope, data) {
  const { checking } = runtimeFor(scope);
  for (const w of data.worlds || []) {
    for (const s of w.servers || []) s.checking = checking.has(s.key);
    w.missing = (w.servers || []).map((s) => {
      const reason = missingReason(s);
      return reason ? { name: s.name, reason } : null;
    }).filter(Boolean);
  }
  return data;
}

function missingReason(s) {
  const code = s?.status?.code;
  if (code === 'timeout') return 'timeout';
  if (code === 'error') return 'error';
  if (!s?.checkedAt && !s?.checking) return 'unchecked';
  return null;
}

function buildCensus(scope) {
  const cliCfg = readJson(mcpsPathsFor(scope).claudeJson) || {};
  const store = loadStore(scope);
  const { checking } = runtimeFor(scope);
  const now = Date.now();
  const worlds = [];
  const readableWorlds = new Set();
  const liveKeys = new Set();
  for (const w of WORLDS) {
    const cwd = worldCwd(scope, w.world);
    // Sin cwd resuelto (p.ej. Tolkien sin su directorio configurado) no hay que
    // caer silenciosamente al cwd de la propia Consola: mostraría los MCP
    // servers de Mi Consola bajo la etiqueta de otro mundo. Reportar el error
    // explícito, mismo criterio que spawnLogin (login-shared.js) que ya lanza en
    // ese caso. (El cruce real al mundo externo lo resuelve worldCwd en
    // login-shared.js, que sí está en el allowlist de cross-world.)
    if (!cwd) {
      worlds.push({ world: w.world, label: w.label, cwd: null, servers: [], hasWarnings: false, conflicts: [], missing: [], error: 'cwd no configurado para este mundo' });
      continue;
    }
    readableWorlds.add(w.world);
    const projectMcp = readJson(path.join(cwd, '.mcp.json'))?.mcpServers || null;
    const conflicts = scopeConflicts(cliCfg, projectMcp, cwd);
    const servers = discoverNames(cliCfg, projectMcp, cwd).map((name) => {
      const { decl } = declaredFor(cliCfg, projectMcp, cwd, name);
      const key = itemKey(w.world, name);
      liveKeys.add(key);
      const st = store.items[key];
      const checkedAt = st?.checkedAt || null;
      const ageMs = checkedAt ? now - checkedAt : null;
      return enrich({
        name,
        endpoint: endpointOf(decl),
        statusRaw: st?.statusRaw || '',
        status: st?.status || { code: 'unknown', light: 'neutral', label: 'Sin verificar' },
        key,
        checking: checking.has(key),
        checkedAt,
        ageMs,
        stale: !!checkedAt && ageMs > AUTO_RECHECK_MS,
        timedOut: !!st?.timedOut,
        timeoutMs: st?.timeoutMs || null,
        error: st?.error || null,
      }, cliCfg, projectMcp, cwd);
    });
    const missing = servers.map((s) => {
      const reason = missingReason(s);
      return reason ? { name: s.name, reason } : null;
    }).filter(Boolean);
    worlds.push({
      world: w.world,
      label: w.label,
      cwd: '~/' + path.relative(scope.home, cwd),
      servers,
      hasWarnings: conflicts.length > 0,
      conflicts,
      missing,
      error: null,
    });
  }
  let pruned = false;
  for (const key of Object.keys(store.items || {})) {
    const world = key.split(':', 1)[0];
    if (!readableWorlds.has(world)) continue;
    if (liveKeys.has(key)) continue;
    delete store.items[key];
    pruned = true;
  }
  if (pruned) saveStore(scope);
  return { worlds, generatedAt: Date.now(), checkTimeoutMs: CHECK_TIMEOUT_MS };
}

function validKeyringSnapshot(snap) {
  return snap && Array.isArray(snap.items) && snap.generatedAt;
}

function hydrateKeyringSnapshot(snap, extra = {}) {
  return { ...snap, ...extra, items: refreshDerived(snap.items) };
}

function keyringSnapshotForDisk(data) {
  return {
    ...data,
    items: (data.items || []).map(({ expiresInMs, ...it }) => it),
  };
}

async function getKeyring(scope, { fresh = false } = {}) {
  const state = runtimeFor(scope);
  const keyringFile = mcpsPathsFor(scope).keyring;
  const now = Date.now();
  if (!state.keyringMemo) {
    const snap = readJson(keyringFile);
    if (validKeyringSnapshot(snap)) state.keyringMemo = snap;
  }
  const ageMs = state.keyringMemo?.generatedAt ? now - state.keyringMemo.generatedAt : Infinity;
  if (!fresh && state.keyringMemo && ageMs < AUTO_RECHECK_MS) return hydrateKeyringSnapshot(state.keyringMemo);
  if (state.keyringInFlight) {
    try {
      return hydrateKeyringSnapshot(await state.keyringInFlight);
    } catch (e) {
      if (state.keyringMemo) return hydrateKeyringSnapshot(state.keyringMemo, { stale: true, staleReason: String(e?.message || e || '').slice(0, 300) });
      throw e;
    }
  }
  state.keyringInFlight = (async () => {
    const data = await buildKeyring(scope);
    state.keyringMemo = data;
    try { writeJsonAtomic(keyringFile, keyringSnapshotForDisk(data), { space: 2 }); } catch { /* best-effort: el snapshot no bloquea la respuesta */ }
    return data;
  })();
  try {
    return hydrateKeyringSnapshot(await state.keyringInFlight);
  } catch (e) {
    const snap = state.keyringMemo || readJson(keyringFile);
    if (validKeyringSnapshot(snap)) {
      state.keyringMemo = snap;
      return hydrateKeyringSnapshot(snap, { stale: true, staleReason: String(e?.message || e || '').slice(0, 300) });
    }
    throw e;
  } finally {
    state.keyringInFlight = null;
  }
}

export default {
  name: 'mcps',

  registerHttp(router) {
    // GET /mcps/keyring — el LLAVERO: credenciales y servicios que se rompen solos.
    // Autenticados (no expone secretos, solo estado/vencimientos). 0 tokens de IA.
    router.get('/mcps/keyring', async (req, res) => {
      try {
        const scope = systemScopeFor(req);
        res.json(await getKeyring(scope, { fresh: req.query.fresh === '1' }));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Reiniciar servicios de la instalación es una acción exclusiva del admin.
    // La unidad siempre proviene de la allowlist cerrada, nunca del request.
    router.post('/mcps/service/restart', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = req.body?.id;
      if (typeof id !== 'string' || !Object.hasOwn(RESTARTABLE_UNITS, id)) {
        return res.status(400).json({ error: 'servicio inválido' });
      }
      const unit = RESTARTABLE_UNITS[id];
      if (id === 'service-claude-web-console') {
        // El propio proceso debe alcanzar a responder antes de que systemd lo mate.
        res.json({ ok: true, unit, self: true });
        setTimeout(() => {
          execFile('systemctl', ['--user', 'restart', unit], { timeout: 30_000 }, () => {});
        }, 500);
        return;
      }
      execFile('systemctl', ['--user', 'restart', unit], { timeout: 30_000 }, () => {});
      res.json({ ok: true, unit });
    });

    // Estado puntual para confirmar que una unidad permitida volvió a levantar.
    router.get('/mcps/service/:id/status', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const { id } = req.params;
      if (!Object.hasOwn(RESTARTABLE_UNITS, id)) {
        return res.status(400).json({ error: 'servicio inválido' });
      }
      const unit = RESTARTABLE_UNITS[id];
      execFile('systemctl', ['--user', 'is-active', unit], { timeout: 30_000 }, (err, stdout, stderr) => {
        const raw = String(stdout || stderr || err?.message || '').trim();
        res.json({ active: raw === 'active', raw });
      });
    });

    // Login guiado de Infisical: desbloquea el MCP `tolkien-mordor` cuando la
    // sesión del CLI vence. Cada dueño escribe únicamente su credencial.
    router.post('/mcps/infisical/login', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const id = spawnInfisicalLogin(scope);
        res.json({ ok: true, id });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // El token pegado es secreto: se manda al runner por archivo 0600 y nunca se
    // devuelve ni se loguea desde este endpoint.
    router.post('/mcps/infisical/login-token', (req, res) => {
      const { id, value } = req.body || {};
      try {
        const scope = systemScopeFor(req);
        writeInfisicalLoginToken(scope, id, value);
        res.json({ ok: true });
      } catch (e) {
        res.status(e.badRequest ? 400 : 500).json({ error: e.message });
      }
    });

    router.get('/mcps/infisical/login/:id', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const job = readInfisicalLoginJob(scope, req.params.id);
        if (!job) return res.status(404).json({ error: 'no existe' });
        if (job.status === 'done') runtimeFor(scope).keyringMemo = null;
        res.json(job);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Censo + estado (autenticados; el estado no expone secretos).
    router.get('/mcps', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const data = buildCensus(scope);
        const targets = req.query.fresh === '1'
          ? targetsFromCensus(scope, data)
          : targetsFromCensus(scope, data, (s) => s.stale || !s.checkedAt);
        scheduleChecks(scope, targets);
        res.json(refreshCheckingFlags(scope, data));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Re-verificar: programa los checks del propio usuario.
    router.post('/mcps/refresh', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const data = buildCensus(scope);
        scheduleChecks(scope, targetsFromCensus(scope, data));
        res.json(refreshCheckingFlags(scope, data));
      }
      catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Health-check puntual: feedback inmediato en la tarjeta sin recargar todo.
    router.post('/mcps/check', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const { world, name } = req.body || {};
        const cwd = worldCwd(scope, world);
        if (!cwd || !NAME_RE.test(String(name || ''))) return res.status(400).json({ error: 'parámetros inválidos' });
        scheduleChecks(scope, [{ world, cwd, name }]);
        res.json({ ok: true, key: itemKey(world, name) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Desconectar: limpia las credenciales OAuth guardadas (vía CLI oficial).
    router.post('/mcps/logout', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const { world, name } = req.body || {};
        const cwd = worldCwd(scope, world);
        if (!cwd || !NAME_RE.test(String(name || ''))) return res.status(400).json({ error: 'parámetros inválidos' });
        execFile('claude', ['mcp', 'logout', name], { cwd, timeout: 20000, env: commandEnvFor(scope) }, (err, stdout, stderr) => {
          scheduleChecks(scope, [{ world, cwd, name }]); // el estado cambió
          if (err) return res.status(500).json({ error: (stderr || err.message || '').trim().slice(0, 300) });
          res.json({ ok: true, output: String(stdout || '').trim().slice(0, 300) });
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // --- Fase 2: reconexión OAuth guiada (runner pty) ---
    router.post('/mcps/login', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const { world, name } = req.body || {};
        const cwd = worldCwd(scope, world);
        if (!cwd || !NAME_RE.test(String(name || ''))) return res.status(400).json({ error: 'parámetros inválidos' });
        const id = spawnLogin(scope, world, name);
        res.json({ ok: true, id });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Pegar la URL de redirect (localhost:.../callback?code=...) al pty.
    router.post('/mcps/login-code', (req, res) => {
      const { id, value } = req.body || {};
      try {
        const scope = systemScopeFor(req);
        writeLoginCode(scope, id, value);
        res.json({ ok: true });
      } catch (e) {
        // El status se deriva de la marca explícita del error (badRequest),
        // nunca hardcodeado: writeLoginCode también puede fallar por I/O real
        // (fs.mkdirSync/writeFileSync), que es un 500, no un 400.
        res.status(e.badRequest ? 400 : 500).json({ error: e.message });
      }
    });

    // Poll del estado del login guiado (0 tokens, solo lee disco).
    router.get('/mcps/login/:id', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const job = readLoginJob(scope, req.params.id);
        if (!job) return res.status(404).json({ error: 'no existe' });
        if (job.status === 'done') {
          const cwd = worldCwd(scope, job.world);
          if (cwd && NAME_RE.test(String(job.name || ''))) scheduleChecks(scope, [{ world: job.world, cwd, name: job.name }]);
        }
        res.json(job);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  },
};
