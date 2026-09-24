// core/compact-memory.js — memoria durable antes/después de compactar una sesión.
//
// PreCompact sólo deja una marca determinística local. PostCompact aprovecha el
// resumen ya producido por el SDK, extrae del final del transcript la evidencia
// mínima útil y persiste primero a disco; Pad es siempre best-effort.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import {
  addComment,
  createItem,
  getItem,
  parseItemFields,
  searchItems,
  updateItem,
} from './pad-service-client.js';

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const SUMMARY_MAX_CHARS = 8000;
const PAD_TIMEOUT_MS = 4000;
const PAD_WORKSPACE = 'tolkien';
const PAD_COLLECTION = 'docs';
const memoryRoot = path.join(os.homedir(), '.cwc', 'compact-memory');

function safeSegment(value) {
  const clean = String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return clean || 'unknown-chat';
}

function sessionKey(value) {
  return String(value || '').trim() || 'unknown-session';
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function writeJson(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readTranscriptTail(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(transcriptPath, { start, encoding: 'utf8' });
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    let text = chunks.join('');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return { text, error: null };
  } catch (err) {
    return { text: '', error: String(err?.message || err).slice(0, 300) };
  }
}

function directUserText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function filesFromToolUse(block) {
  const found = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) found.add(value.trim());
  };
  add(block?.input?.file_path);
  add(block?.input?.path);
  if (Array.isArray(block?.input?.edits)) {
    for (const edit of block.input.edits) {
      add(edit?.file_path);
      add(edit?.path);
    }
  }
  return [...found];
}

function extractTranscriptFacts(text) {
  const fileCounts = new Map();
  let editOperations = 0;
  let lastUserMessage = '';

  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'tool_use' && /^(Edit|Write|MultiEdit)$/.test(String(value.name || ''))) {
      editOperations += 1;
      for (const file of filesFromToolUse(value)) {
        fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
      }
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'user') {
        const userText = directUserText(entry?.message?.content);
        if (userText) lastUserMessage = userText;
      }
      visit(entry);
    } catch {
      // Una línea parcial/corrupta no invalida el resto del tail.
    }
  }

  const files = [...fileCounts.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { files, editOperations, lastUserMessage };
}

function buildDigest({ at, number, trigger, chatId, sessionId, cwd, facts, summary, transcriptError }) {
  const files = facts.files.length
    ? facts.files.map(({ file, count }) => `- \`${file}\` — ${count} operación${count === 1 ? '' : 'es'}`).join('\n')
    : '- Ninguno detectado en los últimos 512 KB del transcript.';
  const userMessage = facts.lastUserMessage || '_No se encontró un mensaje de usuario con texto en la ventana leída._';
  const compactSummary = summary || '_El SDK no entregó un resumen compacto._';
  const readWarning = transcriptError
    ? `\n> Aviso: no se pudo leer el transcript: ${transcriptError}\n`
    : '';

  return [
    '# Memoria de compactación',
    '',
    `- Fecha: ${at}`,
    `- Compactación: #${number}`,
    `- Trigger: ${trigger}`,
    `- Session ID: ${sessionId}`,
    `- Chat ID: ${chatId}`,
    `- CWD: ${cwd}`,
    `- Operaciones de edición detectadas: ${facts.editOperations}`,
    readWarning,
    '## Archivos tocados',
    '',
    files,
    '',
    '## Último mensaje del usuario',
    '',
    userMessage,
    '',
    '## Resumen compacto',
    '',
    compactSummary,
  ].join('\n');
}

function padFields(record) {
  return {
    status: 'published',
    category: 'compact-memory',
    chat_id: record.chat_id,
    session_id: record.session_id,
    cwd: record.cwd,
    compaction_count: record.compaction_number,
    compacted_at: record.timestamp,
  };
}

function padTitle(sessionId) {
  return `Claude session ${sessionId}`;
}

function searchResults(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.results) ? data.results : [];
}

async function addDigestComment(ref, digest, opts) {
  opts.signal?.throwIfAborted();
  const comment = await addComment(ref, digest, opts);
  opts.signal?.throwIfAborted();
  if (!comment.ok) console.error('[compact-memory] Pad addComment falló:', comment.error);
}

async function persistExisting(item, record, opts) {
  opts.signal?.throwIfAborted();
  const fresh = await getItem(item.ref, opts);
  opts.signal?.throwIfAborted();
  let current = fresh.ok ? fresh.data : item;
  let update = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fields = { ...parseItemFields(current), ...padFields(record) };
    update = await updateItem(current.ref, {
      content: record.digest,
      fields,
    }, { ...opts, expectedUpdatedAt: current.updated_at });
    opts.signal?.throwIfAborted();
    if (update.ok) {
      await addDigestComment(current.ref, record.digest, opts);
      return;
    }
    if (update.code !== 'update_conflict' || attempt > 0) break;
    current = update.current || current;
  }

  if (update?.code === 'update_conflict') {
    console.error('[compact-memory] Pad siguió en conflicto; degrado a comentario append-only.');
  } else {
    console.error('[compact-memory] Pad update falló; degrado a comentario:', update?.error || 'error desconocido');
  }
  await addDigestComment(current.ref, record.digest, opts);
}

