#!/usr/bin/env node

/**
 * Runner durable para Tolkien.
 *
 * login, whoami, census y reconcile son subcomandos de SOLO LECTURA. `close` y
 * `reassign` ESCRIBEN en Tolkien: por defecto usan --dry-run y exigen --apply
 * explícito. Toda escritura queda registrada, con el estado antes
 * y después, en el directorio de operaciones correspondiente. El estado de
 * trabajo vive también en state.db (SQLite en modo WAL), junto a los JSON que
 * se conservan como artefacto de salida de cada corrida. El censo puede repartir
 * las lecturas entre varios Chromium, coordinados por esa base local. Todo vive en
 * <directorio de datos del usuario>/tolkien, resuelto por invocación con
 * resolveDataDir(): ~/.cwc-data/tolkien para el host y el espacio propio del
 * inquilino cuando el server inyecta CWC_DATA_DIR. Ese aislamiento impide que
 * un inquilino opere Tolkien con la identidad del host. Las primitivas de
 * sesión y navegación se comparten con el observador de esquema mediante
 * cwc-tolkien-nav.js.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../src/core/data-dir.js';
import * as store from './cwc-tolkien-store.js';
import {
  BASE_URL,
  NAVIGATION_TIMEOUT_MS,
  CliError,
  InvalidSessionError,
  assertAuthenticated,
  errorMessage,
  gotoReadOnly,
  launchContext,
  readIdentity,
  requireSessionFile,
} from './cwc-tolkien-nav.js';

export {
  CliError,
  InvalidSessionError,
  WorkboardNotReadyError,
  errorMessage,
  launchContext,
} from './cwc-tolkien-nav.js';

const COOKIE_NAME = '__Secure-tolkien.session';
const MCP_URL = 'https://mcp.tolkien.mordorstaffing.com/mcp';
const MCP_TIMEOUT_MS = 20_000;
const WRITE_BATCH_CAP = 50;
const REASSIGN_NAVIGATION_TIMEOUT_MS = 60_000;
const REASSIGN_NAVIGATION_RETRY_DELAY_MS = 2_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL_EXECUTION_STATES = new Set(['completed', 'cancelled', 'closed']);
const CLOSED_OK_EXECUTION_STATES = new Set(['completed', 'closed']);
const REASSIGN_SKIP_REASONS = [
  'sin_asignado_en_zoho',
  'agente_zoho_desconocido',
  'agente_sin_email',
  'sin_usuario_en_tolkien',
  'usuario_ambiguo_en_tolkien',
  'ya_es_del_usuario',
];
const NEXT_ACTOR_KINDS = new Set([
  'teammate',
  'team',
  'requester',
  'manager_decision_owner',
  'hr',
  'accounting',
  'vendor',
  'building_administration',
  'automated_agent',
  'external_system',
]);
const SESSION_DAYS = 30;

// PROHIBIDO volver a calcular estas rutas en una constante de módulo: eso
// congela el espacio del HOST y un inquilino terminaría leyendo la sesión de
// Tolkien de otro (Familia B de health/invariants.js · console:BUG-2185 ·
// console:BUG-2472). Se resuelve por invocación, leyendo CWC_DATA_DIR en el
// momento de correr, no al importar el módulo.
export function tolkienPaths() {
  const dataDir = path.join(resolveDataDir(), 'tolkien');
  return {
    dataDir,
    sessionFile: path.join(dataDir, 'session.json'),
    whoamiFile: path.join(dataDir, 'whoami.json'),
    censusFile: path.join(dataDir, 'census.json'),
    partialFile: path.join(dataDir, 'census.partial.jsonl'),
    reconcileFile: path.join(dataDir, 'reconcile.json'),
    reconcilePartialFile: path.join(dataDir, 'reconcile.partial.jsonl'),
    opsDir: path.join(dataDir, 'ops'),
    dbFile: path.join(dataDir, 'state.db'),
  };
}

// El espejo a la base local NUNCA puede tumbar una corrida: si la DB falla, el
// JSON ya se escribió y sigue siendo la salida real del subcomando.
function withStore(paths, fn) {
  let db = null;
  try {
    db = store.openStore(paths.dbFile);
    return fn(db);
  } catch (error) {
    log(`Aviso: la base local no pudo registrar esta corrida: ${errorMessage(error)}`);
    return null;
  } finally {
    try { db?.close(); } catch { /* la base ya estaba cerrada */ }
  }
}

