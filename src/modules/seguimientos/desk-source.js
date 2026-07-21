// modules/seguimientos/desk-source.js — ADUANA de Zoho Desk (mundo externo →
// Limbo). Lee READ-ONLY los tickets del usuario via el mismo desk-mcp-client
// read-only de Tolkien y los mapea a "frentes". 0 tokens (determinístico).
// NO escribe nada al mundo externo (Aduana Ley 1-2).
//
// SET (G1, ticket-céntrico): tickets ABIERTOS que son del USUARIO =
// (asignados a mí, de CUALQUIER categoría) ∪ facilities (casa/oficina). El
// assigneeId del usuario se resuelve por el email de la identidad de instancia
// → multiusuario-ready (hoy 1 usuario = Nico).
import { listTicketsByDepartment, listAgents, listContacts, getTicketState } from '../tickets/desk-mcp-client.js';
import { DEPT_MORDOR } from '../tickets/derive.js';
import { config } from '../../core/config.js';

const OPEN_TYPES = new Set(['Open', 'On Hold']);
// Ventana de cerrados para las métricas ("en qué invierto el tiempo"). El
// snapshot.done trae los tickets cerrados de los últimos N días → completados
// de la semana + tendencia se calculan directo de ahí (sin history-store).
const CLOSED_WINDOW_MS = 30 * 86400000;
// Etiqueta que unifica los tickets de Niko (PLAN-553). Hoy puede no existir aún
// en Zoho — mientras tanto `mine` cae a "asignado a mí"; queda listo para cuando
// Niko empiece a taggear. El string exacto se confirma al configurarlo en Desk.
const NIKO_TAGS = new Set(['niko', 'nico']);
// Proyecto = agrupación de tickets. Fallback por dominio si el ticket no trae
// el customField 'Related to' de Desk.
const DOMAIN_PROJECT = { oficina: 'Oficina (Local 112)', casa: 'Casa de Mark', otros: 'Otros' };

function domainOf(subject = '') {
  const s = subject.toLowerCase();
  if (s.includes('local 112') || s.includes('new office') || s.includes('oficina')) return 'oficina';
  if (s.includes("mark's apartment") || s.includes('apartment') || s.includes('apto') || s.includes('jacuzzi') || s.includes('storage')) return 'casa';
  return 'otros';
}

// Proyecto de un frente: customField 'Related to' de Desk → fallback dominio.
function deriveProject(f) {
  const rel = f.detail?.relatedTo;
  if (rel && String(rel).trim()) return String(rel).trim();
  return DOMAIN_PROJECT[f.domain] || 'Otros';
}

// Nombres de las tags del ticket (Zoho las trae como strings u objetos {name}).
function tagNames(t) {
  const raw = t?.raw?.tags || t?.tags || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => (typeof x === 'string' ? x : (x && x.name) || '')).filter(Boolean);
}
function hasNikoTag(tags) {
  return (tags || []).some((x) => NIKO_TAGS.has(String(x).toLowerCase()));
}

function isFacilities(t) {
  const d = domainOf(t.subject);
  return d === 'casa' || d === 'oficina';
}

// Resuelve el agente de Desk del usuario actual (por email de la identidad de
// instancia). Cache en memoria (multiusuario-ready: la clave sería el usuario).
let _myAgentId; // undefined = sin resolver · null = no encontrado · string = id
async function myAgentId() {
  if (_myAgentId !== undefined) return _myAgentId;
  const email = String(config.instance?.identity?.email || '').toLowerCase();
  try {
    const ags = await listAgents();
    const me = ags.find((a) => String(a.emailId || a.email || '').toLowerCase() === email);
    _myAgentId = me ? String(me.id) : null;
  } catch { _myAgentId = null; }
  return _myAgentId;
}

// Mapea un ticket de Desk a un "frente" crudo (sin clasificación IA aún).
function toFrente(t, myId) {
  const now = Date.now();
  const modified = t.modifiedTime ? Date.parse(t.modifiedTime) : (t.createdTime ? Date.parse(t.createdTime) : now);
  const daysIdle = Number.isFinite(modified) ? Math.floor((now - modified) / 86400000) : 0;
  const assigneeId = t.assigneeId ? String(t.assigneeId) : null;
  return {
    id: `desk:${t.ticketNumber}`,
    source: 'desk',
    world: 'externo',
    key: String(t.ticketNumber),
    title: t.subject || `Ticket #${t.ticketNumber}`,
    domain: domainOf(t.subject),
    project: null,                                  // se completa en enrichFrentes (detail.relatedTo → dominio)
    status: t.status || null,
    statusType: t.statusType || null,
    assigneeId,
    mine: !!(myId && assigneeId === myId),          // tag 'Niko' se suma en enrichFrentes si aparece
    tags: [],
    dueDate: null,                                  // se sube de detail.dueDate en enrichFrentes
    daysIdle,
    lastSignalAt: t.modifiedTime || t.createdTime || null,
    webUrl: t.webUrl || null,
    // Campos que llena el clasificador IA (F1.2); por ahora null:
    ownerBall: null,
    ownerType: null,
    blockedBy: [],
    involucrados: [],
    nextAction: null,
    isBackend: false,
    isMine: true,
    sessionRef: null,
    override: null,
    fingerprint: `${t.status || ''}|${t.modifiedTime || ''}`,
  };
}

