// modules/bugs-v2/desk-mcp-client.js — cliente MCP PROGRAMÁTICO al server
// tolkien-mordor, SIN agente/LLM en el medio (a diferencia del desk-runner de
// v1 en bugfixes/desk-shared.js, que manda un sub-agente a "leer y retranscribir
// a JSON" — ESE paso de retranscripción es la causa raíz del bug #527/#516:
// falla sistemáticamente para tickets con contenido pesado, 6/6 en #516).
//
// Acá llamamos la tool desk_* DIRECTO: la respuesta YA es JSON estructurado
// (lo confirmamos hoy con desk_get_ticket sobre #527/#530) — cero parseo de
// texto libre, cero tokens, cero posibilidad de "no se pudo interpretar".
//
// Arranca el MISMO server que usa Tolkien (.mcp.json): `infisical run ... npx
// tsx apps/mcp/src/index.ts`, con MORDOR_MCP_READONLY=true — reusa exactamente
// la config/credenciales existentes, sin secretos nuevos.
//
// SINGLETON: levantar el proceso (infisical + tsx) tarda varios segundos: se
// mantiene UNA conexión viva y se reutiliza entre llamadas (nunca un server
// por consulta). Reconecta sola si el proceso murió.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../../core/config.js';

const SERVER_ID = 'tolkien-mordor';
const INFISICAL_PROJECT_ID = '25b6c300-7686-4cf0-b8e3-ed808a529638';

let clientPromise = null; // promesa en vuelo del singleton (evita doble arranque en carreras)
let liveClient = null;    // Client conectado, o null si no hay conexión viva

function buildTransport() {
  return new StdioClientTransport({
    command: 'infisical',
    args: ['run', '--projectId', INFISICAL_PROJECT_ID, '--env', 'prod', '--', 'npx', 'tsx', 'apps/mcp/src/index.ts'],
    cwd: config.projectDir, // ~/tolkien (o CWC_PROJECT_DIR) — mismo cwd que .mcp.json espera
    env: { ...process.env, MORDOR_MCP_READONLY: 'true' },
    stderr: 'pipe', // no volcar stderr del server MCP a la consola del proceso padre
  });
}

async function connectClient() {
  const transport = buildTransport();
  const client = new Client({ name: 'cwc-bugs-v2', version: '1.0.0' }, { capabilities: {} });
  // Si el proceso muere (crash, kill), soltamos la referencia para reconectar
  // en la próxima llamada en vez de quedar con un client zombi.
  transport.onclose = () => { if (liveClient === client) liveClient = null; };
  transport.onerror = () => { if (liveClient === client) liveClient = null; };
  await client.connect(transport);
  liveClient = client;
  return client;
}

// Devuelve el Client conectado, reusando el singleton vivo. Si dos llamadas
// concurrentes piden el client mientras no hay ninguno, comparten LA MISMA
// promesa de conexión (no arrancan dos procesos MCP en paralelo).
async function getClient() {
  if (liveClient) return liveClient;
  if (!clientPromise) {
    clientPromise = connectClient().finally(() => { clientPromise = null; });
  }
  return clientPromise;
}