function log(message) {
  process.stderr.write(`[cwc-tolkien] ${message}\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function help() {
  process.stdout.write(`Uso:
  node bin/cwc-tolkien.js login --cookie <valor>
  node bin/cwc-tolkien.js login --cookie-file <ruta>
  printf '%s' '<cookie>' | node bin/cwc-tolkien.js login
  node bin/cwc-tolkien.js whoami
  node bin/cwc-tolkien.js census [--out <ruta>] [--limit <n>] [--fresh] [--workers <n>]
  node bin/cwc-tolkien.js reconcile [--census <ruta>] [--out <ruta>] [--limit <n>] [--fresh]
  node bin/cwc-tolkien.js close [--apply] [--reconcile <ruta>] [--limit <n>] [--confirm-large] [--only <workKey|ticketWorkflowId>]... [--next-actor <kind>]
  node bin/cwc-tolkien.js reassign [--apply] [--reconcile <ruta>] [--limit <n>] [--confirm-large] [--only <workKey|ticketWorkflowId>]...
  node bin/cwc-tolkien.js db [--stats] [--migrate] [--runs <n>] [--bucket <pila>]

Subcomandos:
  login    Guarda la cookie real en un storageState privado y ejecuta whoami.
  whoami   Verifica la sesión guardada e informa email y roles.
  census   Censa los tickets activos asignados al usuario de la sesión.
  reconcile Cruza el censo con Zoho Desk sin abrir Chromium ni escribir en Tolkien.
  close    Revisa o aplica el cierre en masa; el default absoluto es --dry-run.
  reassign Revisa o aplica la reasignación de la pila reassigned; default --dry-run.
  db       Consulta o migra el store de trabajo SQLite local.

Opciones de census:
  --out <ruta>  Escribe el JSON final en otra ruta.
  --limit <n>   Visita como máximo n tickets (útil para pruebas).
  --fresh       Descarta el progreso parcial anterior.
  --workers <n> Usa entre 1 y 12 navegadores; por defecto se calcula según memoria y núcleos.

Opciones de reconcile:
  --census <ruta>  Lee otro archivo de censo.
  --out <ruta>     Escribe el JSON final en otra ruta.
  --limit <n>      Procesa como máximo n tickets.
  --fresh          Descarta el progreso parcial anterior.

Opciones de close:
  --apply               Aplica las escrituras; sin este flag sólo informa.
  --reconcile <ruta>    Lee otro archivo de cruce.
  --limit <n>           Recorta la pila a procesar.
  --confirm-large       Autoriza lotes mayores al tope de 50.
  --only <id>           Filtra por workKey o ticketWorkflowId; es repetible.
  --next-actor <kind>   Actor siguiente (default: external_system).

Opciones de reassign:
  --apply               Aplica las escrituras; sin este flag sólo informa.
  --reconcile <ruta>    Lee otro archivo de cruce.
  --limit <n>           Recorta la pila reassigned a procesar.
  --confirm-large       Autoriza lotes mayores al tope de 50.
  --only <id>           Filtra por workKey o ticketWorkflowId; es repetible.

Opciones de db:
  --stats               Muestra conteos y la corrida más reciente (default).
  --migrate             Importa los JSON existentes sin borrarlos ni moverlos.
  --force               Repite la migración aunque ya haya sido ejecutada.
  --runs <n>            Lista las últimas n corridas (default: 20).
  --bucket <pila>       Lista la última pila closable, realOpen, reassigned o unpaired.
  --help        Muestra esta ayuda.
`);
}

export function ensureDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
}

function writeFileAtomic(file, contents, dataDir) {
  const parent = path.dirname(file);
  const relativeToData = path.relative(dataDir, parent);
  const insideData = relativeToData === ''
    || (!relativeToData.startsWith('..') && !path.isAbsolute(relativeToData));
  if (insideData) {
    ensureDataDir(dataDir);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.chmodSync(parent, 0o700);
  } else {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function writeJson(file, value, dataDir) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, dataDir);
}

function valueAfter(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CliError(`Falta el valor de ${option}.`);
  }
  return value;
}

function parseLoginArgs(args) {
  let cookie = null;
  let cookieFile = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--cookie') {
      cookie = valueAfter(args, i, arg);
      i += 1;
    } else if (arg === '--cookie-file') {
      cookieFile = valueAfter(args, i, arg);
      i += 1;
    } else {
      throw new CliError(`Opción desconocida para login: ${arg}`);
    }
  }
  if (cookie !== null && cookieFile !== null) {
    throw new CliError('Usá --cookie o --cookie-file, no ambos.');
  }
  if (cookieFile !== null) {
    try {
      cookie = fs.readFileSync(path.resolve(cookieFile), 'utf8');
    } catch (error) {
      throw new CliError(`No se pudo leer --cookie-file: ${error.message}`);
    }
  } else if (cookie === null) {
    try {
      cookie = fs.readFileSync(0, 'utf8');
    } catch (error) {
      throw new CliError(`No se pudo leer la cookie desde stdin: ${error.message}`);
    }
  }
  const trimmed = cookie.trim();
  if (!trimmed) {
    throw new CliError('La cookie está vacía.');
  }
  return trimmed;
}

function parseCensusArgs(args, paths) {
  let out = paths.censusFile;
  let limit = null;
  let fresh = false;
  let workers = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out') {
      out = path.resolve(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--limit') {
      const raw = valueAfter(args, i, arg);
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new CliError('--limit debe ser un entero mayor que cero.');
      }
      limit = Number(raw);
      i += 1;
    } else if (arg === '--fresh') {
      fresh = true;
    } else if (arg === '--workers') {
      const raw = valueAfter(args, i, arg);
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 12) {
        throw new CliError('--workers debe ser un entero entre 1 y 12.');
      }
      workers = Number(raw);
      i += 1;
    } else {
      throw new CliError(`Opción desconocida para census: ${arg}`);
    }
  }
  return { out, limit, fresh, workers };
}

function defaultWorkerCount() {
  const PER_WORKER_MB = 1200;
  let availableMb;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const availableKb = Number(meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1]);
    if (!Number.isFinite(availableKb) || availableKb <= 0) throw new Error('sin MemAvailable');
    availableMb = availableKb / 1024;
  } catch {
    availableMb = os.freemem() / (1024 * 1024);
  }
  const cores = Math.max(1, os.cpus().length);
  // Seis protege al Tolkien de producción; media máquina deja CPU al resto;
  // 1,2 GB por browser evita que el page cache oculte presión real de memoria.
  return Math.max(
    1,
    Math.min(6, Math.floor(cores / 2), Math.floor(availableMb / PER_WORKER_MB)),
  );
}

function positiveInteger(raw, option = '--limit') {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new CliError(`${option} debe ser un entero mayor que cero.`);
  }
  return Number(raw);
}

function parseReconcileArgs(args, paths) {
  let censusFile = paths.censusFile;
  let out = paths.reconcileFile;
  let limit = null;
  let fresh = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--census') {
      censusFile = path.resolve(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--out') {
      out = path.resolve(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--limit') {
      limit = positiveInteger(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--fresh') {
      fresh = true;
    } else {
      throw new CliError(`Opción desconocida para reconcile: ${arg}`);
    }
  }
  return { censusFile, out, limit, fresh };
}

function parseCloseArgs(args, paths) {
  let apply = false;
  let reconcileFile = paths.reconcileFile;
  let limit = null;
  let confirmLarge = false;
  let nextActorKind = 'external_system';
  const only = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--reconcile') {
      reconcileFile = path.resolve(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--limit') {
      limit = positiveInteger(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--confirm-large') {
      confirmLarge = true;
    } else if (arg === '--only') {
      only.push(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--next-actor') {
      nextActorKind = valueAfter(args, i, arg);
      i += 1;
    } else {
      throw new CliError(`Opción desconocida para close: ${arg}`);
    }
  }
  if (nextActorKind === 'scheduled_time') {
    throw new CliError(
      'El valor scheduled_time está prohibido: Tolkien rechaza mode=working '
        + 'combinado con nextActorKind=scheduled_time.',
    );
  }
  if (!NEXT_ACTOR_KINDS.has(nextActorKind)) {
    throw new CliError(
      `Valor inválido para --next-actor: ${nextActorKind}. Valores válidos: `
        + `${[...NEXT_ACTOR_KINDS].join(', ')}.`,
    );
  }
  return { apply, reconcileFile, limit, confirmLarge, only, nextActorKind };
}

function parseReassignArgs(args, paths) {
  let apply = false;
  let reconcileFile = paths.reconcileFile;
  let limit = null;
  let confirmLarge = false;
  const only = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--reconcile') {
      reconcileFile = path.resolve(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--limit') {
      limit = positiveInteger(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--confirm-large') {
      confirmLarge = true;
    } else if (arg === '--only') {
      only.push(valueAfter(args, i, arg));
      i += 1;
    } else {
      throw new CliError(`Opción desconocida para reassign: ${arg}`);
    }
  }
  return { apply, reconcileFile, limit, confirmLarge, only };
}

async function whoami({ print = true, paths }) {
  requireSessionFile(paths.sessionFile);
  const { browser, context } = await launchContext(paths.sessionFile);
  const page = await context.newPage();
  const checkedAt = new Date().toISOString();
  try {
    await gotoReadOnly(page, `${BASE_URL}/tickets`);
    const identity = await readIdentity(page);
    if (!identity.email) {
      throw new CliError(
        'La sesión respondió, pero no se pudo leer el email del header de Tolkien.',
      );
    }
    const result = { ok: true, ...identity, checkedAt };
    writeJson(paths.whoamiFile, result, paths.dataDir);
    if (print) {
      printJson(result);
      log(`Sesión válida: ${identity.email} (${identity.roles.join(', ') || 'sin roles visibles'}).`);
    }
    return result;
  } catch (error) {
    writeJson(paths.whoamiFile, {
      ok: false,
      error: errorMessage(error),
      checkedAt,
    }, paths.dataDir);
    throw error;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function login(args, paths) {
  const cookie = parseLoginArgs(args);
  const expires = Math.floor(Date.now() / 1_000) + SESSION_DAYS * 24 * 60 * 60;
  const storageState = {
    cookies: [
      {
        name: COOKIE_NAME,
        value: cookie,
        domain: '.tolkien.mordorstaffing.com',
        path: '/',
        expires,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
  writeJson(paths.sessionFile, storageState, paths.dataDir);
  log(`StorageState guardado en ${paths.sessionFile} (cookie ${COOKIE_NAME}=***).`);
  return whoami({ print: true, paths });
}

function readPartial(file) {
  const records = new Map();
  if (!fs.existsSync(file)) return records;
  fs.chmodSync(file, 0o600);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record.ticketWorkflowId === 'string') {
        records.set(record.ticketWorkflowId, record);
      }
    } catch {
      log(`Se ignoró una línea parcial incompleta (${index + 1}).`);
    }
  }
  return records;
}

function resetPartial(file, dataDir) {
  const parent = path.dirname(file);
  if (parent === dataDir) ensureDataDir(dataDir);
  else fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, '', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function appendPartial(record, file, dataDir) {
  const parent = path.dirname(file);
  if (parent === dataDir) ensureDataDir(dataDir);
  else fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

function mcpToken() {
  if (process.env.TOLKIEN_MCP_TOKEN) return process.env.TOLKIEN_MCP_TOKEN;
  const envFile = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .find((candidate) => /^TOLKIEN_MCP_TOKEN=/.test(candidate));
    if (line) {
      let value = line.slice('TOLKIEN_MCP_TOKEN='.length).trim();
      if (
        value.length >= 2
        && ((value.startsWith('"') && value.endsWith('"'))
          || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (value) return value;
    }
  }
  throw new CliError(
    `Falta TOLKIEN_MCP_TOKEN en ${path.join(REPO_ROOT, '.env')}.`,
  );
}

function parseMcpBody(text) {
  const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith('data: '));
  const raw = dataLines.length > 0
    ? dataLines.at(-1).slice('data: '.length)
    : text;
  const parsed = JSON.parse(raw);
  if (parsed?.error) {
    throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  }
  return parsed;
}

function createZohoClient() {
  const token = mcpToken();
  let sessionId = null;
  let initialized = false;
  let requestId = 1;

  const post = async (body, timeoutName, { expectBody = true } = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
    try {
      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const response = await fetch(MCP_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(
          `MCP respondió HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        );
      }
      const text = await response.text();
      if (!expectBody && !text.trim()) return { response, rpc: null };
      return { response, rpc: parseMcpBody(text) };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`timeout MCP: ${timeoutName}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const initialize = async () => {
    if (initialized) return;
    const { response } = await post({
      jsonrpc: '2.0',
      id: requestId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'cwc-tolkien', version: '1.0' },
      },
    }, 'initialize');
    requestId += 1;
    sessionId = response.headers.get('mcp-session-id');
    if (!sessionId) throw new Error('El handshake MCP no devolvió mcp-session-id.');
    await post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, 'notifications/initialized', { expectBody: false });
    initialized = true;
  };

  return {
    async callTool(name, args) {
      await initialize();
      const { rpc } = await post({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: { name, arguments: args },
      }, name);
      requestId += 1;
      const result = rpc?.result;
      if (result?.isError) {
        const first = result.content?.[0];
        throw new Error(first?.text || JSON.stringify(result));
      }
      const textContent = result?.content?.find((content) => content.type === 'text');
      if (!textContent) throw new Error(`MCP no devolvió contenido de texto para ${name}.`);
      let value;
      try {
        value = JSON.parse(textContent.text);
      } catch {
        value = textContent.text;
      }
      if (value && typeof value === 'object' && value.errorCode) {
        throw new Error(
          `Zoho Desk: ${value.errorCode} — ${value.message || 'error sin detalle'}`,
        );
      }
      return value;
    },
  };
}

async function deskGetTicket(client, ticketId) {
  return client.callTool('desk_get_ticket', { ticket_id: String(ticketId) });
}

async function deskSearchTickets(client, query, limit = 20) {
  const result = await client.callTool('desk_search_tickets', { query, limit });
  return result?.tickets ?? [];
}

const agentsByClient = new WeakMap();

function agentsFromDeskResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.agents)) return result.agents;
  if (Array.isArray(result?.data)) return result.data;
  return null;
}

function addDeskAgents(byId, agents) {
  const before = byId.size;
  for (const agent of agents) {
    const id = String(agent?.id ?? '').trim();
    if (!id) continue;
    byId.set(id, { name: agent.name ?? null, email: agent.email ?? null });
  }
  return byId.size - before;
}

async function deskListAgents(client) {
  if (agentsByClient.has(client)) return agentsByClient.get(client);
  // 100 es el tope observado de desk_list_agents. Se probó 500 y la tool
  // devolvió el directorio vacío; no volver a "optimizar" subiendo el límite.
  const pageSize = 100;
  const maxPages = 20;
  const byId = new Map();
  let firstPage = null;
  try {
    firstPage = agentsFromDeskResult(
      await client.callTool('desk_list_agents', { limit: pageSize }),
    );
  } catch {
    // El guard común de abajo convierte cualquier primera carga fallida en un
    // error de infraestructura explícito, nunca en datos de negocio faltantes.
  }
  if (firstPage) addDeskAgents(byId, firstPage);

  if (firstPage?.length === pageSize) {
    const strategies = [
      { name: 'from', value: (pageIndex) => pageIndex * pageSize },
      { name: 'offset', value: (pageIndex) => pageIndex * pageSize },
      { name: 'page', value: (pageIndex) => pageIndex + 1 },
    ];
    let selected = null;
    let secondPage = null;
    for (const strategy of strategies) {
      try {
        const page = agentsFromDeskResult(await client.callTool('desk_list_agents', {
          limit: pageSize,
          [strategy.name]: strategy.value(1),
        }));
        if (!page) continue;
        if (page.length > 0 && addDeskAgents(byId, page) === 0) continue;
        selected = strategy;
        secondPage = page;
        break;
      } catch {
        // Si un parámetro no existe, probamos el siguiente sin perder la página 1.
      }
    }

    if (selected && secondPage?.length === pageSize) {
      for (let pageIndex = 2; pageIndex < maxPages; pageIndex += 1) {
        try {
          const page = agentsFromDeskResult(await client.callTool('desk_list_agents', {
            limit: pageSize,
            [selected.name]: selected.value(pageIndex),
          }));
          if (!page) break;
          const added = addDeskAgents(byId, page);
          if ((page.length > 0 && added === 0) || page.length < pageSize) break;
        } catch {
          // Una página posterior fallida no invalida los agentes ya acumulados.
          break;
        }
      }
    }
  }

  if (byId.size === 0) {
    throw new CliError(
      'No se pudo cargar el directorio de agentes de Zoho; sin él no se puede '
        + 'verificar ni resolver ningún assignee. Revisá desk_list_agents.',
    );
  }
  agentsByClient.set(client, byId);
  return byId;
}

async function listAssignedTickets(page) {
  // Tolkien resuelve estos filtros en la URL y `focus=mine` compara el
  // assignedToUserId del workflow con el viewerUserId de la sesión.
  const url = `${BASE_URL}/tickets?view=active&focus=mine#queue`;
  await gotoReadOnly(page, url);
  await page.waitForSelector('#queue', { timeout: NAVIGATION_TIMEOUT_MS });
  return page.evaluate((baseUrl) => {
    const found = new Map();
    const anchors = document.querySelectorAll(
      '#queue ul > li a[href^="/tickets/"], #queue ul > li a[href*="/tickets/"]',
    );
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href');
      if (!href) continue;
      const absolute = new URL(href, baseUrl);
      const match = absolute.pathname.match(/^\/tickets\/([^/]+)$/);
      if (!match) continue;
      found.set(match[1], {
        ticketWorkflowId: match[1],
        url: absolute.href,
        listingText: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
      });
    }
    return [...found.values()];
  }, BASE_URL);
}

function fieldFromSerializedHtml(html, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`"${escaped}":"([^"\\\\]*)"`),
    new RegExp(`\\\\"${escaped}\\\\":\\\\"([^"\\\\]*)`),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1].replace(/\\u0026/g, '&').replace(/\\\\/g, '\\');
  }
  return null;
}

function deskIdFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    // La llave real para cruzar con Zoho Desk vive en el href, dentro del hash:
    // ...ShowHomePage.do#Cases/dv/813994000003886174.
    if (url.hostname === 'support.mordorstaffing.co') {
      const deskRoute = `${url.pathname}${url.search}${url.hash}`;
      const deskMatch = deskRoute.match(/Cases\/dv\/(\d+)(?:\b|\/|$)/i);
      if (deskMatch) return deskMatch[1];
    }
    for (const key of ['ticketId', 'ticketid', 'id']) {
      const value = url.searchParams.get(key);
      if (value && /^\d+$/.test(value)) return value;
    }
    const pathIds = url.pathname.match(/\d{5,}/g);
    return pathIds?.at(-1) ?? null;
  } catch {
    return null;
  }
}

