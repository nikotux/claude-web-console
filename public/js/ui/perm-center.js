// ui/perm-center.js — centro GLOBAL de permisos: popups flotantes con las
// solicitudes de permiso PENDIENTES de TODAS las conversaciones, visibles
// desde cualquier pantalla de la consola (pedido del usuario 2026-07-04: con
// varios chats abiertos los permisos expiraban sin que se viera el pedido).
//
// Alimentación DOBLE con dedupe por chatId+permId:
//   ⚡ instantánea: eventos window 'cwc:perm-request' / 'cwc:perm-closed' que
//      emite ChatTab al recibirlos por su WS (pestañas ya abiertas, aunque su
//      panel esté oculto). El replay de history también los emite y es
//      correcto: pendiente ⇒ popup; su closed posterior lo retira.
//   🔄 poll: syncFromList(chats) con el /api/chat/list del poll de 8 s de
//      main.js (pendingPerms[] por chat) — catch-up para chats SIN pestaña en
//      este navegador y limpieza de resueltos/expirados en otro lado.
//
// Responder usa POST /api/chat/permission (no necesita WS adjunto). La
// tarjeta inline del chat se cierra sola: el runner emite permission_closed.
// Supresión: el popup del chat ACTIVO no se muestra (la tarjeta inline ya
// está a la vista); main.js llama refresh() al cambiar de pestaña.
import { icon } from './icons.js';
import { renderDiff } from './diff.js';
import { toolTypeIcon, isDestructiveCommand } from '../modules/chat/chat-tab.js';

// Gracia anti-parpadeo: un item recién llegado por WS puede no figurar aún en
// la respuesta del poll (fetch disparado antes del permiso) — no se borra por
// sync hasta que madure; lo retiran cwc:perm-closed o un poll posterior.
const SYNC_GRACE_MS = 12000;

// Espejo de PERMISSION_TIMEOUT_MS (src/modules/chat/shared.js): el evento WS
// instantáneo trae solo `ts`; el expiresAt exacto llega con el próximo poll
// (/list lo calcula server-side). Si cambia el del server, actualizar acá.
const PERM_TIMEOUT_MS = 5 * 60 * 1000;

