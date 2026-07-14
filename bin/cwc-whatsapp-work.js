#!/usr/bin/env node
// bin/cwc-whatsapp-work.js — TRAE un hilo de WhatsApp a la carpeta de trabajo de
// un chat de la consola (Parte B del PLAN-447/PEND-479, "flujo completo": el
// enfoque de SEGUIMIENTO que Niko validó — traer el contenido de un chat →
// analizarlo/contrastarlo → responder; ver memoria feedback-comms-dashboard-vs-flujo).
//
// El daemon de WhatsApp (proceso de fondo) guarda cada hilo vigilado en
// ~/.cwc-data/comms/whatsapp.json (mensajes + transcripciones) y sus binarios en
// ~/.cwc-data/comms/whatsapp-media/<jid>/ (audios, sus .txt de transcripción,
// PDFs, imágenes). Ese es el "almacén" del hilo, ajeno a cualquier chat.
//
// Este CLI hace el PUENTE al chat de la consola: dado un hilo (por jid, o por
// substring de su label/jid) y el chatId del chat destino, copia a la carpeta de
// ese chat (~/.cwc-data/chat-attachments/<chatId>/ — la que abre "Abrir carpeta
// de este chat" y viaja con el paquete-sesión) TODOS los artefactos del hilo +
// un `<hilo>-historial.txt` con la conversación y las transcripciones inline. Así
// el chat arranca con el hilo entero referenciado (sessionFolderRule ya inyecta
// la regla de esa carpeta en todo chat) y el modelo lo puede leer/analizar.
//
// Determinístico, 0 tokens: reusa materializeIntoChat() de chat/attachments.js
// (mismo filtro trabajable + nombre saneado/único + confinamiento anti-traversal
// que cwc-attach.js). Uso:
//   cwc-whatsapp-work.js <jid|substring-label> <chatId>
// exit 0 OK · 2 hilo no encontrado · 1 error de args/IO.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWhatsapp, WHATSAPP_MEDIA_DIR } from '../src/modules/comms/shared.js';
import { materializeIntoChat, chatAttachDir } from '../src/modules/chat/attachments.js';

function safeName(s) { return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }

const [, , query, chatId] = process.argv;
if (!query || !chatId) {
  console.error('uso: cwc-whatsapp-work.js <jid|substring-label> <chatId>');
  process.exit(1);
}
if (!chatAttachDir(chatId)) { console.error('chatId inválido'); process.exit(1); }

const store = readWhatsapp();
const threads = Array.isArray(store?.threads) ? store.threads : [];
const q = query.toLowerCase();
// Match: jid exacto, o substring del jid/label (case-insensitive).
const thread = threads.find((t) => t.chatId === query)
  || threads.find((t) => String(t.chatId || '').toLowerCase().includes(q) || String(t.label || '').toLowerCase().includes(q));
if (!thread) {
  console.error(`hilo no encontrado para "${query}". Hilos disponibles:`);
  for (const t of threads) console.error(`  · ${t.label || t.chatId} (${t.chatId})`);
  process.exit(2);
}

const mediaDir = path.join(WHATSAPP_MEDIA_DIR, safeName(thread.chatId));
const fmtTs = (ts) => { try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 16); } catch { return '?'; } };

// 1) Armar el historial legible con transcripciones inline.
const lines = [`# Historial WhatsApp — ${thread.label || thread.chatId}`, `# JID: ${thread.chatId}`, `# Mensajes: ${thread.messages?.length || 0}`, ''];
const artifacts = []; // rutas absolutas de binarios a copiar
for (const m of (thread.messages || [])) {
  const who = m.fromMe ? 'YO' : (m.from || 'ellos');
  const when = fmtTs(m.ts);
  const a = m.attachment;
  if (a) {
    if (a.type === 'audio' && a.transcript) {
      lines.push(`[${when}] ${who} 🎙️ (nota de voz): ${a.transcript}`);
    } else {
      lines.push(`[${when}] ${who} 📎 (${a.type}: ${a.fileName || a.file})${a.caption ? ' — ' + a.caption : ''}`);
    }
    // Recolectar el binario + su .txt de transcripción para copiarlos.
    if (a.file) { const p = path.join(mediaDir, a.file); if (fs.existsSync(p)) artifacts.push(p); }
    if (a.transcriptFile) { const p = path.join(mediaDir, a.transcriptFile); if (fs.existsSync(p)) artifacts.push(p); }
  }
  if (m.body) lines.push(`[${when}] ${who}: ${m.body}`);
}

// 2) Escribir el historial a un tmp y materializarlo en la carpeta del chat.
const tmpHist = path.join(os.tmpdir(), `wa-historial-${safeName(thread.chatId)}-${process.pid}.txt`);
fs.writeFileSync(tmpHist, lines.join('\n') + '\n', { mode: 0o600 });
const histLabel = `whatsapp-${safeName(thread.label || thread.chatId).slice(0, 40)}-historial.txt`;
const copied = [];
const rHist = materializeIntoChat(chatId, tmpHist, { label: histLabel });
if (rHist.ok) copied.push(rHist.name); else console.error(`historial: ${rHist.reason}`);
try { fs.unlinkSync(tmpHist); } catch { /* noop */ }

// 3) Copiar los artefactos del hilo (audios, .txt, PDFs, imágenes).
let skipped = 0;
for (const abs of artifacts) {
  const r = materializeIntoChat(chatId, abs);
  if (r.ok) copied.push(r.name); else skipped++;
}

const destRel = path.join('.cwc-data', 'chat-attachments', chatId);
console.log(JSON.stringify({
  ok: true,
  thread: { jid: thread.chatId, label: thread.label, messages: thread.messages?.length || 0 },
  copiedToChatFolder: destRel,
  files: copied,
  skipped,
}, null, 2));
