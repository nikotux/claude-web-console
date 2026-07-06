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

export function initInterfonoCenter({ isChatActive, openChat }) {
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
    item.el.querySelector('.ic-title-text').textContent = String(title || item.chatId);
  }

  function fillBody(item, title, pend) {
    setTitle(item, title);
    item.el.querySelector('.ic-count').textContent = pend.length > 1 ? ` ·${pend.length}` : '';
    const body = item.el.querySelector('.ic-body');
    body.textContent = '';
    for (const m of pend) {
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
      seen.add(c.id);
      upsert(c.id, c.title, pend);
    }
    for (const [chatId, item] of items) {
      if (seen.has(chatId) || item.busy) continue;
      remove(chatId); // tomado (turno/hook/botón) o sesión ida
    }
  }

  return { syncFromList, refresh: render };
}
