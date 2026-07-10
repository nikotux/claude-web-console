// ui/interfono-center.js — centro GLOBAL de interfono: popups flotantes con
// los mensajes de OTRAS sesiones de Claude Code que están esperando ser
// tomados por un chat, visibles desde cualquier pantalla (gemelo de
// ui/perm-center.js). Pedido del usuario 2026-07-06: el chat visual es la
// superficie principal de trabajo y una TUI es backup; una TUI recibe el
// mensaje por un "nudge" (send-keys) que la despierta en vivo, pero un chat
// del SDK solo lo "ve" al tomar un turno. Este centro cierra esa brecha:
//   • el server AUTO-ENTREGA el mensaje a los chats abiertos+ociosos (watcher
//     de src/modules/chat/index.js — paridad con el nudge idle de la TUI);
//   • este popup surfacea SIEMPRE los pendientes (poll de 8 s de /api/chat/list,
//     campo pendingInterfono[] por chat) y ofrece:
//       ▶ Retomar  → POST /api/chat/interfono {action:'deliver'} (inyecta el
//                    mensaje como turno; DESPIERTA el chat si está dormido)
//       ✕ Descartar→ POST /api/chat/interfono {action:'dismiss'} (marca
//                    entregado sin actuar; limpia el aviso)
// Una tarjeta por CHAT (agrupa sus mensajes pendientes). Se suprime la del
// chat ACTIVO (si está abierto+ocioso el watcher lo inyecta solo, y aparece
// como burbuja en la conversación).
import { icon } from './icons.js';

