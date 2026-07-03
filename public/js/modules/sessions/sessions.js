// modules/sessions/sessions.js — "Sesiones": retomar trabajo.
//
// TARJETAS: nombre humano grande (custom o basename del cwd), punto de estado
// (● trabajando / ○ esperando / gris shell), modelo con su color de identidad.
// Tap en la tarjeta = adjuntar (o enfocar si ya está abierta). Lo demás vive
// en el menú ⋯: renombrar / cambiar modelo / matar (diálogos propios).
// La plomería (nombre tmux, socket, ruta) va al tooltip.
// Las sesiones externas (no cwc-*) quedan en "Otras sesiones tmux", colapsado.
import { modelColor } from '../../ui/models.js';
import { dismissablePopup } from '../../ui/popup.js';

const MODEL_OPTIONS = [
  ['opusplan', 'Auto (Opus plan / Sonnet)'],
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['default', 'Default de la cuenta'],
];

export default {
  name: 'sessions',

  mount(el, ctx) {
    const { icon, dialog, bus, openSession, focusSession, openChatView, syncConversation } = ctx;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-title">Sesiones</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Refrescar">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="sess-list" data-ref="list"></div>`;

    const listEl = el.querySelector('[data-ref="list"]');
    const countEl = el.querySelector('[data-ref="count"]');
    el.querySelector('[data-ref="refresh"]').addEventListener('click', refresh);
    bus.addEventListener('sessions-changed', refresh);

    const baseName = (p) => {
      const parts = (p || '').split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '~';
    };
    const displayName = (s) => s.customTitle || (s.cwd ? baseName(s.cwd) : s.name);
    const plumbing = (s) => `tmux: ${s.name} · socket ${s.socketName}${s.cwd ? ` · ${s.cwd}` : ''}`;

    function fmtAgo(ms) {
      if (!ms) return '';
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 60) return 'hace instantes';
      if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
      if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
      return `hace ${Math.floor(s / 86400)} d`;
    }

    // Estado → clase y texto del punto. Sin datos de estado: modelo detectado
    // implica Claude presente (esperando genérico); sin modelo = shell.
    function dotInfo(s) {
      const st = s.state?.status;
      if (st === 'working') return { cls: 'st-working', label: `trabajando · ${fmtAgo(s.state.ts)}` };
      if (st === 'waiting') return { cls: 'st-waiting', label: `esperando input · ${fmtAgo(s.state.ts)}` };
      if (st === 'stale') return { cls: 'st-stale', label: `sin señales · ${fmtAgo(s.state.ts)}` };
      if (s.model) return { cls: 'st-idle', label: 'Claude presente' };
      return { cls: 'st-shell', label: 'shell (sin Claude)' };
    }

    async function fetchAll() {
      const [tmuxRes, chatRes] = await Promise.all([
        fetch('/api/tmux/sessions'),
        fetch('/api/chat/list'),
      ]);
      if (!tmuxRes.ok) throw new Error();
      const sessions = (await tmuxRes.json()).sessions;
      const chats = chatRes.ok ? (await chatRes.json()).chats || [] : [];
      return { sessions, chats };
    }

    async function refresh() {
      listEl.innerHTML = '<div class="cwc-loading"><span class="cwc-spinner"></span>cargando…</div>';
      try {
        render(await fetchAll());
      } catch {
        listEl.innerHTML = '<div class="sess-msg sess-err">No se pudieron listar las sesiones.</div>';
      }
    }

    function render({ sessions, chats }) {
      const total = sessions.length + chats.length;
      countEl.textContent = total ? String(total) : '';
      const owned = sessions.filter((s) => s.owned);
      const others = sessions.filter((s) => !s.owned);

      listEl.innerHTML = '';
      if (!total) {
        listEl.innerHTML = '<div class="sess-msg">Sin sesiones. Creá una con “Nueva sesión”.</div>';
        return;
      }
      for (const c of chats) listEl.appendChild(chatCard(c));
      for (const s of owned) listEl.appendChild(card(s));

      if (others.length) {
        const det = document.createElement('details');
        det.className = 'sess-others';
        det.innerHTML = `<summary>Otras sesiones tmux <span class="side-count">${others.length}</span></summary>`;
        for (const s of others) det.appendChild(card(s));
        listEl.appendChild(det);
      }
    }

    // ===== Tarjeta de conversación (chat SDK) =====
    function chatCard(c) {
      const elCard = document.createElement('div');
      elCard.className = 'sess-card sess-chat';
      elCard.dataset.key = `chat:${c.id}`;
      elCard.title = `chat · ${c.cwd}${c.model ? ` · ${c.model}` : ''}`;

      const dotCls = c.status === 'working' ? 'st-working' : 'st-waiting';
      const isTui = c.viewMode === 'tui';
      const main = document.createElement('button');
      main.className = 'sess-main';
      main.innerHTML = `
        <span class="sess-dot ${dotCls}"></span>
        <span class="sess-type-ic">${icon(isTui ? 'terminal' : 'sparkle', { size: 12 })}</span>
        <span class="sess-name">${c.title}</span>
        <span class="sess-mode" title="${isTui ? 'En modo Terminal (TUI)' : 'En modo Chat'}">${isTui ? 'TUI' : ''}</span>
        <span class="sess-model">${c.model || ''}</span>`;
      main.addEventListener('click', () => openChatView(c));

      const menuBtn = document.createElement('button');
      menuBtn.className = 'btn-ghost btn--sm btn--icon sess-menu';
      menuBtn.innerHTML = icon('more', { size: 15 });
      menuBtn.title = 'Opciones';
      menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openChatMenu(c, menuBtn); });

      elCard.append(main, menuBtn);
      return elCard;
    }

    // Menú ⋯ de una CONVERSACIÓN: mismo popup descartable que las terminales.
    function openChatMenu(c, anchor) {
      const isTui = c.viewMode === 'tui';
      const menu = document.createElement('div');
      menu.className = 'cwc-popup-menu';
      menu.innerHTML = `
        <button class="cwc-popup-item" data-act="open">${icon(isTui ? 'terminal' : 'sparkle', { size: 15 })}<span>Abrir</span></button>
        <button class="cwc-popup-item" data-act="mode">${icon(isTui ? 'sparkle' : 'terminal', { size: 15 })}<span>${isTui ? 'Pasar a Chat' : 'Pasar a TUI'}</span></button>
        <button class="cwc-popup-item" data-act="rename">${icon('edit', { size: 15 })}<span>Renombrar</span></button>
        <button class="cwc-popup-item" data-act="model">${icon('sparkle', { size: 15 })}<span>Cambiar modelo</span></button>
        <button class="cwc-popup-item danger" data-act="close">${icon('trash', { size: 15 })}<span>Cerrar conversación</span></button>`;
      document.body.appendChild(menu);
      positionPopup(menu, anchor);
      const dismiss = dismissablePopup(menu, { onDismiss: () => menu.remove() });
      const act = (fn) => { dismiss(); fn(); };
      menu.querySelector('[data-act="open"]').addEventListener('click', () => act(() => openChatView(c)));
      menu.querySelector('[data-act="mode"]').addEventListener('click', () => act(() => switchChatMode(c)));
      menu.querySelector('[data-act="rename"]').addEventListener('click', () => act(() => renameChat(c)));
      menu.querySelector('[data-act="model"]').addEventListener('click', () => act(() => pickModelForChat(c)));
      menu.querySelector('[data-act="close"]').addEventListener('click', () => act(() => closeChat(c)));
    }

    // Modelo de una CONVERSACIÓN: en vivo (q.setModel() del SDK, sin perder
    // contexto) si el motor está corriendo, o para el próximo arranque si
    // está dormido. Mismo diálogo que pickModel (sesiones tmux), pero pega a
    // /api/chat/model en vez de mandar /model a la terminal.
    function pickModelForChat(c) {
      const m = dialog.openModal({ title: 'Modelo de esta conversación', width: 320 });
      m.body.innerHTML = `
        <div class="sess-menu-list">
          ${MODEL_OPTIONS.map(([v, l]) => `<button class="btn-ghost sess-menu-item" data-model="${v}"><span>${l}</span></button>`).join('')}
        </div>
        <p class="sess-plumbing">Si la conversación está activa, el cambio es en vivo (no se pierde el contexto).</p>`;
      for (const b of m.body.querySelectorAll('[data-model]')) {
        b.addEventListener('click', async () => {
          m.close();
          try {
            const res = await fetch('/api/chat/model', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: c.id, model: b.dataset.model }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'No se pudo cambiar el modelo.');
            syncConversation(data.chat);
            refresh();
          } catch (e) {
            dialog.alertDialog({ title: 'Modelo', message: e.message });
          }
        });
      }
    }

    async function switchChatMode(c) {
      try {
        const res = await fetch('/api/chat/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: c.id, mode: c.viewMode === 'tui' ? 'chat' : 'tui' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo cambiar de modo.');
        syncConversation(data.chat); // si la pestaña está abierta, reconstruye la vista
        refresh();
      } catch (e) {
        dialog.alertDialog({ title: 'Cambio de modo', message: e.message });
      }
    }

    async function renameChat(c) {
      const name = await dialog.promptDialog({
        title: 'Renombrar conversación',
        message: 'Nombre para mostrar (vacío = volver al nombre de la carpeta).',
        value: c.title || '',
      });
      if (name === null) return;
      try {
        const res = await fetch('/api/chat/title', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: c.id, title: name }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) syncConversation(data.chat);
      } finally {
        refresh();
      }
    }

    async function closeChat(c) {
      const ok = await dialog.confirmDialog({
        title: 'Cerrar conversación',
        message: `Se cierra "${c.title}" (el historial queda en el transcript para retomar en el futuro).`,
        confirmLabel: 'Cerrar',
        danger: true,
      });
      if (!ok) return;
      await fetch('/api/chat/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id }),
      }).catch(() => {});
      refresh();
    }

    function card(s) {
      const elCard = document.createElement('div');
      elCard.className = 'sess-card';
      elCard.dataset.key = `${s.socket}\n${s.name}`;
      elCard.title = plumbing(s);

      const dot = dotInfo(s);
      const main = document.createElement('button');
      main.className = 'sess-main';
      main.innerHTML = `
        <span class="sess-dot ${dot.cls}" title="${dot.label}"></span>
        <span class="sess-name">${displayName(s)}</span>
        <span class="sess-model" style="color:${s.model ? modelColor(s.model.key) : 'var(--cwc-text-dimmer)'}">${s.model ? s.model.name : ''}</span>`;
      main.addEventListener('click', () => openCard(s));

      const menuBtn = document.createElement('button');
      menuBtn.className = 'btn-ghost btn--sm btn--icon sess-menu';
      menuBtn.innerHTML = icon('more', { size: 15 });
      menuBtn.title = 'Opciones';
      menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(s, menuBtn); });

      elCard.append(main, menuBtn);
      return elCard;
    }

    // Tap = LA acción: enfocar la pestaña si ya está abierta, si no adjuntar.
    function openCard(s) {
      if (s.owned) {
        const tabId = s.name.replace(/^cwc-/, '');
        if (focusSession(tabId)) return;
      }
      openSession({ attach: { socket: s.socket, session: s.name }, title: displayName(s) });
    }

    // Menú ⋯: popup descartable anclado al botón (mismo helper que el menú
    // contextual del Explorador: cierra ante pointerdown fuera / Esc / scroll /
    // blur / al elegir una acción).
    function openMenu(s, anchor) {
      // "Pasar a Chat": solo sesiones nuestras con Claude corriendo adentro
      // (adopta la sesión como conversación: mismo transcript, misma memoria).
      const canAdopt = s.owned && !!s.model;
      const menu = document.createElement('div');
      menu.className = 'cwc-popup-menu';
      menu.innerHTML = `
        ${canAdopt ? `<button class="cwc-popup-item" data-act="adopt">${icon('sparkle', { size: 15 })}<span>Pasar a Chat</span></button>` : ''}
        <button class="cwc-popup-item" data-act="rename">${icon('edit', { size: 15 })}<span>Renombrar</span></button>
        <button class="cwc-popup-item" data-act="model">${icon('sparkle', { size: 15 })}<span>Cambiar modelo</span></button>
        <button class="cwc-popup-item danger" data-act="kill">${icon('trash', { size: 15 })}<span>Matar sesión</span></button>`;
      document.body.appendChild(menu);
      positionPopup(menu, anchor);
      const dismiss = dismissablePopup(menu, { onDismiss: () => menu.remove() });
      const act = (fn) => { dismiss(); fn(); };
      menu.querySelector('[data-act="adopt"]')?.addEventListener('click', () => act(() => adoptToChat(s)));
      menu.querySelector('[data-act="rename"]').addEventListener('click', () => act(() => rename(s)));
      menu.querySelector('[data-act="model"]').addEventListener('click', () => act(() => pickModel(s)));
      menu.querySelector('[data-act="kill"]').addEventListener('click', () => act(() => kill(s)));
    }

    // TUI(tmux) -> Chat: cierra el claude de la terminal (verificado en el
    // server) y abre la conversación sobre la MISMA sesión.
    async function adoptToChat(s) {
      const ok = await dialog.confirmDialog({
        title: 'Pasar a Chat',
        message: `Se cierra el Claude que corre en la terminal "${displayName(s)}" (Ctrl-C×2, verificado) y la conversación continúa como Chat con toda su memoria. La terminal queda como shell.`,
        confirmLabel: 'Pasar a Chat',
      });
      if (!ok) return;
      try {
        const res = await fetch('/api/chat/adopt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ terminalId: s.name.replace(/^cwc-/, '') }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo pasar a Chat.');
        openChatView(data.chat);
        refresh();
      } catch (e) {
        dialog.alertDialog({ title: 'Pasar a Chat', message: e.message });
      }
    }

    // Ancla un popup al botón, alineado a su borde derecho y clamped al viewport.
    function positionPopup(menu, anchor) {
      const r = anchor.getBoundingClientRect();
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      let left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
      let top = r.bottom + 4;
      if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }

    async function rename(s) {
      const name = await dialog.promptDialog({
        title: 'Renombrar sesión',
        message: 'Nombre para mostrar (vacío = volver al nombre de la carpeta).',
        value: s.customTitle || '',
        placeholder: displayName(s),
      });
      if (name === null) return;
      await fetch('/api/tmux/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ socket: s.socket, session: s.name, title: name }),
      }).catch(() => {});
      refresh();
    }

    function pickModel(s) {
      const m = dialog.openModal({ title: 'Modelo de esta sesión', width: 320 });
      m.body.innerHTML = `
        <div class="sess-menu-list">
          ${MODEL_OPTIONS.map(([v, l]) => `<button class="btn-ghost sess-menu-item" data-model="${v}"><span>${l}</span></button>`).join('')}
        </div>
        <p class="sess-plumbing">Se envía /model a la sesión (solo tiene efecto si corre Claude Code).</p>`;
      for (const b of m.body.querySelectorAll('[data-model]')) {
        b.addEventListener('click', async () => {
          m.close();
          try {
            const res = await fetch('/api/tmux/set-model', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ socket: s.socket, session: s.name, model: b.dataset.model }),
            });
            if (!res.ok) {
              const d = await res.json().catch(() => ({}));
              dialog.alertDialog({ title: 'Modelo', message: d.error || 'No se pudo cambiar el modelo.' });
            }
          } catch {
            dialog.alertDialog({ title: 'Modelo', message: 'No se pudo cambiar el modelo.' });
          }
        });
      }
    }

    async function kill(s) {
      const ok = await dialog.confirmDialog({
        title: 'Matar sesión',
        message: s.owned
          ? `Se cierra definitivamente "${displayName(s)}" y todo lo que corra adentro.`
          : `"${displayName(s)}" es una sesión externa (${plumbing(s)}). Matarla puede interrumpir algo que estés usando por fuera.`,
        confirmLabel: 'Matar',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await fetch('/api/tmux/kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ socket: s.socket, session: s.name }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          dialog.alertDialog({ title: 'Sesiones', message: d.error || 'No se pudo matar la sesión.' });
        }
      } finally {
        refresh();
      }
    }

    // Actualización EN SU LUGAR (cada 8 s): punto de estado, modelo y nombre,
    // sin reconstruir la lista (no interrumpe menús abiertos).
    async function updateInPlace() {
      if (document.hidden) return;
      try {
        const { sessions, chats } = await fetchAll();
        const map = new Map(sessions.map((s) => [`${s.socket}\n${s.name}`, s]));
        const chatMap = new Map(chats.map((c) => [`chat:${c.id}`, c]));
        for (const cardEl of listEl.querySelectorAll('.sess-card')) {
          const key = cardEl.dataset.key;
          if (chatMap.has(key)) {
            const c = chatMap.get(key);
            const dotEl = cardEl.querySelector('.sess-dot');
            dotEl.className = `sess-dot ${c.status === 'working' ? 'st-working' : 'st-waiting'}`;
            const isTui = c.viewMode === 'tui';
            const icEl = cardEl.querySelector('.sess-type-ic');
            if (icEl) icEl.innerHTML = icon(isTui ? 'terminal' : 'sparkle', { size: 12 });
            const modeEl = cardEl.querySelector('.sess-mode');
            if (modeEl) { modeEl.textContent = isTui ? 'TUI' : ''; modeEl.title = isTui ? 'En modo Terminal (TUI)' : 'En modo Chat'; }
            continue;
          }
          const s = map.get(key);
          if (!s) continue;
          const dot = dotInfo(s);
          const dotEl = cardEl.querySelector('.sess-dot');
          dotEl.className = `sess-dot ${dot.cls}`;
          dotEl.title = dot.label;
          cardEl.querySelector('.sess-name').textContent = displayName(s);
          const modelEl = cardEl.querySelector('.sess-model');
          modelEl.textContent = s.model ? s.model.name : '';
          modelEl.style.color = s.model ? modelColor(s.model.key) : 'var(--cwc-text-dimmer)';
        }
      } catch { /* noop */ }
    }
    setInterval(updateInPlace, 8000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) updateInPlace(); });

    refresh();
  },
};
