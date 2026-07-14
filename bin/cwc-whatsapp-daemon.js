#!/usr/bin/env node
// bin/cwc-whatsapp-daemon.js — puente WhatsApp ↔ Comunicaciones (PLAN-447).
//
// Motor: Baileys (@whiskeysockets, paquete npm "baileys" fijado a 6.7.23 —
// NUNCA el dist-tag `latest`, que hoy es un release-candidate 7.x con breaking
// changes documentados). A DIFERENCIA de whatsapp-web.js (BUG-455: el evento
// `ready` dejó de disparar por un A/B testing de WhatsApp Web sobre los
// módulos internos que esa librería necesita "espiar"), Baileys habla el
// WebSocket nativo de WhatsApp directo — no depende de renderizar la página
// web, así que ese bug no lo afecta. Además no necesita Chromium: ~50MB de
// RAM vs los ~500MB de Puppeteer.
//
// A DIFERENCIA de los demás runners de esta consola (spawn de un solo tiro,
// interfaz por archivos + lock/heartbeat), éste es un PROCESO LARGO: necesita
// mantener viva la conexión WebSocket para poder recibir mensajes en tiempo
// real. Se modela como servicio systemd de usuario propio
// (whatsapp-bridge.service, PEND-452), no como runner spawneado por el server.
//
// Estado 100% en archivos (~/.cwc-data/comms/), patrón Interfono/comms: las
// credenciales (auth state) viven en WHATSAPP_SESSION_DIR (dato sensible,
// nunca al repo); los mensajes de la watchlist en WHATSAPP_FILE; un heartbeat
// liviano en WHATSAPP_STATUS_FILE para que el resto de la consola sepa si el
// daemon está vivo/emparejado sin tocar el proceso.
//
// MODO DESCUBRIMIENTO: si la watchlist (WHATSAPP_WATCH_FILE) está vacía, el
// daemon NO persiste ningún mensaje — solo loguea chatId+nombre de lo que va
// viendo, para que puedas identificar el JID del chat/grupo que te interesa
// antes de sumarlo a la watchlist (PEND-450).
//
// MODO BÚSQUEDA: `--find="Diego,Alejandro Vasquez"` lista los chats
// existentes que matcheen esos nombres (substring, case-insensitive) y su JID
// real, sin esperar mensajes nuevos — poblar la watchlist de una sola vez con
// varios contactos ya conocidos. Termina solo al finalizar.
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } from 'baileys';
import {
  ensureDir, WHATSAPP_SESSION_DIR, WHATSAPP_QR_PNG_FILE,
  WHATSAPP_OUTBOX_DIR, WHATSAPP_SENT_DIR, WHATSAPP_MEDIA_DIR,
  readWhatsapp, writeWhatsapp, readWhatsappWatch, writeWhatsappStatus,
} from '../src/modules/comms/shared.js';
import { writeJsonAtomic } from '../src/core/atomic-write.js';
import { transcribeAudio, transcriptionAvailable } from '../src/modules/comms/whatsapp-transcribe.js';

// Tipos de media que descargamos + su extensión por defecto (si el mensaje no
// trae fileName/mimetype confiable). documentMessage suele traer fileName real.
const MEDIA_KINDS = {
  imageMessage: { kind: 'image', ext: 'jpg' },
  videoMessage: { kind: 'video', ext: 'mp4' },
  audioMessage: { kind: 'audio', ext: 'ogg' },
  documentMessage: { kind: 'document', ext: 'bin' },
  stickerMessage: { kind: 'sticker', ext: 'webp' },
};

ensureDir();
fs.mkdirSync(WHATSAPP_SESSION_DIR, { recursive: true, mode: 0o700 });

