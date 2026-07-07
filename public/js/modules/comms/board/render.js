// board/render.js — funciones puras estado→HTML del tablero de Comunicaciones.
// Un solo punto de re-render; nunca guarda estado (R1). Pestañas = contactos.
import { esc, fmtAgo } from './util.js';

let icon = null;
let refs = null;
export function initRender(deps) { icon = deps.icon; refs = deps.refs; }

export function render(state) {
  renderTabs(state);
  renderBody(state);
}

function counts(threads, contactId) {
  let nw = 0; let aw = 0; let tot = 0;
  for (const t of threads) {
    if (t.contactId !== contactId || t.archived) continue;
    tot += 1;
    if (t.newFromContact) nw += 1;
    if (t.awaitingReply) aw += 1;
  }
  return { nw, aw, tot };
}

function renderTabs(state) {
  if (!refs.tabs) return;
  const html = state.contacts.map((c) => {
    const k = counts(state.threads, c.id);
    const badge = k.nw
      ? `<span class="cm-badge cm-badge--new" title="mensajes nuevos">${k.nw}</span>`
      : (k.aw ? `<span class="cm-badge cm-badge--wait" title="sin respuesta">${k.aw}</span>` : '');
    return `<button class="bb-tab${state.tab === c.id ? ' on' : ''}" data-tab="${esc(c.id)}">${esc(c.name)} ${badge}<span class="bb-tab-n">${k.tot}</span></button>`;
  }).join('');
  refs.tabs.innerHTML = html || '<span class="cm-empty-inline">Sin contactos</span>';
}

const SRC = { github: ['🔀', 'GitHub'], teams: ['💬', 'Teams'], chatbot: ['🤖', 'Chatbot'], manual: ['✍️', 'Manual'] };
function srcBadge(source) {
  const x = SRC[source] || ['•', source || ''];
  return `<span class="cm-src cm-src--${esc(source || 'x')}" title="Fuente: ${esc(x[1])}">${x[0]}</span>`;
}

function dot(t) {
  if (t.newFromContact) return '<span class="cm-dot cm-dot--new" title="Mensaje nuevo del contacto"></span>';
  if (t.awaitingReply) return '<span class="cm-dot cm-dot--wait" title="Esperando respuesta del contacto"></span>';
  return '<span class="cm-dot cm-dot--idle" title="Al día"></span>';
}

function msgHtml(m, c) {
  const who = m.fromContact ? esc(c?.name || 'Contacto') : 'Yo';
  const cls = m.fromContact ? 'cm-msg--in' : 'cm-msg--out';
  return `<div class="cm-msg ${cls}"><div class="cm-msg-h">${who} · ${fmtAgo(m.ts)}</div><div class="cm-msg-b">${esc(String(m.text).slice(0, 1200))}</div></div>`;
}

const STATUS_CHIP = {
  'esperando-al-contacto': ['⏳', 'Pelota del contacto', 'cm-st--wait'],
  'esperando-a-mi': ['🟡', 'Pelota mía', 'cm-st--mine'],
  'resuelto': ['✅', 'Resuelto', 'cm-st--done'],
  'bloqueado': ['⛔', 'Bloqueado', 'cm-st--blocked'],
  'en-curso': ['🔵', 'En curso', 'cm-st--wip'],
};
const SENT = { positivo: '🙂', neutral: '😐', tenso: '😟' };

function selfIn(participants, self) {
  if (!Array.isArray(participants) || !participants.length || !self) return true; // sin datos: no marcar
  const em = String(self.email || '').toLowerCase();
  const nm = String(self.name || '').toLowerCase();
  const parts = nm.split(/\s+/).filter((w) => w.length > 3);
  return participants.some((p) => {
    const pe = String(p.email || '').toLowerCase();
    const pn = String(p.name || '').toLowerCase();
    if (em && pe && pe === em) return true;
    if (nm && pn && pn === nm) return true;
    return parts.length > 0 && parts.every((w) => pn.includes(w));
  });
}
function partsHtml(t, state) {
  if (!Array.isArray(t.participants) || !t.participants.length) return '';
  const names = t.participants.map((p) => esc(p.name || p.email || '?')).join(', ');
  const ok = selfIn(t.participants, state.self);
  const warn = ok ? '' : `<span class="cm-suspect" title="Este hilo no parece incluirte a vos">⚠️ no sos parte</span>`;
  return `<div class="cm-parts">${icon('search', { size: 11 })} Con: ${names} ${warn}</div>`;
}

