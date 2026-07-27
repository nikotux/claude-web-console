// modules/sessions/sessions.js — "Sesiones": retomar trabajo.
//
// TARJETAS: nombre humano grande (custom o basename del cwd), Pac-Man de
// estado (amarillo masticando = en uso / verde boca cerrada = libre / gris =
// shell), modelo con su color de identidad.
// Tap en la tarjeta = adjuntar (o enfocar si ya está abierta). Lo demás vive
// en el menú ⋯: renombrar / cambiar modelo / matar (diálogos propios).
// La plomería (nombre tmux, socket, ruta) va al tooltip.
// Las sesiones externas (no cwc-*) quedan en "Otras sesiones tmux", colapsado.
import { modelColor, modelIcon, CHAT_MODEL_OPTIONS, EFFORT_OPTIONS, effortLabel, CODEX_MODEL_OPTIONS, codexEffortsFor, DEFAULT_CODEX_MODEL } from '../../ui/models.js';
import { dismissablePopup } from '../../ui/popup.js';
import { pacman, pacClass } from '../../ui/pacman.js';
import { placeFor, resolvePlace, PLACES, LIMBO_PLACE } from '../../ui/places.js';
import { readCache, writeCache } from '../../ui/cache-store.js';
import { t } from '../../ui/i18n.js';
import { helpBtn } from '../../ui/help.js';

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
  ['opus', 'Opus 5'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['default', 'Default de la cuenta'],
];

// Estado visual de los hijos de cada chat: vive fuera del DOM porque el poll de
// 8 s actualiza tarjetas en su lugar y puede reconstruir solo el contenido
// derivado. La key coincide con dataset.key (`chat:<id>`).
const openKidCards = new Set();
let liveTickTimer = null;

