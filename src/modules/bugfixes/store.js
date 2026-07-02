// modules/bugfixes/store.js — registro de fixes propuestos en chats de tickets.
//
// Cada conversación nacida de un bug de Desk ("Trabajar en Chat" del módulo
// tickets) deja acá, al CERRARSE, un registro de qué hay que cambiar en el
// código: resumen (último texto del asistente) + archivos tocados (Edit/Write
// del transcript). El registro alimenta el botón "Subir PR" de la pestaña
// Salud (module index.js) y el scan retroactivo de chats viejos.
//
// Clave natural = sessionId (un transcript, un registro). Estados:
//   pendiente -> subido (branch+PR creados)
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../../core/claude-model.js';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const FILE = path.join(DATA_DIR, 'bugfixes.json');
// Dos contextos EDITABLES, cada uno con su dueño en la UI:
//  - 'work' (módulo Bugs, botón Contexto de la vista expandida): CÓMO se
//    trabaja un bug — verificación previa, proceso, no enviar el PR.
//  - 'pr' (modal Enviar PR, botón Contexto): CÓMO se redactan los cambios
//    que van a las notas del PR (el formato del cierre del chat, que después
//    parsea formatPrBody).
// Ambos se inyectan en el prompt de cada "Trabajar en Chat".
const CONTEXT_FILES = {
  work: path.join(DATA_DIR, 'bugfix-context.md'),
  pr: path.join(DATA_DIR, 'bugfix-pr-context.md'),
};

export const DEFAULT_CONTEXTS = {
  work: [
    'ANTES de tocar nada — verificación exhaustiva:',
    '1. Estado del ticket: ¿sigue abierto? ¿cambió su status o alguien ya lo',
    '   cerró? Revisá el ticket y su hilo en Desk (desk_get_ticket).',
    '2. ¿Chris (cswenor) ya está trabajando en esto? Puede NO actualizar el',
    '   ticket: buscá PRs abiertos y branches/commits recientes relacionados',
    '   (gh pr list --state all, git log) antes de duplicar trabajo.',
    '',
    'Proceso de resolución — mostrámelo explícito en la conversación:',
    '- CUÁL ES EL PROBLEMA: explicalo en criollo, con la causa raíz.',
    '- QUÉ PODEMOS HACER: las opciones de arreglo.',
    '- ANTES de implementar: evaluá si la opción elegida es LA MEJOR solución',
    '  posible o si hay una alternativa superior; decímelo y esperá mi OK.',
    '',
    'NUNCA envíes el PR desde esta conversación (nada de git push ni gh pr',
    'create): el PR se sube después desde el módulo "Enviar PR" de la consola.',
  ].join('\n'),
  pr: [
    'Cómo se redactan los cambios que van al PR (las notas que lee Chris):',
    '- Formales, claras y concisas; sin jerga interna ni referencias a esta',
    '  consola. Cada afirmación tiene que poder verificarse en el diff.',
    '- Al FINALIZAR la resolución, tu ÚLTIMO mensaje del chat debe tener',
    '  EXACTAMENTE este formato (es lo que se convierte en las notas del PR):',
    'Problema: <una o dos líneas: qué estaba roto y su causa raíz>',
    'Qué hice: <qué se cambió y en qué archivos, sin rodeos>',
    'Mejor solución: <por qué esto es la mejor solución posible, o qué alternativa se descartó y por qué>',
  ].join('\n'),
};

export function getContext(kind = 'work') {
  try { return fss.readFileSync(CONTEXT_FILES[kind], 'utf8'); } catch { return DEFAULT_CONTEXTS[kind]; }
}

export function saveContext(kind, text) {
  if (!CONTEXT_FILES[kind]) throw new Error(`Contexto desconocido: ${kind}`);
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fss.writeFileSync(CONTEXT_FILES[kind], String(text).slice(0, 20000), { mode: 0o600 });
}

// Prompt de tickets.js: "Trabajemos el bug del ticket Desk #<n>." — sin '.'
// en la captura: el punto final de la oración no es parte del número.
const TICKET_RE = /ticket Desk #([\w-]+)/i;
const BROKE_RE = /^Qué se rompió:\s*(.+)$/m;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function listBugfixes() {
  try { return JSON.parse(fss.readFileSync(FILE, 'utf8')); } catch { return []; }
}

export function saveBugfixes(all) {
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fss.writeFileSync(FILE, JSON.stringify(all, null, 1), { mode: 0o600 });
}

function transcriptPath(cwdAbs, sessionId) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwdAbs), `${sessionId}.jsonl`);
}