function analysisHtml(t, state) {
  const a = state.analysis[t.id];
  if (!a) return '';
  if (a.status === 'running') return `<div class="cm-ai cm-ai--load">${icon('sparkle', { size: 13 })} Analizando el hilo…</div>`;
  if (a.status === 'error') return `<div class="cm-ai cm-ai--err">No se pudo analizar: ${esc(a.error || '')}</div>`;
  const d = a.data || {};
  const chip = STATUS_CHIP[d.status] || STATUS_CHIP['en-curso'];
  const projBtn = d.project ? `<button class="btn-ghost btn--xs" data-act="useproject" data-id="${esc(t.id)}" data-proj="${esc(d.project)}">Usar proyecto “${esc(d.project)}”</button>` : '';
  return `<div class="cm-ai">
    <div class="cm-ai-head">
      <span class="cm-st ${chip[2]}">${chip[0]} ${chip[1]}</span>
      ${d.topic ? `<span class="cm-ai-topic">${esc(d.topic)}</span>` : ''}
      <span class="cm-ai-sent" title="clima de la conversación">${SENT[d.sentiment] || ''}</span>
    </div>
    ${d.summary ? `<div class="cm-ai-sum">${esc(d.summary)}</div>` : ''}
    ${d.nextStep ? `<div class="cm-ai-next"><b>Próximo paso:</b> ${esc(d.nextStep)}</div>` : ''}
    ${projBtn ? `<div class="cm-ai-act">${projBtn}</div>` : ''}
  </div>`;
}

function threadHtml(t, state) {
  const c = state.contacts.find((x) => x.id === t.contactId);
  const open = state.expanded.has(t.id);
  const last = t.messages[t.messages.length - 1];
  const sub = last ? esc(String(last.text).replace(/\s+/g, ' ').slice(0, 90)) : '';
  const detail = open ? `
    <div class="cm-detail">
      ${partsHtml(t, state)}
      <div class="cm-msgs">${t.messages.map((m) => msgHtml(m, c)).join('')}</div>
      ${analysisHtml(t, state)}
      <div class="cm-actions">
        <button class="btn btn--sm" data-act="reply" data-id="${esc(t.id)}">${icon('play', { size: 13 })}<span>Responder</span></button>
        <button class="btn-ghost btn--sm" data-act="talk" data-id="${esc(t.id)}">${icon('sparkle', { size: 13 })}<span>Hablar de esto</span></button>
        <button class="btn-ghost btn--sm" data-act="analyze" data-id="${esc(t.id)}">${icon('search', { size: 13 })}<span>Analizar</span></button>
        ${t.url ? `<a class="btn-ghost btn--sm" href="${esc(t.url)}" target="_blank" rel="noopener">${icon('gitBranch', { size: 13 })}<span>Ver en GitHub</span></a>` : ''}
        <button class="btn-ghost btn--sm" data-act="project" data-id="${esc(t.id)}">${icon('folder', { size: 13 })}<span>Proyecto</span></button>
        ${t.newFromContact ? `<button class="btn-ghost btn--sm" data-act="seen" data-id="${esc(t.id)}">${icon('check', { size: 13 })}<span>Marcar visto</span></button>` : ''}
        <button class="btn-ghost btn--sm" data-act="archive" data-id="${esc(t.id)}" data-arch="${t.archived ? '0' : '1'}">${icon('archive', { size: 13 })}<span>${t.archived ? 'Restaurar' : 'Archivar'}</span></button>
      </div>
    </div>` : '';
  return `<div class="cm-thread${open ? ' on' : ''}">
    <div class="cm-thead" data-id="${esc(t.id)}">
      ${dot(t)}
      <div class="cm-tinfo"><div class="cm-ttitle">${srcBadge(t.source)} ${esc(t.title)}</div>${sub ? `<div class="cm-tsub">${sub}</div>` : ''}</div>
      <div class="cm-tmeta">${last ? fmtAgo(last.ts) : ''}</div>
      ${icon(open ? 'chevronDown' : 'chevronRight', { size: 14 })}
    </div>${detail}</div>`;
}