export default {
  name: 'sessions',

  mount(el, ctx) {
    const { icon, dialog, bus, openSession, focusSession, openChatView, syncConversation, openExplorer } = ctx;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot" data-ref="dot" title="${t('sessions.dot.moduleTitle', 'Estado del módulo')}"></span>
        <span class="sec-title">${t('sessions.title', 'Sesiones')}</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon sess-bgbtn--idle" data-ref="bg" title="${t('sessions.bg.title', 'Trabajos en segundo plano')}">${icon('relay', { size: 14 })}<span class="sess-bg-n">0</span></button>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="${t('sessions.refresh', 'Refrescar')}">${icon('refresh', { size: 14 })}</button>
        ${helpBtn('sessions')}
      </header>
      <div class="sess-list" data-ref="list"></div>`;

    const listEl = el.querySelector('[data-ref="list"]');
    const countEl = el.querySelector('[data-ref="count"]');
    const dotEl = el.querySelector('[data-ref="dot"]');
    const bgBtn = el.querySelector('[data-ref="bg"]');
    const bgCountEl = bgBtn.querySelector('.sess-bg-n');
    let lastData = { sessions: [], chats: [], runners: { processes: [], processCount: 0, dominantModel: null } };
    let bgModal = null;
    el.querySelector('[data-ref="refresh"]').addEventListener('click', refresh);
    bgBtn.addEventListener('click', openBgModal);
    bus.addEventListener('sessions-changed', refresh);

    const baseName = (p) => {
      const parts = (p || '').split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '~';
    };
    // Nombre humano: custom > lugar conocido (ui/places.js: "Mi Consola",
    // "Tolkien") > basename del cwd. El renombre manual sigue mandando.
    const displayName = (s) => {
      const p = resolvePlace(s.cwd);
      const placeLabel = p?.isolated ? t('sessions.place.envLabel', 'Tolkien (aislado)') : p?.label;
      return s.customTitle || placeLabel || (s.cwd ? baseName(s.cwd) : s.name);
    };
    const plumbing = (s) => `tmux: ${s.name} · socket ${s.socketName}${s.cwd ? ` · ${s.cwd}` : ''}`;
    // Mini-ícono de LUGAR (dónde corre la sesión): solo lugares conocidos —
    // Mi Consola en acento (is-console), Tolkien tenue. El badge es estático
    // por tarjeta (el cwd no cambia), updateInPlace no necesita tocarlo.
    const placeBadge = (cwd) => {
      const p = resolvePlace(cwd);
      if (!p) return '';
      if (p.isolated) {
        const title = t('sessions.place.envTitle', 'Tolkien · entorno aislado ({env})', { env: p.envId });
        return `<span class="sess-place is-env" title="${escapeHtml(title)}">${icon(p.ico, { size: 11 })}</span>`;
      }
      return `<span class="sess-place ${p.cls}" title="${p.label}">${icon(p.ico, { size: 11 })}</span>`;
    };

    function fmtAgo(ms) {
      if (!ms) return '';
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 60) return t('sessions.ago.now', 'hace instantes');
      if (s < 3600) return t('sessions.ago.min', 'hace {n} min', { n: Math.floor(s / 60) });
      if (s < 86400) return t('sessions.ago.hour', 'hace {n} h', { n: Math.floor(s / 3600) });
      return t('sessions.ago.day', 'hace {n} d', { n: Math.floor(s / 86400) });
    }

    function tsMs(v) {
      if (!v) return 0;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
      const d = Date.parse(v);
      return Number.isFinite(d) ? d : 0;
    }

    function oldestTs(items, field) {
      const xs = (items || []).map((x) => tsMs(x?.[field])).filter(Boolean);
      return xs.length ? Math.min(...xs) : 0;
    }

    function liveWithAge(prefix, since) {
      return {
        prefix,
        since,
        text: prefix + (since ? t('sessions.live.ageSuffix', ' · {ago}', { ago: fmtAgo(since) }) : ''),
      };
    }

    function liveMeta(c) {
      const bg = Array.isArray(c.bgTasks) ? c.bgTasks : [];
      const bgLive = bg.filter((b) => !b.ready);
      const bgReady = bg.filter((b) => b.ready);
      if (bgLive.length) return liveWithAge(t('sessions.live.background', '⚡ {n} en segundo plano', { n: bgLive.length }), oldestTs(bgLive, 'startedAt'));
      if (bgReady.length) return liveWithAge(t('sessions.live.bgReady', '✅ {n} listo(s) para recoger', { n: bgReady.length }), oldestTs(bgReady, 'startedAt'));
      const n = Number(c.delegatingCount || 0);
      if (n > 0) return liveWithAge(t('sessions.live.delegating', '✦ delegando {n}', { n }), tsMs(c.delegatingSince));
      if (c.status === 'working') return { prefix: '', since: 0, text: t('sessions.live.working', 'trabajando') };
      return { prefix: '', since: 0, text: '' };
    }

    // Texto vivo de la fila 2: QUÉ está haciendo la sesión ahora y hace cuánto.
    // Prioridad: trabajo de fondo > delegando > turno en curso > nada.
    function liveText(c) {
      return liveMeta(c).text;
    }

    function syncLiveText(root, c) {
      const liveEl = root.querySelector('.sess-live');
      if (!liveEl) return;
      const meta = liveMeta(c);
      liveEl.textContent = liveText(c);
      if (meta.prefix) {
        liveEl.dataset.livePrefix = meta.prefix;
        liveEl.dataset.liveSince = meta.since ? String(meta.since) : '';
      } else {
        delete liveEl.dataset.livePrefix;
        delete liveEl.dataset.liveSince;
      }
    }

    // Hijos de una sesión = lo que cuelga de ella y sigue vivo: subagentes Task
    // (delegatingList) + trabajos en segundo plano (bgTasks). Es la MISMA lista
    // que impide dormir el motor (PLAN-892): un solo dato, dos usos.
    function kidsOf(c) {
      return [
        ...(c.bgTasks || []).map((b) => ({ id: `bg:${b.id}`, kind: 'bg', label: b.label || b.kind || t('sessions.live.bgFallback', 'trabajo de fondo'), since: b.startedAt, ready: b.ready })),
        ...(c.delegatingList || []).map((d) => ({ id: `sub:${d.id}`, kind: 'sub', label: d.label || t('sessions.live.subFallback', 'subagente'), since: d.since })),
      ];
    }

    function kidRowHtml(k) {
      const since = tsMs(k.since);
      const ico = k.ready ? 'check' : (k.kind === 'sub' ? 'sparkle' : 'relay');
      return `
        <div class="sess-kid" data-kid="${escapeHtml(k.id)}">
          ${k.ready ? '' : pacman({ state: 'delegating', size: 'sm', cls: 'sess-kid-pac' })}
          <span class="sess-kid-ic">${icon(ico, { size: 12 })}</span>
          <span class="sess-kid-label">${escapeHtml(k.label)}</span>
          <span class="sess-kid-ago" data-start="${since || ''}">${since ? fmtAgo(since) : ''}</span>
        </div>`;
    }

    function syncKids(cardEl, c) {
      const key = `chat:${c.id}`;
      cardEl._cwcKidsChat = c;
      const kids = kidsOf(c);
      const row2 = cardEl.querySelector('.sess-row2');
      let toggle = cardEl.querySelector('.sess-kids-toggle');
      let box = cardEl.querySelector('.sess-kids');
      if (!box) {
        box = document.createElement('div');
        box.className = 'sess-kids';
        box.hidden = true;
        cardEl.appendChild(box);
      }
      if (!toggle && row2) {
        toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'sess-kids-toggle';
        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const open = !openKidCards.has(key);
          if (open) openKidCards.add(key);
          else openKidCards.delete(key);
          syncKids(cardEl, cardEl._cwcKidsChat || c);
        });
        toggle.addEventListener('keydown', (e) => e.stopPropagation());
        row2.appendChild(toggle);
      }
      const open = openKidCards.has(key);
      if (toggle) {
        toggle.hidden = false;
        // El chevron NO se esconde con 0 hijos, sólo se atenúa: un control que
        // aparece únicamente cuando hay algo corriendo es indescubrible (la misma
        // lección del widget de actividad que se eliminó). Consistente con el botón
        // global del header, que también se atenúa en 0 pero sigue visible.
        toggle.classList.toggle('sess-kids-toggle--idle', kids.length === 0);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.title = kids.length === 0
          ? t('sessions.live.showKidsEmpty', 'Ver trabajos de esta sesión (ninguno ahora)')
          : (open ? t('sessions.live.hideKids', 'Ocultar trabajos de esta sesión') : t('sessions.live.showKids', 'Ver trabajos de esta sesión'));
        toggle.innerHTML = `${icon(open ? 'chevronDown' : 'chevronRight', { size: 12 })}<span class="sess-kids-n">${kids.length}</span>`;
      }
      box.hidden = !open;
      box.innerHTML = kids.length
        ? kids.map(kidRowHtml).join('')
        : `<div class="sess-kid sess-kid--empty">${escapeHtml(t('sessions.live.emptyKids', 'Nada corriendo en segundo plano'))}</div>`;
    }

    function runnerInfo(data = lastData) {
      const r = data?.runners || {};
      const processes = Array.isArray(r.processes) ? r.processes : [];
      const processCount = Number.isFinite(Number(r.processCount)) ? Number(r.processCount) : processes.length;
      return { processes, processCount, dominantModel: r.dominantModel || null };
    }

    function globalBgCount(data = lastData) {
      const chats = data?.chats || [];
      const childCount = chats.reduce((sum, c) => sum + kidsOf(c).length, 0);
      return childCount + runnerInfo(data).processCount;
    }

    function syncBgButton(data = lastData) {
      const n = globalBgCount(data);
      bgCountEl.textContent = String(n);
      bgBtn.classList.toggle('sess-bgbtn--idle', n === 0);
      bgBtn.title = n
        ? t('sessions.bg.titleCount', 'Trabajos en segundo plano: {n}', { n })
        : t('sessions.bg.titleIdle', 'Trabajos en segundo plano: nada corriendo');
    }

    function processRowHtml(p) {
      const since = tsMs(p.startedAt);
      const label = p.label || p.key || t('sessions.bg.processFallback', 'proceso');
      const phase = p.phase ? `<span class="sess-kid-phase"> · ${escapeHtml(p.phase)}</span>` : '';
      const model = p.model ? `<span class="sess-kid-model">${escapeHtml(p.model)}</span>` : '';
      return `
        <div class="sess-kid" data-process="${escapeHtml(p.key || label)}">
          ${pacman({ state: 'delegating', size: 'sm', cls: 'sess-kid-pac' })}
          <span class="sess-kid-ic">${icon(p.icon || 'gear', { size: 12 })}</span>
          <span class="sess-kid-label">${escapeHtml(label)}${phase}</span>
          ${model}
          <span class="sess-kid-ago" data-start="${since || ''}">${since ? fmtAgo(since) : ''}</span>
        </div>`;
    }

    function bgSessionSection(c) {
      const kids = kidsOf(c);
      if (!kids.length) return '';
      return `
        <details class="sess-bg-group">
          <summary>${placeBadge(c.cwd)}<span class="sess-bg-name">${escapeHtml(c.title || c.id)}</span><span class="sess-bg-n">${kids.length}</span></summary>
          <div class="sess-kids sess-kids--modal">${kids.map(kidRowHtml).join('')}</div>
        </details>`;
    }

    function renderBgModal(data = lastData) {
      if (!bgModal) return;
      const chats = data?.chats || [];
      const { processes } = runnerInfo(data);
      const chatSections = chats.map(bgSessionSection).filter(Boolean).join('');
      const procSection = processes.length ? `
        <details class="sess-bg-group">
          <summary>${icon('gear', { size: 13 })}<span class="sess-bg-name">${t('sessions.bg.serverProcesses', '⚙️ Procesos del server')}</span><span class="sess-bg-n">${processes.length}</span></summary>
          <div class="sess-kids sess-kids--modal">${processes.map(processRowHtml).join('')}</div>
        </details>` : '';
      bgModal.body.innerHTML = (chatSections || procSection)
        ? `<div class="sess-bg-modal">${chatSections}${procSection}</div>`
        : `<p class="sess-bg-empty">${t('sessions.bg.empty', 'Nada corriendo en segundo plano.')}</p>`;
    }

    function openBgModal() {
      if (bgModal) { renderBgModal(lastData); return; }
      bgModal = dialog.openModal({
        title: t('sessions.bg.modalTitle', 'Trabajos en segundo plano'),
        width: 620,
        onClose: () => { bgModal = null; },
      });
      renderBgModal(lastData);
    }

    function tickLiveTimes() {
      for (const liveEl of listEl.querySelectorAll('.sess-live[data-live-prefix]')) {
        const since = tsMs(liveEl.dataset.liveSince);
        liveEl.textContent = liveEl.dataset.livePrefix + (since ? t('sessions.live.ageSuffix', ' · {ago}', { ago: fmtAgo(since) }) : '');
      }
      const roots = [listEl, bgModal?.body].filter(Boolean);
      for (const root of roots) {
        for (const elAgo of root.querySelectorAll('.sess-kid-ago[data-start]')) {
          const since = tsMs(elAgo.dataset.start);
          if (since) elAgo.textContent = fmtAgo(since);
        }
      }
    }

    // Estado → estado del motor Pac-Man + texto del punto. Sin datos de
    // estado: modelo detectado implica Claude presente (tratamos como
    // "esperándote", el caso más común); sin modelo = shell (dormant).
    function dotInfo(s) {
      const st = s.state?.status;
      if (st === 'working') return { state: 'working', label: t('sessions.dot.working', 'trabajando · {ago}', { ago: fmtAgo(s.state.ts) }) };
      if (st === 'waiting') return { state: 'waiting', label: t('sessions.dot.waiting', 'esperando input · {ago}', { ago: fmtAgo(s.state.ts) }) };
      if (st === 'stale') return { state: 'stale', label: t('sessions.dot.stale', 'sin señales · {ago}', { ago: fmtAgo(s.state.ts) }) };
      if (s.model) return { state: 'waiting', label: t('sessions.dot.present', 'Claude presente') };
      return { state: 'dormant', label: t('sessions.dot.shell', 'shell (sin Claude)') };
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
        if (st === 'working') return { state: 'working', label: t('sessions.dot.workingTui', 'trabajando (TUI) · {ago}', { ago: fmtAgo(bare.state.ts) }) };
        if (st === 'stale') return { state: 'stale', label: t('sessions.dot.staleTui', 'sin señales (TUI) · {ago}', { ago: fmtAgo(bare.state.ts) }) };
        return { state: 'waiting', label: bare ? t('sessions.dot.waitingTui', 'esperando input (TUI) · {ago}', { ago: fmtAgo(bare.state.ts) }) : t('sessions.dot.tuiMode', 'en modo TUI') };
      }
      // Delegando a un subagente (Task tool): más específico que "trabajando"
      // a secas, así que manda sobre c.status==='working' cuando aplica.
      if (c.delegating) {
        const n = c.delegatingCount || 0;
        return { state: 'delegating', label: n > 1 ? t('sessions.dot.delegatingN', 'delegando a {n} subagentes…', { n }) : t('sessions.dot.delegating', 'delegando a un subagente…') };
      }
      if (c.status === 'working') return { state: 'working', label: t('sessions.dot.workingShort', 'trabajando') };
      // Distinguir VIVO-esperándote (motor corriendo, tu turno real → verde) de
      // DORMIDO (motor apagado, no pasa nada → gris). Antes TODO lo no-working
      // caía en verde "esperando input", así que 40+ chats dormidos mentían en
      // verde y solo se veían 2 estados. `alive` viene de /api/chat/list.
      if (c.alive) {
        const perms = (c.pendingPerms || []).length;
        return { state: 'waiting', label: perms ? t('sessions.dot.waitingPerm', 'esperando tu permiso ({n})', { n: perms }) : t('sessions.dot.waitingLive', 'esperando tu input') };
      }
      return { state: 'dormant', label: t('sessions.dot.dormant', 'dormido · tocá para retomar') };
    }

    async function fetchAll() {
      const runnersReq = fetch('/api/health/active-runners')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const [tmuxRes, chatRes, runnersRaw] = await Promise.all([
        fetch('/api/tmux/sessions'),
        fetch('/api/chat/list'),
        runnersReq,
      ]);
      if (!tmuxRes.ok) throw new Error();
      const sessions = (await tmuxRes.json()).sessions;
      const chats = chatRes.ok ? (await chatRes.json()).chats || [] : [];
      const processes = Array.isArray(runnersRaw?.processes) ? runnersRaw.processes : [];
      const processCount = Number.isFinite(Number(runnersRaw?.processCount)) ? Number(runnersRaw.processCount) : processes.length;
      const runners = { processes, processCount, dominantModel: runnersRaw?.dominantModel || null };
      return { sessions, chats, runners };
    }

    async function refresh() {
      // Cache-then-network: pinta la última lista conocida al instante (evita el
      // 'cargando…' en cada apertura/reconexión) y refresca por detrás.
      const cached = readCache('sessions');
      if (cached) { try { render(cached.data); } catch { /* noop */ } }
      else listEl.innerHTML = `<div class="cwc-loading"><span class="cwc-spinner"></span>${t('sessions.loading', 'cargando…')}</div>`;
      try {
        const data = await fetchAll();
        writeCache('sessions', data);
        render(data);
      } catch {
        if (!cached) listEl.innerHTML = `<div class="sess-msg sess-err">${t('sessions.listError', 'No se pudieron listar las sesiones.')}</div>`;
      }
    }

    function render(data) {
      const { sessions, chats } = data;
      lastData = { sessions, chats, runners: runnerInfo(data) };
      syncBgButton(lastData);
      if (bgModal) renderBgModal(lastData);
      // Mapa completo (INCLUYE cwct-*) para resolver el estado de un chat en
      // modo TUI; la lista VISIBLE excluye esas tmux ocultas — son plomería
      // interna del modo TUI de un chat, no una sesión propia del usuario.
      const tmuxByName = new Map(sessions.map((s) => [s.name, s]));
      const visible = sessions.filter((s) => !s.name.startsWith('cwct-'));
      const total = visible.length + chats.length;
      countEl.textContent = total ? String(total) : '';
      // Semáforo (visible colapsado): verde si hay sesiones, tenue si no hay.
      dotEl.className = 'sec-dot ' + (total ? 'sec-dot--ok' : 'sec-dot--idle');
      dotEl.title = total ? t('sessions.count.active', '{n} sesión(es) activas', { n: total }) : t('sessions.count.none', 'Sin sesiones');
      const owned = visible.filter((s) => s.owned);
      const others = visible.filter((s) => !s.owned);
      const activeChats = chats.filter((c) => !c.archived);
      const archivedChats = chats.filter((c) => c.archived);

      listEl.innerHTML = '';
      if (!total && !archivedChats.length) {
        listEl.innerHTML = `<div class="sess-msg">${t('sessions.empty', 'Sin sesiones. Creá una con “Nueva sesión”.')}</div>`;
        return;
      }

      // F4 (PLAN-373/PEND-463): agrupar los chats por MUNDO (ui/places.js). Orden:
      // lugares conocidos (Mi Consola, Tolkien) primero, "Otros" al final. El
      // header de mundo aparece solo si hay chats en >1 mundo (con uno solo sería
      // ruido). Cada grupo lleva ícono + label + conteo.
      const byWorld = new Map();
      for (const c of activeChats) {
        // 🌗 sesión-Limbo (alto riesgo, herramientas de ambos mundos): grupo
        // PROPIO, sin importar el cwd — así se identifica de un vistazo.
        const p = c.limbo ? LIMBO_PLACE : resolvePlace(c.cwd);
        const key = c.limbo ? '__limbo' : (p?.rel || '__otros');
        const worldPlace = key === 'tolkien' ? PLACES.find((x) => x.rel === key) : p;
        if (!byWorld.has(key)) byWorld.set(key, { place: worldPlace, chats: [] });
        const envId = c.tolkienEnv?.id || p?.envId || null;
        const branch = c.tolkienEnv?.branch || envId;
        byWorld.get(key).chats.push({
          chat: c,
          envId,
          branch,
          worktree: c.tolkienEnv?.worktree || c.cwd,
        });
      }
      const order = ['__limbo', ...PLACES.map((p) => p.rel), '__otros'];
      const worldKeys = [...byWorld.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const multiWorld = worldKeys.length > 1;
      for (const key of worldKeys) {
        const grp = byWorld.get(key);
        if (multiWorld) {
          const h = document.createElement('div');
          h.className = 'sess-world-h' + (key === '__limbo' ? ' sess-limbo-h' : '');
          h.innerHTML = `${icon(grp.place?.ico || 'folder', { size: 12 })}<span>${grp.place?.label || t('sessions.world.other', 'Otros')}</span><span class="side-count">${grp.chats.length}</span>`;
          listEl.appendChild(h);
        }
        if (key !== 'tolkien') {
          for (const item of grp.chats) listEl.appendChild(chatCard(item.chat, tmuxByName));
          continue;
        }

        // Tolkien principal conserva sus tarjetas al mismo nivel. Cada worktree
        // efímero vive debajo en su propio bloque de árbol, incluso cuando no hay
        // headers de mundo porque Tolkien es el único grupo presente.
        for (const item of grp.chats.filter((x) => !x.envId)) {
          listEl.appendChild(chatCard(item.chat, tmuxByName));
        }
        const envGroups = new Map();
        for (const item of grp.chats.filter((x) => x.envId)) {
          if (!envGroups.has(item.envId)) {
            const shortBranch = String(item.branch || '').replace(/^cwc-env\//, '');
            const label = t('sessions.env.header', 'Aislado · {branch}', { branch: shortBranch });
            envGroups.set(item.envId, { ...item, label, chats: [] });
          }
          envGroups.get(item.envId).chats.push(item.chat);
        }
        const sortedEnvs = [...envGroups.values()].sort((a, b) => a.label.localeCompare(b.label));
        for (const env of sortedEnvs) {
          const det = document.createElement('details');
          det.className = 'sess-env-grp';
          det.open = true;
          const summary = document.createElement('summary');
          summary.className = 'sess-env-h';
          summary.title = t('sessions.env.summaryTitle', 'Entorno {env} · rama {branch} · worktree {worktree}', {
            env: env.envId,
            branch: env.branch,
            worktree: env.worktree,
          });
          summary.innerHTML = `${icon('isolated', { size: 12 })}<span class="sess-env-name">${escapeHtml(env.label)}</span><span class="side-count">${env.chats.length}</span>`;
          det.appendChild(summary);
          for (const c of env.chats) det.appendChild(chatCard(c, tmuxByName));
          listEl.appendChild(det);
        }
      }
      for (const s of owned) listEl.appendChild(card(s));

      // F3 (PLAN-373/PEND-462): conversaciones ARCHIVADAS (revivibles) en una
      // sección colapsada. Tocar una la revive y la abre (ver chatCard).
      if (archivedChats.length) {
        const det = document.createElement('details');
        det.className = 'sess-others sess-archived';
        det.innerHTML = `<summary>${icon('folder', { size: 13 })} ${t('sessions.archived', 'Archivados')} <span class="side-count">${archivedChats.length}</span></summary>`;
        for (const c of archivedChats) det.appendChild(chatCard(c, tmuxByName));
        listEl.appendChild(det);
      }

      if (others.length) {
        const det = document.createElement('details');
        det.className = 'sess-others';
        det.innerHTML = `<summary>${t('sessions.otherTmux', 'Otras sesiones tmux')} <span class="side-count">${others.length}</span></summary>`;
        for (const s of others) det.appendChild(card(s));
        listEl.appendChild(det);
      }

    }

    // ===== Tarjeta de conversación (chat SDK) =====
    function chatCard(c, tmuxByName) {
      const elCard = document.createElement('div');
      const isEnv = resolvePlace(c.cwd)?.isolated;
      elCard.className = 'sess-card sess-chat' + (c.archived ? ' sess-chat--archived' : '') + (isEnv ? ' sess-chat--env' : '');
      elCard.dataset.key = `chat:${c.id}`;
      elCard.title = `chat · ${c.cwd}${c.model ? ` · ${c.model}` : ''}`;

      const dot = chatDotInfo(c, tmuxByName);
      const isTui = c.viewMode === 'tui';
      const main = document.createElement('div');
      main.className = 'sess-main';
      main.setAttribute('role', 'button');
      main.tabIndex = 0;
      main.innerHTML = `
        ${pacEl(dot.state, dot.label)}
        <span class="sess-body">
          <span class="sess-row1">
            <span class="sess-type-ic">${icon(isTui ? 'terminal' : 'sparkle', { size: 12 })}</span>
            ${placeBadge(c.cwd)}
            <span class="sess-name">${c.title}</span>
            <span class="sess-mode" title="${isTui ? t('sessions.mode.terminal', 'En modo Terminal (TUI)') : t('sessions.mode.chat', 'En modo Chat')}">${isTui ? 'TUI' : ''}</span>
          </span>
          <span class="sess-row2">
            <span class="sess-model">${chatModelLabel(c)}</span>
            <span class="sess-live"></span>
          </span>
        </span>`;
      // Archivada (F3): tocarla la REVIVE y la abre; activa: abrir normal.
      main.addEventListener('click', () => (c.archived ? reviveChat(c, { open: true }) : openChatView(c)));
      main.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        c.archived ? reviveChat(c, { open: true }) : openChatView(c);
      });

      const menuBtn = document.createElement('button');
      menuBtn.className = 'btn-ghost btn--sm btn--icon sess-menu';
      menuBtn.innerHTML = icon('more', { size: 15 });
      menuBtn.title = t('sessions.options', 'Opciones');
      menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openChatMenu(c, menuBtn); });

      const kidsBox = document.createElement('div');
      kidsBox.className = 'sess-kids';
      kidsBox.hidden = true;

      elCard.append(main, menuBtn, kidsBox);
      syncLiveText(elCard, c);
      syncKids(elCard, c);
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
      badge.title = t('sessions.interfono.badge', '{n} mensaje(s) del Interfono sin tomar{active}: {preview}', { n: pend.length, active: hasActive ? t('sessions.interfono.touched', ' (⚠ archivo tocado)') : '', preview });
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
        const from = escapeHtml(m.fromName || t('sessions.interfono.session', 'sesión'));
        const txt = escapeHtml(String(m.text || '').slice(0, 160));
        return `<div class="sif-msg"><strong>${from}:</strong> ${txt}</div>`;
      }).join('');
      menu.innerHTML = `
        <div class="sif-head">${icon('relay', { size: 13 })} ${t('sessions.interfono.head', 'Interfono · {n} mensaje(s)', { n: pend.length })}</div>
        <div class="sif-body">${list}</div>
        <div class="sif-actions">
          <button class="btn-ghost btn--sm" data-act="dismiss">${icon('close', { size: 13 })} ${t('sessions.interfono.dismiss', 'Archivar')}</button>
          <button class="btn btn--sm" data-act="deliver">${icon('play', { size: 13 })} ${t('sessions.interfono.deliver', 'Entregar')}</button>
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
          title: t('sessions.interfono.deliverTitle', 'Entregar al chat'),
          message: t('sessions.interfono.deliverMsg', 'Voy a inyectar {n} mensaje(s) del Interfono en "{title}" como un turno. Si el chat estaba dormido, se despierta (consume tokens).', { n: pend.length, title: c.title }),
          confirmLabel: t('sessions.interfono.deliver', 'Entregar'),
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
        if (!res.ok) throw new Error(data.error || t('sessions.interfono.actionError', 'No se pudo procesar el mensaje.'));
      } catch (e) {
        dialog.alertDialog({ title: t('sessions.interfono.title', 'Interfono'), message: e.message });
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
        <button class="cwc-popup-item" data-act="open">${icon(isTui ? 'terminal' : 'sparkle', { size: 15 })}<span>${arch ? t('sessions.menu.reviveOpen', 'Revivir y abrir') : t('sessions.menu.open', 'Abrir')}</span></button>
        ${arch ? `<button class="cwc-popup-item" data-act="revive">${icon('refresh', { size: 15 })}<span>${t('sessions.menu.revive', 'Revivir')}</span></button>` : ''}
        ${arch || isTui ? '' : `<button class="cwc-popup-item" data-act="mode">${icon('terminal', { size: 15 })}<span>${t('sessions.menu.toTui', 'Pasar a TUI')}</span></button>`}
        ${!arch && isTui ? `<button class="cwc-popup-item" data-act="mode">${icon('sparkle', { size: 15 })}<span>${t('sessions.menu.toChat', 'Pasar a Chat')}</span></button>` : ''}
        <button class="cwc-popup-item" data-act="rename">${icon('edit', { size: 15 })}<span>${t('sessions.menu.rename', 'Renombrar')}</span></button>
        ${arch ? '' : `<button class="cwc-popup-item" data-act="model">${icon('sparkle', { size: 15 })}<span>${t('sessions.menu.model', 'Cambiar modelo')}</span></button>`}
        ${arch || isTui ? '' : `<button class="cwc-popup-item" data-act="reopen">${icon('refresh', { size: 15 })}<span>${t('sessions.menu.reopen', 'Reabrir para cambios')}</span></button>`}
        ${arch || isTui ? '' : `<button class="cwc-popup-item" data-act="world">${icon('gitBranch', { size: 15 })}<span>${t('sessions.menu.moveWorld', 'Mover a otro mundo')}</span></button>`}
        ${arch || isTui ? '' : `<button class="cwc-popup-item" data-act="archive">${icon('folder', { size: 15 })}<span>${t('sessions.menu.archive', 'Archivar')}</span></button>`}
        <button class="cwc-popup-item" data-act="folder">${icon('folder', { size: 15 })}<span>${t('sessions.menu.folder', 'Abrir carpeta del chat')}</span></button>
        <button class="cwc-popup-item danger" data-act="close">${icon('trash', { size: 15 })}<span>${t('sessions.menu.close', 'Cerrar conversación')}</span></button>`;
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
        if (!res.ok) throw new Error(data.error || t('sessions.archive.error', 'No se pudo archivar.'));
      } catch (e) {
        dialog.alertDialog({ title: t('sessions.archive.title', 'Archivar'), message: e.message });
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
        if (!res.ok) throw new Error(data.error || t('sessions.revive.error', 'No se pudo revivir.'));
        if (data.chat) syncConversation(data.chat);
        if (open) openChatView(data.chat || c);
      } catch (e) {
        dialog.alertDialog({ title: t('sessions.revive.title', 'Revivir'), message: e.message });
      } finally { refresh(); }
    }

    // Abre el Explorador (ventana existente, deep-link ?path=) en la carpeta de
    // adjuntos del chat (~/.cwc-data/chat-attachments/<id>). El backend la crea
    // si no existía (sin adjuntos aún) y devuelve la ruta relativa al home.
    async function openChatFolder(c) {
      try {
        const res = await fetch(`/api/chat/folder?id=${encodeURIComponent(c.id)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.rel) throw new Error(data.error || t('sessions.folder.error', 'No se pudo abrir la carpeta.'));
        openExplorer(data.rel);
      } catch (e) {
        dialog.alertDialog({ title: t('sessions.folder.title', 'Carpeta del chat'), message: e.message });
      }
    }

    // Reabre el motor de una conversación para que tome cambios de código
    // nuevos tras un deploy (mata el runner viejo y levanta uno fresco sobre la
    // MISMA sesión: conserva el contexto, no cierra el chat). Confirm SOLO si
    // hay un turno en curso (se cortaría).
    async function reopenChat(c) {
      if (c.status === 'working') {
        const ok = await dialog.confirmDialog({
          title: t('sessions.reopen.title', 'Reabrir para cambios'),
          message: t('sessions.reopen.msg', '"{title}" está trabajando ahora: reabrir el motor corta el turno en curso. La conversación y su contexto se conservan.', { title: c.title }),
          confirmLabel: t('sessions.reopen.confirm', 'Reabrir igual'),
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
        if (!res.ok) throw new Error(data.error || t('sessions.reopen.error', 'No se pudo reabrir el motor.'));
        if (data.chat) syncConversation(data.chat);
      } catch (e) {
        dialog.alertDialog({ title: t('sessions.reopen.title', 'Reabrir para cambios'), message: e.message });
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
        dialog.alertDialog({ title: t('sessions.world.title', 'Mover a otro mundo'), message: t('sessions.world.noDests', 'No hay otro mundo conocido para mudar esta conversación.') });
        return;
      }
      const m = dialog.openModal({ title: t('sessions.world.title', 'Mover a otro mundo'), width: 360 });
      m.body.innerHTML = `
        <p class="sess-plumbing">${t('sessions.world.info', 'La MISMA conversación se mueve con TODO su contexto al mundo elegido (no se copia ni queda en Archivados). Su tarjeta pasa al grupo de ese mundo y ahí usa las herramientas de ESE mundo (Regla 12: un mundo a la vez).')}</p>
        <label class="sess-plumbing" style="display:block;margin:.2rem 0 .3rem">${t('sessions.world.taskLabel', '🎯 Tarea para el mundo destino')} <span style="opacity:.7">${t('sessions.world.taskOpt', '(opcional; se le inyecta al llegar)')}</span></label>
        <textarea class="dlg-input" data-task rows="2" placeholder="${t('sessions.world.taskPlaceholder', 'Ej: registrá estos pendientes de WhatsApp como tickets en Tolkien')}"></textarea>
        <div class="sess-menu-list" style="margin-top:.5rem">${dests.map((p) =>
          `<button class="btn-ghost sess-menu-item" data-rel="${p.rel}"><span>${t('sessions.world.moveTo', 'Mover a {label}', { label: p.label })}</span></button>`).join('')}</div>
        <div class="sess-pick-actions"><button class="btn-ghost" data-act="cancel">${t('sessions.cancel', 'Cancelar')}</button></div>`;
      m.body.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
      m.body.querySelectorAll('[data-rel]').forEach((btn) => btn.addEventListener('click', async () => {
        const rel = btn.getAttribute('data-rel');
        const task = (m.body.querySelector('[data-task]')?.value || '').trim();
        const label = dests.find((p) => p.rel === rel)?.label || rel;
        const ok = await dialog.confirmDialog({
          title: t('sessions.world.title', 'Mover a otro mundo'),
          message: t('sessions.world.confirmMsg', 'Mover "{title}" a {label}: la conversación pasa a {label} con el mismo contexto. ¿Seguir?', { title: c.title, label }),
          confirmLabel: t('sessions.world.moveTo', 'Mover a {label}', { label }),
        });
        if (!ok) return;
        m.close();
        try {
          const res = await fetch('/api/chat/handoff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: c.id, cwd: rel, ...(task ? { task } : {}) }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || t('sessions.world.error', 'No se pudo mover la conversación.'));
          // MISMA tarjeta (mismo id): syncConversation la actualiza y refresh la
          // re-agrupa en el mundo destino. Si estaba abierta, sigue enfocada.
          if (data.chat) syncConversation(data.chat);
        } catch (e) {
          dialog.alertDialog({ title: t('sessions.world.title', 'Mover a otro mundo'), message: e.message });
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
    // PLAN-519 F3: selector REDISEÑADO — 2 toggles [AutoTux][Tándem] + columnas
    // Cloud/Codex + leyenda dinámica. La ARQUITECTURA se elige arriba; Manual
    // EMERGE de Tándem sin Codex. Mapea al backend: AutoTux→{model:'auto',
    // fableCeiling} · Tándem→{model:'tandem',tandem:{...}} · Manual→{model:<cloud>,
    // effort}. (Secciones apiladas en vez de 3 columnas: mejor en el modal angosto
    // y en móvil — convención colapsable del proyecto; funcionalmente idéntico.)
    function pickModelForChat(c) {
      const m = dialog.openModal({ title: t('sessions.model.title', 'Modelo y protocolo'), width: 460 });
      const CLOUD = [['haiku', 'Haiku'], ['sonnet', 'Sonnet'], ['opus', 'Opus 5'], ['fable', 'Fable']];
      const CODEX = [['', t('sessions.model.codexNone', 'Ninguno (Manual)')], ...CODEX_MODEL_OPTIONS];
      const EFFS = [['low', t('sessions.eff.low', 'Bajo')], ['medium', t('sessions.eff.medium', 'Medio')], ['high', t('sessions.eff.high', 'Alto')], ['xhigh', t('sessions.eff.xhigh', 'Muy alto')], ['max', t('sessions.eff.max', 'Máximo')], ['ultra', t('sessions.eff.ultra', 'Ultra')]];
      const CLOUD_EFFS = ['low', 'medium', 'high', 'xhigh', 'max'];
      const CLOUDSET = new Set(['haiku', 'sonnet', 'opus', 'fable']);
      // Estado inicial derivado de la conversación.
      let mode = 'autotux'; let fable = false;
      let rModel = 'opus'; let rEffort = 'medium'; let cModel = ''; let cEffort = 'high';
      if (c.modelChoice === 'auto') { mode = 'autotux'; fable = !!c.fableCeiling; }
      else if (c.modelChoice === 'tandem') { mode = 'tandem'; rModel = CLOUDSET.has(c.model) ? c.model : 'opus'; rEffort = c.effort || 'medium'; cModel = c.tandemCodex?.model || DEFAULT_CODEX_MODEL; cEffort = c.tandemCodex?.effort || 'high'; }
      else { mode = 'tandem'; rModel = CLOUDSET.has(c.modelChoice) ? c.modelChoice : (CLOUDSET.has(c.model) ? c.model : 'opus'); rEffort = c.effort || 'medium'; cModel = ''; }

      const legend = () => {
        if (mode === 'autotux') return { t: t('sessions.model.legendAutotux', '🤖 Protocolo AutoTux{fable}', { fable: fable ? t('sessions.model.withFable', ' · con Fable') : '' }), cls: 'autotux' };
        if (cModel) return { t: t('sessions.model.legendTandem', '🤝 Protocolo Tándem'), cls: 'tandem' };
        return { t: t('sessions.model.legendManual', '🔵 Manual'), cls: 'manual' };
      };
      const opts = (list, sel, attr) => list.map(([v, l]) =>
        `<button class="mp-opt${v === sel ? ' mp-opt--on' : ''}" data-${attr}="${v}">${l}${v === sel ? icon('check', { size: 12 }) : ''}</button>`).join('');
      const effSel = (id, sel, allowed) => `<select class="mp-eff" data-eff="${id}">${EFFS.filter(([v]) => allowed.includes(v)).map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('')}</select>`;

      const paint = () => {
        const lg = legend();
        let bodyH = '';
        if (mode === 'autotux') {
          bodyH = `
            <div class="sess-pick-sec">
              <div class="sess-pick-h">${icon('sparkle', { size: 14 })} ${t('sessions.model.cloudAuto', 'Cloud · router automático')}</div>
              <p class="mp-info">${t('sessions.model.autoInfo', 'Sube y baja solo entre <b>Haiku · Sonnet · Opus</b> según cada turno. El esfuerzo lo maneja el router.')}</p>
              <label class="mp-check"><input type="checkbox" data-fable ${fable ? 'checked' : ''}> ${t('sessions.model.fableCheck', 'Incluir <b>Fable</b> como techo (opcional)')}</label>
            </div>
            <div class="sess-pick-sec mp-off">
              <div class="sess-pick-h">${icon('gear', { size: 14 })} ${t('sessions.model.codexOff', 'Codex — no participa en AutoTux')}</div>
            </div>`;
        } else {
          bodyH = `
            <div class="sess-pick-sec">
              <div class="sess-pick-h">${icon('sparkle', { size: 14 })} ${t('sessions.model.cloudReasoner', 'Cloud · razonador')}</div>
              <div class="mp-opts">${opts(CLOUD, rModel, 'rmodel')}</div>
              <div class="mp-effrow">${t('sessions.model.effort', 'Esfuerzo:')} ${effSel('r', rEffort, CLOUD_EFFS)}</div>
            </div>
            <div class="sess-pick-sec">
              <div class="sess-pick-h">${icon('gear', { size: 14 })} ${t('sessions.model.codexExec', 'Codex · ejecutor')}</div>
              <div class="mp-opts">${opts(CODEX, cModel, 'cmodel')}</div>
              ${cModel ? `<div class="mp-effrow">${t('sessions.model.effort', 'Esfuerzo:')} ${effSel('c', cEffort, codexEffortsFor(cModel))}</div>` : `<p class="mp-info">${t('sessions.model.manualInfo', 'Sin Codex = <b>Manual</b> (Claude solo, sin delegación).')}</p>`}
            </div>`;
        }
        m.body.innerHTML = `
          <div class="mp-legend mp-legend--${lg.cls}">${lg.t}</div>
          <div class="mp-toggles">
            <button class="mp-toggle${mode === 'autotux' ? ' mp-toggle--on' : ''}" data-mode="autotux">${t('sessions.model.toggleAutotux', '🤖 AutoTux')}</button>
            <button class="mp-toggle${mode === 'tandem' ? ' mp-toggle--on' : ''}" data-mode="tandem">${t('sessions.model.toggleTandem', '🤝 Tándem / Manual')}</button>
          </div>
          ${bodyH}
          <p class="sess-plumbing">${t('sessions.model.footer', 'AutoTux rutea el modelo solo (esfuerzo automático). Tándem: Claude razona, Codex ejecuta. Sin Codex = Manual. El cambio se aplica al reabrir la conversación o en el próximo turno tras dormir.')}</p>
          <div class="sess-pick-actions">
            <button class="btn-ghost" data-act="cancel">${t('sessions.cancel', 'Cancelar')}</button>
            <button class="btn" data-act="apply">${t('sessions.model.apply', 'Aplicar')}</button>
          </div>`;
        m.body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; paint(); }));
        m.body.querySelectorAll('[data-rmodel]').forEach((b) => b.addEventListener('click', () => { rModel = b.dataset.rmodel; paint(); }));
        m.body.querySelectorAll('[data-cmodel]').forEach((b) => b.addEventListener('click', () => {
          cModel = b.dataset.cmodel;
          // `ultra` solo existe en sol/terra: al pasar a un modelo que no lo
          // soporta, el esfuerzo cae al default en vez de mandar un valor inválido.
          const allowed = codexEffortsFor(cModel);
          if (cModel && !allowed.includes(cEffort)) cEffort = allowed.includes('high') ? 'high' : allowed[allowed.length - 1];
          paint();
        }));
        const fb = m.body.querySelector('[data-fable]'); if (fb) fb.addEventListener('change', () => { fable = fb.checked; paint(); });
        const re = m.body.querySelector('[data-eff="r"]'); if (re) re.addEventListener('change', () => { rEffort = re.value; });
        const ce = m.body.querySelector('[data-eff="c"]'); if (ce) ce.addEventListener('change', () => { cEffort = ce.value; });
        m.body.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
        m.body.querySelector('[data-act="apply"]').addEventListener('click', apply);
      };
      const apply = async () => {
        let payload;
        if (mode === 'autotux') payload = { id: c.id, model: 'auto', fableCeiling: fable };
        else if (cModel) payload = { id: c.id, model: 'tandem', tandem: { reasonerModel: rModel, reasonerEffort: rEffort, codexModel: cModel, codexEffort: cEffort } };
        else payload = { id: c.id, model: rModel, effort: rEffort }; // Manual
        m.close();
        try {
          const res = await fetch('/api/chat/model', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || t('sessions.model.error', 'No se pudo cambiar el modelo.'));
          syncConversation(data.chat);
          await refresh();
          const chip = listEl.querySelector(`[data-key="chat:${c.id}"] .sess-model`);
          if (chip) chip.textContent = chatModelLabel(data.chat || c);
        } catch (e) {
          dialog.alertDialog({ title: t('sessions.model.title', 'Modelo y protocolo'), message: e.message });
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
        if (!res.ok) throw new Error(data.error || t('sessions.mode.error', 'No se pudo cambiar de modo.'));
        syncConversation(data.chat); // si la pestaña está abierta, reconstruye la vista
        refresh();
      } catch (e) {
        dialog.alertDialog({ title: t('sessions.mode.title', 'Cambio de modo'), message: e.message });
      }
    }

    async function renameChat(c) {
      const name = await dialog.promptDialog({
        title: t('sessions.renameChat.title', 'Renombrar conversación'),
        message: t('sessions.rename.msg', 'Nombre para mostrar (vacío = volver al nombre de la carpeta).'),
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
        if (!res.ok) throw new Error(data.error || t('sessions.rename.error', 'No se pudo renombrar.'));
        syncConversation(data.chat);
      } catch (e) {
        dialog.alertDialog({ title: t('sessions.renameChat.title', 'Renombrar conversación'), message: e.message });
      } finally {
        refresh();
      }
    }

    async function closeChat(c) {
      const ok = await dialog.confirmDialog({
        title: t('sessions.close.title', 'Cerrar conversación'),
        message: t('sessions.close.msg', 'Se cierra "{title}" (el historial queda en el transcript para retomar en el futuro).', { title: c.title }),
        confirmLabel: t('sessions.close.confirm', 'Cerrar'),
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
          dialog.alertDialog({ title: t('sessions.close.title', 'Cerrar conversación'), message: data.error || t('sessions.close.error', 'No se pudo cerrar la conversación.') });
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
      menuBtn.title = t('sessions.options', 'Opciones');
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
        ${canAdopt ? `<button class="cwc-popup-item" data-act="adopt">${icon('sparkle', { size: 15 })}<span>${t('sessions.menu.toChat', 'Pasar a Chat')}</span></button>` : ''}
        <button class="cwc-popup-item" data-act="rename">${icon('edit', { size: 15 })}<span>${t('sessions.menu.rename', 'Renombrar')}</span></button>
        <button class="cwc-popup-item" data-act="model">${icon('sparkle', { size: 15 })}<span>${t('sessions.menu.model', 'Cambiar modelo')}</span></button>
        <button class="cwc-popup-item danger" data-act="kill">${icon('trash', { size: 15 })}<span>${t('sessions.menu.kill', 'Matar sesión')}</span></button>`;
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
        title: t('sessions.adopt.title', 'Pasar a Chat'),
        message: t('sessions.adopt.msg', 'Se cierra el Claude que corre en la terminal "{name}" (Ctrl-C×2, verificado) y la conversación continúa como Chat con toda su memoria. La terminal queda como shell.', { name: displayName(s) }),
        confirmLabel: t('sessions.adopt.title', 'Pasar a Chat'),
      });
      if (!ok) return;
      try {
        const res = await fetch('/api/chat/adopt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ terminalId: s.name.replace(/^cwc-/, '') }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('sessions.adopt.error', 'No se pudo pasar a Chat.'));
        openChatView(data.chat);
        refresh();
      } catch (e) {
        dialog.alertDialog({ title: t('sessions.adopt.title', 'Pasar a Chat'), message: e.message });
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
        title: t('sessions.rename.title', 'Renombrar sesión'),
        message: t('sessions.rename.msg', 'Nombre para mostrar (vacío = volver al nombre de la carpeta).'),
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
          dialog.alertDialog({ title: t('sessions.rename.title', 'Renombrar sesión'), message: data.error || t('sessions.rename.errorSess', 'No se pudo renombrar la sesión.') });
        }
      } finally {
        refresh();
      }
    }

    function pickModel(s) {
      const m = dialog.openModal({ title: t('sessions.pickModel.title', 'Modelo de esta sesión'), width: 320 });
      m.body.innerHTML = `
        <div class="sess-menu-list">
          ${TUI_MODEL_OPTIONS.map(([v, l]) => `<button class="btn-ghost sess-menu-item" data-model="${v}"><span>${t('sessions.pickModel.model.' + v, l)}</span></button>`).join('')}
        </div>
        <p class="sess-plumbing">${t('sessions.pickModel.note', 'Se envía /model a la sesión (solo tiene efecto si corre Claude Code). AutoTux todavía no gestiona sesiones de terminal.')}</p>`;
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
              dialog.alertDialog({ title: t('sessions.model.short', 'Modelo'), message: d.error || t('sessions.model.error', 'No se pudo cambiar el modelo.') });
            }
          } catch {
            dialog.alertDialog({ title: t('sessions.model.short', 'Modelo'), message: t('sessions.model.error', 'No se pudo cambiar el modelo.') });
          }
        });
      }
    }

    async function kill(s) {
      const ok = await dialog.confirmDialog({
        title: t('sessions.kill.title', 'Matar sesión'),
        message: s.owned
          ? t('sessions.kill.msgOwned', 'Se cierra definitivamente "{name}" y todo lo que corra adentro.', { name: displayName(s) })
          : t('sessions.kill.msgExternal', '"{name}" es una sesión externa ({plumbing}). Matarla puede interrumpir algo que estés usando por fuera.', { name: displayName(s), plumbing: plumbing(s) }),
        confirmLabel: t('sessions.kill.confirm', 'Matar'),
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
          dialog.alertDialog({ title: t('sessions.title', 'Sesiones'), message: d.error || t('sessions.kill.error', 'No se pudo matar la sesión.') });
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
        const data = await fetchAll();
        const { sessions, chats } = data;
        lastData = { sessions, chats, runners: runnerInfo(data) };
        syncBgButton(lastData);
        if (bgModal) renderBgModal(lastData);
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
            if (modeEl) { modeEl.textContent = isTui ? 'TUI' : ''; modeEl.title = isTui ? t('sessions.mode.terminal', 'En modo Terminal (TUI)') : t('sessions.mode.chat', 'En modo Chat'); }
            // Refrescar el chip de modelo: con motor vivo el cambio de modelo se
            // confirma por eco (this.model queda stale un instante), así que sin
            // esto el poll nunca reflejaba el modelo nuevo hasta un rebuild total.
            const chatModelEl = cardEl.querySelector('.sess-model');
            if (chatModelEl) chatModelEl.textContent = chatModelLabel(c);
            syncLiveText(cardEl, c);
            syncKids(cardEl, c);
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
    if (liveTickTimer) clearInterval(liveTickTimer);
    liveTickTimer = setInterval(tickLiveTimes, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) updateInPlace(); });

    refresh();
  },
};
