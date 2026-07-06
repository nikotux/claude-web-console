// modules/comms/teams-shared.js — COMPARTIDO server <-> runner de TEAMS.
//
// Fase 5: "mensajes directos con Chris" desde Microsoft Teams vía el MCP
// tolkien-mordor (graph_* de LECTURA). CONSUME TOKENS ⇒ bajo botón.
//
// CORRECTITUD DE ATRIBUCIÓN (fix 2026-07-05): la conversación DEBE ser el DM
// 1:1 entre YO (self: Nicolás) y el contacto. Antes el prompt buscaba "un 1:1
// donde el contacto sea miembro" sin exigir que el OTRO miembro fuera yo — así
// podía traer un DM del contacto con otra persona. Ahora: el prompt exige que
// los participantes sean {yo, contacto} y devuelve members[]+chatId; el parseo
// RECHAZA (found:false) cualquier chat que no me incluya, y guarda los
// participantes + remitente real por mensaje para poder auditar.
//
// SEGURIDAD (regla 6): READ-ONLY doble capa con graphReadAllowed (solo
// graph_*/teams_* de lectura). teams_send_message / graph_send_* / *_write* /
// *_save* → DENEGADOS.
import fss from 'node:fs';
import path from 'node:path';
import { COMMS_DIR, ensureDir } from './shared.js';

export const TEAMS_LOCK = path.join(COMMS_DIR, 'teams.lock');
export const TEAMS_LOG = path.join(COMMS_DIR, 'teams.log');

export const TEAMS_TIMEOUT_MS = 4 * 60000;
export const TEAMS_HEARTBEAT_MS = 3000;
export const TEAMS_LOCK_FRESH_MS = 20000;

const GRAPH_WRITE_VERB = /(send|create|update|write|delete|remove|post|set|add|move|assign|reply|mkdir|share|save|patch|put)/i;
const GRAPH_READ_VERB = /(list|read|get|search|find|members|presence|detail|view|info)/i;
export const graphReadAllowed = (name) => {
  const s = String(name);
  if (s === 'TodoWrite' || s === 'ToolSearch') return true;
  const m = s.match(/^mcp__[a-z0-9_-]+__(?:graph|teams)_([a-z0-9_]+)$/i);
  if (!m) return false;
  const op = m[1];
  return !GRAPH_WRITE_VERB.test(op) && GRAPH_READ_VERB.test(op);
};

// ¿Este participante (por nombre/email) es "self" (yo)?
export function isSelfPerson(person, self) {
  const name = String(person?.name || '').toLowerCase();
  const email = String(person?.email || '').toLowerCase();
  const sEmail = String(self?.email || '').toLowerCase();
  const sName = String(self?.name || '').toLowerCase();
  if (sEmail && email && email === sEmail) return true;
  if (sName && name && name === sName) return true;
  // apellido/nombre sueltos (ej. "Nicolás Mosquera" ~ "Nico Mosquera")
  const parts = sName.split(/\s+/).filter((w) => w.length > 3);
  return parts.length > 0 && parts.every((w) => name.includes(w));
}
export function isContactPerson(person, contact) {
  const name = String(person?.name || '').toLowerCase();
  const email = String(person?.email || '').toLowerCase();
  if (contact.email && email && email === String(contact.email).toLowerCase()) return true;
  if (contact.name && name && name.includes(String(contact.name).toLowerCase())) return true;
  // heurística por github/apellido conocido del contacto
  if (contact.github && name.includes(String(contact.github).toLowerCase())) return true;
  return false;
}