const findArg = process.argv.find((a) => a.startsWith('--find='));
const findNames = findArg ? findArg.slice('--find='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;

// Modo puntual: `--groupmeta=<jid1,jid2>` resuelve el NOMBRE real de uno o
// más chats de GRUPO (los grupos no traen pushName por mensaje — cada
// integrante tiene el suyo — así que discovery no alcanza para saber el
// título del grupo). Termina solo al finalizar.
const groupmetaArg = process.argv.find((a) => a.startsWith('--groupmeta='));
const groupmetaJids = groupmetaArg ? groupmetaArg.slice('--groupmeta='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;

// Modo puntual: `--listgroups` (opcionalmente `--listgroups=filtro`) trae
// TODOS los grupos donde participa la cuenta en una sola llamada
// (groupFetchAllParticipating) — más directo que adivinar un JID de un
// mensaje suelto. Termina solo al finalizar.
const listgroupsArg = process.argv.find((a) => a === '--listgroups' || a.startsWith('--listgroups='));
const listgroupsFilter = listgroupsArg && listgroupsArg.includes('=') ? listgroupsArg.slice('--listgroups='.length).trim().toLowerCase() : null;
const doListGroups = !!listgroupsArg;

const HEARTBEAT_MS = 15000;
let currentState = 'starting';

function setStatus(state, extra = {}) {
  currentState = state;
  writeWhatsappStatus({ pid: process.pid, ts: Date.now(), state, ...extra });
}

function isGroupJid(jid) { return typeof jid === 'string' && jid.endsWith('@g.us'); }

function textOf(message) {
  if (!message) return '';
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || '';
}

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_SESSION_DIR);
  // El paquete "baileys" (fijado a 6.7.23, la versión estable — ver cabecera)
  // trae hardcodeada una versión vieja del protocolo de WhatsApp Web; usarla
  // tal cual devuelve error 405 "Connection Failure" (verificado en vivo y en
  // github.com/WhiskeySockets/Baileys#2370). fetchLatestBaileysVersion()
  // consulta el repo oficial de versiones vigentes — con fallback silencioso
  // al default de la librería si no hay red (mejor un intento con la versión
  // vieja que no arrancar nunca).
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
    console.log('[whatsapp] versión de protocolo:', version.join('.'));
  } catch (err) {
    console.error('[whatsapp] no se pudo obtener la versión vigente, uso el default de la librería:', err?.message);
  }
  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    // Nunca marcar "en línea": un monitor de solo-lectura no debe robarte las
    // notificaciones push del teléfono (doc oficial: default = true).
    markOnlineOnConnect: false,
    getMessage: async () => undefined, // no reenviamos/desciframos histórico
    // Emular un dispositivo de escritorio para recibir el sync COMPLETO de
    // chats (messaging-history.set) — sin esto Baileys se comporta como un
    // "dispositivo móvil" y solo trae una porción; --find necesita ver todos.
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: !!findNames,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      setStatus('qr');
      console.log('[whatsapp] escaneá este QR desde WhatsApp → Dispositivos vinculados (o usá el código de 8 dígitos si lo pediste con --pair=<numero>):');
      QRCode.toFile(WHATSAPP_QR_PNG_FILE, qr, { width: 400, margin: 2 })
        .catch((err) => console.error('[whatsapp] no se pudo rasterizar el QR:', err?.message));
    }

    if (connection === 'open') {
      setStatus('ready');
      console.log('[whatsapp] sesión emparejada y lista.');
      if (findNames) await runFind(sock);
      if (groupmetaJids) await runGroupMeta(sock);
      if (doListGroups) await runListGroups(sock);
      // Modo persistente normal: arrancar el watcher del canal de escritura.
      if (!findNames && !groupmetaJids && !doListGroups) startOutboxWatcher(sock);
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('[whatsapp] sesión cerrada desde el teléfono — hace falta re-emparejar (borrar WHATSAPP_SESSION_DIR y escanear de nuevo).');
        setStatus('logged_out');
        process.exit(1);
      }
      console.error('[whatsapp] conexión cerrada, código:', statusCode, '— reintentando…');
      setStatus('reconnecting', { statusCode: statusCode ?? null });
      // systemd (Restart=on-failure, PEND-452) relanza si esto termina en error;
      // acá reintentamos in-process para statusCode transitorios (restartRequired, etc).
      main().catch((err) => { console.error('[whatsapp] fallo al reconectar:', err?.message); process.exit(1); });
    }
  });

  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await handleMessage(sock, msg); } catch (err) { console.error('[whatsapp] error procesando mensaje:', err?.message); }
    }
  });

  return sock;
}

function safeName(s) { return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }

