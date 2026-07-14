#!/usr/bin/env node
// bin/cwc-comms-send-runner.js — EJECUTOR desacoplado de envíos Desk/Teams del
// gateway del motor Comunicaciones (regla de oro). El endpoint/gateway escribe
// el job y spawnea esto; acá se EJECUTA el envío vía MCP (SDK), con ESCRITURA
// GOBERNADA (doble capa regla 6: hook PreToolUse + canUseTool con la allowlist
// del canal — permite SOLO los verbos de envío puntuales, todo lo demás
// denegado). Se registra en outbox y se persiste el resultado en el MISMO job.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import { settingSourcesFor } from '../src/core/sdk-settings.js';
import { appendOutbox, appendManual, readContacts, readSelf } from '../src/modules/comms/shared.js';
import {
  readSendJob, writeSendJobRaw, deskWriteAllowed, teamsWriteAllowed, SIGNATURE,
} from '../src/modules/comms/gateway-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, '[comms-send]', ...a);
const id = process.argv[2];
const TIMEOUT_MS = 4 * 60000;

function deskReplyPrompt(payload) {
  const n = String(payload.ticketNumber || '');
  return [
    `Publicá una respuesta en el ticket de Zoho Desk #${n}. Es una ESCRITURA autorizada`,
    `y gobernada: podés usar las tools desk_* de lectura para ubicar el ticket y`,
    `desk_add_comment / desk_update_ticket para publicar. NO uses ninguna otra tool.`,
    '',
    'Texto EXACTO a publicar (ya viene firmado, NO lo reescribas ni le saques la firma):',
    '"""',
    String(payload.text || ''),
    '"""',
    payload.status ? `Además, dejá el ticket en estado "${payload.status}".` : '',
    '',
    'Publicá la nota (visible al solicitante si se puede) con ese texto tal cual.',
    'Cuando termines respondé SOLO con un bloque ```json {"sent":true,"ticket":"' + n + '"} ``` (o {"sent":false,"error":"..."}).',
  ].filter(Boolean).join('\n');
}

function deskAutoUpdatePrompt(payload) {
  const n = String(payload.ticketNumber || '');
  return [
    `Se envió el PR interno #${payload.prNumber || '?'} (${payload.prUrl || ''}) con el fix del ticket de Zoho Desk #${n}.`,
    payload.ticketUrl ? `Ticket: ${payload.ticketUrl}` : '',
    '',
    'Tu ÚNICA tarea, usando las tools desk_* del MCP (lectura + desk_add_comment/desk_update_ticket):',
    '1. Buscá el ticket y verificá que sea ese.',
    '2. Ponelo en estado "On Hold" (o el equivalente que exista).',
    '3. Publicá una actualización EN INGLÉS, corta y humana (2 a 4 frases), para quien reportó: qué estaba fallando (en simple), que el arreglo ya está implementado y en revisión, y que se desplegará en los próximos días. Sin jerga interna, sin mencionar herramientas ni consolas. VISIBLE para el solicitante si se puede.',
    `   La nota SIEMPRE cierra con la firma exacta "${payload.signature || SIGNATURE}" en su propia línea: la API de Desk publica con otra identidad y el autor real tiene que quedar claro.`,
    '',
    'Referencia de lo arreglado (notas del PR):',
    String(payload.prBody || '').slice(0, 1500),
    '',
    'NO toques nada más. Cuando termines respondé SOLO con ```json {"sent":true,"detail":"<qué aplicaste>"} ``` (o {"sent":false,"error":"..."}).',
  ].filter(Boolean).join('\n');
}

