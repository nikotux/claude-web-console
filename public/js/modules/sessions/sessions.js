// modules/sessions/sessions.js — "Sesiones": retomar trabajo.
//
// TARJETAS: nombre humano grande (custom o basename del cwd), Pac-Man de
// estado (amarillo masticando = en uso / verde boca cerrada = libre / gris =
// shell), modelo con su color de identidad.
// Tap en la tarjeta = adjuntar (o enfocar si ya está abierta). Lo demás vive
// en el menú ⋯: renombrar / cambiar modelo / matar (diálogos propios).
// La plomería (nombre tmux, socket, ruta) va al tooltip.
// Las sesiones externas (no cwc-*) quedan en "Otras sesiones tmux", colapsado.
import { modelColor, modelIcon, CHAT_MODEL_OPTIONS, EFFORT_OPTIONS, effortLabel } from '../../ui/models.js';
import { dismissablePopup } from '../../ui/popup.js';
import { pacman, pacClass } from '../../ui/pacman.js';
import { placeFor, PLACES } from '../../ui/places.js';

// Punto de estado de una tarjeta: motor Pac-Man (ui/pacman.js) — color Y
// animación por estado vienen del catálogo central (ver ui.css); acá solo
// se arma el markup/clase en tamaño 'sm'. Misma firma para render inicial y
// updateInPlace (que solo toca la clase, nunca reinyecta HTML interno).
const pacEl = (state, label) => pacman({ state, size: 'sm', cls: 'sess-pac', title: label });
const pacCls = (state) => pacClass(state, { size: 'sm', cls: 'sess-pac' });

// Escape para texto de OTRAS sesiones (mensajes del Interfono) antes de meterlo
// en innerHTML del popup del badge. El resto de la tarjeta usa valores propios
// (título, cwd) ya confiables; estos vienen de afuera.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Texto del chip .sess-model de un chat: con AutoTux ('auto') muestra el
// nombre del router + el NIVEL real (que va cambiando solo); con una
// elección forzada, el modelo tal cual. Fuente única para la tarjeta inicial
// y la actualización en su lugar del poll de 8s (ver más abajo).
function chatModelLabel(c) {
  // Sufijo de esfuerzo (eje thinking effort): solo si la persona lo FIJÓ a mano
  // (effortPinned) — el derivado del tier no se muestra para no ensuciar el chip.
  const eff = c.effortPinned && c.effort ? ` · ${effortLabel(c.effort, true)}` : '';
  if (c.modelChoice === 'auto') return `${modelIcon('auto')} AutoTux: ${c.model || '…'}${eff}`;
  return c.model ? `${modelIcon(c.model)} ${c.model}${eff}` : '';
}

// Nombre de la tmux OCULTA que sostiene un chat en modo TUI (misma fórmula
// que BARE_PREFIX del backend, terminal/sessions.js). Esas sesiones NO se
// listan como tarjeta propia (son plomería interna del modo TUI de un chat,
// duplicarían la tarjeta del chat) — pero SÍ traen el estado REAL vía el
// observador de hooks. Antes eran invisibles del todo y la tarjeta del chat
// quedaba con el Pac-Man CONGELADO al pasar a TUI: cualquier reactivación
// (por el interfono, por vos tipeando en la terminal oculta, por lo que
// sea) no se veía hasta volver a modo Chat (bug reportado 2026-07-05).
const bareNameOf = (terminalId) => `cwct-${terminalId}`;

// Modelo de una sesión TUI (tmux, vía `/model` tecleado real): NO incluye
// AutoTux — el CLI real no conoce ese alias, y el router (core/model-router.js)
// solo gestiona el chat visual del SDK por ahora. Lista SEPARADA a propósito
// de CHAT_MODEL_OPTIONS (ui/models.js), que sí lleva AutoTux primero.
const TUI_MODEL_OPTIONS = [
  ['opusplan', 'Opus plan'],
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['default', 'Default de la cuenta'],
];

