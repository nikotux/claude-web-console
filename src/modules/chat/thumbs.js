// Miniaturas server-side para adjuntos del chat. Esta cola limita trabajo
// REQUEST-SCOPED, no es un job de fondo: si el server reinicia, las requests
// HTTP pendientes mueren y el navegador vuelve a pedirlas. No hay trabajo
// durable atado al proceso, por lo que cumple la Regla dura 2.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attachPath, chatAttachDir } from './attachments.js';

export const THUMB_DIR = '_thumbs';
const THUMB_PX = 360;
const WEBP_QUALITY = 70;
const SMALL_BYTES = 60 * 1024;
const MAX_RUNNING = 2;
const MAX_PENDING = 200;

let sharpP = null;
function loadSharp() {
  return sharpP ||= import('sharp').then((m) => {
    const s = m.default;
    s.concurrency(1);
    s.cache(false);
    return s;
  }).catch((e) => {
    console.warn('[chat-thumbs] sharp no disponible:', e.message);
    return null;
  });
}

export function thumbsEnabled() {
  return process.env.CWC_CHAT_THUMBS !== '0';
}

export function isThumbCandidate(name, size) {
  return /\.(?:png|jpe?g)$/i.test(String(name || ''))
    && Number.isFinite(size) && size >= SMALL_BYTES;
}

export function thumbNameFor(name, size, mtimeMs) {
  return `${crypto.createHash('sha1')
    .update(`${name}|${size}|${Math.floor(mtimeMs)}`)
    .digest('hex').slice(0, 20)}.webp`;
}

export function thumbFileFor(chatId, name) {
  const src = attachPath(chatId, name);
  const dir = chatAttachDir(chatId);
  if (!src || !dir) return null;
  try {
    const stat = fs.statSync(src);
    if (!stat.isFile() || !isThumbCandidate(name, stat.size)) return null;
    return {
      src,
      dst: path.join(dir, THUMB_DIR, thumbNameFor(name, stat.size, stat.mtimeMs)),
      size: stat.size,
    };
  } catch {
    return null;
  }
}

export async function generateThumbFile(absSrc, absDst) {
  const sharp = await loadSharp();
  if (!sharp) return false;
  const tmp = `${absDst}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(absDst), { recursive: true, mode: 0o700 });
    await sharp(absSrc, { animated: false })
      .rotate()
      .resize(THUMB_PX, THUMB_PX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(tmp);
    fs.renameSync(tmp, absDst);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    return false;
  }
}

const pending = [];
const inFlight = new Map();
let running = 0;

function pump() {
  while (running < MAX_RUNNING && pending.length) {
    const job = pending.shift();
    running += 1;
    (async () => {
      let result = null;
      try {
        if (!job.signal?.aborted) {
          if (fs.existsSync(job.src.dst) || await generateThumbFile(job.src.src, job.src.dst)) {
            result = job.src.dst;
          }
        }
      } catch { /* degradar al original */ }
      finally {
        running -= 1;
        if (inFlight.get(job.src.dst) === job.promise) inFlight.delete(job.src.dst);
        job.resolve(result);
        pump();
      }
    })();
  }
}

export function ensureThumb(chatId, name, { signal } = {}) {
  if (!thumbsEnabled()) return Promise.resolve(null);
  const src = thumbFileFor(chatId, name);
  if (!src) return Promise.resolve(null);
  if (fs.existsSync(src.dst)) return Promise.resolve(src.dst);
  const active = inFlight.get(src.dst);
  if (active) return active;
  if (running >= MAX_RUNNING && pending.length >= MAX_PENDING) return Promise.resolve(null);

  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  inFlight.set(src.dst, promise);
  pending.push({ src, signal, promise, resolve });
  pump();
  return promise;
}

export function _queueStats() {
  return { running, pending: pending.length, inFlight: inFlight.size };
}