function teamsDmPrompt(payload, contact, self) {
  const name = contact?.name || payload.contactId;
  const email = contact?.email ? ` (email ${contact.email})` : '';
  // BOT (kind:'bot' con chatId conocido, p.ej. Tolkien): enviar DIRECTO a ese
  // chatId — el graph_list_chats NO surface los chats con apps/bots (verificado
  // 2026-07-06), así que "ubicar el chat 1:1" fallaría. Mismo criterio que el
  // scan (teams-shared.js teamsBotPrompt).
  if (contact?.kind === 'bot' && contact?.chatId) {
    return [
      `Enviá un mensaje al chat de Microsoft Teams con id EXACTO "${contact.chatId}"`,
      `— es mi conversación con el BOT/APP "${name}". Es una ESCRITURA autorizada:`,
      `usá teams_send_message (o el send de Teams) con ESE chatId. NO uses ninguna`,
      `otra tool. NO envíes a ningún otro chat.`,
      '',
      'Texto EXACTO a enviar (ya viene firmado, no lo cambies):',
      '"""',
      String(payload.text || ''),
      '"""',
      '',
      'Cuando termines respondé SOLO con ```json {"sent":true} ``` (o {"sent":false,"error":"..."}).',
    ].join('\n');
  }
  return [
    `Enviá un mensaje directo (DM) de Microsoft Teams a "${name}"${email} DE PARTE de`,
    `${self?.name || 'mí'}. Es una ESCRITURA autorizada y gobernada: usá graph_* de lectura`,
    `para ubicar el chat 1:1 CONMIGO y con ${name}, y teams_send_message (o el send`,
    `de Teams) para enviar. NO uses ninguna otra tool. NO envíes a otro chat que no`,
    `sea el 1:1 entre ${self?.name || 'yo'} y ${name}.`,
    '',
    'Texto EXACTO a enviar (ya viene firmado, no lo cambies):',
    '"""',
    String(payload.text || ''),
    '"""',
    '',
    'Cuando termines respondé SOLO con ```json {"sent":true} ``` (o {"sent":false,"error":"..."}).',
  ].join('\n');
}

async function runSend(job) {
  const allowed = job.channel === 'desk' ? deskWriteAllowed : teamsWriteAllowed;
  const self = readSelf();
  const contact = readContacts().find((c) => c.id === job.contactId) || null;
  let prompt;
  if (job.channel === 'teams') prompt = teamsDmPrompt(job.payload, contact, self);
  else if (job.action === 'ticket_auto_update') prompt = deskAutoUpdatePrompt(job.payload);
  else prompt = deskReplyPrompt(job.payload);
  const denyMsg = `Envío ${job.channel}: solo las tools autorizadas del canal.`;
  const denyHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg } };
  const q = query({
    prompt,
    options: {
      cwd: config.projectDir,
      model: 'sonnet',
      maxTurns: 12,
      permissionMode: 'default',
      settingSources: settingSourcesFor('headless'),
      hooks: { PreToolUse: [{ hooks: [async (input) => (allowed(input.tool_name) ? {} : denyHook)] }] },
      canUseTool: async (name, input) => (allowed(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: denyMsg }),
    },
  });
  let out = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text; }
      else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {});
  try { await Promise.race([pump, timeout]); }
  finally { clearTimeout(timer); try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
  // Parseo del acuse
  let sent = false; let err = null;
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try { const j = JSON.parse(fence ? fence[1] : (out.match(/\{[\s\S]*\}/) || ['{}'])[0]); sent = j.sent === true; err = j.error || null; }
  catch { sent = /"?sent"?\s*:\s*true/i.test(out); }
  if (!sent) throw new Error(err || 'El modelo no confirmó el envío.');
  return { sent: true };
}

async function main() {
  if (!id) { log('falta id'); process.exit(1); return; }
  const job = readSendJob(id);
  if (!job) { log(`job ${id} inexistente`); process.exit(0); return; }
  try {
    const result = await runSend(job);
    writeSendJobRaw(id, { ...job, status: 'done', result, error: null, updatedAt: Date.now() });
    const to = job.payload?.ticketNumber ? `ticket #${job.payload.ticketNumber}` : (job.contactId || 'externo');
    appendOutbox({ channel: job.channel, action: job.action, to, ref: job.payload?.ticketNumber ? `ticket #${job.payload.ticketNumber}` : null, contactId: job.contactId, text: job.payload?.text || '', actor: job.actor, ok: true });
    if (job.contactId) { try { appendManual({ contactId: job.contactId, text: `→ [${job.channel}] ${String(job.payload?.text || '').slice(0, 300)}`, direction: 'out', channel: job.channel }); } catch { /* noop */ } }
    log(`OK job ${id} (${job.channel}/${job.action}).`);
  } catch (e) {
    writeSendJobRaw(id, { ...job, status: 'error', result: null, error: String(e?.message || e).slice(0, 300), updatedAt: Date.now() });
    appendOutbox({ channel: job.channel, action: job.action, to: job.contactId || 'externo', contactId: job.contactId, text: job.payload?.text || '', actor: job.actor, ok: false, error: String(e?.message || e).slice(0, 300) });
    log(`FAIL job ${id}:`, e?.message || e);
  }
}
main().catch((e) => { log('FALLO:', e?.message || e); process.exit(1); });
