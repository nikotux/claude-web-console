// modules/comms/chatbot-shared.js — COMPARTIDO server <-> runner del CHATBOT.
//
// IDEA (pedido del usuario 2026-07-07): el "Chatbot" deja de ser una fuente
// seedeada a mano y pasa a DERIVARSE de lo que YA escaneamos del bot de Teams
// "Tolkien" (TheEye). El bot RELAYA mensajes de personas reales — cuando el bot
// escribe, en realidad puede ser Chris (u otra persona a futuro) hablándote "a
// través de él". Este motor:
//   Fase 1 (LEER, read-only vía Graph, regla 6): junta los mensajes CRUDOS del
//     chat con cada contacto kind:'bot' (reusa teamsBotPrompt/parseTeamsResponse
//     de teams-shared) — "escanea lo que ya escaneamos de nuestra sección".
//   Fase 2 (INTERPRETAR, CERO herramientas, regla 6): una corrida SDK (sonnet,
//     1 turno) DEDUCE quién es la persona REAL detrás de cada mensaje del bot y
//     lo atribuye a un contacto conocido (o "unknown" → cae al contacto del bot).
//   Fase 3 (MERGE): agrupa por contacto real y FUSIONA con chatbot.json existente
//     (append, nunca pisa: preserva el seed histórico y suma lo nuevo).
//
// Es DESACOPLADO (regla de oro): runner detached + estado file-based (lock +
// chatbot.json). CONSUME TOKENS (Graph read + interpretación) ⇒ bajo botón.
//
// Extensible: a futuro, cualquier persona que aparezca relayada por el bot se
// atribuye sola si es un contacto conocido — no solo Chris.
import fss from 'node:fs';
import path from 'node:path';
import { COMMS_DIR, ensureDir } from './shared.js';

export const CHATBOT_LOCK = path.join(COMMS_DIR, 'chatbot.lock');
export const CHATBOT_LOG = path.join(COMMS_DIR, 'chatbot.log');

// Interpretación de VARIOS mensajes con sonnet: más generoso que el análisis de
// UN hilo (60s) — el cold-start de query() (~4-8s) + razonar la atribución de
// ~20 mensajes con salida JSON estructurada no entra en 60s (verificado: cortaba).
export const CHATBOT_INTERPRET_TIMEOUT_MS = 150 * 1000;
export const CHATBOT_HEARTBEAT_MS = 3000;
export const CHATBOT_LOCK_FRESH_MS = 20000;

// Contactos que son bots de Teams que RELAYAN a personas (kind:'bot').
export function relayBots(contacts) {
  return (contacts || []).filter((c) => c && c.kind === 'bot');
}

// ===== Fase 2: prompt de interpretación (CERO herramientas) =====
// Recibe la lista de contactos conocidos + los mensajes crudos del bot y pide
// atribuir cada mensaje a la persona REAL. El modelo NO usa herramientas: solo
// razona sobre el texto que ya tenemos (regla 6, doble capa deniega todo).
export function chatbotInterpretPrompt(knownContacts, rawMessages, meName) {
  const contactLines = (knownContacts || [])
    .map((c) => `- id="${c.id}" nombre="${c.name}"${c.github ? ` github=${c.github}` : ''}${c.email ? ` email=${c.email}` : ''}`)
    .join('\n');
  const msgLines = (rawMessages || [])
    .map((m, i) => `[${i}] (${m.from === 'me' ? 'yo' : 'bot'}) ${m.sender || '?'} @ ${m.at || ''}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n');
  return [
    'El bot de Microsoft Teams "Tolkien" (TheEye) RELAYA mensajes de personas reales:',
    'cuando el bot escribe, en realidad suele ser UNA PERSONA hablándote a través de él',
    '("disfrazada de Tolkien"). Por el CONTENIDO (firmas, "Chris reviewed…", nombres,',
    'contexto, tickets) deducí quién es la persona REAL detrás de cada mensaje.',
    '',
    'Contactos conocidos (usá EXACTAMENTE su id; si el mensaje es de alguien que NO',
    'está en la lista, usá "unknown"):',
    contactLines || '(ninguno)',
    `Tu identidad (mensajes "míos", los que escribí YO): ${meName || 'yo'}.`,
    '',
    'Mensajes del bot (del más viejo al más nuevo):',
    msgLines || '(ninguno)',
    '',
    'Respondé ÚNICAMENTE con un bloque ```json (nada de texto fuera):',
    '```json',
    '{"items":[{"i":0,"realContactId":"chris","realSender":"Christopher Swenor","mine":false}]}',
    '```',
    '- "i" = índice del mensaje (el número entre corchetes).',
    '- "realContactId" = id EXACTO del contacto real (de la lista de arriba) o "unknown".',
    '  Para un mensaje MÍO ("yo"), poné el id del contacto con quien estoy hablando (o "unknown").',
    '- "realSender" = nombre real de quien escribió ese mensaje.',
    '- "mine" = true SOLO si ese mensaje lo escribí YO (no una persona relayada por el bot).',
    'Incluí un item por CADA mensaje. No inventes contactos ni datos.',
  ].join('\n');
}