function renderBody(state) {
  if (!refs.body) return;
  if (state.loadError) { refs.body.innerHTML = '<div class="cm-empty">No se pudo cargar. Reintentá con el ↻.</div>'; return; }
  const c = state.contacts.find((x) => x.id === state.tab);
  if (!c) { refs.body.innerHTML = '<div class="cm-empty">Agregá un contacto para empezar.</div>'; return; }

  const list = state.threads.filter((t) => t.contactId === state.tab && (state.showArchived ? t.archived : !t.archived));
  // La sección "🤖 Chatbot" (Chris vía el bot Tolkien/TheEye en Teams) va aparte
  // de los grupos de proyecto y SIEMPRE se muestra en la vista activa (aunque
  // vacía). El resto se agrupa por proyecto como siempre.
  const chatbotList = list.filter((t) => t.source === 'chatbot');
  const rest = list.filter((t) => t.source !== 'chatbot');
  const groups = new Map();
  for (const t of rest) {
    const k = t.project || 'Sin proyecto';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const groupsHtml = [...groups.entries()].map(([proj, ts]) => `
    <details class="cm-group" open>
      <summary class="cm-gsum">${icon('folder', { size: 13 })} <span>${esc(proj)}</span> <span class="cm-gn">${ts.length}</span></summary>
      <div class="cm-glist">${ts.map((t) => threadHtml(t, state)).join('')}</div>
    </details>`).join('');

  const showChatbot = !state.showArchived || chatbotList.length > 0;
  const chatbotInner = chatbotList.length
    ? chatbotList.map((t) => threadHtml(t, state)).join('')
    : '<div class="cm-empty-inline">Sin comunicaciones del chatbot todavía. Llegan de Chris vía el bot Tolkien (TheEye) en Teams.</div>';
  const chatbotHtml = showChatbot ? `
    <details class="cm-group cm-group--bot" open>
      <summary class="cm-gsum">🤖 <span>Chatbot</span> <span class="cm-gn">${chatbotList.length}</span></summary>
      <div class="cm-glist">${chatbotInner}</div>
    </details>` : '';

  const head = `
    <div class="cm-chead">
      <div class="cm-chead-info">${esc(c.name)}${c.github ? ` · <span class="cm-gh">@${esc(c.github)}</span>` : ''}${c.kind === 'bot' ? ' <span class="cm-botbadge" title="Bot de Teams (no una persona)">🤖 bot</span>' : ''}</div>
      <div class="cm-chead-act">
        <button class="btn-ghost btn--sm" data-act="log">${icon('edit', { size: 13 })}<span>Registrar</span></button>
        <button class="btn-ghost btn--sm${state.showArchived ? ' on' : ''}" data-act="togglearch">${icon('archive', { size: 13 })}<span>${state.showArchived ? 'Ver activos' : 'Archivados'}</span></button>
      </div>
    </div>`;

  // Composer: ENVÍA un DM de Teams REAL a este contacto (queda registrado en
  // el hilo — ver A.sendMessage). El value sale del store para sobrevivir a un
  // re-render (el input escribe al store en cada tecla, sin emit). El botón se
  // deshabilita mientras hay un envío en vuelo.
  const draft = state.composer[c.id] || '';
  const sending = !!state.busy.send;
  const composer = `
    <div class="cm-composer">
      <textarea class="cm-composer-input" rows="2" placeholder="Escribir un mensaje a ${esc(c.name)} por Teams…" ${sending ? 'disabled' : ''}>${esc(draft)}</textarea>
      <div class="cm-composer-bar">
        <span class="cm-composer-hint">Envía por Teams con tu identidad · firma automática “— Nicolás (dev team)”</span>
        <button class="btn btn--sm" data-act="send" ${sending || !draft.trim() ? 'disabled' : ''}>${icon('play', { size: 13 })}<span>${sending ? 'Enviando…' : 'Enviar'}</span></button>
      </div>
    </div>`;

  const empty = state.showArchived
    ? '<div class="cm-empty">Sin comunicaciones archivadas.</div>'
    : '<div class="cm-empty">Sin comunicaciones todavía. Escaneá GitHub (↻) o registrá una a mano.</div>';
  const nothing = !chatbotHtml && rest.length === 0;
  refs.body.innerHTML = head + composer + chatbotHtml + (rest.length ? groupsHtml : '') + (nothing ? empty : '');
}