// Descarga el adjunto de un mensaje (si tiene) y devuelve su referencia
// {type,file,fileName,mime,caption,size}. Guarda el binario en
// WHATSAPP_MEDIA_DIR/<chatId>/<msgId>.<ext>. Devuelve null si el mensaje no
// tiene media. Ante fallo de descarga devuelve una referencia con `error` para
// no perder el registro de que llegó algo.
async function downloadMedia(sock, msg, chatId) {
  const type = Object.keys(MEDIA_KINDS).find((k) => msg.message?.[k]);
  if (!type) return null;
  const info = MEDIA_KINDS[type];
  const node = msg.message[type];
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
    const chatDir = path.join(WHATSAPP_MEDIA_DIR, safeName(chatId));
    fs.mkdirSync(chatDir, { recursive: true, mode: 0o700 });
    const origName = node.fileName || null;
    let ext = info.ext;
    if (origName && path.extname(origName)) ext = path.extname(origName).slice(1);
    const file = `${safeName(msg.key.id || String(msg.messageTimestamp || 'x'))}.${ext}`;
    const fullPath = path.join(chatDir, file);
    fs.writeFileSync(fullPath, buffer, { mode: 0o600 });
    console.log(`[whatsapp] 📎 adjunto ${info.kind} guardado: ${chatId}/${file} (${buffer.length} bytes)`);
    const ref = { type: info.kind, file, fileName: origName || file, mime: node.mimetype || null, caption: node.caption || null, size: buffer.length };
    // Nota de voz → transcripción LOCAL (whisper.cpp, 0 tokens). Best-effort:
    // si whisper no está o falla, el audio queda guardado igual, sin transcript.
    if (info.kind === 'audio' && transcriptionAvailable()) {
      console.log(`[whatsapp] 🎙️ transcribiendo audio ${file}…`);
      const res = await transcribeAudio(fullPath, { lang: 'es' });
      if (res && res.text) {
        ref.transcript = res.text;
        if (res.txtFile) ref.transcriptFile = res.txtFile; // .txt artefacto junto al audio
        console.log(`[whatsapp] 🎙️ transcripción: "${res.text.slice(0, 80)}${res.text.length > 80 ? '…' : ''}"`);
      }
    }
    return ref;
  } catch (err) {
    console.error('[whatsapp] fallo al descargar adjunto:', err?.message);
    return { type: info.kind, error: err?.message || String(err), fileName: node.fileName || null, mime: node.mimetype || null };
  }
}

async function handleMessage(sock, msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;
  const body = textOf(msg.message);
  const watch = readWhatsappWatch();

  const match = watch.find((w) => w.jid === chatId);
  if (!match) {
    // Discovery SIEMPRE activo (incluso con watchlist poblada): así se puede
    // mapear un chat nuevo mandándole un mensaje —propio o ajeno— sin apagar el
    // monitoreo. Los grupos loguean el nombre del grupo (subject) si lo tenemos
    // cacheado; los individuales, el pushName. NO se persiste, solo se loguea.
    console.log(`[whatsapp] (descubrimiento) ${chatId} · "${msg.pushName || ''}" · ${msg.key.fromMe ? '[mío] ' : ''}"${body.slice(0, 60)}"`);
    return;
  }

  // Descargar adjunto ANTES de persistir, para que la referencia quede en el
  // mismo write (una sola escritura del store).
  const attachment = await downloadMedia(sock, msg, chatId);

  const store = readWhatsapp();
  let thread = store.threads.find((t) => t.chatId === chatId);
  if (!thread) {
    thread = { chatId, chatName: match.label || msg.pushName || chatId, label: match.label || chatId, isGroup: isGroupJid(chatId), messages: [] };
    store.threads.push(thread);
  }
  const entry = {
    id: msg.key.id || null,
    ts: (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000,
    from: msg.key.participant || msg.key.remoteJid,
    fromMe: !!msg.key.fromMe,
    body: body.slice(0, 8000),
  };
  if (attachment) entry.attachment = attachment;
  thread.messages.push(entry);
  if (thread.messages.length > 500) thread.messages = thread.messages.slice(-500);
  store.updatedAt = Date.now();
  writeWhatsapp(store);
}

async function runFind(sock) {
  try {
    // Baileys no expone un "getChats()" como whatsapp-web.js: la lista de
    // chats se arma escuchando 'messaging-history.set' durante el sync
    // inicial tras conectar. Esperamos una ventana corta a que llegue.
    const chats = await new Promise((resolve) => {
      let collected = [];
      const onHistory = ({ chats: c }) => {
        collected = collected.concat(c || []);
        console.log(`[whatsapp] messaging-history.set: +${(c || []).length} (total ${collected.length})`);
      };
      sock.ev.on('messaging-history.set', onHistory);
      setTimeout(() => { sock.ev.off('messaging-history.set', onHistory); resolve(collected); }, 30000);
    });
    console.log(`[whatsapp] buscando ${findNames.length} nombre(s) entre ${chats.length} chats sincronizados…`);
    for (const name of findNames) {
      const hits = chats.filter((c) => String(c.name || '').toLowerCase().includes(name));
      if (!hits.length) { console.log(`[whatsapp] --find "${name}": SIN COINCIDENCIAS`); continue; }
      for (const c of hits) {
        console.log(`[whatsapp] --find "${name}" → jid=${c.id} · nombre="${c.name}" · grupo=${isGroupJid(c.id)}`);
      }
    }
  } catch (err) {
    console.error('[whatsapp] error listando chats:', err?.message);
  } finally {
    if (!groupmetaJids) process.exit(0);
  }
}

async function runGroupMeta(sock) {
  for (const jid of groupmetaJids) {
    try {
      const meta = await sock.groupMetadata(jid);
      console.log(`[whatsapp] --groupmeta ${jid} → nombre="${meta.subject}" · participantes=${meta.participants?.length ?? '?'}`);
    } catch (err) {
      console.log(`[whatsapp] --groupmeta ${jid} → ERROR: ${err?.message}`);
    }
  }
  process.exit(0);
}

async function runListGroups(sock) {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const entries = Object.values(groups);
    console.log(`[whatsapp] ${entries.length} grupo(s) donde participás:`);
    for (const g of entries) {
      if (listgroupsFilter && !String(g.subject || '').toLowerCase().includes(listgroupsFilter)) continue;
      console.log(`[whatsapp] --listgroups → jid=${g.id} · nombre="${g.subject}" · participantes=${g.participants?.length ?? '?'}`);
    }
  } catch (err) {
    console.error('[whatsapp] error listando grupos:', err?.message);
  } finally {
    process.exit(0);
  }
}