export function teamsPrompt(contact, self) {
  const name = contact.name || contact.id;
  const cEmail = contact.email ? ` (email ${contact.email})` : '';
  const cGh = contact.github ? ` (GitHub ${contact.github})` : '';
  const meName = self?.name || 'yo';
  const meEmail = self?.email ? ` (email ${self.email})` : '';
  return [
    `Buscá EXCLUSIVAMENTE el chat DIRECTO 1:1 de Microsoft Teams entre`,
    `${meName}${meEmail} y "${name}"${cEmail}${cGh}. Es SOLO LECTURA: no envíes ni`,
    `modifiques nada.`,
    '',
    'Pasos con las tools graph_* de LECTURA:',
    `1. Resolvé con graph_list_users a AMBAS personas: a ${meName} y a ${name}`,
    `   (por email si lo tenés, si no por nombre). Anotá sus emails.`,
    `2. Listá los chats con graph_list_chats para ${meName} (mi cuenta) y quedate`,
    `   SOLO con el chat cuyo tipo es 1:1 (oneOnOne) y cuyos DOS miembros son`,
    `   EXACTAMENTE ${meName} y ${name}. Confirmá los miembros con graph_chat_members.`,
    `3. Si NO existe ese 1:1 entre ${meName} y ${name} (por ejemplo solo hay chats`,
    `   de ${name} con OTRAS personas), devolvé found:false — NO devuelvas un chat`,
    `   que no me incluya a mí (${meName}).`,
    '4. Si existe, leé los mensajes recientes con graph_read_chat_messages.',
    '',
    'Respondé ÚNICAMENTE con un bloque JSON (nada de texto fuera):',
    '```json',
    '{"found":true,"chatId":"<id>","members":[{"name":"<displayName>","email":"<email>"}],"messages":[{"from":"contact"|"me","sender":"<displayName real>","at":"<fecha ISO>","text":"<~300 chars>"}]}',
    '```',
    `"members" son los participantes REALES del chat (deben ser ${meName} y ${name}).`,
    `"from":"contact" = lo escribió ${name}; "from":"me" = lo escribí yo (${meName}).`,
    `"sender" = el displayName REAL de quien mandó ese mensaje.`,
    'Máximo 20 mensajes, del más viejo al más nuevo. Si no hay ese 1:1 conmigo:',
    '{"found":false,"note":"<por qué en 1 línea>"}.',
  ].join('\n');
}

// Parseo defensivo + VALIDACIÓN de que el chat me incluye a MÍ y al contacto.
export function parseTeamsResponse(out, contact, self) {
  const candidates = [];
  const fences = String(out || '').match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fences) for (const f of fences) candidates.push(f.replace(/```(?:json)?/gi, '').trim());
  const brace = String(out || '').match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  let parsed = null;
  for (const c of candidates.reverse()) { try { parsed = JSON.parse(c); break; } catch { /* siguiente */ } }
  if (!parsed || typeof parsed !== 'object') return { found: false, note: 'No se pudo interpretar la respuesta de Teams.' };
  if (parsed.found === false || !Array.isArray(parsed.messages) || !parsed.messages.length) {
    return { found: false, note: String(parsed.note || 'sin DM').slice(0, 200) };
  }

  const members = Array.isArray(parsed.members)
    ? parsed.members.map((m) => ({ name: String(m?.name || '').slice(0, 80), email: String(m?.email || '').slice(0, 120) })).filter((m) => m.name || m.email)
    : [];
  // Guarda de atribución: si hay lista de miembros y YO no estoy, RECHAZAR.
  if (members.length) {
    const selfIn = members.some((m) => isSelfPerson(m, self));
    const contactIn = members.some((m) => isContactPerson(m, contact));
    if (!selfIn) {
      const who = members.map((m) => m.name || m.email).join(', ');
      return { found: false, note: `El DM no te incluye (participantes: ${who}).`, members, rejected: true };
    }
    if (!contactIn) {
      const who = members.map((m) => m.name || m.email).join(', ');
      return { found: false, note: `El DM no incluye a ${contact.name} (participantes: ${who}).`, members, rejected: true };
    }
  }

  const ts = (s) => { const n = Date.parse(s || ''); return Number.isFinite(n) ? n : 0; };
  const messages = parsed.messages.slice(0, 30).map((m) => ({
    author: String(m.sender || (m.from === 'contact' ? (contact.name || 'contacto') : (self?.name || 'Yo'))).slice(0, 80),
    login: '',
    ts: ts(m.at),
    text: String(m.text || '').slice(0, 1200),
    kind: 'teams',
    url: null,
    fromContact: m.from === 'contact',
  })).filter((m) => m.text);
  if (!messages.length) return { found: false, note: 'DM sin mensajes legibles.' };

  const thread = {
    id: `teams:${contact.id}`,
    contactId: contact.id,
    source: 'teams',
    project: null,
    title: `Teams · DM con ${contact.name || contact.id}`,
    url: null,
    state: null,
    participants: members,     // auditable: con quién es realmente
    chatId: String(parsed.chatId || '').slice(0, 200) || null,
    messages,
  };
  return { found: true, thread, note: String(parsed.note || '').slice(0, 200) };
}

// ===== Lock de "escaneo Teams corriendo" =====
export function writeTeamsLock(state) {
  try { ensureDir(); fss.writeFileSync(TEAMS_LOCK, JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 }); }
  catch { /* noop */ }
}
export function clearTeamsLock() { try { fss.unlinkSync(TEAMS_LOCK); } catch { /* noop */ } }
export function readTeamsLock() {
  try {
    const l = JSON.parse(fss.readFileSync(TEAMS_LOCK, 'utf8'));
    if (Date.now() - l.ts >= TEAMS_LOCK_FRESH_MS) return null;
    return l;
  } catch { return null; }
}
export function isTeamsRunning() { return !!readTeamsLock(); }
