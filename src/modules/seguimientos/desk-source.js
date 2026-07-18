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

function domainOf(subject = '') {
  const s = subject.toLowerCase();
  if (s.includes('local 112') || s.includes('new office') || s.includes('oficina')) return 'oficina';
  if (s.includes("mark's apartment") || s.includes('apartment') || s.includes('apto') || s.includes('jacuzzi') || s.includes('storage')) return 'casa';
  return 'otros';
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
function toFrente(t) {
  const now = Date.now();
  const modified = t.modifiedTime ? Date.parse(t.modifiedTime) : (t.createdTime ? Date.parse(t.createdTime) : now);
  const daysIdle = Number.isFinite(modified) ? Math.floor((now - modified) / 86400000) : 0;
  return {
    id: `desk:${t.ticketNumber}`,
    source: 'desk',
    world: 'externo',
    key: String(t.ticketNumber),
    title: t.subject || `Ticket #${t.ticketNumber}`,
    domain: domainOf(t.subject),
    status: t.status || null,
    statusType: t.statusType || null,
    assigneeId: t.assigneeId ? String(t.assigneeId) : null,
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

// Trae los frentes del usuario desde Desk (read-only, aduana): abiertos y
// (asignados a mí de cualquier categoría) O facilities.
export async function pullDeskFrentes() {
  const [tickets, myId] = await Promise.all([
    listTicketsByDepartment(DEPT_MORDOR, 100),
    myAgentId(),
  ]);
  return tickets
    .filter((t) => OPEN_TYPES.has(t.statusType) && (isFacilities(t) || (myId && String(t.assigneeId) === myId)))
    .map(toFrente);
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
    if (old && old.fingerprint === f.fingerprint && old.detail) { f.detail = old.detail; return; }
    try {
      const t = await getTicketState(f.key);
      const cf = t.customFields || {};
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
    } catch { f.detail = old?.detail || null; }
  }, 4);
  return frentes;
}