// Parseo defensivo del JSON de interpretación → threads[] agrupados por contacto
// real. Un realContactId inválido/"unknown" cae al contacto del bot (botFallbackId)
// para no perder nada; el nombre real queda en author. fromContact = !mine.
export function parseChatbotInterpretation(out, rawMessages, knownIds, opts = {}) {
  const botFallbackId = opts.botFallbackId || null;
  const chatId = opts.chatId || null;
  const participants = Array.isArray(opts.participants) ? opts.participants : null;
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);

  const candidates = [];
  const fences = String(out || '').match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fences) for (const f of fences) candidates.push(f.replace(/```(?:json)?/gi, '').trim());
  const brace = String(out || '').match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  let parsed = null;
  for (const c of candidates.reverse()) { try { parsed = JSON.parse(c); break; } catch { /* siguiente */ } }
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  if (!items.length) return [];

  const byContact = new Map();
  for (const it of items) {
    const i = Number(it?.i);
    const raw = Number.isInteger(i) ? rawMessages[i] : null;
    if (!raw || !raw.text) continue;
    let cid = String(it?.realContactId || '').trim();
    if (!cid || cid === 'unknown' || !known.has(cid)) cid = botFallbackId;
    if (!cid) continue; // sin fallback y sin match ⇒ descartar (no hay dónde ponerlo)
    const mine = it?.mine === true;
    const msg = {
      author: String(it?.realSender || raw.sender || (mine ? (opts.meName || 'Yo') : 'Contacto')).slice(0, 80),
      login: '',
      ts: raw.ts || 0,
      text: String(raw.text || '').slice(0, 8000),
      kind: 'chatbot',
      url: null,
      fromContact: !mine,
    };
    if (!byContact.has(cid)) byContact.set(cid, []);
    byContact.get(cid).push(msg);
  }

  const threads = [];
  for (const [cid, messages] of byContact.entries()) {
    messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    threads.push({
      id: `chatbot:${cid}`,
      contactId: cid,
      source: 'chatbot',
      project: null,
      title: 'Teams · vía bot Tolkien (TheEye)',
      url: null,
      state: null,
      participants,
      chatId,
      messages,
    });
  }
  return threads;
}

// ===== Fase 3: merge NO destructivo con lo existente (append + dedup) =====
// Clave por ts + arranque del texto: identifica "el mismo mensaje" aunque su
// contenido se haya des-clippeado entre corridas (mismo comienzo, más largo).
function msgKey(m) { return `${m.ts || 0}|${String(m.text || '').replace(/\s+/g, ' ').slice(0, 60)}`; }
export function mergeChatbotThreads(existing, fresh) {
  const byId = new Map();
  for (const t of (existing || [])) byId.set(t.contactId, { ...t, messages: [...(t.messages || [])] });
  for (const t of (fresh || [])) {
    const cur = byId.get(t.contactId);
    if (!cur) { byId.set(t.contactId, { ...t, messages: [...(t.messages || [])] }); continue; }
    // Índice por clave: mensaje nuevo → agregar; mismo mensaje con MÁS texto
    // (des-clippeado en un re-scan) → UPGRADE (reemplaza la versión recortada).
    const idxByKey = new Map(cur.messages.map((m, i) => [msgKey(m), i]));
    for (const m of (t.messages || [])) {
      const k = msgKey(m);
      if (!idxByKey.has(k)) { cur.messages.push(m); idxByKey.set(k, cur.messages.length - 1); continue; }
      const i = idxByKey.get(k);
      if (String(m.text || '').length > String(cur.messages[i].text || '').length) cur.messages[i] = m;
    }
    cur.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    cur.participants = t.participants || cur.participants;
    cur.chatId = t.chatId || cur.chatId;
    cur.title = cur.title || t.title;
  }
  return [...byId.values()];
}

// ===== Lock de "interpretación de chatbot corriendo" (heartbeat del runner) =====
export function writeChatbotLock(state) {
  try { ensureDir(); fss.writeFileSync(CHATBOT_LOCK, JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 }); }
  catch { /* noop */ }
}
export function clearChatbotLock() { try { fss.unlinkSync(CHATBOT_LOCK); } catch { /* noop */ } }
export function readChatbotLock() {
  try {
    const l = JSON.parse(fss.readFileSync(CHATBOT_LOCK, 'utf8'));
    if (Date.now() - l.ts >= CHATBOT_LOCK_FRESH_MS) return null;
    return l;
  } catch { return null; }
}
export function isChatbotRunning() { return !!readChatbotLock(); }