// Ítem cerrado LIGERO para las métricas (no entra a la tabla). Agrupado por
// dominio (0 llamadas extra a Zoho); cycleDays = creado→cerrado.
function toDone(t) {
  const created = t.createdTime ? Date.parse(t.createdTime) : null;
  const closed = t.closedTime ? Date.parse(t.closedTime) : (t.modifiedTime ? Date.parse(t.modifiedTime) : null);
  const dom = domainOf(t.subject);
  return {
    key: String(t.ticketNumber),
    title: t.subject || `Ticket #${t.ticketNumber}`,
    domain: dom,
    project: DOMAIN_PROJECT[dom] || 'Otros',
    closedAt: Number.isFinite(closed) ? closed : null,
    closedTime: t.closedTime || t.modifiedTime || null,
    cycleDays: (Number.isFinite(created) && Number.isFinite(closed)) ? Math.max(0, Math.round((closed - created) / 86400000)) : null,
  };
}

// Trae open + done en UNA lectura de Desk (aduana read-only, 0 tokens).
// open = abiertos (asignados a mí de cualquier categoría) ∪ facilities.
// done = cerrados de los últimos CLOSED_WINDOW_MS (para métricas).
export async function pullDeskData() {
  const [tickets, myId] = await Promise.all([
    listTicketsByDepartment(DEPT_MORDOR, 100),
    myAgentId(),
  ]);
  const mineOrFacilities = (t) => isFacilities(t) || (myId && String(t.assigneeId) === myId);
  const open = tickets
    .filter((t) => OPEN_TYPES.has(t.statusType) && mineOrFacilities(t))
    .map((t) => toFrente(t, myId));
  const now = Date.now();
  // done: MISMO scope que open (mis tickets / facilities) — el reporte es "en qué
  // invierto MI tiempo", no el trabajo cerrado de todo el equipo (dev incluido).
  const done = tickets
    .filter((t) => t.statusType === 'Closed' && mineOrFacilities(t))
    .map(toDone)
    .filter((d) => d.closedAt == null || (now - d.closedAt) <= CLOSED_WINDOW_MS);
  return { open, done };
}

// Compat: los frentes abiertos (algún consumidor viejo podría llamarlo).
export async function pullDeskFrentes() {
  return (await pullDeskData()).open;
}

// ===== G2: enriquecer con TODOS los campos de Desk (la "base de datos") =====

function stripHtml(s = '') {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Pool de concurrencia acotada (rate-limit de Zoho): N workers en paralelo.
async function mapPool(items, worker, concurrency = 4) {
  let i = 0;
  async function run() { while (i < items.length) { const idx = i++; try { await worker(items[idx]); } catch { /* best-effort */ } } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return items;
}

// Enriquece cada frente con el detalle completo del ticket (getTicketState).
// Reusa el detail previo si el fingerprint no cambió (ahorra llamadas a Zoho).
export async function enrichFrentes(frentes, prevById = new Map()) {
  let agents = []; let contacts = [];
  try { agents = await listAgents(); } catch { /* noop */ }
  try { contacts = await listContacts(100); } catch { /* noop */ }
  const agentName = new Map(agents.map((a) => [String(a.id), a.name || `${a.firstName || ''} ${a.lastName || ''}`.trim()]));
  const contactName = new Map(contacts.map((c) => [String(c.id), c.email || c.emailId || `${c.firstName || ''} ${c.lastName || ''}`.trim()]));

  await mapPool(frentes, async (f) => {
    const old = prevById.get(f.id);
    if (old && old.fingerprint === f.fingerprint && old.detail) {
      // Sin cambios: reusar detail + los derivados que ya calculamos antes.
      f.detail = old.detail;
      f.tags = old.tags || [];
      f.project = deriveProject(f);
      f.dueDate = f.detail?.dueDate || null;
      f.mine = f.mine || hasNikoTag(f.tags);
      return;
    }
    try {
      const t = await getTicketState(f.key);
      const cf = t.customFields || {};
      f.tags = tagNames(t);
      f.detail = {
        priority: t.priority || null,
        category: t.category || null,
        subCategory: t.subCategory || null,
        channel: t.channel || null,
        language: t.language || null,
        assignee: t.assigneeId ? (agentName.get(String(t.assigneeId)) || String(t.assigneeId)) : null,
        reporter: t.contactId ? (contactName.get(String(t.contactId)) || t.email || null) : (t.email || null),
        description: stripHtml(t.raw?.description || ''),
        country: cf.Country || cf['País'] || null,
        client: cf["Mordor's Client"] || cf.Cliente || null,
        relatedTo: cf['Related to'] || cf.Relacionado || null,
        product: cf.Product || cf.Producto || null,
        createdTime: t.createdTime || null,
        modifiedTime: t.modifiedTime || null,
        onholdTime: t.onholdTime || null,
        dueDate: t.dueDate || null,
        commentCount: t.commentCount || 0,
        threadCount: t.threadCount || 0,
        attachmentCount: t.raw?.attachmentCount || 0,
        customFields: cf,
      };
    } catch { f.detail = old?.detail || null; f.tags = old?.tags || []; }
    // Derivados (valen para el frente fresco): proyecto, deadline, dueño Niko.
    f.project = deriveProject(f);
    f.dueDate = f.detail?.dueDate || null;
    f.mine = f.mine || hasNikoTag(f.tags);
  }, 4);
  return frentes;
}
