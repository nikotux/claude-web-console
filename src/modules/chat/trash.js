// Papelera de conversaciones cerradas: conserva durante 30 días una COPIA del
// transcript, los adjuntos y su metadata. Nunca mueve ni borra los originales;
// restaurar solo repone lo que ya no exista. La purga corre al arrancar y al
// listar, sin timers, para respetar el ciclo de vida simple del server.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { userDataDir, hostUser } from '../../core/user-space.js';

export const CHAT_TRASH_TTL_DAYS = 30;
const TTL_MS = 30 * 86400000;
const MAX_ATTACH_BYTES = 200 * 1024 * 1024;
const IDEMPOTENCY_MS = 5 * 60 * 1000;
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// La ruta se deriva en cada operación: nunca se cachea porque depende del dueño.
function trashDir(owner) {
  return path.join(userDataDir(owner || hostUser()), 'chat-trash');
}

function indexPath(owner) {
  return path.join(trashDir(owner), 'index.json');
}

function readIndex(owner) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(owner), 'utf8'));
    return { items: Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

function writeIndex(owner, items) {
  writeJsonAtomic(indexPath(owner), { items });
}

function itemDir(owner, trashId) {
  if (!SAFE_ID_RE.test(String(trashId || ''))) return null;
  return path.join(trashDir(owner), trashId);
}

function writeMeta(owner, meta) {
  const dir = itemDir(owner, meta?.trashId);
  if (!dir) return;
  writeJsonAtomic(path.join(dir, 'meta.json'), meta);
}

function recursiveSize(dir, limit = Infinity) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) total += recursiveSize(entryPath, limit - total);
    else total += fs.lstatSync(entryPath).size;
    if (total > limit) return total;
  }
  return total;
}

function transcriptCopyPath(owner, meta) {
  const dir = itemDir(owner, meta?.trashId);
  if (!dir || typeof meta?.transcriptPath !== 'string' || !meta.transcriptPath) return null;
  return path.join(dir, 'transcript', path.basename(meta.transcriptPath));
}

function persistMetaAndIndex(owner, meta, items) {
  writeMeta(owner, meta);
  writeIndex(owner, items);
}

export function trashChat({
  chatId, owner, title, cwd, sessionId, packageRef, model, permissionMode,
  ticket, transcriptPath, attachDir,
}) {
  if (!SAFE_ID_RE.test(String(chatId || ''))) return null;

  try {
    const now = Date.now();
    const index = readIndex(owner);
    const existing = index.items.find((item) => (
      item?.chatId === chatId
      && SAFE_ID_RE.test(String(item?.trashId || ''))
      && Number.isFinite(Number(item?.deletedAt))
      && now - Number(item.deletedAt) < IDEMPOTENCY_MS
    ));
    if (existing) return existing.trashId;

    const trashId = randomUUID();
    const dir = itemDir(owner, trashId);
    if (!dir) return null;

    const meta = {
      trashId,
      chatId,
      owner: owner || hostUser(),
      deletedAt: now,
      title: title || null,
      cwd: cwd || null,
      sessionId: sessionId || null,
      packageRef: packageRef || null,
      model: model || null,
      permissionMode: permissionMode || null,
      ticket: ticket || null,
      transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : null,
      attachDir: typeof attachDir === 'string' ? attachDir : null,
      hasTranscript: false,
      hasAttachments: false,
      attachmentsSkipped: false,
    };

    // El registro durable se escribe antes de intentar cualquier copia.
    fs.mkdirSync(dir, { recursive: true });
    index.items.push(meta);
    persistMetaAndIndex(owner, meta, index.items);

    try {
      if (meta.transcriptPath && fs.existsSync(meta.transcriptPath)) {
        const dest = transcriptCopyPath(owner, meta);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(meta.transcriptPath, dest);
        meta.hasTranscript = true;
        persistMetaAndIndex(owner, meta, index.items);
      }
    } catch (err) {
      console.error('[chat-trash] no pude copiar el transcript:', err?.message);
    }

    try {
      if (meta.attachDir && fs.existsSync(meta.attachDir) && fs.statSync(meta.attachDir).isDirectory()) {
        const bytes = recursiveSize(meta.attachDir, MAX_ATTACH_BYTES);
        if (bytes > MAX_ATTACH_BYTES) {
          meta.attachmentsSkipped = true;
        } else {
          fs.cpSync(meta.attachDir, path.join(dir, 'attachments'), { recursive: true });
          meta.hasAttachments = true;
        }
        persistMetaAndIndex(owner, meta, index.items);
      }
    } catch (err) {
      console.error('[chat-trash] no pude copiar los adjuntos:', err?.message);
    }

    return trashId;
  } catch (err) {
    console.error('[chat-trash] no pude copiar la conversación a la papelera:', err?.message);
    return null;
  }
}