// callTool determinístico: la tool MCP devuelve su resultado como JSON
// (content[0].text con el JSON serializado) — lo parseamos UNA vez acá, no
// pedimos a ningún modelo que lo retranscriba.
//
// TIMEOUT por llamada (descubierto en Fase 2, 2026-07-06): sin esto, un único
// desk_get_ticket que no responde deja colgado para siempre el worker del pool
// que lo espera, y con él todo el lote (Promise.all nunca resuelve). Con el
// timeout, ese ítem cae como error y el resto del dashboard sigue.
const CALL_TIMEOUT_MS = 20_000;
async function callTool(name, args = {}) {
  const client = await getClient();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout MCP: ${name}`)), CALL_TIMEOUT_MS); });
  let result;
  try {
    result = await Promise.race([client.callTool({ name, arguments: args }), timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (result.isError) {
    const msg = result.content?.[0]?.text || 'Error desconocido de la tool MCP.';
    throw new Error(msg);
  }
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) return result; // tool sin salida de texto (raro para desk_*)
  try { return JSON.parse(text); } catch { return text; } // algunas tools devuelven texto plano
}

// ===== Resolución número de ticket -> ID interno de Zoho =====
// desk_get_ticket exige el ID interno (18 dígitos, "ticket_id: from
// desk_list_tickets"), NO el número humano ("527"). Descubierto en la
// verificación de Fase 1 (2026-07-06): pasarle "527" directo devuelve
// {errorCode:"URL_NOT_FOUND"} DENTRO de un content de tipo texto (isError no
// se marca), así que se ve como "éxito" con campos vacíos si no se valida.
// Se resuelve listando los 2 departamentos conocidos (Tolkien = bugs/features,
// Mordor Staffing = hw/access/onboarding/platform/client) y buscando el
// ticketNumber. Cache en memoria con TTL corto — cero estado en disco.
const KNOWN_DEPARTMENTS = ['813994000003710353', '813994000000006907']; // Tolkien, Mordor Staffing
const RESOLVE_CACHE_TTL_MS = 30_000;
let resolveCache = null; // { at, byNumber: Map<string,string> }

async function buildResolveCache() {
  const byNumber = new Map();
  for (const deptId of KNOWN_DEPARTMENTS) {
    const tickets = await listTicketsByDepartment(deptId, 100);
    for (const t of tickets) if (t.ticketNumber) byNumber.set(String(t.ticketNumber), t.id);
  }
  return { at: Date.now(), byNumber };
}

async function resolveTicketId(ticketNumberOrId) {
  const s = String(ticketNumberOrId);
  if (s.length >= 15) return s; // ya es un ID interno de Zoho (18 dígitos típico)
  if (!resolveCache || Date.now() - resolveCache.at > RESOLVE_CACHE_TTL_MS) {
    resolveCache = await buildResolveCache();
  }
  const id = resolveCache.byNumber.get(s);
  if (!id) throw new Error(`Ticket #${s} no encontrado en los departamentos conocidos (Tolkien/Mordor Staffing).`);
  return id;
}

// ===== API pública determinística (sin IA) =====

export async function getTicketState(ticketNumberOrId) {
  const ticketId = await resolveTicketId(ticketNumberOrId);
  const t = await callTool('desk_get_ticket', { ticket_id: ticketId });
  if (t?.errorCode) throw new Error(`Zoho Desk: ${t.errorCode} — ${t.message || 'sin detalle'}`);
  return {
    found: true,
    id: t.id ?? null,
    ticketNumber: t.ticketNumber ?? null,
    status: t.status ?? null,
    statusType: t.statusType ?? null,
    closed: t.statusType === 'Closed',
    subject: t.subject ?? null,
    departmentId: t.departmentId ?? null,
    assigneeId: t.assigneeId ?? null,
    contactId: t.contactId ?? null,
    email: t.email ?? null,
    priority: t.priority ?? null,
    channel: t.channel ?? null,
    language: t.language ?? null,
    customFields: t.customFields ?? t.cf ?? {},
    commentCount: Number(t.commentCount ?? 0),
    threadCount: Number(t.threadCount ?? 0),
    createdTime: t.createdTime ?? null,
    modifiedTime: t.modifiedTime ?? null,
    closedTime: t.closedTime ?? null,
    onholdTime: t.onholdTime ?? null,
    dueDate: t.dueDate ?? null,
    responseDueDate: t.responseDueDate ?? null,
    webUrl: t.webUrl ?? null,
    raw: t,
  };
}

// Agentes de Desk (para resolver assigneeId -> nombre del propietario).
export async function listAgents() {
  const r = await callTool('desk_list_agents', { limit: 100 });
  const arr = Array.isArray(r?.agents) ? r.agents : (Array.isArray(r) ? r : (r?.data || []));
  return arr;
}

// Contactos de Desk (para resolver contactId -> nombre del reporter). Lista
// acotada (limit configurable); si el contacto no está, se usa el email del ticket.
export async function listContacts(limit = 100) {
  const r = await callTool('desk_list_contacts', { limit });
  const arr = Array.isArray(r?.contacts) ? r.contacts : (Array.isArray(r) ? r : (r?.data || []));
  return arr;
}

export async function listDepartments() {
  const r = await callTool('desk_list_departments', {});
  return Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : []);
}

export async function listTicketsByDepartment(departmentId, limit = 50) {
  const r = await callTool('desk_list_tickets', { department_id: departmentId, limit });
  return Array.isArray(r?.tickets) ? r.tickets : [];
}

// Cierre explícito (para tests/CLI de diagnóstico). En el server normal NO
// hace falta llamarlo: el singleton vive todo el proceso.
export async function closeClient() {
  if (liveClient) { try { await liveClient.close(); } catch { /* noop */ } }
  liveClient = null;
}