export default {
  name: 'sessions',

  mount(el, ctx) {
    const { icon, dialog, bus, openSession, focusSession, openChatView, syncConversation, openExplorer } = ctx;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot" data-ref="dot" title="Estado del módulo"></span>
        <span class="sec-title">Sesiones</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Refrescar">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="sess-list" data-ref="list"></div>`;

    const listEl = el.querySelector('[data-ref="list"]');
    const countEl = el.querySelector('[data-ref="count"]');
    const dotEl = el.querySelector('[data-ref="dot"]');
    el.querySelector('[data-ref="refresh"]').addEventListener('click', refresh);
    bus.addEventListener('sessions-changed', refresh);

    const baseName = (p) => {
      const parts = (p || '').split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '~';
    };
    // Nombre humano: custom > lugar conocido (ui/places.js: "Mi Consola",
    // "Tolkien") > basename del cwd. El renombre manual sigue mandando.
    const displayName = (s) => s.customTitle || placeFor(s.cwd)?.label || (s.cwd ? baseName(s.cwd) : s.name);
    const plumbing = (s) => `tmux: ${s.name} · socket ${s.socketName}${s.cwd ? ` · ${s.cwd}` : ''}`;
    // Mini-ícono de LUGAR (dónde corre la sesión): solo lugares conocidos —
    // Mi Consola en acento (is-console), Tolkien tenue. El badge es estático
    // por tarjeta (el cwd no cambia), updateInPlace no necesita tocarlo.
    const placeBadge = (cwd) => {
      const p = placeFor(cwd);
      return p ? `<span class="sess-place ${p.cls}" title="${p.label}">${icon(p.ico, { size: 11 })}</span>` : '';
    };

    function fmtAgo(ms) {
      if (!ms) return '';
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 60) return 'hace instantes';
      if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
      if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
      return `hace ${Math.floor(s / 86400)} d`;
    }

    // Estado → estado del motor Pac-Man + texto del punto. Sin datos de
    // estado: modelo detectado implica Claude presente (tratamos como
    // "esperándote", el caso más común); sin modelo = shell (dormant).
    function dotInfo(s) {
      const st = s.state?.status;
      if (st === 'working') return { state: 'working', label: `trabajando · ${fmtAgo(s.state.ts)}` };
      if (st === 'waiting') return { state: 'waiting', label: `esperando input · ${fmtAgo(s.state.ts)}` };
      if (st === 'stale') return { state: 'stale', label: `sin señales · ${fmtAgo(s.state.ts)}` };
      if (s.model) return { state: 'waiting', label: 'Claude presente' };
      return { state: 'dormant', label: 'shell (sin Claude)' };
    }

    // Estado de una tarjeta de CONVERSACIÓN: en modo TUI el motor SDK está
    // dormido (this.link=null en el backend) y `c.status` queda congelado —
    // la actividad real vive en el pane tmux oculto (cwct-<id>), reportada
    // por el observador. `tmuxByName` (armado en render/updateInPlace desde
    // el mismo fetch de /api/tmux/sessions) trae ese estado en vivo.
    function chatDotInfo(c, tmuxByName) {
      if (c.viewMode === 'tui' && c.terminalId) {
        const bare = tmuxByName.get(bareNameOf(c.terminalId));
        const st = bare?.state?.status;
        if (st === 'working') return { state: 'working', label: `trabajando (TUI) · ${fmtAgo(bare.state.ts)}` };
        if (st === 'stale') return { state: 'stale', label: `sin señales (TUI) · ${fmtAgo(bare.state.ts)}` };
        return { state: 'waiting', label: bare ? `esperando input (TUI) · ${fmtAgo(bare.state.ts)}` : 'en modo TUI' };
      }
      // Delegando a un subagente (Task tool): más específico que "trabajando"
      // a secas, así que manda sobre c.status==='working' cuando aplica.
      if (c.delegating) return { state: 'delegating', label: 'delegando a un subagente…' };
      return c.status === 'working'
        ? { state: 'working', label: 'trabajando' }
        : { state: 'waiting', label: 'esperando input' };
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
      // Mapa completo (INCLUYE cwct-*) para resolver el estado de un chat en
      // modo TUI; la lista VISIBLE excluye esas tmux ocultas — son plomería
      // interna del modo TUI de un chat, no una sesión propia del usuario.
      const tmuxByName = new Map(sessions.map((s) => [s.name, s]));
      const visible = sessions.filter((s) => !s.name.startsWith('cwct-'));
      const total = visible.length + chats.length;
      countEl.textContent = total ? String(total) : '';
      // Semáforo (visible colapsado): verde si hay sesiones, tenue si no hay.
      dotEl.className = 'sec-dot ' + (total ? 'sec-dot--ok' : 'sec-dot--idle');
      dotEl.title = total ? `${total} sesión(es) activas` : 'Sin sesiones';
      const owned = visible.filter((s) => s.owned);
      const others = visible.filter((s) => !s.owned);
      const activeChats = chats.filter((c) => !c.archived);
      const archivedChats = chats.filter((c) => c.archived);

      listEl.innerHTML = '';
      if (!total && !archivedChats.length) {
        listEl.innerHTML = '<div class="sess-msg">Sin sesiones. Creá una con “Nueva sesión”.</div>';
        return;
      }

      // F4 (PLAN-373/PEND-463): agrupar los chats por MUNDO (ui/places.js). Orden:
      // lugares conocidos (Mi Consola, Tolkien) primero, "Otros" al final. El
      // header de mundo aparece solo si hay chats en >1 mundo (con uno solo sería
      // ruido). Cada grupo lleva ícono + label + conteo.
      const byWorld = new Map();
      for (const c of activeChats) {
        const p = placeFor(c.cwd);
        const key = p?.rel || '__otros';
        if (!byWorld.has(key)) byWorld.set(key, { place: p, chats: [] });
        byWorld.get(key).chats.push(c);
      }
      const order = [...PLACES.map((p) => p.rel), '__otros'];
      const worldKeys = [...byWorld.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const multiWorld = worldKeys.length > 1;
      for (const key of worldKeys) {
        const grp = byWorld.get(key);
        if (multiWorld) {
          const h = document.createElement('div');
          h.className = 'sess-world-h';
          h.innerHTML = `${icon(grp.place?.ico || 'folder', { size: 12 })}<span>${grp.place?.label || 'Otros'}</span><span class="side-count">${grp.chats.length}</span>`;
          listEl.appendChild(h);
        }
        for (const c of grp.chats) listEl.appendChild(chatCard(c, tmuxByName));
      }
      for (const s of owned) listEl.appendChild(card(s));

      // F3 (PLAN-373/PEND-462): conversaciones ARCHIVADAS (revivibles) en una
      // sección colapsada. Tocar una la revive y la abre (ver chatCard).
      if (archivedChats.length) {
        const det = document.createElement('details');
        det.className = 'sess-others sess-archived';
        det.innerHTML = `<summary>${icon('folder', { size: 13 })} Archivados <span class="side-count">${archivedChats.length}</span></summary>`;
        for (const c of archivedChats) det.appendChild(chatCard(c, tmuxByName));
        listEl.appendChild(det);
      }

      if (others.length) {
        const det = document.createElement('details');
        det.className = 'sess-others';
        det.innerHTML = `<summary>Otras sesiones tmux <span class="side-count">${others.length}</span></summary>`;
        for (const s of others) det.appendChild(card(s));
        listEl.appendChild(det);
      }
    }

    // ===== Tarjeta de conversación (chat SDK) =====
    function chatCard(c, tmuxByName) {
      const elCard = document.createElement('div');
      elCard.className = 'sess-card sess-chat' + (c.archived ? ' sess-chat--archived' : '');
      elCard.dataset.key = `chat:${c.id}`;
      elCard.title = `chat · ${c.cwd}${c.model ? ` · ${c.model}` : ''}`;

      const dot = chatDotInfo(c, tmuxByName);
      const isTui = c.viewMode === 'tui';
      const main = document.createElement('button');
      main.className = 'sess-main';
      main.innerHTML = `
        ${pacEl(dot.state, dot.label)}
        <span class="sess-body">
          <span class="sess-row1">
            <span class="sess-type-ic">${icon(isTui ? 'terminal' : 'sparkle', { size: 12 })}</span>
            ${placeBadge(c.cwd)}
            <span class="sess-name">${c.title}</span>
            <span class="sess-mode" title="${isTui ? 'En modo Terminal (TUI)' : 'En modo Chat'}">${isTui ? 'TUI' : ''}</span>
          </span>
          <span class="sess-row2">
            <span class="sess-model">${chatModelLabel(c)}</span>
          </span>
        </span>`;
      // Archivada (F3): tocarla la REVIVE y la abre; activa: abrir normal.
      main.addEventListener('click', () => (c.archived ? reviveChat(c, { open: true }) : openChatView(c)));

      const menuBtn = document.createElement('button');
      menuBtn.className = 'btn-ghost btn--sm btn--icon sess-menu';
      menuBtn.innerHTML = icon('more', { size: 15 });
      menuBtn.title = 'Opciones';
      menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openChatMenu(c, menuBtn); });

      elCard.append(main, menuBtn);
      syncInterfonoBadge(elCard, c); // señal pasiva del interfono (Fase 2)
      return elCard;
    }

    // Badge PASIVO del Interfono (rediseño 2026-07-10, Fase 2): reemplaza al
    // popup modal "Retomar/Descartar" que aparecía en TODA ventana. Si un chat
    // tiene mensajes de otras sesiones sin tomar, su tarjeta muestra un badge
    // discreto (contador + ícono relay); al tocarlo, un popup con el preview y
    // las acciones Entregar/Archivar. Sin robar foco, sin sonido, sin modal.
    // (Re)construye el badge en su lugar sin reconstruir la tarjeta.
    function syncInterfonoBadge(cardEl, c) {
      const pend = c.pendingInterfono || [];
      let badge = cardEl.querySelector('.sess-interfono');
      if (!pend.length) { if (badge) badge.remove(); return; }
      const preview = String(pend[0]?.text || '').slice(0, 80);
      if (!badge) {
        badge = document.createElement('button');
        badge.className = 'btn-ghost btn--sm btn--icon sess-interfono';
        // Insertar ANTES del menú ⋯ para que quede junto a él.
        const menu = cardEl.querySelector('.sess-menu');
        cardEl.insertBefore(badge, menu);
        badge.addEventListener('click', (e) => { e.stopPropagation(); openInterfonoMenu(c, badge); });
      }
      // F4: si algún pendiente es `active` (colisión real de archivos), el badge
      // toma el acento de ALERTA; si todo es passive, el acento frío neutro.
      const hasActive = pend.some((m) => m.level === 'active');
      badge.classList.toggle('sess-interfono--active', hasActive);
      badge.dataset.chat = c.id;
      badge.title = `${pend.length} mensaje(s) del Interfono sin tomar${hasActive ? ' (⚠ archivo tocado)' : ''}: ${preview}`;
      badge.innerHTML = `${icon('relay', { size: 13 })}<span class="sess-interfono-n">${pend.length}</span>`;
    }

    // Popup del badge: preview de los mensajes + Entregar/Archivar. Entregar
    // dispara un turno (puede despertar el chat) → confirm por consumo de
    // tokens (regla de oro). Archivar solo marca entregado (0 tokens).
    function openInterfonoMenu(c, anchor) {
      const pend = c.pendingInterfono || [];
      if (!pend.length) return;
      const menu = document.createElement('div');
      menu.className = 'cwc-popup-menu sess-interfono-pop';
      const list = pend.slice(-6).map((m) => {
        const from = escapeHtml(m.fromName || 'sesión');
        const txt = escapeHtml(String(m.text || '').slice(0, 160));
        return `<div class="sif-msg"><strong>${from}:</strong> ${txt}</div>`;
      }).join('');
      menu.innerHTML = `
        <div class="sif-head">${icon('relay', { size: 13 })} Interfono · ${pend.length} mensaje(s)</div>
        <div class="sif-body">${list}</div>
        <div class="sif-actions">
          <button class="btn-ghost btn--sm" data-act="dismiss">${icon('close', { size: 13 })} Archivar</button>
          <button class="btn btn--sm" data-act="deliver">${icon('play', { size: 13 })} Entregar</button>
        </div>`;
      document.body.appendChild(menu);
      positionPopup(menu, anchor);
      const dismiss = dismissablePopup(menu, { onDismiss: () => menu.remove() });
      menu.querySelector('[data-act="dismiss"]').addEventListener('click', async () => {
        dismiss();
        await interfonoAction(c, 'dismiss');
      });
      menu.querySelector('[data-act="deliver"]').addEventListener('click', async () => {
        dismiss();
        const ok = await dialog.confirmDialog({
          title: 'Entregar al chat',
          message: `Voy a inyectar ${pend.length} mensaje(s) del Interfono en "${c.title}" como un turno. Si el chat estaba dormido, se despierta (consume tokens).`,
          confirmLabel: 'Entregar',
        });
        if (ok) await interfonoAction(c, 'deliver');
      });
    }

    async function interfonoAction(c, action) {
      try {
        const res = await fetch('/api/chat/interfono', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: c.id, action }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo procesar el mensaje.');
      } catch (e) {
        dialog.alertDialog({ title: 'Interfono', message: e.message });
      } finally {
        refresh();
      }
    }

    // Menú ⋯ de una CONVERSACIÓN: mismo popup descartable que las terminales.
    function openChatMenu(c, anchor) {
      const isTui = c.viewMode === 'tui';
      const arch = !!c.archived; // F3: una archivada muestra "Revivir" y esconde las acciones que exigen motor vivo
      const menu = document.createElement('div');
      menu.className = 'cwc-popup-menu';
      menu.innerHTML = `
        <button class="cwc-popup-item" data-act="open">${icon(isTui ? 'terminal' : 'sparkle', { size: 15 })}<span>${arch ? 'Revivir y abrir' : 'Abrir'}</span></button>
        ${arch ? `<button class="cwc-popup-item" data-act="revive">${icon('refresh', { size: 15 })}<span>Revivir</span></button>` : ''}
        ${arch || isTui ? '' : `<button class="cwc-popup-item" data-act="mode">${icon('terminal', { size: 15 })}<span>Pasar a TUI</span></button>`}
        ${!arch && isTui ? `<button class="cwc-popup-item" data-act="mode">${icon('sparkle', { size: 15 })}<span>Pasar a Chat</span></button>` : ''}
        <button class="cwc-popup-item" data-act="rename">${icon('edit', { size: 15 })}<span>Renombrar</span></button>
        ${arch ? '' : `<button class="cwc-popup-item" data-act="model">${icon('sparkle', { size: 15 })}<span>Cambiar modelo</span></button>`}
        ${arch || isTui ? '' : `<button class="cwc-popup-item" data-act="reopen">${icon('refresh', { size: 15 })}<span>Reabrir para cambios</span></button>`}
        ${arch || isTui ? '' : `<button class="cwc-popup-item" data-act="world">${icon('gitBranch', { size: 15 })}<span>Mover a otro mundo</span></button>`}
        ${arch || isTui ? '' : `<button class="cwc-popup-item" data-act="archive">${icon('folder', { size: 15 })}<span>Archivar</span></button>`}
        <button class="cwc-popup-item" data-act="folder">${icon('folder', { size: 15 })}<span>Abrir carpeta del chat</span></button>
        <button class="cwc-popup-item danger" data-act="close">${icon('trash', { size: 15 })}<span>Cerrar conversación</span></button>`;
      document.body.appendChild(menu);
      positionPopup(menu, anchor);
      const dismiss = dismissablePopup(menu, { onDismiss: () => menu.remove() });
      const act = (fn) => { dismiss(); fn(); };
      menu.querySelector('[data-act="open"]').addEventListener('click', () => act(() => (arch ? reviveChat(c, { open: true }) : openChatView(c))));
      menu.querySelector('[data-act="revive"]')?.addEventListener('click', () => act(() => reviveChat(c)));
      menu.querySelector('[data-act="mode"]')?.addEventListener('click', () => act(() => switchChatMode(c)));
      menu.querySelector('[data-act="rename"]').addEventListener('click', () => act(() => renameChat(c)));
      menu.querySelector('[data-act="model"]')?.addEventListener('click', () => act(() => pickModelForChat(c)));
      menu.querySelector('[data-act="reopen"]')?.addEventListener('click', () => act(() => reopenChat(c)));
      menu.querySelector('[data-act="world"]')?.addEventListener('click', () => act(() => moveChatWorld(c)));
      menu.querySelector('[data-act="archive"]')?.addEventListener('click', () => act(() => archiveChat(c)));
      menu.querySelector('[data-act="folder"]').addEventListener('click', () => act(() => openChatFolder(c)));
      menu.querySelector('[data-act="close"]').addEventListener('click', () => act(() => closeChat(c)));
    }

    // F3: archivar (aparcar revivible) una conversación desde el menú ⋯.
    async function archiveChat(c) {
      try {
        const res = await fetch('/api/chat/archive', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: c.id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo archivar.');
      } catch (e) {
        dialog.alertDialog({ title: 'Archivar', message: e.message });
      } finally { refresh(); }
    }

    // F3: revivir una conversación archivada; con {open:true} además la abre.
    async function reviveChat(c, { open = false } = {}) {
      try {
        const res = await fetch('/api/chat/revive', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: c.id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo revivir.');
        if (data.chat) syncConversation(data.chat);
        if (open) openChatView(data.chat || c);
      } catch (e) {
        dialog.alertDialog({ title: 'Revivir', message: e.message });
      } finally { refresh(); }
    }

    // Abre el Explorador (ventana existente, deep-link ?path=) en la carpeta de
    // adjuntos del chat (~/.cwc-data/chat-attachments/<id>). El backend la crea
    // si no existía (sin adjuntos aún) y devuelve la ruta relativa al home.
    async function openChatFolder(c) {
      try {
        const res = await fetch(`/api/chat/folder?id=${encodeURIComponent(c.id)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.rel) throw new Error(data.error || 'No se pudo abrir la carpeta.');
        openExplorer(data.rel);
      } catch (e) {
        dialog.alertDialog({ title: 'Carpeta del chat', message: e.message });
      }
    }

    // Reabre el motor de una conversación para que tome cambios de código
    // nuevos tras un deploy (mata el runner viejo y levanta uno fresco sobre la
    // MISMA sesión: conserva el contexto, no cierra el chat). Confirm SOLO si
    // hay un turno en curso (se cortaría).
    async function reopenChat(c) {
      if (c.status === 'working') {
        const ok = await dialog.confirmDialog({
          title: 'Reabrir para cambios',
          message: `"${c.title}" está trabajando ahora: reabrir el motor corta el turno en curso. La conversación y su contexto se conservan.`,
          confirmLabel: 'Reabrir igual',
          danger: true,
        });
        if (!ok) return;
      }
      try {
        const res = await fetch('/api/chat/reopen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: c.id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo reabrir el motor.');
        if (data.chat) syncConversation(data.chat);
      } catch (e) {
        dialog.alertDialog({ title: 'Reabrir para cambios', message: e.message });
      } finally {
        refresh();
      }
    }

    // Mueve una conversación a OTRO mundo (cwd) conservando TODO el contexto (F1
    // de PLAN-373 / PEND-386): el backend forkea la sesión, reloca el transcript
    // y ARCHIVA el origen. Elegís el mundo destino (lugares conocidos de
    // ui/places.js, menos el de origen). 0 tokens; el motor destino arranca al
    // abrir la conversación nueva. "Un mundo a la vez" (Regla dura 12).
    async function moveChatWorld(c) {
      const originRel = placeFor(c.cwd)?.rel || null;
      const dests = PLACES.filter((p) => p.rel !== originRel);
      if (!dests.length) {
        dialog.alertDialog({ title: 'Mover a otro mundo', message: 'No hay otro mundo conocido para mudar esta conversación.' });
        return;
      }
      const m = dialog.openModal({ title: 'Mover a otro mundo', width: 360 });
      m.body.innerHTML = `
        <p class="sess-plumbing">La conversación se muda con TODO su contexto al mundo elegido: se <b>forkea</b> la sesión y el origen se <b>archiva</b>. En el destino usa las herramientas de ESE mundo (Regla 12: un mundo a la vez).</p>
        <div class="sess-menu-list">${dests.map((p) =>
          `<button class="btn-ghost sess-menu-item" data-rel="${p.rel}"><span>${p.label}</span></button>`).join('')}</div>
        <div class="sess-pick-actions"><button class="btn-ghost" data-act="cancel">Cancelar</button></div>`;
      m.body.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
      m.body.querySelectorAll('[data-rel]').forEach((btn) => btn.addEventListener('click', async () => {
        const rel = btn.getAttribute('data-rel');
        const label = dests.find((p) => p.rel === rel)?.label || rel;
        const ok = await dialog.confirmDialog({
          title: 'Mover a otro mundo',
          message: `Mudar "${c.title}" a ${label}: el origen se archiva (cierra) y se abre una conversación nueva en ${label} con el mismo contexto. ¿Seguir?`,
          confirmLabel: `Mover a ${label}`,
        });
        if (!ok) return;
        m.close();
        try {
          const res = await fetch('/api/chat/handoff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: c.id, cwd: rel }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo mover la conversación.');
          if (data.chat) { syncConversation(data.chat); openChatView(data.chat); }
        } catch (e) {
          dialog.alertDialog({ title: 'Mover a otro mundo', message: e.message });
        } finally {
          refresh();
        }
      }));
    }

    // Modelo de una CONVERSACIÓN: en vivo (q.setModel() del SDK, sin perder
    // contexto) si el motor está corriendo, o para el próximo arranque si
    // está dormido. Mismo diálogo que pickModel (sesiones tmux), pero pega a
    // /api/chat/model en vez de mandar /model a la terminal.
    // Submenú modelo → esfuerzo (PEND-391 #3). DOS secciones en un modal: elegís
    // el AGENTE (modelo) y el ESFUERZO de razonamiento, y "Aplicar" los manda
    // juntos a POST /api/chat/model {id, model, effort}. La opción de modelo se
    // marca contra `modelChoice` (QUÉ ELIGIÓ la persona) — con AutoTux, `c.model`
    // es el nivel real que cambia solo, así que comparar contra ESO marcaría mal.
    // El esfuerzo 'auto' = seguir el tier del modelo (effortPinned=false).
    function pickModelForChat(c) {
      const m = dialog.openModal({ title: 'Modelo y esfuerzo', width: 340 });
      // Selección local (se confirma con Aplicar): arranca en lo actual.
      let selModel = c.modelChoice || 'auto';
      let selEffort = c.effortPinned ? (c.effort || 'auto') : 'auto';
      const renderList = (opts, sel, attr) => opts.map(([v, l]) =>
        `<button class="btn-ghost sess-menu-item${v === sel ? ' sess-menu-item--active' : ''}" data-${attr}="${v}"><span>${l}</span>${v === sel ? icon('check', { size: 14 }) : ''}</button>`).join('');
      const paint = () => {
        m.body.innerHTML = `
          <div class="sess-pick-sec">
            <div class="sess-pick-h">${icon('sparkle', { size: 14 })} Agente</div>
            <div class="sess-menu-list">${renderList(CHAT_MODEL_OPTIONS, selModel, 'model')}</div>
          </div>
          <div class="sess-pick-sec">
            <div class="sess-pick-h">🧠 Esfuerzo de razonamiento</div>
            <div class="sess-menu-list">${renderList(EFFORT_OPTIONS, selEffort, 'effort')}</div>
          </div>
          <p class="sess-plumbing">AutoTux decide el <b>modelo</b> solo; los demás fuerzan uno fijo. El <b>esfuerzo</b> (más barato que saltar de tier) se aplica al SPAWN del motor — con la conversación activa toma efecto al reabrir o en el próximo turno tras dormir. "Auto" sigue el tier del modelo.</p>
          <div class="sess-pick-actions">
            <button class="btn-ghost" data-act="cancel">Cancelar</button>
            <button class="btn" data-act="apply">Aplicar</button>
          </div>`;
        for (const b of m.body.querySelectorAll('[data-model]')) b.addEventListener('click', () => { selModel = b.dataset.model; paint(); });
        for (const b of m.body.querySelectorAll('[data-effort]')) b.addEventListener('click', () => { selEffort = b.dataset.effort; paint(); });
        m.body.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
        m.body.querySelector('[data-act="apply"]').addEventListener('click', apply);
      };
      const apply = async () => {
        m.close();
        try {
          const res = await fetch('/api/chat/model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: c.id, model: selModel, effort: selEffort }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo cambiar el modelo/esfuerzo.');
          syncConversation(data.chat);
          await refresh();
          // Update OPTIMISTA: con motor vivo, data.chat/list traen this.model
          // aún STALE (se confirma por eco). Pinto el chip ya para feedback
          // inmediato; el poll de 8s lo reconcilia cuando llega el eco.
          const chip = listEl.querySelector(`[data-key="chat:${c.id}"] .sess-model`);
          if (chip) chip.textContent = chatModelLabel(data.chat || { modelChoice: selModel, model: c.model });
        } catch (e) {
          dialog.alertDialog({ title: 'Modelo y esfuerzo', message: e.message });
        }
      };
      paint();
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
        if (!res.ok) throw new Error(data.error || 'No se pudo renombrar.');
        syncConversation(data.chat);
      } catch (e) {
        dialog.alertDialog({ title: 'Renombrar conversación', message: e.message });
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
      try {
        const res = await fetch('/api/chat/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: c.id }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          dialog.alertDialog({ title: 'Cerrar conversación', message: data.error || 'No se pudo cerrar la conversación.' });
        }
      } finally {
        refresh();
      }
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
        ${pacEl(dot.state, dot.label)}
        <span class="sess-body">
          <span class="sess-row1">
            ${placeBadge(s.cwd)}
            <span class="sess-name">${displayName(s)}</span>
          </span>
          <span class="sess-row2">
            <span class="sess-model" style="color:${s.model ? modelColor(s.model.key) : 'var(--cwc-text-dimmer)'}">${s.model ? `${modelIcon(s.model.key)} ${s.model.name}` : ''}</span>
          </span>
        </span>`;
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
      try {
        const res = await fetch('/api/tmux/title', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ socket: s.socket, session: s.name, title: name }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          dialog.alertDialog({ title: 'Renombrar sesión', message: data.error || 'No se pudo renombrar la sesión.' });
        }
      } finally {
        refresh();
      }
    }

    function pickModel(s) {
      const m = dialog.openModal({ title: 'Modelo de esta sesión', width: 320 });
      m.body.innerHTML = `
        <div class="sess-menu-list">
          ${TUI_MODEL_OPTIONS.map(([v, l]) => `<button class="btn-ghost sess-menu-item" data-model="${v}"><span>${l}</span></button>`).join('')}
        </div>
        <p class="sess-plumbing">Se envía /model a la sesión (solo tiene efecto si corre Claude Code). AutoTux todavía no gestiona sesiones de terminal.</p>`;
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
        const tmuxByName = new Map(sessions.map((s) => [s.name, s]));
        const map = new Map(sessions.map((s) => [`${s.socket}\n${s.name}`, s]));
        const chatMap = new Map(chats.map((c) => [`chat:${c.id}`, c]));
        for (const cardEl of listEl.querySelectorAll('.sess-card')) {
          const key = cardEl.dataset.key;
          if (chatMap.has(key)) {
            const c = chatMap.get(key);
            const dot = chatDotInfo(c, tmuxByName);
            const dotEl = cardEl.querySelector('.sess-pac');
            dotEl.className = pacCls(dot.state);
            dotEl.title = dot.label;
            const isTui = c.viewMode === 'tui';
            const icEl = cardEl.querySelector('.sess-type-ic');
            if (icEl) icEl.innerHTML = icon(isTui ? 'terminal' : 'sparkle', { size: 12 });
            const modeEl = cardEl.querySelector('.sess-mode');
            if (modeEl) { modeEl.textContent = isTui ? 'TUI' : ''; modeEl.title = isTui ? 'En modo Terminal (TUI)' : 'En modo Chat'; }
            // Refrescar el chip de modelo: con motor vivo el cambio de modelo se
            // confirma por eco (this.model queda stale un instante), así que sin
            // esto el poll nunca reflejaba el modelo nuevo hasta un rebuild total.
            const chatModelEl = cardEl.querySelector('.sess-model');
            if (chatModelEl) chatModelEl.textContent = chatModelLabel(c);
            syncInterfonoBadge(cardEl, c); // señal pasiva del interfono (Fase 2)
            continue;
          }
          const s = map.get(key);
          if (!s) continue;
          const dot = dotInfo(s);
          const dotEl = cardEl.querySelector('.sess-pac');
          dotEl.className = pacCls(dot.state);
          dotEl.title = dot.label;
          cardEl.querySelector('.sess-name').textContent = displayName(s);
          const modelEl = cardEl.querySelector('.sess-model');
          modelEl.textContent = s.model ? `${modelIcon(s.model.key)} ${s.model.name}` : '';
          modelEl.style.color = s.model ? modelColor(s.model.key) : 'var(--cwc-text-dimmer)';
        }
      } catch { /* noop */ }
    }
    setInterval(updateInPlace, 8000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) updateInPlace(); });

    refresh();
  },
};