// Recorre el transcript y saca lo que necesita el registro:
//   files   — rutas RELATIVAS al cwd tocadas por herramientas de edición
//   summary — último texto sustancial del asistente (el cierre suele resumir
//             qué se cambió / qué habría que cambiar)
//   firstUser / ticketNumber / whatBroke — para el scan retroactivo
export function extractFromTranscript(cwdAbs, sessionId) {
  let raw;
  try { raw = fss.readFileSync(transcriptPath(cwdAbs, sessionId), 'utf8'); } catch { return null; }
  const files = new Set();
  let summary = '';
  let lastText = '';
  let firstUser = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
    if (o.type === 'user' && o.message?.role === 'user' && !firstUser) {
      const text = typeof o.message.content === 'string' ? o.message.content
        : blocks.find((b) => b.type === 'text')?.text || '';
      if (text.trim() && !text.startsWith('<')) firstUser = text;
    }
    if (o.type !== 'assistant') continue;
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) {
        lastText = b.text.trim();
        if (lastText.length >= 40) summary = lastText;
      }
      if (b.type === 'tool_use' && EDIT_TOOLS.has(b.name)) {
        const abs = b.input?.file_path || b.input?.notebook_path;
        if (!abs) continue;
        const rel = path.relative(cwdAbs, String(abs));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) files.add(rel);
      }
    }
  }
  const ticket = firstUser.match(TICKET_RE);
  return {
    files: [...files],
    summary: (summary || lastText).slice(0, 4000),
    firstUser,
    ticketNumber: ticket ? ticket[1] : null,
    whatBroke: (firstUser.match(BROKE_RE)?.[1] || '').slice(0, 200),
  };
}

// Alta/actualización del registro para una conversación (al cerrar el chat o
// desde el scan). Re-extrae siempre: un chat puede cerrarse más de una vez y
// el transcript solo crece. No pisa un estado 'subido'.
export function recordBugfix({ cwd, sessionId, chatId = null, ticket = null, title = null }) {
  if (!sessionId) return null;
  const ex = extractFromTranscript(cwd, sessionId);
  if (!ex) return null;
  const all = listBugfixes();
  const prev = all.find((b) => b.sessionId === sessionId);
  const entry = {
    ...(prev || {}), // conserva los campos de PR (prNumber/prState/mergedBy/sentAt…)
    sessionId,
    chatId: chatId || prev?.chatId || null,
    cwd,
    ticketNumber: ticket?.number || prev?.ticketNumber || ex.ticketNumber || null,
    ticketUrl: ticket?.url || prev?.ticketUrl || null,
    title: (title || prev?.title || (ex.whatBroke ? `TKT #${ex.ticketNumber || '?'} — ${ex.whatBroke}` : `Fix ${sessionId.slice(0, 8)}`)).slice(0, 120),
    summary: ex.summary || prev?.summary || '',
    files: ex.files.length ? ex.files : (prev?.files || []),
    status: prev?.status === 'subido' ? 'subido' : 'pendiente',
    branch: prev?.branch || null,
    prUrl: prev?.prUrl || null,
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  const rest = all.filter((b) => b.sessionId !== sessionId);
  saveBugfixes([entry, ...rest]);
  return entry;
}

// Scan retroactivo: transcripts del cwd cuyo PRIMER mensaje tiene el patrón
// de ticket de Desk y que no están en el registro -> se registran. Además
// RE-extrae los ya registrados que siguen 'pendiente' (auto-reparación: un
// close en plena escritura del transcript, o un chat retomado y re-trabajado,
// actualizan resumen/archivos acá).
export function scanUnregistered(cwdAbs) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwdAbs));
  let files = [];
  try { files = fss.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return { scanned: 0, added: [] }; }
  const known = new Set(listBugfixes().map((b) => b.sessionId));
  const added = [];
  for (const f of files) {
    const sessionId = f.replace(/\.jsonl$/, '');
    if (known.has(sessionId)) continue;
    const ex = extractFromTranscript(cwdAbs, sessionId);
    if (!ex?.ticketNumber) continue; // no nació de un ticket
    const entry = recordBugfix({ cwd: cwdAbs, sessionId });
    if (entry) added.push(entry);
  }
  const justAdded = new Set(added.map((b) => b.sessionId));
  for (const b of listBugfixes()) {
    if (b.status === 'pendiente' && b.cwd === cwdAbs && !justAdded.has(b.sessionId)) {
      recordBugfix({ cwd: cwdAbs, sessionId: b.sessionId });
    }
  }
  return { scanned: files.length, added };
}