async function persistToPad(record, signal) {
  const opts = { workspace: PAD_WORKSPACE, signal };
  const title = padTitle(record.session_id);
  signal.throwIfAborted();
  const search = await searchItems(record.session_id, { ...opts, limit: 50 });
  signal.throwIfAborted();
  if (!search.ok) throw new Error(search.error || 'Pad search falló');
  const existing = searchResults(search.data).find((item) => (
    item?.title === title || parseItemFields(item).session_id === record.session_id
  ));

  if (existing) {
    await persistExisting(existing, record, opts);
    return;
  }

  const created = await createItem(PAD_COLLECTION, {
    title,
    content: record.digest,
    fields: padFields(record),
  }, opts);
  signal.throwIfAborted();
  if (!created.ok) throw new Error(created.error || 'Pad create falló');
}

async function withPadTimeout(record) {
  const signal = AbortSignal.timeout(PAD_TIMEOUT_MS);
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(new Error(`Pad timeout (${PAD_TIMEOUT_MS} ms)`));
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    await Promise.race([persistToPad(record, signal), aborted]);
  } finally {
    signal.removeEventListener('abort', abortListener);
  }
}

export function compactMemoryHook({ chatId, cwd, onWrite } = {}) {
  const normalizedChatId = String(chatId || '').trim() || 'unknown-chat';
  const chatDir = path.join(memoryRoot, safeSegment(normalizedChatId));
  const stateFile = path.join(chatDir, 'state.json');

  return {
    PreCompact: [{
      timeout: 5,
      hooks: [async (input) => {
        try {
          if (input?.agent_id) return {};
          const sid = sessionKey(input?.session_id);
          const state = readState(stateFile);
          if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};
          const previous = state.sessions[sid] || {};
          state.sessions[sid] = {
            ...previous,
            pending: {
              session_id: sid,
              trigger: String(input?.trigger || 'unknown'),
              timestamp: new Date().toISOString(),
              compaction_number: (Number(previous.compaction_count) || 0) + 1,
            },
          };
          writeJson(stateFile, state);
        } catch (err) {
          console.error('[compact-memory] PreCompact falló abierto:', err?.message || err);
        }
        return {};
      }],
    }],
    PostCompact: [{
      timeout: 20,
      hooks: [async (input) => {
        try {
          if (input?.agent_id) return {};
          const sid = sessionKey(input?.session_id);
          const at = new Date().toISOString();
          const state = readState(stateFile);
          if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};
          const previous = state.sessions[sid] || {};
          const pending = previous.pending?.session_id === sid ? previous.pending : null;
          const number = Number(pending?.compaction_number)
            || ((Number(previous.compaction_count) || 0) + 1);
          const transcript = await readTranscriptTail(input?.transcript_path);
          const facts = extractTranscriptFacts(transcript.text);
          const summary = String(input?.compact_summary || '').slice(0, SUMMARY_MAX_CHARS);
          const effectiveCwd = String(input?.cwd || cwd || '');
          const digest = buildDigest({
            at,
            number,
            trigger: String(input?.trigger || pending?.trigger || 'unknown'),
            chatId: normalizedChatId,
            sessionId: sid,
            cwd: effectiveCwd,
            facts,
            summary,
            transcriptError: transcript.error,
          });
          const record = {
            timestamp: at,
            chat_id: normalizedChatId,
            session_id: sid,
            cwd: effectiveCwd,
            trigger: String(input?.trigger || pending?.trigger || 'unknown'),
            compaction_number: number,
            transcript_path: String(input?.transcript_path || ''),
            transcript_error: transcript.error,
            files: facts.files,
            edit_operations: facts.editOperations,
            last_user_message: facts.lastUserMessage,
            compact_summary: summary,
            digest,
          };

          const snapshotFile = path.join(chatDir, `${Date.now()}.json`);
          writeJson(snapshotFile, record);
          state.sessions[sid] = { compaction_count: number, last_snapshot: snapshotFile, pending: null };
          writeJson(stateFile, state);
          try { onWrite?.({ file: snapshotFile, record }); } catch { /* observabilidad best-effort */ }

          try {
            await withPadTimeout(record);
          } catch (err) {
            console.error('[compact-memory] Pad falló; queda el JSON local:', err?.message || err);
          }
        } catch (err) {
          console.error('[compact-memory] PostCompact falló abierto:', err?.message || err);
        }
        return {};
      }],
    }],
  };
}