export function initPermCenter({ isChatActive, chatTitle, openChat }) {
  const stack = document.createElement('div');
  stack.className = 'cwc-permcenter';
  stack.hidden = true;
  document.body.appendChild(stack);

  const items = new Map(); // `${chatId}:${permId}` -> { el, chatId, permId, expiresAt, addedAt, busy }
  let ticker = null;

  const keyOf = (chatId, permId) => `${chatId}:${permId}`;

  // ===== Tarjeta =====
  function add(chatId, perm, title = null) {
    if (!chatId || !perm?.id) return;
    const k = keyOf(chatId, perm.id);
    if (items.has(k)) { if (title) setTitle(items.get(k), title); return; }
    if (perm.expiresAt && perm.expiresAt <= Date.now()) return; // ya vencido

    const el = document.createElement('div');
    el.className = 'pc-card';
    el.innerHTML = `
      <button type="button" class="pc-title" title="Ir a la conversación">
        ${icon('sparkle', { size: 13 })}<span class="pc-title-text"></span><span class="pc-count"></span>
      </button>
      <div class="chat-perm-row">
        <button type="button" class="chat-toolchip cp-chip">
          ${icon('terminal', { size: 14 })}${icon(toolTypeIcon(perm.tool), { size: 13, className: 'ct-type' })}${icon('chevronDown', { size: 12, className: 'cp-chev' })}
        </button>
        <button class="btn-ghost btn--sm cp-deny">${icon('close', { size: 13 })} Denegar</button>
        <button class="btn btn--sm cp-allow">${icon('check', { size: 13 })} Permitir</button>
      </div>
      <div class="pc-detail" hidden></div>
      <div class="pc-error" hidden></div>`;

    const item = {
      el, chatId, permId: perm.id, tool: perm.tool || '', summary: String(perm.summary || ''),
      detail: perm.detail || null,
      expiresAt: perm.expiresAt || (perm.ts ? perm.ts + PERM_TIMEOUT_MS : null),
      addedAt: Date.now(), busy: false,
    };
    setTitle(item, title || chatTitle?.(chatId) || chatId);
    // El tooltip NUNCA parafrasea (mismo criterio que la tarjeta del chat).
    el.querySelector('.cp-chip').title = `${item.tool}${item.summary ? ` — ${item.summary}` : ''}`;

    el.querySelector('.pc-title').addEventListener('click', () => openChat(chatId));
    const detEl = el.querySelector('.pc-detail');
    const toggle = (want = detEl.hidden) => {
      if (want && !detEl.childNodes.length) detEl.appendChild(detailBody(item));
      detEl.hidden = !want;
      el.classList.toggle('open', want);
    };
    el.querySelector('.cp-chip').addEventListener('click', () => toggle());
    el.querySelector('.cp-deny').addEventListener('click', () => answer(item, false));
    el.querySelector('.cp-allow').addEventListener('click', () => answer(item, true));
    // Regla de seguridad: los comandos destructivos nacen EXPANDIDOS.
    if (item.tool === 'Bash' && isDestructiveCommand(item.detail?.command || item.summary)) toggle(true);

    items.set(k, item);
    stack.appendChild(el);
    render();
  }

  function setTitle(item, title) {
    item.title = String(title || '');
    item.el.querySelector('.pc-title-text').textContent = item.title;
  }

  // Detalle íntegro (mismo formato que el chat): nombre COMPLETO de la función
  // + diff exacto para ediciones o comando completo para Bash/resto.
  function detailBody(item) {
    const body = document.createElement('div');
    body.className = 'ct-body';
    const name = document.createElement('div');
    name.className = 'cp-detail-tool';
    name.textContent = item.tool;
    body.appendChild(name);
    const d = item.detail;
    if (d && (d.old != null || d.new != null)) body.appendChild(renderDiff(d));
    else {
      const pre = document.createElement('pre');
      pre.className = 'ct-cmd';
      pre.textContent = d?.command || item.summary || '(sin detalle)';
      body.appendChild(pre);
    }
    return body;
  }

  async function answer(item, allow) {
    if (item.busy) return;
    item.busy = true;
    for (const b of item.el.querySelectorAll('.cp-deny, .cp-allow')) b.disabled = true;
    try {
      const res = await fetch('/api/chat/permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.chatId, permId: item.permId, allow }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo responder el permiso.');
      remove(keyOf(item.chatId, item.permId));
    } catch (err) {
      // Ya respondido/expirado en otro lado ⇒ la tarjeta sobra igual.
      if (/pendiente|inexistente/i.test(String(err.message))) {
        remove(keyOf(item.chatId, item.permId));
        return;
      }
      item.busy = false;
      for (const b of item.el.querySelectorAll('.cp-deny, .cp-allow')) b.disabled = false;
      const errEl = item.el.querySelector('.pc-error');
      errEl.textContent = String(err.message);
      errEl.hidden = false;
    }
  }

  function remove(k) {
    const item = items.get(k);
    if (!item) return;
    items.delete(k);
    item.el.remove();
    render();
  }

  // ===== Render / supresión / cuenta regresiva =====
  function render() {
    let visible = 0;
    for (const item of items.values()) {
      const hide = isChatActive(item.chatId); // la tarjeta inline ya está a la vista
      item.el.hidden = hide;
      if (!hide) visible += 1;
    }
    stack.hidden = visible === 0;
    if (items.size && !ticker) ticker = setInterval(tick, 1000);
    if (!items.size && ticker) { clearInterval(ticker); ticker = null; }
    tick();
  }

  function tick() {
    const now = Date.now();
    for (const [k, item] of items) {
      if (item.expiresAt && item.expiresAt <= now) { remove(k); continue; }
      const cEl = item.el.querySelector('.pc-count');
      if (!item.expiresAt) { cEl.textContent = ''; continue; }
      const s = Math.max(0, Math.round((item.expiresAt - now) / 1000));
      cEl.textContent = `⏳ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      cEl.classList.toggle('danger', s < 60);
    }
  }

  // ===== Alimentación =====
  window.addEventListener('cwc:perm-request', (e) => add(e.detail.chatId, e.detail.perm));
  window.addEventListener('cwc:perm-closed', (e) => remove(keyOf(e.detail.chatId, e.detail.permId)));

  function syncFromList(chats) {
    const seen = new Set();
    for (const c of chats || []) {
      for (const p of c.pendingPerms || []) {
        const k = keyOf(c.id, p.id);
        seen.add(k);
        if (items.has(k)) setTitle(items.get(k), c.title);
        else add(c.id, p, c.title);
      }
    }
    const now = Date.now();
    for (const [k, item] of items) {
      if (seen.has(k) || item.busy || now - item.addedAt < SYNC_GRACE_MS) continue;
      remove(k); // resuelto/expirado en otro lado
    }
  }

  return { syncFromList, refresh: render };
}