export function listChatTrash(owner) {
  autoPurgeChatTrash(owner);
  const index = readIndex(owner);
  let repaired = false;

  for (const meta of index.items) {
    if (meta?.hasTranscript !== false || typeof meta?.transcriptPath !== 'string') continue;
    if (!SAFE_ID_RE.test(String(meta?.trashId || '')) || !fs.existsSync(meta.transcriptPath)) continue;
    try {
      const dest = transcriptCopyPath(owner, meta);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(meta.transcriptPath, dest);
      meta.hasTranscript = true;
      writeMeta(owner, meta);
      repaired = true;
    } catch (err) {
      console.error('[chat-trash] no pude reparar el transcript pendiente:', err?.message);
    }
  }
  if (repaired) {
    try { writeIndex(owner, index.items); }
    catch (err) { console.error('[chat-trash] no pude guardar la reparación:', err?.message); }
  }

  const now = Date.now();
  return index.items
    .map((meta) => {
      const expiresAt = Number(meta.deletedAt) + TTL_MS;
      return {
        id: meta.trashId,
        chatId: meta.chatId,
        title: meta.title,
        cwd: meta.cwd,
        sessionId: meta.sessionId,
        deletedAt: meta.deletedAt,
        expiresAt,
        daysLeft: Math.max(0, Math.ceil((expiresAt - now) / 86400000)),
        hasTranscript: meta.hasTranscript,
        hasAttachments: meta.hasAttachments,
        attachmentsSkipped: meta.attachmentsSkipped,
        packageRef: meta.packageRef,
        model: meta.model,
        permissionMode: meta.permissionMode,
        ticket: meta.ticket,
      };
    })
    .sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt));
}

export function restoreChatTrash(id, owner) {
  if (!SAFE_ID_RE.test(String(id || ''))) return null;
  const index = readIndex(owner);
  const meta = index.items.find((item) => item?.trashId === id);
  if (!meta) return null;

  try {
    if (typeof meta.transcriptPath === 'string' && !fs.existsSync(meta.transcriptPath)) {
      const src = transcriptCopyPath(owner, meta);
      if (src && fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(meta.transcriptPath), { recursive: true });
        fs.copyFileSync(src, meta.transcriptPath);
      }
    }

    const dir = itemDir(owner, id);
    const attachmentsCopy = dir ? path.join(dir, 'attachments') : null;
    if (
      typeof meta.attachDir === 'string'
      && !fs.existsSync(meta.attachDir)
      && attachmentsCopy
      && fs.existsSync(attachmentsCopy)
    ) {
      fs.mkdirSync(path.dirname(meta.attachDir), { recursive: true });
      fs.cpSync(attachmentsCopy, meta.attachDir, { recursive: true });
    }

    const remaining = index.items.filter((item) => item?.trashId !== id);
    fs.rmSync(dir, { recursive: true, force: true });
    writeIndex(owner, remaining);
    return {
      sessionId: meta.sessionId || null,
      cwd: meta.cwd || null,
      title: meta.title || null,
      model: meta.model || null,
      permissionMode: meta.permissionMode || null,
      ticket: meta.ticket || null,
    };
  } catch (err) {
    console.error('[chat-trash] no pude restaurar la conversación:', err?.message);
    return null;
  }
}

export function purgeChatTrash(id, owner) {
  if (!SAFE_ID_RE.test(String(id || ''))) return false;
  const index = readIndex(owner);
  if (!index.items.some((item) => item?.trashId === id)) return false;

  try {
    fs.rmSync(itemDir(owner, id), { recursive: true, force: true });
    writeIndex(owner, index.items.filter((item) => item?.trashId !== id));
    return true;
  } catch (err) {
    console.error('[chat-trash] no pude purgar la conversación:', err?.message);
    return false;
  }
}

export function autoPurgeChatTrash(owner) {
  const index = readIndex(owner);
  const now = Date.now();
  const remaining = [];
  let purged = 0;

  for (const meta of index.items) {
    if (now - Number(meta?.deletedAt) <= TTL_MS) {
      remaining.push(meta);
      continue;
    }
    const dir = itemDir(owner, meta?.trashId);
    if (!dir) {
      remaining.push(meta);
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      purged += 1;
    } catch {
      remaining.push(meta);
    }
  }

  if (purged) {
    try { writeIndex(owner, remaining); }
    catch (err) {
      console.error('[chat-trash] no pude actualizar el índice de purga:', err?.message);
      return 0;
    }
  }
  return purged;
}

// Purga las papeleras de TODOS los usuarios (host + inquilinos). Se llama al
// arrancar el módulo: un usuario que nunca abre su papelera igual queda purgado.
export function autoPurgeAllChatTrash(owners) {
  let purged = 0;
  for (const owner of new Set(Array.isArray(owners) ? owners.filter(Boolean) : [])) {
    try {
      purged += autoPurgeChatTrash(owner);
    } catch (err) {
      console.error(`[chat-trash] no pude purgar la papelera de ${owner}:`, err?.message);
    }
  }
  return purged;
}
