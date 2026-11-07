// Helpers puros para volver a asociar los bloques base64 del transcript con
// los archivos materializados en el escritorio persistente del chat.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chatAttachDir, classifyAttachment } from './attachments.js';

const SAMPLE_BYTES = 48;
const CACHE_MAX = 200;
const replayCache = new Map();
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};

export function imageFingerprint(base64) {
  if (typeof base64 !== 'string' || base64.length % 4 !== 0) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if (padding > 2 || base64.slice(0, base64.length - padding).includes('=')) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const size = (base64.length / 4) * 3 - padding;
  const offsets = [
    0,
    Math.floor(size / 2 / 3) * 3,
    Math.max(0, Math.floor((size - SAMPLE_BYTES) / 3) * 3),
  ];
  const samples = [];
  for (const offset of new Set(offsets)) {
    const charOffset = (offset / 3) * 4;
    const length = Math.max(0, Math.min(SAMPLE_BYTES, size - offset));
    const bytes = Buffer.from(base64.slice(charOffset, charOffset + 64), 'base64').subarray(0, length);
    samples.push({ offset, bytes });
  }
  return { size, samples };
}

export function toolImagePrefix(toolUseId) {
  // Debe ser idéntico al saneado de saveToolImages en bin/cwc-chat-runner.js.
  return `asst-${String(toolUseId || 'tool').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'tool'}-`;
}

function indexFor(dir) {
  if (!dir) return null;
  let dirStat;
  try { dirStat = fs.statSync(dir); } catch { return null; }
  if (!dirStat.isDirectory()) return null;

  const cached = replayCache.get(dir);
  if (cached && cached.mtimeMs === dirStat.mtimeMs) {
    replayCache.delete(dir);
    replayCache.set(dir, cached);
    return cached.index;
  }

  const index = new Map();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const stat = fs.statSync(abs);
    const list = index.get(stat.size) || [];
    list.push({ name: entry.name, mtimeMs: stat.mtimeMs });
    index.set(stat.size, list);
  }
  replayCache.delete(dir);
  replayCache.set(dir, { mtimeMs: dirStat.mtimeMs, index });
  while (replayCache.size > CACHE_MAX) replayCache.delete(replayCache.keys().next().value);
  return index;
}

function samplesMatch(abs, fp) {
  const fd = fs.openSync(abs, 'r');
  try {
    for (const sample of fp.samples) {
      const got = Buffer.alloc(sample.bytes.length);
      const read = fs.readSync(fd, got, 0, got.length, sample.offset);
      if (read !== got.length || !got.equals(sample.bytes)) return false;
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function mimeFor(kind, name) {
  if (kind === 'pdf') return 'application/pdf';
  return EXT_MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
}

export function resolveReplayFiles(chatId, items, { dir: explicitDir } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!chatId) return list.map(() => null);
  let index;
  let dir;
  try {
    dir = explicitDir !== undefined ? explicitDir : chatAttachDir(chatId);
    index = indexFor(dir);
  } catch {
    return list.map(() => null);
  }
  if (!dir || !index) return list.map(() => null);

  return list.map((item) => {
    try {
      if (!item?.fp || !Number.isFinite(item.fp.size)
          || (item.kind !== 'image' && item.kind !== 'pdf')) return null;
      const candidates = (index.get(item.fp.size) || [])
        .filter((candidate) => classifyAttachment('', candidate.name) === item.kind)
        .sort((a, b) => Number(b.name.startsWith(item.prefix || '\0')) - Number(a.name.startsWith(item.prefix || '\0')));
      const matches = [];
      for (const candidate of candidates) {
        if (samplesMatch(path.join(dir, candidate.name), item.fp)) matches.push(candidate);
      }
      let match = matches.length === 1 ? matches[0] : null;
      if (matches.length > 1 && typeof item.base64Getter === 'function') {
        const wanted = sha256(Buffer.from(item.base64Getter(), 'base64'));
        match = matches.find((candidate) => sha256(fs.readFileSync(path.join(dir, candidate.name))) === wanted) || null;
      } else if (matches.length > 1 && item.prefix) {
        match = matches.find((candidate) => candidate.name.startsWith(item.prefix)) || null;
      }
      return match ? { name: match.name, mime: mimeFor(item.kind, match.name) } : null;
    } catch {
      return null;
    }
  });
}

export function _clearReplayCache() {
  replayCache.clear();
}