export function initInterfonoCenter({ isChatActive, isChatRelevant, openChat }) {
  // isChatRelevant(chatId) — ¿ESTA ventana tiene ese chat abierto? (Fase 1). Si
  // no se pasa (compat), todo es relevante (comportamiento viejo).
  const relevant = typeof isChatRelevant === 'function' ? isChatRelevant : () => true;
  const stack = document.createElement('div');
  stack.className = 'cwc-intercom';
  stack.hidden = true;
  document.body.appendChild(stack);

  const items = new Map(); // chatId -> { el, chatId, busy, sig }

  // ===== Tarjeta (una por chat) =====
  function upsert(chatId, title, pend) {
    if (!chatId || !pend?.length) return;
    const sig = pend.map((m) => m.id).join(',');
    let item = items.get(chatId);
    if (item) {
      if (item.sig !== sig) { item.sig = sig; fillBody(item, title, pend); }
      else setTitle(item, title);
      return;
    }
    const el = document.createElement('div');
    el.className = 'ic-card';
    el.innerHTML = `
      <button type="button" class="ic-title" title="Ir a la conversación">
        ${icon('relay', { size: 13 })}<span class="ic-title-text"></span><span class="ic-count"></span>
      </button>
      <div class="ic-body"></div>
      <div class="ic-actions">
        <button class="btn-ghost btn--sm ic-dismiss">${icon('close', { size: 13 })} Descartar</button>
        <button class="btn btn--sm ic-resume">${icon('play', { size: 13 })} Retomar</button>
      </div>
      <div class="ic-error" hidden></div>`;
    item = { el, chatId, busy: false, sig };
    fillBody(item, title, pend);
    el.querySelector('.ic-title').addEventListener('click', () => openChat(chatId));
    el.querySelector('.ic-dismiss').addEventListener('click', () => act(item, 'dismiss'));
    el.querySelector('.ic-resume').addEventListener('click', () => act(item, 'deliver'));
    items.set(chatId, item);
    stack.appendChild(el);
    render();
  }

  function setTitle(item, title) {
    // title undefined (evento en vivo de Fase 3) => conservar el que ya puso el
    // poll; solo caemos a chatId si nunca hubo título.
    const el = item.el.querySelector('.ic-title-text');
    if (title == null) { if (!el.textContent) el.textContent = item.chatId; return; }
    el.textContent = String(title || item.chatId);
  }

  const MAX_MSGS = 50; // tope de nodos DOM por tarjeta (dato externo sin cota)

  function fillBody(item, title, pend) {
    setTitle(item, title);
    item.el.querySelector('.ic-count').textContent = pend.length > 1 ? ` ·${pend.length}` : '';
    const body = item.el.querySelector('.ic-body');
    body.textContent = '';
    // Acotamos los mensajes renderizados: una sesión inactiva puede acumular
    // muchos avisos sin cota. Mostramos los más recientes con aviso de resto,
    // mismo patrón que diff.js/markdown.js.
    const overflow = pend.length > MAX_MSGS;
    const shown = overflow ? pend.slice(-MAX_MSGS) : pend;
    if (overflow) {
      const more = document.createElement('div');
      more.className = 'ic-msg ic-more';
      more.textContent = `… +${pend.length - MAX_MSGS} mensaje(s) más`;
      body.appendChild(more);
    }
    for (const m of shown) {
      const row = document.createElement('div');
      row.className = 'ic-msg';
      const from = document.createElement('strong');
      from.className = 'ic-from';
      from.textContent = `${m.fromName || 'una sesión'}: `;
      const txt = document.createElement('span');
      txt.textContent = String(m.text || '');
      row.appendChild(from);
      row.appendChild(txt);
      body.appendChild(row);
    }
  }

  async function act(item, action) {
    if (item.busy) return;
    item.busy = true;
    for (const b of item.el.querySelectorAll('.ic-dismiss, .ic-resume')) b.disabled = true;
    try {
      const res = await fetch('/api/chat/interfono', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.chatId, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo procesar el mensaje.');
      remove(item.chatId);
    } catch (err) {
      item.busy = false;
      for (const b of item.el.querySelectorAll('.ic-dismiss, .ic-resume')) b.disabled = false;
      const errEl = item.el.querySelector('.ic-error');
      errEl.textContent = String(err.message);
      errEl.hidden = false;
    }
  }

  function remove(chatId) {
    const item = items.get(chatId);
    if (!item) return;
    items.delete(chatId);
    item.el.remove();
    render();
  }

  // ===== Render / supresión =====
  function render() {
    let visible = 0;
    for (const item of items.values()) {
      const hide = isChatActive(item.chatId); // se inyecta solo / aparece como burbuja
      item.el.hidden = hide;
      if (!hide) visible += 1;
    }
    stack.hidden = visible === 0;
  }

  // ===== Alimentación: poll de 8 s de /api/chat/list =====
  function syncFromList(chats) {
    const seen = new Set();
    for (const c of chats || []) {
      const pend = c.pendingInterfono || [];
      if (!pend.length) continue;
      // F1: esta ventana no sirve ese chat → ni se crea la tarjeta (antes solo
      // se ocultaba en render(), pero igual se creaba en TODA ventana).
      if (!relevant(c.id)) continue;
      // F2/F4: el popup modal SOLO surfacea mensajes `active` (colisión REAL de
      // archivos). Todo lo demás (`passive`: coordinación, heads-up, broadcasts)
      // ya vive como badge pasivo en la tarjeta de Sesiones — se retiró el
      // "Retomar/Descartar" obligatorio que aparecía por cada mensaje. Hasta que
      // la Fase 4 marque `level`, ningún mensaje es active → el centro queda en
      // silencio (badge = superficie por defecto).
      const active = pend.filter((m) => m.level === 'active');
      if (!active.length) { if (items.has(c.id)) remove(c.id); continue; }
      seen.add(c.id);
      upsert(c.id, c.title, active);
    }
    for (const [chatId, item] of items) {
      if (seen.has(chatId) || item.busy) continue;
      remove(chatId); // tomado (turno/hook/botón) o sesión ida
    }
  }

  // Señal EN VIVO del server (Fase 3): un evento WS que llega SOLO a las
  // ventanas que tienen ese chat abierto (scoping server-side, ui/chat-tab.js
  // lo re-emite). Misma regla que el poll: solo mensajes `active` y solo si esta
  // ventana sirve el chat. Adelanta la aparición/retiro del aviso sin esperar
  // los 8 s del poll; el poll queda como red de seguridad.
  window.addEventListener('cwc:interfono', (e) => {
    const { chatId, pending } = e.detail || {};
    if (!chatId || !relevant(chatId)) return;
    const active = (pending || []).filter((m) => m.level === 'active');
    // Retiro instantáneo si ya no hay nada active; refresco de una tarjeta que
    // ya existe. La CREACIÓN se deja al poll (trae c.title legible; el evento no
    // carga el título) — a lo sumo 8 s de latencia para una tarjeta nueva, que
    // es rara (solo colisión real de archivos).
    if (!active.length) { if (items.has(chatId)) remove(chatId); return; }
    const item = items.get(chatId);
    if (item) upsert(chatId, undefined, active);
  });

  return { syncFromList, refresh: render };
}