async function readOverview(page) {
  return page.evaluate((terminalExecutionStates) => {
    const clean = (value) => value?.replace(/\s+/g, ' ').trim() || null;
    // Durante la hidratación puede convivir el cascarón con el contenido real;
    // elegimos el main útil sin perder badges repartidos entre mains (console:BUG-2556).
    const todos = [...document.querySelectorAll('main')];
    const reales = todos.filter((m) => !(m.textContent ?? '').includes('Loading ticket workboard'));
    const candidatos = reales.length > 0 ? reales : todos;
    const main = candidatos.find((m) => /\bWORK-\d+\b/.test(m.textContent ?? ''))
      ?? candidatos.at(-1)
      ?? null;
    // WORK-n es el identificador visible más estable del header; no dependemos
    // de la cadena completa de clases Tailwind ni del aria-label del botón volver.
    const workSpan = [...(main?.querySelectorAll('span') ?? [])]
      .find((span) => /^WORK-\d+$/.test(clean(span.textContent) ?? ''));
    const detailHeader = workSpan?.closest('header') ?? main?.querySelector('header');
    const headerText = clean(detailHeader?.textContent) ?? '';
    const workNumber = clean(workSpan?.textContent)
      ?? headerText.match(/\bWORK-\d+\b/)?.[0]
      ?? null;
    const title = clean(detailHeader?.querySelector('h1')?.textContent)
      ?? clean(main?.querySelector('h1')?.textContent);
    const progressHeading = document.querySelector('#current-progress-heading');
    const progressEyebrow = clean(progressHeading?.previousElementSibling?.textContent);
    // El primer badge que sigue a WORK-n es el estado. Los estados conocidos se
    // normalizan; ante uno nuevo conservamos el texto original para no perderlo.
    const spansAfterWork = workSpan && detailHeader
      ? [...detailHeader.querySelectorAll('span')].slice(
          [...detailHeader.querySelectorAll('span')].indexOf(workSpan) + 1,
        )
      : [];
    const badgeTexts = spansAfterWork.map((span) => clean(span.textContent)).filter(Boolean);
    const rawExecutionState = badgeTexts[0] ?? progressEyebrow;
    const normalizedState = rawExecutionState?.toLowerCase() ?? null;
    const executionState = (
      normalizedState === 'active' || terminalExecutionStates.includes(normalizedState)
    )
      ? normalizedState
      : rawExecutionState;
    const dlValue = (label) => {
      const dt = [...document.querySelectorAll('dt')]
        .find((candidate) => clean(candidate.textContent) === label);
      return clean(dt?.nextElementSibling?.textContent);
    };
    const reported = [...document.querySelectorAll('main span, main p')]
      .map((element) => clean(element.textContent))
      .find((text) => text?.startsWith('Reported ')) ?? null;
    const latestSection = [...document.querySelectorAll('main section')]
      .find((section) => [...section.querySelectorAll('h2')]
        .some((heading) => clean(heading.textContent) === 'Latest progress'));
    const latestMeta = latestSection
      ? [...latestSection.querySelectorAll('p')]
          .map((element) => clean(element.textContent))
          .find((text) => text && /\b\d{4}-\d{2}-\d{2}\b/.test(text) && text.includes('·')) ?? null
      : null;
    // Desk no expone necesariamente su número corto: el dato confiable es el
    // enlace support.mordorstaffing.co cuyo hash contiene Cases/dv/<id largo>.
    const deskLink = [...document.querySelectorAll('main a[href]')]
      .find((anchor) => {
        try {
          const url = new URL(anchor.href);
          return url.hostname === 'support.mordorstaffing.co'
            && /Cases\/dv\/\d+/i.test(`${url.pathname}${url.search}${url.hash}`);
        } catch {
          return false;
        }
      });
    const mainText = clean(candidatos.map((m) => m.innerText).join('\n')) ?? '';
    return {
      workNumber,
      title,
      executionState,
      assignee: dlValue('Owner'),
      desiredOutcome: dlValue('Desired outcome'),
      targetAt: dlValue('Target date'),
      createdAt: reported?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null,
      lastMovementAt: latestMeta?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null,
      lastMovement: latestMeta,
      deskUrl: deskLink?.href ?? null,
      deskTicketNumber: mainText.match(/\b(?:Zoho\s+)?Desk\s*#\s*(\d+)\b/i)?.[1] ?? null,
    };
  }, [...TERMINAL_EXECUTION_STATES]);
}

async function readManage(page) {
  return page.evaluate(() => {
    const clean = (value) => value?.replace(/\s+/g, ' ').trim() || null;
    const valueOf = (selector) => {
      const element = document.querySelector(selector);
      return element && 'value' in element ? clean(String(element.value)) : null;
    };
    const dlValue = (label) => {
      const dt = [...document.querySelectorAll('dt')]
        .find((candidate) => clean(candidate.textContent) === label);
      return clean(dt?.nextElementSibling?.textContent);
    };
    const ownership = document.querySelector('#ownership');
    const taken = clean(ownership?.textContent)?.match(/Taken by\s+(.+?)(?:\s+·|\s+\(assigned by|$)/)?.[1] ?? null;
    // En ?tab=estado el resultado esperado editable vive en un textarea; el
    // hidden y el <dl> quedan como compatibilidad con otras variantes de vista.
    const desired = valueOf('textarea[name="desiredOutcome"]')
      ?? valueOf('input[type="hidden"][name="desiredOutcome"]')
      ?? dlValue('Desired outcome');
    const mode = valueOf('select[name="mode"]');
    // Si hay contenido real, el cascarón de hidratación no aporta datos; el resto
    // de los mains sí puede contener el badge buscado (console:BUG-2556).
    const todos = [...document.querySelectorAll('main')];
    const reales = todos.filter((main) =>
      !(main.textContent ?? '').includes('Loading ticket workboard'),
    );
    const candidatos = reales.length > 0 ? reales : todos;
    const mainText = clean(candidatos.map((main) => main.innerText).join('\n')) ?? '';
    return {
      ticketWorkflowId: valueOf('input[type="hidden"][name="ticketWorkflowId"]'),
      desiredOutcome: desired === 'Not recorded' ? null : desired,
      isWaiting: mode === 'waiting',
      assignee: taken,
      priority: valueOf('select[name="priority"]'),
      bucketKey: valueOf('select[name="bucketKey"]'),
      targetAt: valueOf('input[name="targetOn"]') ?? dlValue('Target / effective date'),
      externalCommitmentAt:
        valueOf('input[name="externalCommitmentOn"]') ?? dlValue('External commitment'),
      deskTicketNumber: mainText.match(/\b(?:Zoho\s+)?Desk\s*#\s*(\d+)\b/i)?.[1] ?? null,
    };
  });
}

async function readDeskNumber(page, detailUrl) {
  await gotoReadOnly(page, `${detailUrl}?tab=dev`);
  // Con dos <main> el locator estricto explota; leer todos y concatenar es inmune
  // a cuántos haya y a cuál sea el real (console:BUG-2556).
  const text = await page.evaluate(
    () => [...document.querySelectorAll('main')].map((main) => main.innerText).join('\n'),
  );
  return text.match(/legacy Desk #(\d+)/i)?.[1] ?? null;
}

function nullableVisible(value) {
  if (!value || value === 'Not set' || value === 'Not defined' || value === '—') {
    return null;
  }
  return value;
}

// Tolkien devuelve el texto renderizado y readManage le colapsa los espacios:
// comparar crudo daría falsos negativos por un salto de línea del asunto de Zoho.
function sameText(a, b) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

async function scrapeTicket(page, listed) {
  const detailUrl = `${BASE_URL}/tickets/${encodeURIComponent(listed.ticketWorkflowId)}`;
  await gotoReadOnly(page, detailUrl);
  await page.waitForSelector('main h1', { timeout: NAVIGATION_TIMEOUT_MS });
  const overview = await readOverview(page);
  const overviewHtml = await page.content();

  await gotoReadOnly(page, `${detailUrl}?tab=estado`);
  // Este input es hidden: nunca será visible, sólo necesitamos que esté adjunto al DOM.
  await page.waitForSelector('input[name="ticketWorkflowId"]', {
    state: 'attached',
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  const manage = await readManage(page);
  const manageHtml = await page.content();

  const serializedDeskId = [
    fieldFromSerializedHtml(overviewHtml, 'deskTicketId'),
    fieldFromSerializedHtml(manageHtml, 'deskTicketId'),
  ].find((value) => value && value !== 'null') ?? null;
  const serializedDeskNumber = [
    fieldFromSerializedHtml(overviewHtml, 'deskTicketNumber'),
    fieldFromSerializedHtml(manageHtml, 'deskTicketNumber'),
  ].find((value) => value && value !== 'null') ?? null;
  let deskTicketId = deskIdFromUrl(overview.deskUrl) ?? serializedDeskId;
  let deskTicketNumber = overview.deskTicketNumber
    ?? manage.deskTicketNumber
    ?? serializedDeskNumber;
  // Cualquiera de las dos señales confirma que el ticket tiene par en Desk;
  // exigir sólo el enlace perdía el número cuando overview no lo leyó (console:BUG-2556).
  if (!deskTicketNumber && (overview.deskUrl || deskTicketId)) {
    deskTicketNumber = await readDeskNumber(page, detailUrl);
  }
  // Tolkien puede no mostrar el número corto humano (#693). En ese caso queda
  // null: reconcile debe usar deskTicketId, la llave real tomada del href.
  if (deskTicketId === 'null') deskTicketId = null;
  if (deskTicketNumber === 'null') deskTicketNumber = null;

  const desiredOutcome = nullableVisible(manage.desiredOutcome ?? overview.desiredOutcome);
  const assignee = nullableVisible(
    manage.assignee ?? (overview.assignee === 'Not assigned' ? null : overview.assignee),
  );
  const workKey =
    overview.workNumber ?? listed.listingText.match(/\bWORK-\d+\b/)?.[0] ?? null;
  return {
    ticketWorkflowId: manage.ticketWorkflowId ?? listed.ticketWorkflowId,
    workNumber: workKey,
    workKey,
    title: overview.title,
    executionState: overview.executionState,
    deskTicketNumber,
    deskTicketId,
    hasDesiredOutcome: Boolean(desiredOutcome),
    desiredOutcome,
    isWaiting: Boolean(manage.isWaiting),
    assignee,
    priority: nullableVisible(manage.priority),
    bucketKey: nullableVisible(manage.bucketKey),
    targetAt: nullableVisible(manage.targetAt ?? overview.targetAt),
    externalCommitmentAt: nullableVisible(manage.externalCommitmentAt),
    createdAt: overview.createdAt,
    lastMovementAt: overview.lastMovementAt,
    lastMovement: overview.lastMovement,
    url: detailUrl,
  };
}

export async function scrapeWithRetry(page, listed) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await scrapeTicket(page, listed);
    } catch (error) {
      if (error instanceof InvalidSessionError) throw error;
      lastError = error;
      log(
        `Fallo leyendo ${listed.ticketWorkflowId} (intento ${attempt}/2): ${errorMessage(error)}`,
      );
    }
  }
  return {
    ticketWorkflowId: listed.ticketWorkflowId,
    url: listed.url,
    error: errorMessage(lastError),
  };
}

async function censusSequential(options, paths, identity) {
  if (options.fresh) resetPartial(paths.partialFile, paths.dataDir);
  const partial = readPartial(paths.partialFile);
  const { browser, context } = await launchContext(paths.sessionFile);
  const page = await context.newPage();
  try {
    const allListed = await listAssignedTickets(page);
    const listed = options.limit === null
      ? allListed
      : allListed.slice(0, options.limit);
    log(
      `Vista "Mis tickets": ${allListed.length} asignados; ${listed.length} dentro de esta corrida.`,
    );
    for (let index = 0; index < listed.length; index += 1) {
      const item = listed[index];
      if (partial.has(item.ticketWorkflowId)) {
        log(`[${index + 1}/${listed.length}] ${item.ticketWorkflowId}: ya estaba en el parcial.`);
        continue;
      }
      log(`[${index + 1}/${listed.length}] Leyendo ${item.ticketWorkflowId}.`);
      const record = await scrapeWithRetry(page, item);
      appendPartial(record, paths.partialFile, paths.dataDir);
      partial.set(item.ticketWorkflowId, record);
    }

    const tickets = listed
      .map((item) => partial.get(item.ticketWorkflowId))
      .filter(Boolean);
    const result = {
      generatedAt: new Date().toISOString(),
      viewerEmail: identity.email,
      count: tickets.length,
      tickets,
    };
    writeJson(options.out, result, paths.dataDir);
    printJson(result);
    withStore(paths, (db) => {
      const runUid = store.startRun(db, {
        kind: 'census',
        viewerEmail: identity.email,
        scope: { limit: options.limit, fresh: options.fresh, out: options.out },
      });
      const written = store.upsertTickets(db, runUid, tickets, result.generatedAt);
      store.finishRun(db, runUid, { counts: { ...written, total: tickets.length } });
      log(`Base local: ${written.inserted} tickets registrados en la corrida ${runUid}.`);
    });

    const successful = tickets.filter((ticket) => !ticket.error);
    const withoutOutcome = successful.filter((ticket) => !ticket.hasDesiredOutcome).length;
    const waiting = successful.filter((ticket) => ticket.isWaiting).length;
    const withoutDesk = successful.filter(
      (ticket) => !ticket.deskTicketId && !ticket.deskTicketNumber,
    ).length;
    const failed = tickets.length - successful.length;
    log(
      `Censo listo: ${tickets.length} total · ${withoutOutcome} sin desiredOutcome · `
        + `${waiting} en espera · ${withoutDesk} sin Zoho asociado`
        + (failed ? ` · ${failed} con error` : ''),
    );
    return result;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parallelWorkerPath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'cwc-tolkien-worker.js',
  );
}

function spawnCensusWorker(runUid, workerId) {
  const child = spawn(process.execPath, [
    parallelWorkerPath(),
    '--run',
    runUid,
    '--worker-id',
    workerId,
  ], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  let resolveExited;
  const state = {
    child,
    workerId,
    alive: true,
    code: null,
    signal: null,
    error: null,
    exited: new Promise((resolve) => { resolveExited = resolve; }),
  };
  const finish = (code, signal = null, error = null) => {
    if (!state.alive) return;
    state.alive = false;
    state.code = code;
    state.signal = signal;
    state.error = error;
    resolveExited();
  };
  child.once('exit', (code, signal) => finish(code ?? 1, signal));
  child.once('error', (error) => finish(1, null, error));
  return state;
}

async function stopCensusWorkers(children) {
  const alive = children.filter((state) => state.alive);
  for (const state of alive) {
    try { state.child.kill('SIGTERM'); } catch { /* el hijo terminó entre el filtro y kill */ }
  }
  if (alive.length === 0) return;
  await Promise.race([
    Promise.all(alive.map((state) => state.exited)),
    delay(5_000),
  ]);
  const stubborn = alive.filter((state) => state.alive);
  for (const state of stubborn) {
    try { state.child.kill('SIGKILL'); } catch { /* el hijo terminó antes de la red de seguridad */ }
  }
  await Promise.all(stubborn.map((state) => state.exited));
}

async function superviseCensusWorkers(db, runUid, workers) {
  const deadline = Date.now() + 30 * 60_000;
  const maxSpawns = Math.max(8, workers * 3);
  const children = [];
  let spawns = 0;
  let nextWorkerNumber = 1;
  let lastDone = null;
  let waitingForStaleLogged = false;

  while (spawns < workers && spawns < maxSpawns) {
    children.push(spawnCensusWorker(runUid, `w${nextWorkerNumber}`));
    nextWorkerNumber += 1;
    spawns += 1;
  }

  try {
    while (true) {
      await delay(2_000);
      // El worker latea cada 15 s; 60 s equivalen a cuatro latidos perdidos.
      const reclaimed = store.reclaimStaleScanTargets(db, runUid, { staleMs: 60_000 });
      if (reclaimed > 0) log(`Cola paralela: ${reclaimed} tickets vencidos volvieron a pending.`);
      const counts = store.scanQueueCounts(db, runUid);
      let liveWorkers = children.filter((state) => state.alive).length;
      if (counts.done !== lastDone) {
        log(`Progreso: ${counts.done}/${counts.total} (activos: ${liveWorkers} workers)`);
        lastDone = counts.done;
      }

      if (children.some((state) => !state.alive && state.code === 2)) {
        throw new InvalidSessionError();
      }

      const remaining = counts.pending + counts.running + counts.retryable;
      if (remaining === 0) return counts;

      const reclamable = counts.pending + counts.retryable;
      const targetWorkers = Math.min(workers, reclamable);
      while (liveWorkers < targetWorkers && spawns < maxSpawns) {
        const workerId = `w${nextWorkerNumber}`;
        const previousLiveWorkers = liveWorkers;
        children.push(spawnCensusWorker(runUid, workerId));
        nextWorkerNumber += 1;
        spawns += 1;
        liveWorkers += 1;
        log(
          `Cola paralela: arrancando ${workerId}; workers activos: `
            + `${previousLiveWorkers} → ${liveWorkers}.`,
        );
      }

      liveWorkers = children.filter((state) => state.alive).length;
      if (liveWorkers === 0 && reclamable === 0 && counts.running > 0) {
        if (!waitingForStaleLogged) {
          log(
            `Esperando el rescate de ${counts.running} tickets que quedaron en manos `
              + 'de workers muertos.',
          );
          waitingForStaleLogged = true;
        }
      } else if (liveWorkers === 0 && reclamable > 0 && spawns >= maxSpawns) {
        log(
          `Se agotó el presupuesto de ${maxSpawns} arranques de workers; `
            + 'se cierra la corrida con lo reunido.',
        );
        return counts;
      }

      if (Date.now() >= deadline) {
        log('El censo paralelo alcanzó el tope de 30 minutos; se cerrará con lo reunido.');
        return counts;
      }
    }
  } finally {
    await stopCensusWorkers(children);
  }
}

async function censusParallel(options, paths, identity, workers) {
  const startedAt = Date.now();
  let db = null;
  try {
    try {
      db = store.openStore(paths.dbFile);
    } catch (error) {
      throw new CliError(
        `No se pudo abrir la base local para el censo paralelo: ${errorMessage(error)}. `
          + 'Podés usar el camino secuencial con --workers 1.',
      );
    }

    let runUid;
    if (!options.fresh) {
      const previous = store.latestRun(db, ['census-parallel']);
      if (previous?.status === 'running') runUid = previous.run_uid;
    }
    if (runUid) {
      log(`Censo paralelo: retomando la corrida ${runUid}.`);
    } else {
      runUid = store.startRun(db, {
        kind: 'census-parallel',
        viewerEmail: identity.email,
        scope: { limit: options.limit, workers, out: options.out },
      });
      log(`Censo paralelo: nueva corrida ${runUid}.`);
    }

    let browser = null;
    let context = null;
    let page = null;
    let allListed;
    try {
      ({ browser, context } = await launchContext(paths.sessionFile));
      page = await context.newPage();
      allListed = await listAssignedTickets(page);
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
    const listed = options.limit === null
      ? allListed
      : allListed.slice(0, options.limit);
    log(
      `Vista "Mis tickets": ${allListed.length} asignados; ${listed.length} dentro de esta corrida.`,
    );
    const queued = store.enqueueScanTargets(db, runUid, listed);
    log(
      `Cola paralela: ${queued.enqueued} encolados · ${queued.existing} ya estaban`
        + (queued.skipped ? ` · ${queued.skipped} omitidos` : ''),
    );

    await superviseCensusWorkers(db, runUid, workers);

    const byWorkflowId = new Map(
      store.runTickets(db, runUid).map((ticket) => [ticket.ticketWorkflowId, ticket]),
    );
    const queueByWorkflowId = new Map(
      store.scanQueueRows(db, runUid)
        .map((row) => [row.ticket_workflow_id, row]),
    );
    const synthesizedIds = [];
    const tickets = listed.map((item) => {
      const observed = byWorkflowId.get(item.ticketWorkflowId);
      if (observed) return observed;
      const queueRow = queueByWorkflowId.get(item.ticketWorkflowId);
      const attempts = Number(queueRow?.attempts ?? 0);
      const status = queueRow?.status ?? 'sin fila';
      const error = queueRow?.error
        ? `sin resultado tras ${attempts} intentos: ${queueRow.error}`
        : `el censo paralelo terminó sin leer este ticket `
          + `(estado ${status}, intentos ${attempts})`;
      synthesizedIds.push(
        item.listingText?.match(/\bWORK-\d+\b/)?.[0] ?? item.ticketWorkflowId,
      );
      return {
        ticketWorkflowId: item.ticketWorkflowId,
        url: item.url,
        error,
      };
    });
    if (synthesizedIds.length > 0) {
      log(
        `ATENCIÓN: ${synthesizedIds.length} tickets quedaron sin leer y entraron al censo `
          + `como error: ${synthesizedIds.join(', ')}`,
      );
    }
    const result = {
      generatedAt: new Date().toISOString(),
      viewerEmail: identity.email,
      count: tickets.length,
      tickets,
    };
    writeJson(options.out, result, paths.dataDir);
    resetPartial(paths.partialFile, paths.dataDir);
    for (const ticket of tickets) appendPartial(ticket, paths.partialFile, paths.dataDir);

    const successful = tickets.filter((ticket) => !ticket.error);
    const failed = tickets.length - successful.length;
    store.finishRun(db, runUid, {
      status: 'done',
      counts: { total: tickets.length, ok: successful.length, error: failed, workers },
    });
    printJson(result);
    const withoutOutcome = successful.filter((ticket) => !ticket.hasDesiredOutcome).length;
    const waiting = successful.filter((ticket) => ticket.isWaiting).length;
    const withoutDesk = successful.filter(
      (ticket) => !ticket.deskTicketId && !ticket.deskTicketNumber,
    ).length;
    log(
      `Censo listo: ${tickets.length} total · ${withoutOutcome} sin desiredOutcome · `
        + `${waiting} en espera · ${withoutDesk} sin Zoho asociado`
        + (failed ? ` · ${failed} con error` : ''),
    );
    log(
      `Censo paralelo: ${workers} workers · ${Math.round((Date.now() - startedAt) / 1000)} s `
        + `· corrida ${runUid}`,
    );
    return result;
  } finally {
    try { db?.close(); } catch { /* la base ya estaba cerrada */ }
  }
}

async function census(args, paths) {
  const options = parseCensusArgs(args, paths);
  const identity = await whoami({ print: false, paths });
  ensureDataDir(paths.dataDir);
  const workers = options.workers ?? defaultWorkerCount();
  if (workers === 1) return censusSequential(options, paths, identity);
  return censusParallel(options, paths, identity, workers);
}

function readJsonFile(file, description) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`No se pudo leer ${description} en ${file}: ${error.message}`);
  }
}

function truncated(value, maximum) {
  const text = String(value ?? '');
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

export function zohoSnapshot(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id ?? null,
    ticketNumber: ticket.ticketNumber ?? null,
    subject: ticket.subject ?? null,
    status: ticket.status ?? null,
    statusType: ticket.statusType ?? null,
    closedTime: ticket.closedTime ?? null,
    modifiedTime: ticket.modifiedTime ?? null,
    resolution: ticket.resolution ?? null,
    webUrl: ticket.webUrl ?? null,
    assigneeId: ticket.assigneeId ?? null,
  };
}

function reconciliationBase(ticket, zoho = null) {
  return {
    ticketWorkflowId: ticket.ticketWorkflowId ?? null,
    workKey: ticket.workKey ?? null,
    workNumber: ticket.workNumber ?? null,
    title: ticket.title ?? null,
    url: ticket.url ?? null,
    isWaiting: Boolean(ticket.isWaiting),
    hasDesiredOutcome: Boolean(ticket.hasDesiredOutcome),
    desiredOutcome: ticket.desiredOutcome ?? null,
    deskTicketNumber: ticket.deskTicketNumber ?? zoho?.ticketNumber ?? null,
    deskTicketId: ticket.deskTicketId ?? zoho?.id ?? null,
    zoho: zohoSnapshot(zoho),
  };
}

export async function classifyReconciliationTicket(
  ticket,
  client,
  generatedAt,
  getAgents,
  viewerAgentId,
) {
  const unpaired = (reason, detail = null, zoho = null) => ({
    bucket: 'unpaired',
    entry: { ...reconciliationBase(ticket, zoho), reason, detail },
  });
  if (ticket.error) return unpaired('census_error', String(ticket.error));
  if (ticket.executionState !== 'active') return unpaired('not_active_in_tolkien');
  if (!ticket.deskTicketId && !ticket.deskTicketNumber) return unpaired('no_desk_link');

  let zoho;
  if (ticket.deskTicketId) {
    try {
      zoho = await deskGetTicket(client, ticket.deskTicketId);
    } catch (error) {
      return unpaired('desk_lookup_failed', errorMessage(error));
    }
  } else {
    let matches;
    try {
      const found = await deskSearchTickets(client, String(ticket.deskTicketNumber), 20);
      matches = found.filter(
        (candidate) => String(candidate.ticketNumber) === String(ticket.deskTicketNumber),
      );
    } catch (error) {
      return unpaired('desk_lookup_failed', errorMessage(error));
    }
    if (matches.length === 0) return unpaired('no_desk_match');
    if (matches.length > 1) return unpaired('ambiguous_desk_match');
    try {
      zoho = await deskGetTicket(client, matches[0].id);
    } catch (error) {
      return unpaired('desk_lookup_failed', errorMessage(error));
    }
  }

  if (
    ticket.deskTicketNumber
    && String(zoho?.ticketNumber) !== String(ticket.deskTicketNumber)
  ) {
    return unpaired(
      'desk_number_mismatch',
      `Censo #${ticket.deskTicketNumber}; Zoho #${zoho?.ticketNumber ?? 'sin número'}.`,
      zoho,
    );
  }

  const base = reconciliationBase(ticket, zoho);
  if (zoho?.statusType === 'Open') {
    if (String(zoho.assigneeId ?? '') !== String(viewerAgentId)) {
      const assigneeId = String(zoho.assigneeId ?? '');
      const agents = await getAgents();
      const assignee = assigneeId ? agents.get(assigneeId) : null;
      let detail = 'Sin asignado en Zoho.';
      if (assigneeId && assignee?.name) {
        detail = `Asignado en Zoho a ${assignee.name} (${assigneeId}).`;
      } else if (assigneeId) {
        detail = `Asignado en Zoho a un agente desconocido (${assigneeId}).`;
      }
      return {
        bucket: 'reassigned',
        entry: {
          ...base,
          reason: 'assigned_to_other',
          detail,
          assigneeName: assignee?.name ?? null,
        },
      };
    }
    return {
      bucket: 'realOpen',
      entry: { ...base, reason: 'open_in_both', detail: null },
    };
  }
  if (zoho?.statusType !== 'Closed') {
    return unpaired('unknown_status_type', null, zoho);
  }

  // En Zoho, "Closed" también abarca descartes y anulaciones. Sólo un cierre
  // inequívocamente resuelto puede alimentar el motor automático.
  if (/cancel|duplicat|spam|reject|invalid|descartad|anulad|no aplica/i.test(zoho.status ?? '')) {
    return unpaired('closed_but_not_resolved', null, zoho);
  }
  if (!zoho.closedTime) return unpaired('closed_without_close_time', null, zoho);

  const agents = await getAgents();
  const assigneeId = zoho.assigneeId === null || zoho.assigneeId === undefined
    || String(zoho.assigneeId) === ''
    ? null
    : String(zoho.assigneeId);
  const assignee = assigneeId === null ? null : agents.get(assigneeId);
  const assigneeName = assignee?.name ?? null;
  let assigneeEvidence = 'Sin asignado en Zoho.';
  if (assigneeId && assigneeName) {
    assigneeEvidence = `Asignado en Zoho a ${assigneeName}.`;
  } else if (assigneeId) {
    assigneeEvidence = `Asignado en Zoho a un agente desconocido (${assigneeId}).`;
  }
  const modifier = zoho.modifiedBy === null || zoho.modifiedBy === undefined
    ? null
    : agents.get(String(zoho.modifiedBy));
  let closerLabel = 'sin autor de cierre identificable en Zoho';
  if (modifier?.name && zoho.modifiedTime === zoho.closedTime) {
    closerLabel = `cerrado por ${modifier.name}`;
  } else if (modifier?.name) {
    closerLabel = `última modificación por ${modifier.name} `
      + '(Zoho no registra autor explícito del cierre)';
  }
  const subject = zoho.subject ?? ticket.title ?? 'sin asunto';
  const resolution = zoho.resolution || 'sin nota de resolución registrada en Zoho';
  const evidenceSummary = truncated(
    `Cierre verificado en Zoho Desk #${zoho.ticketNumber} `
      + `("${truncated(subject, 120)}"): estado "${zoho.status}" al ${zoho.closedTime}, `
      + `${closerLabel}. Resolución: ${resolution}. Cruce automático `
      + `cwc-tolkien reconcile del ${generatedAt}. ${assigneeEvidence}`,
    1000,
  );
  const desiredOutcomeProposal = truncated(
    `Reflejar en Tolkien el cierre ya verificado en Zoho Desk #${zoho.ticketNumber}: `
      + `el trabajo "${truncated(subject, 100)}" queda cerrado con la evidencia `
      + 'del cierre externo.',
    1000,
  );
  return {
    bucket: 'closable',
    entry: {
      ...base,
      evidenceSummary,
      desiredOutcomeProposal,
      closerLabel,
      assigneeName,
      assigneeId,
    },
  };
}

async function reconcile(args, paths) {
  const options = parseReconcileArgs(args, paths);
  if (!fs.existsSync(options.censusFile)) {
    throw new CliError(
      `No hay censo en ${options.censusFile}. Corré primero: `
        + '`node bin/cwc-tolkien.js census`.',
    );
  }
  const source = readJsonFile(options.censusFile, 'el censo');
  const viewerEmail = String(source.viewerEmail ?? '').trim();
  if (!viewerEmail) {
    throw new CliError(
      'El censo no incluye viewerEmail, así que no se puede verificar el asignado en Zoho. '
        + 'Volvé a correr `node bin/cwc-tolkien.js census`.',
    );
  }
  const allTickets = Array.isArray(source.tickets) ? source.tickets : [];
  const tickets = options.limit === null ? allTickets : allTickets.slice(0, options.limit);
  if (options.fresh) resetPartial(paths.reconcilePartialFile, paths.dataDir);
  const partial = readPartial(paths.reconcilePartialFile);
  const generatedAt = new Date().toISOString();
  const client = createZohoClient();
  let agentsPromise = null;
  const getAgents = async () => {
    if (!agentsPromise) {
      agentsPromise = deskListAgents(client);
    }
    return agentsPromise;
  };
  let agents;
  try {
    agents = await getAgents();
  } catch (error) {
    throw new CliError(
      `No se pudo obtener el directorio de agentes de Zoho: ${errorMessage(error)}. `
        + 'Volvé a correr `node bin/cwc-tolkien.js census` antes de reconciliar.',
    );
  }
  if (!(agents instanceof Map) || agents.size === 0) {
    throw new CliError(
      'El directorio de agentes de Zoho está vacío; no se puede verificar el asignado. '
        + 'Volvé a correr `node bin/cwc-tolkien.js census` antes de reconciliar.',
    );
  }
  const normalizedViewerEmail = viewerEmail.toLowerCase();
  const viewerAgent = [...agents.entries()].find(([, agent]) => (
    String(agent?.email ?? '').trim().toLowerCase() === normalizedViewerEmail
  ));
  if (!viewerAgent) {
    throw new CliError(
      `Ningún agente de Zoho coincide con viewerEmail "${viewerEmail}" del censo. `
        + 'Volvé a correr `node bin/cwc-tolkien.js census` antes de reconciliar.',
    );
  }
  const viewerAgentId = String(viewerAgent[0]);
  const viewerAgentName = viewerAgent[1]?.name ?? viewerEmail;
  log(`Identidad Zoho resuelta: ${viewerAgentName} (${viewerAgentId}).`);

  for (let index = 0; index < tickets.length; index += 1) {
    const ticket = tickets[index];
    if (partial.has(ticket.ticketWorkflowId)) {
      log(`[${index + 1}/${tickets.length}] ${ticket.ticketWorkflowId}: ya estaba en el parcial.`);
      continue;
    }
    log(`[${index + 1}/${tickets.length}] Cruzando ${ticket.ticketWorkflowId}.`);
    const classification = await classifyReconciliationTicket(
      ticket,
      client,
      generatedAt,
      getAgents,
      viewerAgentId,
    );
    const record = { ticketWorkflowId: ticket.ticketWorkflowId, ...classification };
    appendPartial(record, paths.reconcilePartialFile, paths.dataDir);
    partial.set(ticket.ticketWorkflowId, record);
  }

  const selected = tickets
    .map((ticket) => partial.get(ticket.ticketWorkflowId))
    .filter(Boolean);
  const closable = selected.filter((item) => item.bucket === 'closable').map((item) => item.entry);
  const realOpen = selected.filter((item) => item.bucket === 'realOpen').map((item) => item.entry);
  const reassigned = selected.filter((item) => item.bucket === 'reassigned').map((item) => item.entry);
  const unpaired = selected.filter((item) => item.bucket === 'unpaired').map((item) => item.entry);
  const result = {
    generatedAt,
    censusGeneratedAt: source.generatedAt ?? null,
    viewerEmail: source.viewerEmail ?? null,
    counts: {
      total: selected.length,
      closable: closable.length,
      realOpen: realOpen.length,
      reassigned: reassigned.length,
      unpaired: unpaired.length,
      waitingInClosable: closable.filter((ticket) => ticket.isWaiting).length,
    },
    closable,
    realOpen,
    reassigned,
    unpaired,
  };
  writeJson(options.out, result, paths.dataDir);
  printJson(result);
  withStore(paths, (db) => {
    const runUid = store.startRun(db, {
      kind: 'reconcile',
      viewerEmail: result.viewerEmail,
      scope: { limit: options.limit, fresh: options.fresh, censusFile: options.censusFile },
    });
    const written = store.recordReconcile(db, runUid, result, generatedAt);
    store.finishRun(db, runUid, { counts: written });
    log(`Base local: ${JSON.stringify(written)} en la corrida ${runUid}.`);
  });
  log(
    `Cruce listo: ${result.counts.total} total · ${result.counts.closable} cerrables · `
      + `${result.counts.realOpen} abiertos reales · ${result.counts.reassigned} reasignados · `
      + `${result.counts.unpaired} sin par seguro · `
      + `${result.counts.waitingInClosable} cerrables en espera.`,
  );
  const reasons = new Map();
  for (const ticket of unpaired) reasons.set(ticket.reason, (reasons.get(ticket.reason) ?? 0) + 1);
  const orderedReasons = [...reasons.entries()].sort(
    ([reasonA, countA], [reasonB, countB]) => countB - countA || reasonA.localeCompare(reasonB),
  );
  for (const [reason, count] of orderedReasons) log(`  ${reason}: ${count}`);
  const reassignedByName = new Map();
  for (const ticket of reassigned) {
    const assigneeId = String(ticket.zoho?.assigneeId ?? '');
    const label = ticket.assigneeName
      ?? (assigneeId ? `Agente desconocido (${assigneeId})` : 'Sin asignado');
    reassignedByName.set(label, (reassignedByName.get(label) ?? 0) + 1);
  }
  const orderedReassigned = [...reassignedByName.entries()].sort(
    ([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB),
  );
  for (const [name, count] of orderedReassigned) log(`  ${name}: ${count}`);
  return result;
}

function selectCloseBatch(source, options) {
  const all = Array.isArray(source.closable) ? source.closable : [];
  for (const requested of options.only) {
    const matched = all.some(
      (ticket) => ticket.workKey === requested || ticket.ticketWorkflowId === requested,
    );
    if (!matched) throw new CliError(`El valor de --only no coincide con ningún ticket: ${requested}`);
  }
  const filtered = options.only.length === 0
    ? all
    : all.filter(
        (ticket) => options.only.includes(ticket.workKey)
          || options.only.includes(ticket.ticketWorkflowId),
      );
  const batch = options.limit === null ? filtered : filtered.slice(0, options.limit);
  if (batch.length > WRITE_BATCH_CAP && !options.confirmLarge) {
    throw new CliError(
      `El lote tiene ${batch.length} tickets y el tope por corrida es 50. `
        + 'Volvé a correr con --limit 50, o con --confirm-large si de verdad querés '
        + 'procesarlos todos de una.',
    );
  }
  return batch;
}

function selectReassignBatch(source, options) {
  // Esta selección deliberadamente sólo mira reassigned: ninguna otra pila
  // puede entrar al motor de reasignación ni siquiera mediante --only.
  const all = Array.isArray(source.reassigned) ? source.reassigned : [];
  for (const requested of options.only) {
    const matched = all.some(
      (ticket) => ticket.workKey === requested || ticket.ticketWorkflowId === requested,
    );
    if (!matched) throw new CliError(`El valor de --only no coincide con ningún ticket: ${requested}`);
  }
  const filtered = options.only.length === 0
    ? all
    : all.filter(
        (ticket) => options.only.includes(ticket.workKey)
          || options.only.includes(ticket.ticketWorkflowId),
      );
  const batch = options.limit === null ? filtered : filtered.slice(0, options.limit);
  if (batch.length > WRITE_BATCH_CAP && !options.confirmLarge) {
    throw new CliError(
      `El lote tiene ${batch.length} tickets y el tope por corrida es 50. `
        + 'Volvé a correr con --limit 50, o con --confirm-large si de verdad querés '
        + 'procesarlos todos de una.',
    );
  }
  return batch;
}

function normalizedEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizedAssigneeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function extractReassignAssigneeName(assignee) {
  const match = String(assignee ?? '').match(/Taken by\s+(.+?)\s+·/u);
  return match?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

function reassignAssigneeName(state) {
  return state?.assigneeName ?? extractReassignAssigneeName(state?.assignee);
}

export function verifyReassignState(observed, payload, { before = null } = {}) {
  const assigneeName = reassignAssigneeName(observed);
  const previousAssigneeName = reassignAssigneeName(before);
  const targetName = String(payload?.targetName ?? '').trim();
  const expectedUserId = String(payload?.assignedToUserId ?? '').trim();
  const observedUserId = String(observed?.assignedToUserId ?? '').trim();
  const nameMatches = Boolean(
    normalizedAssigneeName(assigneeName)
    && normalizedAssigneeName(assigneeName) === normalizedAssigneeName(targetName),
  );
  const uuidMatches = Boolean(expectedUserId && observedUserId === expectedUserId);
  const unchangedOwner = Boolean(
    normalizedAssigneeName(assigneeName)
    && normalizedAssigneeName(assigneeName) === normalizedAssigneeName(previousAssigneeName),
  );
  let detail = null;
  if (!nameMatches && !uuidMatches) {
    if (unchangedOwner) {
      detail = `El dueño no cambió: sigue siendo ${assigneeName}.`;
    } else if (assigneeName) {
      detail = `El dueño observado es ${assigneeName}; se esperaba ${targetName || 'un destinatario válido'}.`;
    } else {
      detail = 'No se pudo extraer el dueño mostrado ni verificar el UUID esperado.';
    }
  }
  return {
    ok: nameMatches || uuidMatches,
    nameMatches,
    uuidMatches,
    unchangedOwner,
    assigneeName,
    detail,
  };
}

export function reassignSubmissionDecision(observed, payload) {
  const assigneeName = reassignAssigneeName(observed);
  const alreadyReassigned = Boolean(
    normalizedAssigneeName(assigneeName)
    && normalizedAssigneeName(assigneeName) === normalizedAssigneeName(payload?.targetName),
  );
  return alreadyReassigned
    ? { shouldSubmit: false, reason: 'ya_reasignado', assigneeName }
    : { shouldSubmit: true, reason: null, assigneeName };
}

function verifiedReassignViewerEmail(identity, source) {
  const liveEmail = String(identity?.email ?? '').trim();
  if (!liveEmail) {
    throw new CliError('No se pudo leer el email del usuario de la sesión de Tolkien.');
  }
  const sourceEmail = String(source?.viewerEmail ?? '').trim();
  if (sourceEmail && normalizedEmail(sourceEmail) !== normalizedEmail(liveEmail)) {
    throw new CliError(
      `El cruce pertenece a ${sourceEmail}, pero la sesión viva es ${liveEmail}. `
        + 'Volvé a correr census y reconcile con esta sesión.',
    );
  }
  return liveEmail;
}

function reassignOption(option) {
  const value = String(option?.value ?? '').trim();
  const label = String(option?.label ?? '').replace(/\s+/g, ' ').trim();
  const match = label.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!value || option?.disabled || !match) return null;
  const name = match[1].trim();
  const email = match[2].trim();
  if (!email) return null;
  return { userId: value, name, email, normalizedEmail: normalizedEmail(email) };
}

/**
 * Resuelve un dueño de Zoho contra opciones vivas del formulario de Tolkien.
 * Sólo compara emails exactos normalizados; los nombres son salida, nunca llave.
 */
export function resolveReassignTarget({
  zohoAssigneeId,
  agents,
  selectOptions,
  viewerAgentId = null,
  viewerEmail = null,
}) {
  const assigneeId = String(zohoAssigneeId ?? '').trim();
  if (!assigneeId) return { ok: false, reason: 'sin_asignado_en_zoho' };
  const agent = agents instanceof Map ? agents.get(assigneeId) : null;
  if (!agent) return { ok: false, reason: 'agente_zoho_desconocido' };
  const agentEmail = String(agent.email ?? '').trim();
  if (!agentEmail) return { ok: false, reason: 'agente_sin_email' };
  const wantedEmail = normalizedEmail(agentEmail);
  const matches = (Array.isArray(selectOptions) ? selectOptions : [])
    .map(reassignOption)
    .filter((option) => option?.normalizedEmail === wantedEmail);
  if (matches.length === 0) return { ok: false, reason: 'sin_usuario_en_tolkien' };
  if (matches.length > 1) return { ok: false, reason: 'usuario_ambiguo_en_tolkien' };
  const target = matches[0];
  const targetResult = {
    userId: target.userId,
    name: target.name || agent.name || target.email,
    email: target.email,
  };
  if (
    (viewerAgentId !== null && String(viewerAgentId) === target.userId)
    || (normalizedEmail(viewerEmail) && normalizedEmail(viewerEmail) === target.normalizedEmail)
  ) {
    return { ok: false, reason: 'ya_es_del_usuario', ...targetResult };
  }
  return { ok: true, ...targetResult };
}

export function shouldAbortForUnknownAgents(results) {
  return Array.isArray(results)
    && results.length > 0
    && results.every((item) => {
      const target = item?.target ?? item;
      return target?.ok === false && target.reason === 'agente_zoho_desconocido';
    });
}

function shellArgument(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function printCloseDryRun(source, batch, options, originalArgs) {
  const waiting = batch.filter((ticket) => ticket.isWaiting).length;
  let report = '';
  report += `DRY-RUN close · cruce ${source.generatedAt ?? 'sin fecha'}\n`;
  report += `Lote: ${batch.length} tickets · en espera y se saltean: ${waiting}\n\n`;
  for (const ticket of batch) {
    const label = ticket.workKey ?? ticket.ticketWorkflowId;
    report += `${label} · ${truncated(ticket.title ?? 'sin título', 80)}\n`;
    report += `  Tolkien   : ${ticket.url}   | desiredOutcome: `
      + `${ticket.hasDesiredOutcome ? 'presente' : 'AUSENTE (se registrará)'} | espera: `
      + `${ticket.isWaiting ? 'SÍ (SE SALTEA)' : 'no'}\n`;
    report += `  Zoho #${ticket.zoho?.ticketNumber ?? ticket.deskTicketNumber ?? '?'} : `
      + `${ticket.zoho?.status ?? '?'} / ${ticket.zoho?.statusType ?? '?'} · `
      + `cerrado ${ticket.zoho?.closedTime ?? '?'} · ${ticket.closerLabel ?? '?'}\n`;
    if (ticket.isWaiting) {
      report += '  Decisión  : SE SALTEA; Tolkien marca una espera estructurada y no se fuerza.\n';
    } else {
      if (ticket.hasDesiredOutcome) {
        report += '  Acciones  : [1] setWorkContext SE SALTEA '
          + '(ya tiene resultado esperado; no se reescriben sus 9 campos)  '
          + '[2] closeTicket(objective_check)\n';
      } else {
        report += `  Acciones  : [1] setWorkContext(mode=working, nextActorKind=${options.nextActorKind})  `
          + '[2] closeTicket(objective_check)\n';
      }
      report += '  Nota      : el paso [1] se decide releyendo el ticket justo antes de escribir; '
        + 'este reporte usa el estado del censo.\n';
    }
    if (!ticket.hasDesiredOutcome) report += `  Outcome   : ${ticket.desiredOutcomeProposal}\n`;
    report += `  Evidencia : ${ticket.evidenceSummary}\n`;
    report += '\n';
  }
  const applyArgs = originalArgs.filter((arg) => arg !== '--apply');
  const applyCommand = ['node', 'bin/cwc-tolkien.js', 'close', ...applyArgs, '--apply']
    .map(shellArgument)
    .join(' ');
  report += 'No se escribió nada en Tolkien. Para aplicar exactamente este lote:\n';
  report += `${applyCommand}\n`;
  process.stdout.write(report);
}

function utcLogTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function createOpsLog(paths, kind = 'close') {
  ensureDataDir(paths.dataDir);
  fs.mkdirSync(paths.opsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.opsDir, 0o700);
  const file = path.join(paths.opsDir, `${kind}-${utcLogTimestamp()}-${process.pid}.jsonl`);
  fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return file;
}

function stateSnapshot(state) {
  return {
    desiredOutcome: state?.desiredOutcome ?? null,
    isWaiting: Boolean(state?.isWaiting),
    executionState: state?.executionState ?? null,
  };
}

async function inspectTicketState(page, detailUrl) {
  // gotoReadOnly incluye la guarda del workboard: esta relectura de cierre no
  // debe duplicar la espera ni poder salteársela (console:BUG-2557).
  await gotoReadOnly(page, detailUrl);
  const overview = await readOverview(page);
  await gotoReadOnly(page, `${detailUrl}?tab=estado`);
  const manage = await readManage(page);
  const forms = await page.evaluate(() => {
    const formWith = (selector) => [...document.querySelectorAll('form')]
      .some((form) => Boolean(form.querySelector(selector)));
    const closedHeading = [...document.querySelectorAll('main h1, main h2, main h3')]
      .some((heading) => /^(completed|cancelled|completado|cancelado|cerrado)$/i
        .test((heading.textContent ?? '').replace(/\s+/g, ' ').trim()));
    return {
      hasWorkContextForm: formWith('select[name="mode"]'),
      hasCloseForm: formWith('select[name="verificationKind"]'),
      showsClosedBlock: closedHeading && !formWith('select[name="verificationKind"]'),
    };
  });
  return {
    desiredOutcome: nullableVisible(manage.desiredOutcome ?? overview.desiredOutcome),
    isWaiting: Boolean(manage.isWaiting),
    executionState: overview.executionState,
    ...forms,
  };
}

async function settleAfterSubmit(page, isSettled) {
  const deadline = Date.now() + 12_000;
  let errorCode = null;
  while (Date.now() < deadline) {
    errorCode = new URL(page.url()).searchParams.get('error');
    if (errorCode) break;
    try {
      if (await isSettled(page)) break;
    } catch {
      // El DOM puede estar transitoriamente indisponible mientras React re-renderiza.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await page.waitForTimeout(Math.min(250, remaining));
  }
  await assertAuthenticated(page);
  return errorCode;
}

async function submitDesiredOutcome(page, proposal, nextActorKind) {
  const form = page.locator('select[name="mode"]').locator('xpath=ancestor::form[1]');
  if (await form.count() === 0) throw new Error('No se encontró el formulario de contexto de trabajo.');
  await form.locator('textarea[name="desiredOutcome"]').fill(proposal);
  await form.locator('select[name="mode"]').selectOption('working');
  await form.locator('select[name="nextActorKind"]').selectOption(nextActorKind);
  await form.locator('button[type="submit"]').click();
  return settleAfterSubmit(
    page,
    async (currentPage) => (await currentPage.locator('textarea[name="desiredOutcome"]').count()) === 0,
  );
}

async function submitClose(page, evidenceSummary) {
  const form = page.locator('select[name="verificationKind"]').locator('xpath=ancestor::form[1]');
  if (await form.count() === 0) throw new Error('No se encontró el formulario de cierre.');
  await form.locator('select[name="verificationKind"]').selectOption('objective_check');
  await form.locator('textarea[name="evidenceSummary"]').fill(evidenceSummary);
  await form.locator('button[type="submit"]').click();
  return settleAfterSubmit(
    page,
    async (currentPage) => (await currentPage.locator('select[name="verificationKind"]').count()) === 0,
  );
}

function isReassignNavigationTimeout(error) {
  return error?.name === 'TimeoutError'
    || /page\.goto: Timeout \d+ms exceeded/i.test(errorMessage(error));
}

async function gotoReassignReadOnly(page, url) {
  // Se conserva gotoReadOnly como dueño de las guardas comunes; este proxy sólo
  // amplía a 60 s el goto de reassign y agrega un reintento ante timeout.
  const pageWithReassignRetry = new Proxy(page, {
    get(target, property) {
      if (property === 'goto') {
        return async (targetUrl, options = {}) => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              return await target.goto(targetUrl, {
                ...options,
                timeout: REASSIGN_NAVIGATION_TIMEOUT_MS,
              });
            } catch (error) {
              if (attempt > 0 || !isReassignNavigationTimeout(error)) throw error;
              await target.waitForTimeout(REASSIGN_NAVIGATION_RETRY_DELAY_MS);
            }
          }
          return null;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return gotoReadOnly(pageWithReassignRetry, url);
}

async function readReassignState(page, detailUrl) {
  await gotoReassignReadOnly(page, `${detailUrl}?tab=estado`);
  const form = page.locator('select[name="assignedToUserId"]').locator('xpath=ancestor::form[1]');
  const found = await form.count();
  const dom = found === 0
    ? {
        ticketWorkflowId: null,
        assignedToUserId: null,
        assignee: null,
        assigneeName: null,
        selectOptions: [],
      }
    : await form.evaluate((element) => {
        const select = element.querySelector('select[name="assignedToUserId"]');
        const hidden = element.querySelector('input[type="hidden"][name="ticketWorkflowId"]');
        const ownership = document.querySelector('#ownership');
        const clean = (value) => value?.replace(/\s+/g, ' ').trim() || null;
        return {
          ticketWorkflowId: hidden?.value ?? null,
          assignedToUserId: select?.value || null,
          assignee: clean(ownership?.textContent),
          selectOptions: [...(select?.options ?? [])].map((option) => ({
            value: option.value,
            label: clean(option.textContent) ?? '',
            disabled: option.disabled,
            selected: option.selected,
          })),
        };
      });
  const serialized = fieldFromSerializedHtml(await page.content(), 'assignedToUserId');
  return {
    ...dom,
    assignedToUserId: dom.assignedToUserId || serialized || null,
    assigneeName: extractReassignAssigneeName(dom.assignee),
    hasReassignForm: found > 0,
  };
}

async function submitReassign(page, userId) {
  // El form se localiza siempre en el DOM vivo por su campo distintivo; ni el
  // actionId ni los UUID de opciones se toman de schema.json.
  const form = page.locator('select[name="assignedToUserId"]').locator('xpath=ancestor::form[1]');
  if (await form.count() === 0) {
    throw new Error('No se encontró el formulario de reasignación.');
  }
  await form.locator('select[name="assignedToUserId"]').selectOption(userId);
  await form.locator('button[type="submit"]').click();
  return settleAfterSubmit(
    page,
    async (currentPage) => (
      await currentPage.locator('select[name="assignedToUserId"]').count()
    ) === 0,
  );
}

function appendOpsStep(
  logFile,
  ticket,
  phase,
  result,
  errorCode,
  before,
  after,
  payload,
  dataDir,
  mirror = null,
) {
  const entry = {
    kind: 'step',
    at: new Date().toISOString(),
    ticketWorkflowId: ticket.ticketWorkflowId,
    workKey: ticket.workKey,
    url: ticket.url,
    phase,
    result,
    errorCode: errorCode ?? null,
    before: stateSnapshot(before),
    after: stateSnapshot(after),
    payload: payload ?? null,
  };
  appendPartial(entry, logFile, dataDir);
  if (mirror?.db && mirror.runUid) {
    try {
      store.recordOp(mirror.db, {
        runUid: mirror.runUid,
        ticketWorkflowId: entry.ticketWorkflowId,
        workKey: entry.workKey,
        phase: entry.phase,
        outcome: entry.result,
        reason: entry.errorCode,
        before: entry.before,
        after: entry.after,
        payload: entry.payload,
        actor: mirror.actor,
      });
    } catch (error) {
      log(`Aviso: la base local no pudo registrar una operación: ${errorMessage(error)}`);
    }
  }
}

function reassignStateSnapshot(state) {
  return {
    ticketWorkflowId: state?.ticketWorkflowId ?? null,
    assignedToUserId: state?.assignedToUserId ?? null,
    assignee: state?.assignee ?? null,
    assigneeName: state?.assigneeName ?? null,
    hasReassignForm: Boolean(state?.hasReassignForm),
  };
}

function appendReassignOpsStep(
  logFile,
  ticket,
  result,
  errorCode,
  before,
  after,
  payload,
  dataDir,
  mirror = null,
) {
  const entry = {
    kind: 'step',
    at: new Date().toISOString(),
    ticketWorkflowId: ticket.ticketWorkflowId,
    workKey: ticket.workKey,
    url: ticket.url,
    phase: 'reassign',
    result,
    errorCode: errorCode ?? null,
    before: reassignStateSnapshot(before),
    after: reassignStateSnapshot(after),
    payload: payload ?? null,
  };
  appendPartial(entry, logFile, dataDir);
  if (mirror?.db && mirror.runUid) {
    try {
      store.recordOp(mirror.db, {
        runUid: mirror.runUid,
        ticketWorkflowId: entry.ticketWorkflowId,
        workKey: entry.workKey,
        phase: entry.phase,
        outcome: entry.result,
        reason: entry.errorCode,
        before: entry.before,
        after: entry.after,
        payload: entry.payload,
        actor: mirror.actor,
      });
    } catch (error) {
      log(`Aviso: la base local no pudo registrar una operación: ${errorMessage(error)}`);
    }
  }
}

async function applyClose(source, batch, options, paths) {
  const { browser, context } = await launchContext(paths.sessionFile);
  const page = await context.newPage();
  let logFile = null;
  let opsDb = null;
  let opsRunUid = null;
  const opsMirror = { db: null, runUid: null, actor: null };
  const counts = { closed: 0, skipped: 0, failed: 0, aborted: 0 };
  let fatalError = null;
  try {
    await gotoReadOnly(page, `${BASE_URL}/tickets`);
    const identity = await readIdentity(page);
    logFile = createOpsLog(paths);
    appendPartial({
      kind: 'run-start',
      at: new Date().toISOString(),
      apply: true,
      batchSize: batch.length,
      nextActorKind: options.nextActorKind,
      reconcileFile: options.reconcileFile,
      viewer: identity.email ?? source.viewerEmail ?? null,
    }, logFile, paths.dataDir);
    try {
      opsDb = store.openStore(paths.dbFile);
      opsRunUid = store.startRun(opsDb, {
        kind: 'close',
        viewerEmail: identity.email ?? source.viewerEmail ?? null,
        scope: { batchSize: batch.length, nextActorKind: options.nextActorKind },
      });
      opsMirror.db = opsDb;
      opsMirror.runUid = opsRunUid;
      opsMirror.actor = identity.email ?? source.viewerEmail ?? null;
    } catch (error) {
      log(`Aviso: la base local no pudo registrar esta corrida: ${errorMessage(error)}`);
      try { opsDb?.close(); } catch { /* la base ya estaba cerrada */ }
      opsDb = null;
      opsRunUid = null;
    }
    const client = createZohoClient();

    for (let index = 0; index < batch.length; index += 1) {
      const ticket = batch[index];
      let current = null;
      let exceptionPhase = 'close';
      let exceptionBefore = null;
      let exceptionPayload = null;
      try {
        log(`[${index + 1}/${batch.length}] Verificando ${ticket.workKey ?? ticket.ticketWorkflowId}.`);
        await gotoReadOnly(page, `${ticket.url}?tab=estado`);
        current = await inspectTicketState(page, ticket.url);
        if (
          TERMINAL_EXECUTION_STATES.has(current.executionState)
          || current.showsClosedBlock
        ) {
          appendOpsStep(
            logFile, ticket, 'close', 'skipped', 'already_closed', current, current, null,
            paths.dataDir, opsMirror,
          );
          counts.skipped += 1;
          continue;
        }

        // El cruce habilita el lote, pero nunca una escritura futura: justo antes
        // de tocar Tolkien se vuelve a comprobar que Zoho siga cerrado y sea el mismo ticket.
        // Sin id de Zoho no se puede re-verificar, y sin re-verificación no se escribe.
        if (!ticket.zoho?.id) {
          appendOpsStep(
            logFile, ticket, 'close', 'aborted', 'missing_zoho_id', current, current, null,
            paths.dataDir, opsMirror,
          );
          counts.aborted += 1;
          continue;
        }
        const freshZoho = await deskGetTicket(client, ticket.zoho?.id);
        if (
          freshZoho?.statusType !== 'Closed'
          || String(freshZoho?.ticketNumber) !== String(ticket.zoho?.ticketNumber)
        ) {
          appendOpsStep(
            logFile,
            ticket,
            'close',
            'aborted',
            'zoho_state_changed',
            current,
            current,
            {
              expected: zohoSnapshot(ticket.zoho),
              observed: zohoSnapshot(freshZoho),
            },
            paths.dataDir,
            opsMirror,
          );
          counts.aborted += 1;
          continue;
        }
        if (current.isWaiting || ticket.isWaiting) {
          appendOpsStep(
            logFile, ticket, 'close', 'skipped', 'waiting', current, current, null,
            paths.dataDir, opsMirror,
          );
          counts.skipped += 1;
          continue;
        }

        if (!current.desiredOutcome) {
          const beforeOutcome = current;
          const outcomePayload = {
            desiredOutcome: ticket.desiredOutcomeProposal,
            mode: 'working',
            nextActorKind: options.nextActorKind,
          };
          exceptionPhase = 'set_outcome';
          exceptionBefore = beforeOutcome;
          exceptionPayload = outcomePayload;
          const outcomeError = await submitDesiredOutcome(
            page,
            ticket.desiredOutcomeProposal,
            options.nextActorKind,
          );
          let afterOutcome;
          try {
            afterOutcome = await inspectTicketState(page, ticket.url);
          } catch (readError) {
            if (readError instanceof InvalidSessionError) throw readError;
            if (!outcomeError) throw readError;
            afterOutcome = beforeOutcome;
          }
          if (outcomeError) {
            appendOpsStep(
              logFile, ticket, 'set_outcome', 'failed', outcomeError,
              beforeOutcome, afterOutcome, outcomePayload, paths.dataDir, opsMirror,
            );
            counts.failed += 1;
            continue;
          }
          // La ausencia de ?error= no prueba que una server action haya persistido.
          // Sólo avanzamos si la relectura devuelve el outcome guardado.
          if (!sameText(afterOutcome.desiredOutcome, ticket.desiredOutcomeProposal)) {
            appendOpsStep(
              logFile, ticket, 'set_outcome', 'failed', 'set_outcome_unverified',
              beforeOutcome, afterOutcome, outcomePayload, paths.dataDir, opsMirror,
            );
            counts.failed += 1;
            continue;
          }
          appendOpsStep(
            logFile, ticket, 'set_outcome', 'ok', null,
            beforeOutcome, afterOutcome, outcomePayload, paths.dataDir, opsMirror,
          );
          current = afterOutcome;
        }

        await gotoReadOnly(page, `${ticket.url}?tab=estado`);
        const beforeClose = current;
        const closePayload = {
          verificationKind: 'objective_check',
          evidenceSummary: ticket.evidenceSummary,
        };
        exceptionPhase = 'close';
        exceptionBefore = beforeClose;
        exceptionPayload = closePayload;
        const closeError = await submitClose(page, ticket.evidenceSummary);
        let afterClose;
        try {
          afterClose = await inspectTicketState(page, ticket.url);
        } catch (readError) {
          if (readError instanceof InvalidSessionError) throw readError;
          if (!closeError) throw readError;
          afterClose = beforeClose;
        }
        if (closeError) {
          appendOpsStep(
            logFile, ticket, 'close', 'failed', closeError,
            beforeClose, afterClose, closePayload, paths.dataDir, opsMirror,
          );
          counts.failed += 1;
          continue;
        }
        // También en el cierre manda el estado releído, no la mera falta de un error.
        if (!CLOSED_OK_EXECUTION_STATES.has(afterClose.executionState)) {
          appendOpsStep(
            logFile, ticket, 'close', 'failed', 'close_unverified',
            beforeClose, afterClose, closePayload, paths.dataDir, opsMirror,
          );
          counts.failed += 1;
          continue;
        }
        appendOpsStep(
          logFile, ticket, 'close', 'ok', null,
          beforeClose, afterClose, closePayload, paths.dataDir, opsMirror,
        );
        counts.closed += 1;
      } catch (error) {
        if (error instanceof InvalidSessionError) throw error;
        let afterException = current;
        if (current && ticket.url) {
          try {
            afterException = await inspectTicketState(page, ticket.url);
          } catch (readError) {
            if (readError instanceof InvalidSessionError) throw readError;
          }
        }
        appendOpsStep(
          logFile,
          ticket,
          exceptionPhase,
          'failed',
          'exception',
          exceptionBefore ?? current,
          afterException,
          { ...exceptionPayload, exceptionMessage: errorMessage(error) },
          paths.dataDir,
          opsMirror,
        );
        counts.failed += 1;
      }
    }
  } catch (error) {
    fatalError = error;
  } finally {
    if (logFile) {
      appendPartial({
        kind: 'run-end',
        at: new Date().toISOString(),
        counts,
      }, logFile, paths.dataDir);
    }
    try {
      if (opsDb && opsRunUid) store.finishRun(opsDb, opsRunUid, { counts });
    } catch {
      // El JSONL ya contiene el cierre de la corrida.
    }
    try { opsDb?.close(); } catch { /* la base ya estaba cerrada */ }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  if (fatalError) throw fatalError;
  log(
    `Cierre terminado: ${counts.closed} cerrados · ${counts.skipped} salteados · `
      + `${counts.failed} fallidos · ${counts.aborted} abortados. Log: ${logFile}`,
  );
  return counts;
}

async function close(args, paths) {
  const options = parseCloseArgs(args, paths);
  if (options.apply) requireSessionFile(paths.sessionFile);
  if (!fs.existsSync(options.reconcileFile)) {
    throw new CliError(
      `No hay cruce en ${options.reconcileFile}. Corré primero: `
        + '`node bin/cwc-tolkien.js reconcile`.',
    );
  }
  const source = readJsonFile(options.reconcileFile, 'el cruce');
  const reassignedCount = Array.isArray(source.reassigned) ? source.reassigned.length : 0;
  if (reassignedCount > 0) {
    log(
      `Nota: ${reassignedCount} tickets están reasignados en Zoho y quedan fuera de este cierre.`,
    );
  }
  const batch = selectCloseBatch(source, options);
  if (!options.apply) {
    printCloseDryRun(source, batch, options, args);
    return;
  }
  await applyClose(source, batch, options, paths);
}

function reassignSkipCounts(results) {
  const counts = new Map();
  for (const item of results) {
    if (item.target.ok) continue;
    counts.set(item.target.reason, (counts.get(item.target.reason) ?? 0) + 1);
  }
  return counts;
}

function printReassignDryRun(source, batch, results, originalArgs) {
  let report = `DRY-RUN reassign · cruce ${source.generatedAt ?? 'sin fecha'}\n`;
  report += `Lote: ${batch.length} tickets de la pila reassigned\n\n`;
  for (const item of results) {
    const { ticket, target } = item;
    report += `${ticket.workKey ?? ticket.ticketWorkflowId} · `
      + `${truncated(ticket.title ?? 'sin título', 80)} · `
      + `Zoho #${ticket.zoho?.ticketNumber ?? ticket.deskTicketNumber ?? '?'}\n`;
    if (target.ok) {
      report += `  → ${target.name} (${target.email})\n`;
    } else if (target.name && target.email) {
      report += `  → ${target.name} (${target.email}) · SE SALTEA: ${target.reason}\n`;
    } else {
      report += `  → SE SALTEA: ${target.reason}\n`;
    }
  }

  const grouped = new Map();
  for (const { target } of results) {
    if (!target.ok) continue;
    grouped.set(target.name, (grouped.get(target.name) ?? 0) + 1);
  }
  report += '\nRESUMEN POR DESTINATARIO\n';
  if (grouped.size === 0) report += '  Ningún ticket reasignable.\n';
  for (const [name, count] of [...grouped.entries()].sort(
    ([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB),
  )) {
    report += `  ${name}: ${count} tickets\n`;
  }
  report += 'SALTEADOS POR MOTIVO\n';
  const skipped = reassignSkipCounts(results);
  for (const reason of REASSIGN_SKIP_REASONS) {
    report += `  ${reason}: ${skipped.get(reason) ?? 0}\n`;
    if (reason === 'agente_zoho_desconocido' && (skipped.get(reason) ?? 0) > 0) {
      report += '  ADVERTENCIA: este motivo suele indicar un directorio de agentes '
        + 'incompleto, no un ticket mal configurado.\n';
    }
  }
  const applyArgs = originalArgs.filter((arg) => arg !== '--apply');
  const applyCommand = ['node', 'bin/cwc-tolkien.js', 'reassign', ...applyArgs, '--apply']
    .map(shellArgument)
    .join(' ');
  report += '\nNo se escribió nada en Tolkien. Para aplicar exactamente este lote:\n';
  report += `${applyCommand}\n`;
  process.stdout.write(report);
}

async function inspectReassignDryRun(source, batch, paths, client) {
  const { browser, context } = await launchContext(paths.sessionFile);
  const page = await context.newPage();
  try {
    await gotoReadOnly(page, `${BASE_URL}/tickets`);
    const identity = await readIdentity(page);
    const viewerEmail = verifiedReassignViewerEmail(identity, source);
    const agents = await deskListAgents(client);
    const results = [];
    for (let index = 0; index < batch.length; index += 1) {
      const ticket = batch[index];
      log(`[${index + 1}/${batch.length}] Resolviendo ${ticket.workKey ?? ticket.ticketWorkflowId}.`);
      const current = await readReassignState(page, ticket.url);
      const target = resolveReassignTarget({
        zohoAssigneeId: ticket.zoho?.assigneeId,
        agents,
        selectOptions: current.selectOptions,
        viewerEmail,
      });
      results.push({ ticket, target });
    }
    return results;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function applyReassign(source, batch, options, paths, client) {
  const { browser, context } = await launchContext(paths.sessionFile);
  const page = await context.newPage();
  let logFile = null;
  let opsDb = null;
  let opsRunUid = null;
  const opsMirror = { db: null, runUid: null, actor: null };
  const counts = {
    reassigned: 0,
    skipped: 0,
    alreadyReassigned: 0,
    failed: 0,
    aborted: 0,
  };
  const skippedReasons = new Map();
  let fatalError = null;
  try {
    await gotoReadOnly(page, `${BASE_URL}/tickets`);
    const identity = await readIdentity(page);
    const viewerEmail = verifiedReassignViewerEmail(identity, source);
    logFile = createOpsLog(paths, 'reassign');
    appendPartial({
      kind: 'run-start',
      at: new Date().toISOString(),
      apply: true,
      batchSize: batch.length,
      reconcileFile: options.reconcileFile,
      viewer: viewerEmail,
    }, logFile, paths.dataDir);
    try {
      opsDb = store.openStore(paths.dbFile);
      opsRunUid = store.startRun(opsDb, {
        kind: 'reassign',
        viewerEmail,
        scope: { batchSize: batch.length, reconcileFile: options.reconcileFile },
      });
      opsMirror.db = opsDb;
      opsMirror.runUid = opsRunUid;
      opsMirror.actor = viewerEmail;
    } catch (error) {
      log(`Aviso: la base local no pudo registrar esta corrida: ${errorMessage(error)}`);
      try { opsDb?.close(); } catch { /* la base ya estaba cerrada */ }
      opsDb = null;
      opsRunUid = null;
    }
    const agents = await deskListAgents(client);

    for (let index = 0; index < batch.length; index += 1) {
      const ticket = batch[index];
      let before = null;
      let payload = null;
      try {
        log(`[${index + 1}/${batch.length}] Verificando ${ticket.workKey ?? ticket.ticketWorkflowId}.`);
        before = await readReassignState(page, ticket.url);
        if (
          before.ticketWorkflowId
          && String(before.ticketWorkflowId) !== String(ticket.ticketWorkflowId)
        ) {
          appendReassignOpsStep(
            logFile, ticket, 'aborted', 'ticket_workflow_mismatch', before, before, null,
            paths.dataDir, opsMirror,
          );
          counts.aborted += 1;
          continue;
        }
        if (!ticket.zoho?.id) {
          appendReassignOpsStep(
            logFile, ticket, 'aborted', 'missing_zoho_id', before, before, null,
            paths.dataDir, opsMirror,
          );
          counts.aborted += 1;
          continue;
        }
        // Igual que close, el cruce habilita el lote pero no una escritura
        // futura: el dueño real se vuelve a consultar justo antes del submit.
        const freshZoho = await deskGetTicket(client, ticket.zoho.id);
        if (
          freshZoho?.statusType !== 'Open'
          || String(freshZoho?.ticketNumber) !== String(ticket.zoho?.ticketNumber)
          || String(freshZoho?.assigneeId ?? '') !== String(ticket.zoho?.assigneeId ?? '')
        ) {
          appendReassignOpsStep(
            logFile,
            ticket,
            'aborted',
            'zoho_state_changed',
            before,
            before,
            {
              expected: zohoSnapshot(ticket.zoho),
              observed: zohoSnapshot(freshZoho),
            },
            paths.dataDir,
            opsMirror,
          );
          counts.aborted += 1;
          continue;
        }
        const target = resolveReassignTarget({
          zohoAssigneeId: freshZoho.assigneeId,
          agents,
          selectOptions: before.selectOptions,
          viewerEmail,
        });
        if (!target.ok) {
          appendReassignOpsStep(
            logFile,
            ticket,
            'skipped',
            target.reason,
            before,
            before,
            target.name && target.email ? { target } : null,
            paths.dataDir,
            opsMirror,
          );
          counts.skipped += 1;
          skippedReasons.set(target.reason, (skippedReasons.get(target.reason) ?? 0) + 1);
          continue;
        }
        payload = {
          ticketWorkflowId: before.ticketWorkflowId ?? ticket.ticketWorkflowId,
          assignedToUserId: target.userId,
          zohoAssigneeId: String(freshZoho.assigneeId),
          targetName: target.name,
          targetEmail: target.email,
        };
        const submission = reassignSubmissionDecision(before, payload);
        if (!submission.shouldSubmit) {
          appendReassignOpsStep(
            logFile, ticket, 'skipped', submission.reason, before, before, payload,
            paths.dataDir, opsMirror,
          );
          counts.skipped += 1;
          counts.alreadyReassigned += 1;
          skippedReasons.set(
            submission.reason,
            (skippedReasons.get(submission.reason) ?? 0) + 1,
          );
          continue;
        }
        const submitError = await submitReassign(page, target.userId);
        let after;
        try {
          after = await readReassignState(page, ticket.url);
        } catch (readError) {
          if (readError instanceof InvalidSessionError) throw readError;
          if (!submitError) throw readError;
          after = before;
        }
        if (submitError) {
          appendReassignOpsStep(
            logFile, ticket, 'failed', submitError, before, after, payload,
            paths.dataDir, opsMirror,
          );
          counts.failed += 1;
          continue;
        }
        // El select vuelve al placeholder después del submit y verificar su value
        // produjo falsos negativos en la corrida real del 2026-08-02. Por eso manda
        // el dueño mostrado; el UUID sólo queda como una segunda señal válida.
        const verification = verifyReassignState(after, payload, { before });
        if (!verification.ok) {
          appendReassignOpsStep(
            logFile,
            ticket,
            'failed',
            'reassign_unverified',
            before,
            after,
            { ...payload, verification },
            paths.dataDir, opsMirror,
          );
          counts.failed += 1;
          continue;
        }
        appendReassignOpsStep(
          logFile, ticket, 'ok', null, before, after, payload, paths.dataDir, opsMirror,
        );
        counts.reassigned += 1;
      } catch (error) {
        if (error instanceof InvalidSessionError) throw error;
        let afterException = before;
        if (before && ticket.url) {
          try {
            afterException = await readReassignState(page, ticket.url);
          } catch (readError) {
            if (readError instanceof InvalidSessionError) throw readError;
          }
        }
        appendReassignOpsStep(
          logFile,
          ticket,
          'failed',
          'exception',
          before,
          afterException,
          { ...payload, exceptionMessage: errorMessage(error) },
          paths.dataDir,
          opsMirror,
        );
        counts.failed += 1;
      }
    }
  } catch (error) {
    fatalError = error;
  } finally {
    if (logFile) {
      appendPartial({
        kind: 'run-end',
        at: new Date().toISOString(),
        counts,
        skippedReasons: Object.fromEntries(skippedReasons),
      }, logFile, paths.dataDir);
    }
    try {
      if (opsDb && opsRunUid) store.finishRun(opsDb, opsRunUid, { counts });
    } catch {
      // El JSONL ya contiene el cierre de la corrida.
    }
    try { opsDb?.close(); } catch { /* la base ya estaba cerrada */ }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  if (fatalError) throw fatalError;
  log(
    `Reasignación terminada: ${counts.reassigned} reasignados · `
      + `${counts.skipped} salteados (${counts.alreadyReassigned} ya estaban reasignados) · `
      + `${counts.failed} fallidos · `
      + `${counts.aborted} abortados. Log: ${logFile}`,
  );
  for (const [reason, count] of [...skippedReasons.entries()].sort()) {
    log(`  ${reason}: ${count}`);
  }
  if ((skippedReasons.get('agente_zoho_desconocido') ?? 0) > 0) {
    log(
      'ADVERTENCIA: agente_zoho_desconocido suele indicar un directorio de agentes '
        + 'incompleto, no un ticket mal configurado.',
    );
  }
  return counts;
}

async function reassign(args, paths) {
  const options = parseReassignArgs(args, paths);
  requireSessionFile(paths.sessionFile);
  if (!fs.existsSync(options.reconcileFile)) {
    throw new CliError(
      `No hay cruce en ${options.reconcileFile}. Corré primero: `
        + '`node bin/cwc-tolkien.js reconcile`.',
    );
  }
  const source = readJsonFile(options.reconcileFile, 'el cruce');
  const batch = selectReassignBatch(source, options);
  const client = createZohoClient();
  const results = await inspectReassignDryRun(source, batch, paths, client);
  if (shouldAbortForUnknownAgents(results)) {
    throw new CliError(
      'Todos los candidatos quedaron como agente_zoho_desconocido. Esto indica un '
        + 'fallo de carga del directorio de agentes, no una condición real de los '
        + 'tickets. Revisá desk_list_agents antes de continuar.',
    );
  }
  if (!options.apply) {
    printReassignDryRun(source, batch, results, args);
    return;
  }
  await applyReassign(source, batch, options, paths, client);
}

async function dbCommand(args, paths) {
  let action = null;
  let force = false;
  let runsLimit = 20;
  let bucket = null;
  const chooseAction = (next) => {
    if (action && action !== next) {
      throw new CliError('Elegí una sola acción de db por invocación.');
    }
    action = next;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--stats') {
      chooseAction('stats');
    } else if (arg === '--migrate') {
      chooseAction('migrate');
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--runs') {
      chooseAction('runs');
      const candidate = args[index + 1];
      if (candidate && !candidate.startsWith('--')) {
        runsLimit = positiveInteger(candidate, '--runs');
        index += 1;
      }
    } else if (arg === '--bucket') {
      chooseAction('bucket');
      bucket = valueAfter(args, index, arg);
      index += 1;
      if (!['closable', 'realOpen', 'reassigned', 'unpaired'].includes(bucket)) {
        throw new CliError('--bucket debe ser closable, realOpen, reassigned o unpaired.');
      }
    } else {
      throw new CliError(`Opción desconocida para db: ${arg}`);
    }
  }
  action ??= 'stats';
  if (force && action !== 'migrate') {
    throw new CliError('--force sólo se puede usar junto con --migrate.');
  }

  let db = null;
  try {
    db = store.openStore(paths.dbFile);
    if (action === 'migrate') {
      printJson(store.migrateFromJson(db, paths, { force }));
    } else if (action === 'runs') {
      printJson(store.listRuns(db, runsLimit));
    } else if (action === 'bucket') {
      printJson(store.latestReconcileByBucket(db, bucket));
    } else {
      printJson(store.storeStats(db));
    }
  } finally {
    try { db?.close(); } catch { /* la base ya estaba cerrada */ }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    help();
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    help();
    return;
  }
  const paths = tolkienPaths();
  if (command === 'login') {
    await login(args, paths);
  } else if (command === 'whoami') {
    if (args.length > 0) throw new CliError(`Opción desconocida para whoami: ${args[0]}`);
    await whoami({ print: true, paths });
  } else if (command === 'census') {
    await census(args, paths);
  } else if (command === 'reconcile') {
    await reconcile(args, paths);
  } else if (command === 'close') {
    await close(args, paths);
  } else if (command === 'reassign') {
    await reassign(args, paths);
  } else if (command === 'db') {
    await dbCommand(args, paths);
  } else {
    throw new CliError(`Subcomando desconocido: ${command}. Usá --help para ver las opciones.`);
  }
}

// El worker importa las primitivas de scraping: importar el módulo no debe
// ejecutar también el CLI completo dentro de cada proceso hijo.
const ejecutadoDirecto = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ejecutadoDirecto) {
  main().catch((error) => {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${message}`);
    process.exitCode = exitCode;
  });
}