// ===== Canal de ESCRITURA (outbox file-based) =====
// Vigila WHATSAPP_OUTBOX_DIR por polling (1.5s). Cada <id>.json {jid,text} se
// envía con sock.sendMessage, se registra el resultado en WHATSAPP_SENT_DIR y
// se borra del outbox. Serial (un envío por tick) para no ráfaga-ar los
// servidores de WhatsApp — el envío automatizado es lo más vigilado por su
// anti-bot (ver riesgo de ban del PLAN-447).
let outboxBusy = false;
function startOutboxWatcher(sock) {
  fs.mkdirSync(WHATSAPP_OUTBOX_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(WHATSAPP_SENT_DIR, { recursive: true, mode: 0o700 });
  console.log('[whatsapp] canal de escritura activo (outbox):', WHATSAPP_OUTBOX_DIR);
  setInterval(() => { processOutbox(sock).catch((err) => console.error('[whatsapp] outbox:', err?.message)); }, 1500).unref();
}

// Arma el `content` de Baileys para un job del outbox. Soporta:
//  - texto:  { jid, text }                              → { text }
//  - media:  { jid, media:{ path, type, fileName?, mimetype?, caption? } }
//            type ∈ image|video|audio|document. El binario se lee del `path`
//            (archivo local, típicamente un adjunto que el usuario subió a la
//            consola: soporte de pago, etc.). Puede llevar `caption`.
function buildOutgoingContent(job) {
  if (job.media && job.media.path) {
    const m = job.media;
    const buffer = fs.readFileSync(m.path); // lanza si no existe → queda en el result.error
    const caption = m.caption || job.text || undefined;
    switch (m.type) {
      case 'image': return { image: buffer, caption };
      case 'video': return { video: buffer, caption };
      case 'audio': return { audio: buffer, mimetype: m.mimetype || 'audio/ogg; codecs=opus' };
      case 'document':
      default:
        return { document: buffer, fileName: m.fileName || path.basename(m.path), mimetype: m.mimetype || 'application/octet-stream', caption };
    }
  }
  if (typeof job.text !== 'string') throw new Error('job inválido: sin text ni media');
  return { text: job.text };
}

async function processOutbox(sock) {
  if (outboxBusy) return;
  const files = fs.readdirSync(WHATSAPP_OUTBOX_DIR).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return;
  outboxBusy = true;
  try {
    for (const f of files) {
      const full = path.join(WHATSAPP_OUTBOX_DIR, f);
      let job;
      try { job = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { fs.unlinkSync(full); continue; }
      const id = f.replace(/\.json$/, '');
      let result;
      try {
        if (!job.jid) throw new Error('job inválido: falta jid');
        const content = buildOutgoingContent(job);
        const sent = await sock.sendMessage(job.jid, content);
        result = { ok: true, id, jid: job.jid, messageId: sent?.key?.id || null, kind: job.media ? job.media.type : 'text', ts: Date.now() };
        console.log(`[whatsapp] enviado a ${job.jid}: ${job.media ? `📎 ${job.media.type} (${job.media.path})` : `"${(job.text || '').slice(0, 40)}"`}`);
      } catch (err) {
        result = { ok: false, id, jid: job.jid, error: err?.message || String(err), ts: Date.now() };
        console.error(`[whatsapp] fallo al enviar a ${job.jid}:`, err?.message);
      }
      try { writeJsonAtomic(path.join(WHATSAPP_SENT_DIR, `${id}.json`), result); } catch { /* best-effort */ }
      fs.unlinkSync(full);
    }
  } finally {
    outboxBusy = false;
  }
}

function shutdown() {
  console.log('[whatsapp] apagando…');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

setStatus('starting');
setInterval(() => setStatus(currentState), HEARTBEAT_MS).unref();

main().catch((err) => {
  console.error('[whatsapp] fallo al inicializar:', err?.message);
  setStatus('error', { error: err?.message || String(err) });
  process.exit(1);
});
