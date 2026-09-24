import { renderMarkdown } from '../ui/markdown.js';
import { icon } from '../ui/icons.js';
import { t } from '../ui/i18n.js';

let dispose = () => {};
let mountGeneration = 0;
const UMBRAL_FONDO_PX = 120;
const DURACION_SCROLL_PROGRAMATICO_MS = 800;
const MAX_MENSAJE = 4000;
const REACCIONES = [
  ['👍', t('cabina.salas.reactionAgree', 'de acuerdo')],
  ['❓', t('cabina.salas.reactionDoubt', 'tengo dudas')],
  ['🔴', t('cabina.salas.reactionBlocker', 'esto bloquea')],
];

function routeId() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const encoded = path.split('/')[1];
  if (!encoded) return new URLSearchParams(query).get('id');
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

function peerToneFor(username) {
  let hash = 0;
  for (const ch of String(username || '')) hash = ((hash * 31) + ch.codePointAt(0)) >>> 0;
  return `peer-${(hash % 6) + 1}`;
}

function stripAddressees(text, { final = false } = {}) {
  const raw = String(text ?? '');
  const newline = raw.indexOf('\n');
  if (newline !== -1) {
    const match = raw.slice(0, newline).match(/^@para:[ \t]*(.*)$/i);
    if (match) {
      const addressees = match[1].split(',').map((name) => name.trim()).filter(Boolean);
      return { addressees, text: raw.slice(newline + 1), pending: false };
    }
  } else if (!final) {
    const lower = raw.toLowerCase();
    if ('@para:'.startsWith(lower) || lower.startsWith('@para:')) {
      return { addressees: null, text: '', pending: true };
    }
  }
  // Si una respuesta final trae una cabecera inesperada, es mejor mostrarla
  // una vez que ocultar por accidente la respuesta completa.
  return { addressees: null, text: raw, pending: false };
}

function node(tag, className = '', text = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = String(text);
  return el;
}

function makeButton(className, text, title = '') {
  const el = node('button', className, text);
  el.type = 'button';
  if (title) el.title = title;
  return el;
}

function floatingPanelIcon(name) {
  const body = name === 'acta'
    ? '<path d="M3 3h10M3 8h10M3 13h10"></path><path d="M1 3h.01M1 8h.01M1 13h.01"></path>'
    : '<path d="M3 1h7l3 3v11H3z"></path><path d="M10 1v4h3M6 9h4M6 12h4"></path>';
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function identityName(identity) {
  return identity?.type === 'token' ? identity.host : identity?.username;
}

function peopleNames(participants, owner) {
  return [...new Set([owner, ...(Array.isArray(participants) ? participants.map((p) => p?.user) : [])]
    .map((name) => String(name || '').trim()).filter(Boolean))];
}

function excerpt(text, limit = 200) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function appendMarkdown(parent, text, mentions = []) {
  parent.replaceChildren(renderMarkdown(String(text ?? '')));
  const names = [...new Set(mentions.map((name) => String(name || '').trim()).filter(Boolean))];
  if (!names.length) return;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const matcher = new RegExp(`@(${escaped.join('|')})(?![A-Za-z0-9._-])`, 'gi');
  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
  const found = [];
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    if (!textNode.parentElement?.closest('code, pre, a') && matcher.test(textNode.data)) found.push(textNode);
    matcher.lastIndex = 0;
  }
  for (const textNode of found) {
    const fragment = document.createDocumentFragment();
    let from = 0;
    for (const match of textNode.data.matchAll(matcher)) {
      fragment.append(textNode.data.slice(from, match.index));
      fragment.append(node('mark', '', match[0]));
      from = match.index + match[0].length;
    }
    fragment.append(textNode.data.slice(from));
    textNode.replaceWith(fragment);
  }
}

function openRoom(id) {
  location.hash = `#/salas/${encodeURIComponent(String(id))}`;
}

async function mountList(el, ctx, isCurrent) {
  el.innerHTML = `
    <section class="cab-main-inner">
      <header class="cab-page-header">
        <div><h1 class="cab-title">${t('cabina.salas.sharedRooms', 'Salas compartidas')}</h1><p class="cab-subtitle">${t('cabina.salas.sharedRoomsDescription', 'Un espacio para trabajar con otras personas; la IA solo lee cuando el grupo se lo pide.')}</p></div>
        <button class="cab-btn cab-btn--hot" type="button" data-create-open>${t('cabina.salas.openRoom', 'Abrir una sala')}</button>
        <button class="cab-help-btn" type="button" data-cabina-help title="${t('cabina.salas.screenHelp', 'Cómo se usa esta pantalla')}" aria-label="${t('cabina.salas.screenHelp', 'Cómo se usa esta pantalla')}">${icon('help', { size: 16 })}</button>
      </header>
      <form class="cab-sala-invite" data-create-form hidden>
        <label>${t('cabina.salas.roomName', 'Nombre de la sala')} <input class="cab-sala-input" maxlength="120" autocomplete="off" data-create-title></label>
        <button class="cab-btn cab-btn--hot" type="submit">${t('cabina.salas.createRoom', 'Crear sala')}</button>
        <button class="cab-btn" type="button" data-create-cancel>${t('cabina.salas.cancel', 'Cancelar')}</button>
      </form>
      <div class="cab-fs-tree cab-fs-salas-grid" data-list><div class="cab-view-state cab-view-state--loading"><span class="cab-spinner" aria-hidden="true"></span><span>${t('cabina.salas.loadingRooms', 'Cargando salas…')}</span></div></div>
    </section>`;

  const root = el.querySelector('.cab-main-inner');
  const list = el.querySelector('[data-list]');
  const form = el.querySelector('[data-create-form]');
  const input = el.querySelector('[data-create-title]');
  let active = true;
  let loading = false;
  let creating = false;
  let rooms = [];
  let timer = null;

  const showCreate = () => { form.hidden = false; input.focus(); };
  const hideCreate = () => { form.hidden = true; form.reset(); };
  const stateOf = (room, unread) => {
    if (room.status === 'working' && room.alive) return 'working';
    if (room.alive && unread) return 'waiting';
    return 'resting';
  };
  const stateLabel = (state) => {
    if (state === 'working') return t('cabina.salas.aiWorking', 'Cucho está trabajando');
    if (state === 'waiting') return t('cabina.salas.newMessagesAvailable', 'Tenés mensajes nuevos');
    return t('cabina.salas.resting', 'En reposo');
  };
  const stateIcon = (state) => {
    if (state === 'working') return '<span class="cab-status-bars" aria-hidden="true"><i></i><i></i><i></i></span>';
    return ctx.icon(state === 'waiting' ? 'warning' : 'rest');
  };
  const paint = () => {
    if (!active) return;
    list.replaceChildren();
    if (!rooms.length) {
      const empty = node('div', 'cab-fs-empty');
      empty.append(
        node('strong', '', t('cabina.salas.noRoomsYet', 'Todavía no hay salas compartidas.')),
        node('p', '', t('cabina.salas.noRoomsDescription', 'Una sala reúne al grupo y deja que ustedes decidan cuándo compartir la conversación con Cucho.')),
      );
      const first = makeButton('cab-btn cab-btn--hot', t('cabina.salas.openFirstRoom', 'Abrir la primera sala'));
      first.dataset.createOpen = '';
      empty.appendChild(first);
      list.appendChild(empty);
      return;
    }
    for (const room of rooms) {
      const unread = Math.max(0, Number(room.salaUnread) || 0);
      const state = stateOf(room, unread);
      const card = node('div', `cab-fs-item cab-fs-item--${state}`);
      card.dataset.roomId = String(room.id || '');
      const open = node('div', 'cab-fs-item-main');
      open.setAttribute('role', 'button');
      open.tabIndex = 0;
      open.dataset.openRoom = '';
      open.insertAdjacentHTML('beforeend', icon('room', { className: 'cab-fs-icon' }));
      const peers = node('span', 'cab-sala-peers');
      peers.setAttribute('aria-hidden', 'true');
      const names = peopleNames(room.participants, room.salaOwner || room.owner);
      for (const name of names) {
        const dot = node('i', `cab-peer-dot ${peerToneFor(name)}`);
        dot.setAttribute('aria-hidden', 'true');
        peers.appendChild(dot);
      }
      const people = names.length === 1
        ? t('cabina.salas.peopleCount.one', '{count} persona + {aiLabel}', { count: names.length, aiLabel: room.salaAiLabel || 'Cucho' })
        : t('cabina.salas.peopleCount.many', '{count} personas + {aiLabel}', { count: names.length, aiLabel: room.salaAiLabel || 'Cucho' });
      const meta = room.lastActivity
        ? t('cabina.salas.lastActivity', '{people} · Última actividad: {date}', { people, date: ctx.fmtDate(room.lastActivity) })
        : people;
      const copy = node('span', 'cab-fs-item-copy');
      copy.append(
        node('span', 'cab-fs-item-name', room.title || t('cabina.salas.untitledRoom', 'Sala sin título')),
        node('span', 'cab-fs-item-meta', meta),
      );
      open.appendChild(copy);
      const status = node('span', 'cab-sala-card-status');
      status.appendChild(peers);
      const chip = node('span', `cab-status-chip cab-status-chip--${state}`);
      chip.insertAdjacentHTML('beforeend', stateIcon(state));
      chip.append(stateLabel(state));
      status.appendChild(chip);
      if (unread) {
        const mention = Number(room.salaMentions) > 0;
        status.appendChild(node(
          'span',
          `cab-sala-card-unread${mention ? ' cab-sala-card-unread--mention' : ''}`,
          mention
            ? t('cabina.salas.unreadMention', '{count} nuevo{s} · te mencionaron', { count: unread, s: unread === 1 ? '' : 's' })
            : t('cabina.salas.unread', '{count} nuevo{s}', { count: unread, s: unread === 1 ? '' : 's' }),
        ));
      }
      open.appendChild(status);
      card.appendChild(open);
      list.appendChild(card);
    }
  };
  const refresh = async () => {
    if (!active || loading) return;
    loading = true;
    try {
      const data = await ctx.api.get('/api/chat/list');
      if (!active || !isCurrent()) return;
      rooms = (Array.isArray(data?.chats) ? data.chats : [])
        .filter((chat) => chat?.isSala === true && !chat.archived)
        .sort((a, b) => (Number(b.lastActivity) || 0) - (Number(a.lastActivity) || 0));
      paint();
    } catch (error) {
      if (!rooms.length && active) {
        const state = node('div', 'cab-view-state cab-view-state--error');
        state.append(node('strong', '', t('cabina.salas.loadRoomsError', 'No se pudieron cargar las salas.')), node('span', '', error.message));
        list.replaceChildren(state);
      } else if (active) ctx.toast(t('cabina.salas.refreshListError', 'No se pudo actualizar la lista: {error}', { error: error.message }));
    } finally { loading = false; }
  };
  const onClick = (event) => {
    const room = event.target.closest('[data-open-room]')?.closest('[data-room-id]');
    if (room) return openRoom(room.dataset.roomId);
    if (event.target.closest('[data-create-open]')) showCreate();
    if (event.target.closest('[data-create-cancel]')) hideCreate();
  };
  const onKeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const room = event.target.closest('[data-open-room]')?.closest('[data-room-id]');
    if (!room) return;
    event.preventDefault();
    openRoom(room.dataset.roomId);
  };
  const onSubmit = async (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title || creating) {
      if (!title) ctx.toast(t('cabina.salas.roomNameRequired', 'Escribí un nombre para la sala.'));
      return;
    }
    creating = true;
    form.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
    try {
      const data = await ctx.api.post('/api/chat/create', { sala: true, title });
      if (!data?.chat?.id) throw new Error(t('cabina.salas.createdRoomOpenError', 'La sala se creó, pero no se pudo abrir.'));
      openRoom(data.chat.id);
    } catch (error) {
      if (active) ctx.toast(error.message || t('cabina.salas.createRoomError', 'No se pudo crear la sala.'));
    } finally {
      creating = false;
      form.querySelectorAll('button, input').forEach((control) => { control.disabled = false; });
    }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  form.addEventListener('submit', onSubmit);
  dispose = () => {
    active = false;
    window.clearInterval(timer);
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKeydown);
    form.removeEventListener('submit', onSubmit);
  };
  await refresh();
  if (active && isCurrent()) timer = window.setInterval(refresh, 5000);
}

async function mountDetail(el, ctx, id, isCurrent) {
  let active = true;
  dispose = () => { active = false; };
  const [data, identity] = await Promise.all([ctx.api.get('/api/chat/list'), ctx.api.get('/api/whoami')]);
  if (!active || !isCurrent()) return;
  const room = (Array.isArray(data?.chats) ? data.chats : [])
    .find((chat) => chat?.id === id && chat.isSala === true && !chat.archived);
  if (!room) throw new Error(t('cabina.salas.roomUnavailable', 'La sala no existe o no está disponible para esta cuenta.'));

  el.innerHTML = `
    <section class="cab-main-inner cab-sala">
      <header class="cab-sala-head">
        <button class="cab-sala-back cab-btn" type="button" data-back>${ctx.icon('back')} ${t('cabina.salas.rooms', 'Salas')}</button>
        <div><h1 class="cab-sala-title" data-title></h1><div class="cab-sala-peers" data-peers></div></div>
        <div class="cab-sala-actions" data-actions></div>
      </header>
      <div class="cab-sala-invite" data-invite hidden></div>
      <div class="cab-sala-invite" data-leave-confirm hidden></div>
      <details class="cab-sala-acta" data-acta hidden>
        <summary class="cab-sala-acta-head">${t('cabina.salas.minutesSummary', 'Acta de la sala — el resumen de lo acordado')} <span class="cab-sala-acta-stale" data-acta-stale hidden>${t('cabina.salas.outdated', 'Desactualizada')}</span></summary>
        <div class="cab-sala-acta-body" data-acta-body></div>
      </details>
      <div class="cab-sala-thread" data-thread><div class="cab-view-state cab-view-state--loading"><span class="cab-spinner" aria-hidden="true"></span><span>${t('cabina.salas.loadingRoom', 'Cargando la sala…')}</span></div></div>
      <footer class="cab-sala-foot">
        <form class="cab-sala-composer" data-composer>
          <div class="cab-sala-pending">
            <span class="cab-sala-pending-count" data-pending-count></span>
            <button class="cab-sala-cut-btn" type="button" data-cut title="${t('cabina.salas.sendToAiTitle', 'Esto sí le pide trabajo a la IA.')}">${t('cabina.salas.sendToAi', '✦ Enviar a la IA')}</button>
            <div class="cab-sala-invite" data-stop-confirm hidden></div>
          </div>
          <div class="cab-sala-reply-chip" data-reply-chip hidden></div>
          <textarea class="cab-sala-input" rows="3" maxlength="4000" placeholder="${t('cabina.salas.messagePlaceholder', 'Escribí a la sala. Usá @cucho para marcar una pregunta para la IA.')}" aria-label="${t('cabina.salas.roomMessage', 'Mensaje para la sala')}" data-input></textarea>
          <div class="cab-sala-mentions" data-mentions hidden></div>
          <span class="cab-sala-pending-count" data-char-count hidden></span>
          <button class="cab-sala-say-btn" type="submit" title="${t('cabina.salas.publishTitle', 'Publicar en la sala no le pide trabajo a la IA.')}">${ctx.icon('send')} ${t('cabina.salas.sendToRoom', 'Enviar a la sala')}</button>
        </form>
      </footer>
      <aside class="cab-panel-dock" aria-label="${t('cabina.salas.roomPanels', 'Paneles de la sala')}" data-panel-dock>
        <section class="cab-floating-panel cab-floating-panel--acta" id="cab-floating-acta-sala" data-floating-panel="acta" role="dialog" aria-label="${t('cabina.salas.roomIndex', 'Índice de la sala')}" aria-hidden="true" tabindex="-1" inert>
          <button class="cab-floating-panel-close" type="button" data-panel-close="acta" aria-label="${t('cabina.salas.closeIndex', 'Cerrar Índice')}" title="${t('cabina.salas.closeIndex', 'Cerrar Índice')}">×</button>
          <div class="cab-floating-panel-content"><section data-cabina-panel="acta"></section></div>
        </section>
        <section class="cab-floating-panel cab-floating-panel--artefactos" id="cab-floating-artefactos-sala" data-floating-panel="artefactos" role="dialog" aria-label="${t('cabina.salas.roomArtifacts', 'Artefactos de la sala')}" aria-hidden="true" tabindex="-1" inert>
          <button class="cab-floating-panel-close" type="button" data-panel-close="artefactos" aria-label="${t('cabina.salas.closeArtifacts', 'Cerrar Artefactos')}" title="${t('cabina.salas.closeArtifacts', 'Cerrar Artefactos')}">×</button>
          <div class="cab-floating-panel-content"><section data-cabina-panel="artefactos"></section></div>
        </section>
        <div class="cab-panel-launchers">
          <button class="cab-panel-launcher" type="button" data-panel-toggle="acta" aria-controls="cab-floating-acta-sala" aria-expanded="false" aria-label="${t('cabina.salas.openIndex', 'Abrir Índice')}" title="${t('cabina.salas.index', 'Índice')}">
            ${floatingPanelIcon('acta')}<span class="cab-panel-count" data-panel-count="acta" hidden></span>
          </button>
          <button class="cab-panel-launcher" type="button" data-panel-toggle="artefactos" aria-controls="cab-floating-artefactos-sala" aria-expanded="false" aria-label="${t('cabina.salas.openArtifacts', 'Abrir Artefactos')}" title="${t('cabina.salas.artifacts', 'Artefactos')}">
            ${floatingPanelIcon('artefactos')}<span class="cab-panel-count" data-panel-count="artefactos" hidden></span>
          </button>
        </div>
      </aside>
      <button class="cab-jump-latest" type="button" data-jump-latest aria-label="${t('cabina.salas.goToLastMessage', 'Ir al último mensaje')}" aria-hidden="true" tabindex="-1">
        <span aria-hidden="true">↓</span>
        <span>${t('cabina.salas.goToLast', 'Ir al último')}</span>
        <span class="cab-jump-latest-count" data-jump-latest-count hidden></span>
      </button>
    </section>`;

  const root = el.querySelector('.cab-sala');
  const title = el.querySelector('[data-title]');
  const peersEl = el.querySelector('[data-peers]');
  const actions = el.querySelector('[data-actions]');
  const invitePanel = el.querySelector('[data-invite]');
  const leavePanel = el.querySelector('[data-leave-confirm]');
  const actaEl = el.querySelector('[data-acta]');
  const actaStale = el.querySelector('[data-acta-stale]');
  const actaBody = el.querySelector('[data-acta-body]');
  const thread = el.querySelector('[data-thread]');
  const pendingCount = el.querySelector('[data-pending-count]');
  const cutButton = el.querySelector('[data-cut]');
  const stopPanel = el.querySelector('[data-stop-confirm]');
  const form = el.querySelector('[data-composer]');
  const input = el.querySelector('[data-input]');
  const mentionsEl = el.querySelector('[data-mentions]');
  const replyChip = el.querySelector('[data-reply-chip]');
  const charCount = el.querySelector('[data-char-count]');
  const panelDock = el.querySelector('[data-panel-dock]');
  const jumpLatest = el.querySelector('[data-jump-latest]');
  const jumpLatestCount = el.querySelector('[data-jump-latest-count]');
  const scrollHost = el.closest('.cab-main');
  const scrollsInWindow = !scrollHost || getComputedStyle(scrollHost).overflowY === 'visible';
  const scrollTarget = scrollsInWindow ? window : scrollHost;
  const scrollElement = scrollsInWindow ? document.scrollingElement : scrollHost;
  const me = identityName(identity) || '';

  let socket = null;
  let reconnectTimer = null;
  let readTimer = null;
  let scrollFrame = null;
  let scrollProgrammatic = null;
  let scrollProgrammaticTimer = null;
  let events = [];
  let participants = room.participants || [];
  let owner = room.salaOwner || room.owner || '';
  let aiName = room.salaAiName || 'cucho';
  let aiLabel = room.salaAiLabel || 'Cucho';
  let status = room.status || 'waiting';
  let acta = null;
  let streamText = '';
  let cutPending = false;
  let connected = false;
  let reply = null;
  let unreadStartIndex = -1;
  let lastMarkedTs = 0;
  let stuckToBottom = true;
  let newMessages = 0;
  let streamingCountedAsNew = false;
  let typingSentAt = 0;
  let openPanelName = null;
  let highlighted = null;
  let highlightTimer = null;
  const panels = [];
  const panelCountObservers = [];
  const typingPeople = new Set();
  const typingTimers = new Map();
  title.textContent = room.title || t('cabina.salas.untitledRoom', 'Sala sin título');

  const people = () => peopleNames(participants, owner);
  const isOwner = () => Boolean(me && owner && me === owner);
  const nearBottom = () => !scrollElement
    || scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <= UMBRAL_FONDO_PX;
  const updateJumpLatest = () => {
    const visible = !stuckToBottom;
    jumpLatest.classList.toggle('cab-jump-latest--visible', visible);
    jumpLatest.setAttribute('aria-hidden', String(!visible));
    jumpLatest.tabIndex = visible ? 0 : -1;
    jumpLatestCount.textContent = newMessages ? String(newMessages) : '';
    jumpLatestCount.hidden = newMessages === 0;
    jumpLatest.setAttribute(
      'aria-label',
      newMessages
        ? (newMessages === 1
          ? t('cabina.salas.goToLastMessageCount.one', 'Ir al último mensaje, {count} mensaje nuevo', { count: newMessages })
          : t('cabina.salas.goToLastMessageCount.many', 'Ir al último mensaje, {count} mensajes nuevos', { count: newMessages }))
        : t('cabina.salas.goToLastMessage', 'Ir al último mensaje'),
    );
  };
  const setStuckToBottom = (value) => {
    stuckToBottom = Boolean(value);
    if (stuckToBottom) newMessages = 0;
    updateJumpLatest();
  };
  const finishProgrammaticScroll = () => {
    const completedMode = scrollProgrammatic;
    scrollProgrammatic = null;
    scrollProgrammaticTimer = null;
    if (completedMode === 'bottom') setStuckToBottom(nearBottom());
  };
  const beginProgrammaticScroll = (mode) => {
    window.clearTimeout(scrollProgrammaticTimer);
    scrollProgrammatic = mode;
    scrollProgrammaticTimer = window.setTimeout(finishProgrammaticScroll, DURACION_SCROLL_PROGRAMATICO_MS);
  };
  const cancelProgrammaticScroll = () => {
    if (!scrollProgrammatic) return;
    window.clearTimeout(scrollProgrammaticTimer);
    scrollProgrammatic = null;
    scrollProgrammaticTimer = null;
    setStuckToBottom(false);
  };
  const addNewMessage = () => {
    if (stuckToBottom) return;
    newMessages += 1;
    updateJumpLatest();
  };
  const lastTs = () => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const ts = Number(events[index]?.ts);
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
    return 0;
  };
  const scheduleRead = () => {
    if (!active || !stuckToBottom) return;
    const ts = lastTs();
    if (!ts || ts <= lastMarkedTs) return;
    window.clearTimeout(readTimer);
    readTimer = window.setTimeout(async () => {
      if (!active || !stuckToBottom) return;
      try {
        await ctx.api.post('/api/chat/collab/read', { id, ts });
        if (active) lastMarkedTs = Math.max(lastMarkedTs, ts);
      } catch { /* La reconexión o el próximo scroll vuelven a intentarlo. */ }
    }, 1000);
  };
  const scrollBottom = () => {
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      if (!active || !scrollElement) return;
      beginProgrammaticScroll('bottom');
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      if (scrollsInWindow) window.scrollTo({ top: scrollElement.scrollHeight, behavior });
      else scrollHost.scrollTo({ top: scrollElement.scrollHeight, behavior });
      scheduleRead();
    });
  };
  const panelStorageKey = `cabina:sala-panel-abierto:${id}`;
  const panelElement = (name) => panelDock.querySelector(`[data-floating-panel="${name}"]`);
  const panelButton = (name) => panelDock.querySelector(`[data-panel-toggle="${name}"]`);
  const saveOpenPanel = () => {
    try {
      if (openPanelName) localStorage.setItem(panelStorageKey, openPanelName);
      else localStorage.removeItem(panelStorageKey);
    } catch { /* localStorage puede estar bloqueado */ }
  };
  const setOpenPanel = (name, { restoreFocus = true, persist = true } = {}) => {
    const nextName = ['acta', 'artefactos'].includes(name) ? name : null;
    const previousName = openPanelName;
    openPanelName = nextName;
    for (const panelName of ['acta', 'artefactos']) {
      const panel = panelElement(panelName);
      const button = panelButton(panelName);
      const isOpen = panelName === openPanelName;
      panel.classList.toggle('cab-floating-panel--open', isOpen);
      panel.setAttribute('aria-hidden', String(!isOpen));
      panel.toggleAttribute('inert', !isOpen);
      button.setAttribute('aria-expanded', String(isOpen));
      button.setAttribute('aria-label', panelName === 'acta'
        ? (isOpen ? t('cabina.salas.closeIndex', 'Cerrar Índice') : t('cabina.salas.openIndex', 'Abrir Índice'))
        : (isOpen ? t('cabina.salas.closeArtifacts', 'Cerrar Artefactos') : t('cabina.salas.openArtifacts', 'Abrir Artefactos')));
    }
    if (persist) saveOpenPanel();
    if (openPanelName) panelElement(openPanelName).focus({ preventScroll: true });
    else if (restoreFocus && previousName) panelButton(previousName).focus({ preventScroll: true });
  };
  const updatePanelCount = (name) => {
    const slot = el.querySelector(`[data-cabina-panel="${name}"]`);
    const badge = panelDock.querySelector(`[data-panel-count="${name}"]`);
    const selector = name === 'acta'
      ? '.cab-side-item[data-event-index]'
      : '.cab-side-item[data-artifact-key]';
    const count = slot.querySelectorAll(selector).length;
    badge.textContent = count ? String(count) : '';
    badge.hidden = count === 0;
  };
  const onPanelDockClick = (event) => {
    const close = event.target.closest('[data-panel-close]');
    if (close) { setOpenPanel(null); return; }
    const toggle = event.target.closest('[data-panel-toggle]');
    if (toggle) setOpenPanel(openPanelName === toggle.dataset.panelToggle ? null : toggle.dataset.panelToggle);
  };
  const onDocumentPointerDown = (event) => {
    if (openPanelName && !panelDock.contains(event.target)) setOpenPanel(null);
  };
  const onDocumentKeydown = (event) => {
    if (event.key === 'Escape' && openPanelName) {
      event.preventDefault();
      setOpenPanel(null);
    }
  };
  const syncFloatingGeometry = () => {
    root.style.setProperty('--cab-composer-height', `${Math.ceil(form.getBoundingClientRect().height)}px`);
    root.style.setProperty('--cab-panel-inline-end', `${Math.max(0, Math.ceil(window.innerWidth - root.getBoundingClientRect().right))}px`);
  };
  const layoutObserver = 'ResizeObserver' in window ? new ResizeObserver(syncFloatingGeometry) : null;
  const paintPeers = () => {
    peersEl.replaceChildren();
    for (const name of people()) peersEl.appendChild(node('span', `cab-sala-peer ${peerToneFor(name)}`, name));
    peersEl.appendChild(node('span', 'cab-sala-peer cab-sala-peer--ai', t('cabina.salas.roomAi', '{aiLabel}, la IA de la sala', { aiLabel })));
  };
  const paintActions = () => {
    actions.replaceChildren();
    const action = makeButton('cab-btn', isOwner()
      ? t('cabina.salas.invite', 'Invitar')
      : t('cabina.salas.leaveRoom', 'Salir de la sala'));
    if (isOwner()) action.dataset.inviteOpen = '';
    else action.dataset.leaveOpen = '';
    actions.appendChild(action);
  };
  const paintActa = () => {
    actaEl.hidden = !acta?.text;
    if (!acta?.text) return actaBody.replaceChildren();
    actaStale.hidden = acta.stale !== true;
    appendMarkdown(actaBody, acta.text);
  };
  const addQuote = (parent, event) => {
    if (!event.replyTo) return;
    const by = event.replyToBy || event.replyBy || t('cabina.salas.quotedMessage', 'Mensaje citado');
    const text = event.replyToText || event.replyText || '';
    const quote = makeButton(
      'cab-sala-msg-quote',
      t('cabina.salas.quotePreview', '{by} · {text}', { by, text: excerpt(text, 120) }),
      t('cabina.salas.goToQuotedMessage', 'Ir al mensaje citado'),
    );
    quote.dataset.jumpMsg = String(event.replyTo);
    parent.appendChild(quote);
  };
  const reactionTools = (event) => {
    const tools = node('div', 'cab-sala-msg-tools');
    for (const [emoji, meaning] of REACCIONES) {
      const users = Array.isArray(event.reactions?.[emoji]) ? event.reactions[emoji] : [];
      const react = makeButton(
        `cab-sala-react${users.includes(me) ? ' cab-sala-react--on' : ''}`,
        emoji,
        t('cabina.salas.reactionTitle', '{meaning}; reaccionar no le pide trabajo a la IA.', { meaning }),
      );
      react.dataset.react = emoji;
      react.dataset.msgId = String(event.id || '');
      react.appendChild(node('span', 'cab-sala-react-count', users.length || ''));
      tools.appendChild(react);
    }
    const answer = makeButton('cab-sala-quote-btn', t('cabina.salas.reply', 'Responder'));
    answer.dataset.replyMsg = String(event.id || '');
    tools.appendChild(answer);
    return tools;
  };
  const sayNode = (event) => {
    const article = node('article', `cab-sala-msg ${peerToneFor(event.by)}${event.by === me ? ' cab-sala-msg--mine' : ''}${event.askAi ? ' cab-sala-msg--ask' : ''}`);
    article.dataset.msgId = String(event.id || '');
    const head = node('div', 'cab-sala-msg-head');
    head.appendChild(node('strong', 'cab-sala-msg-author', event.by || t('cabina.salas.someone', 'Alguien')));
    if (event.ts) head.appendChild(node('time', 'cab-sala-msg-time', ctx.fmtDate(event.ts)));
    article.appendChild(head);
    if (event.askAi) article.appendChild(node('div', 'cab-sala-msg-para', t('cabina.salas.questionForAi', 'pregunta para {aiLabel}', { aiLabel })));
    addQuote(article, event);
    const body = node('div', 'cab-sala-msg-body');
    appendMarkdown(body, event.text || '', [
      ...(Array.isArray(event.mentions) ? event.mentions : []),
      ...(event.askAi ? [aiName] : []),
    ]);
    if (Array.isArray(event.attachments)) {
      for (const attachment of event.attachments) {
        body.appendChild(node('p', '', t('cabina.salas.attachment', 'Adjunto: {name}', {
          name: attachment?.name || t('cabina.salas.file', 'archivo'),
        })));
      }
    }
    article.append(body, reactionTools(event));
    return article;
  };
  const aiNode = (event, live = false) => {
    const parsed = stripAddressees(event.text || '', { final: !live });
    const article = node('article', 'cab-sala-msg cab-sala-msg--ai');
    if (live) article.dataset.streaming = '';
    const head = node('div', 'cab-sala-msg-head');
    head.appendChild(node('strong', 'cab-sala-msg-author', `✦ ${aiLabel}`));
    if (event.ts) head.appendChild(node('time', 'cab-sala-msg-time', ctx.fmtDate(event.ts)));
    article.appendChild(head);
    if (parsed.addressees?.length) article.appendChild(node('div', 'cab-sala-msg-para', t('cabina.salas.forPeople', 'para: {names}', { names: parsed.addressees.join(', ') })));
    const body = node('div', 'cab-sala-msg-body');
    if (live) body.textContent = parsed.pending ? '' : parsed.text;
    else appendMarkdown(body, parsed.text);
    article.appendChild(body);
    return article;
  };
  const eventNode = (event) => {
    if (event.type === 'say') return sayNode(event);
    if (event.type === 'assistant') return aiNode(event);
    if (event.type === 'cut') {
      const cut = node('div', 'cab-sala-cut');
      const count = Math.max(0, Number(event.count) || 0);
      const kind = event.directed
        ? t('cabina.salas.questions', 'preguntas')
        : t('cabina.salas.messages', 'mensajes');
      cut.appendChild(node('span', 'cab-sala-cut-label', t('cabina.salas.sentToAi',
        '«{by}» envió {count} {kind} a {aiLabel}{date}',
        {
          by: event.by || t('cabina.salas.someone', 'Alguien'),
          count,
          kind,
          aiLabel,
          date: event.ts ? t('cabina.salas.dateSuffix', ' · {date}', { date: ctx.fmtDate(event.ts) }) : '',
        },
      )));
      return cut;
    }
    if (event.type === 'orquestado') {
      return node('div', 'cab-sala-sys', t('cabina.salas.ideaMoved', '{by} llevó una idea a {world}{snippet}', {
        by: event.by || t('cabina.salas.someone', 'Alguien'),
        world: event.world || t('cabina.salas.anotherSpace', 'otro espacio'),
        snippet: event.snippet ? t('cabina.salas.snippetSuffix', ': {snippet}', { snippet: excerpt(event.snippet, 140) }) : '',
      }));
    }
    return null;
  };
  const appendTransient = () => {
    if (streamText) thread.appendChild(aiNode({ text: streamText }, true));
    if (status === 'working' && !streamText) thread.appendChild(node('div', 'cab-sala-sys cab-sala-typing', t('cabina.salas.aiThinking', '{aiLabel} está pensando…', { aiLabel })));
    if (typingPeople.size) {
      const names = [...typingPeople];
      thread.appendChild(node('div', 'cab-sala-typing', names.length === 1
        ? t('cabina.salas.typing.one', '{names} está escribiendo…', { names: names[0] })
        : t('cabina.salas.typing.many', '{names} están escribiendo…', { names: names.join(', ') })));
    }
  };
  const paintThread = () => {
    const fragment = document.createDocumentFragment();
    let lastCut = -1;
    events.forEach((event, index) => { if (event?.type === 'cut') lastCut = index; });
    let zoneShown = false;
    let visible = 0;
    events.forEach((event, index) => {
      if (index === unreadStartIndex) fragment.appendChild(node('div', 'cab-sala-newline', t('cabina.salas.newMessages', 'mensajes nuevos')));
      if (!zoneShown && index > lastCut && event?.type === 'say') {
        fragment.appendChild(node('div', 'cab-sala-zone', t('cabina.salas.privateZone', 'Entre ustedes · {aiLabel} no lee', { aiLabel })));
        zoneShown = true;
      }
      const rendered = eventNode(event);
      if (rendered) {
        rendered.dataset.eventIndex = String(index);
        visible += 1;
        fragment.appendChild(rendered);
      }
    });
    thread.replaceChildren(fragment);
    appendTransient();
    if (!visible && !streamText && status !== 'working') {
      const empty = node('div', 'cab-view-state');
      empty.appendChild(node('p', '', t('cabina.salas.noMessagesYet', 'La sala todavía no tiene mensajes.')));
      thread.appendChild(empty);
    }
    if (stuckToBottom) scrollBottom();
  };
  const goToEvent = (index) => {
    const eventIndex = Number(index);
    if (!Number.isInteger(eventIndex) || eventIndex < 0) return;
    const target = thread.querySelector(`[data-event-index="${eventIndex}"]`);
    if (!target) return;
    setOpenPanel(null);
    setStuckToBottom(false);
    beginProgrammaticScroll('navigation');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlighted?.classList.remove('cab-event-target--active');
    window.clearTimeout(highlightTimer);
    target.classList.remove('cab-event-target--active');
    void target.offsetWidth;
    target.classList.add('cab-event-target--active');
    highlighted = target;
    highlightTimer = window.setTimeout(() => {
      target.classList.remove('cab-event-target--active');
      if (highlighted === target) highlighted = null;
    }, 1800);
  };
  const panelContext = { chatId: String(id), api: ctx.api, toast: ctx.toast, fmtDate: ctx.fmtDate, icon: ctx.icon, goToEvent };
  const mountPanel = async (name, path) => {
    const slot = el.querySelector(`[data-cabina-panel="${name}"]`);
    if (!slot) return;
    try {
      const imported = await import(path);
      const panel = imported?.default;
      if (!active || !isCurrent() || !panel?.mount) return;
      await panel.mount(slot, panelContext);
      if (!active || !isCurrent()) {
        panel.unmount?.();
        return;
      }
      panels.push(panel);
      await panel.update?.(events);
    } catch {
      slot.replaceChildren();
    }
  };
  const notifyPanels = () => {
    for (const panel of panels) {
      try {
        Promise.resolve(panel.update?.(events)).catch(() => {});
      } catch { /* un panel opcional no puede romper el hilo */ }
    }
  };
  const pendingMessages = () => {
    let count = 0;
    for (const event of events) {
      if (event?.type === 'cut') count = 0;
      else if (event?.type === 'say') count += 1;
    }
    return count;
  };
  const paintFooter = () => {
    const count = pendingMessages();
    if (cutPending) pendingCount.textContent = t('cabina.salas.sendQueued', 'El envío queda en cola: {aiLabel} está ocupado.', { aiLabel });
    else if (!connected) pendingCount.textContent = t('cabina.salas.reconnecting', 'Volviendo a conectar con la sala…');
    else if (count) pendingCount.textContent = count === 1
      ? t('cabina.salas.pendingMessages.one', '{count} mensaje desde el último envío. {aiLabel} todavía no lo leyó.', { count, aiLabel })
      : t('cabina.salas.pendingMessages.many', '{count} mensajes desde el último envío. {aiLabel} todavía no los leyó.', { count, aiLabel });
    else pendingCount.textContent = t('cabina.salas.aiUpToDate', '{aiLabel} está al día con la sala.', { aiLabel });
    const working = status === 'working';
    cutButton.className = working ? 'cab-sala-stop-btn' : 'cab-sala-cut-btn';
    cutButton.textContent = working
      ? t('cabina.salas.stop', 'Detener')
      : t('cabina.salas.sendToAi', '✦ Enviar a la IA');
    cutButton.title = working
      ? t('cabina.salas.stopAiTitle', 'Pedirle a {aiLabel} que detenga este trabajo.', { aiLabel })
      : t('cabina.salas.sendToAiTitle', 'Esto sí le pide trabajo a la IA.');
    // El corte tiene respaldo por HTTP cuando el hilo perdió la conexión; solo
    // Detener necesita que el canal en vivo siga abierto.
    cutButton.disabled = working && !connected;
  };
  const paintReply = () => {
    replyChip.replaceChildren();
    replyChip.hidden = !reply;
    if (!reply) return;
    replyChip.append(t('cabina.salas.replyingTo', 'Respondiendo a {by}: {text} ', { by: reply.by, text: excerpt(reply.text, 100) }));
    const close = makeButton('cab-sala-quote-btn', '×', t('cabina.salas.discardQuote', 'Descartar cita'));
    close.dataset.replyClear = '';
    replyChip.appendChild(close);
  };
  const send = (payload) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };
  const showCandidates = (users) => {
    invitePanel.replaceChildren(node('strong', '', t('cabina.salas.inviteToRoom', 'Invitar a la sala')));
    invitePanel.hidden = false;
    if (!users.length) invitePanel.appendChild(node('span', '', t('cabina.salas.noInviteCandidates', 'No hay personas disponibles para sumar a esta sala. Podés pedírselo a quien administra tu cuenta.')));
    for (const user of users) {
      const item = makeButton('cab-sala-invite-item', user.username || t('cabina.salas.person', 'Persona'));
      item.dataset.inviteUser = String(user.username || '');
      invitePanel.appendChild(item);
    }
    const close = makeButton('cab-btn', t('cabina.salas.close', 'Cerrar'));
    close.dataset.inviteClose = '';
    invitePanel.appendChild(close);
  };
  const loadCandidates = async ({ quiet = false } = {}) => {
    if (!isOwner()) return;
    try {
      const data = await ctx.api.get(`/api/chat/collab/candidates?id=${encodeURIComponent(id)}`);
      if (!active || !isCurrent()) return;
      if (!quiet) showCandidates(Array.isArray(data?.users) ? data.users : []);
    } catch (error) {
      actions.querySelector('[data-invite-open]')?.remove();
      if (!quiet && active) ctx.toast(error.message || t('cabina.salas.openInviteListError', 'No se pudo abrir la lista de invitaciones.'));
    }
  };
  const applyReaction = (message) => {
    const target = events.find((event) => event?.type === 'say' && event.id === message.msgId);
    if (!target) return;
    const reactions = { ...(target.reactions || {}) };
    const users = Array.isArray(reactions[message.emoji]) ? reactions[message.emoji].filter((name) => name !== message.by) : [];
    if (!message.off) users.push(message.by);
    if (users.length) reactions[message.emoji] = users;
    else delete reactions[message.emoji];
    target.reactions = reactions;
  };
  const setTyping = (name) => {
    if (!name || name === me) return;
    typingPeople.add(name);
    window.clearTimeout(typingTimers.get(name));
    typingTimers.set(name, window.setTimeout(() => {
      typingPeople.delete(name);
      typingTimers.delete(name);
      if (active) paintThread();
    }, 4000));
  };
  const onMessage = (message) => {
    if (!active || !isCurrent() || !message || typeof message !== 'object') return;
    if (message.type === 'history') {
      if (message.isSala === false) {
        ctx.toast(t('cabina.salas.notSharedRoom', 'Ese espacio no es una sala compartida.'));
        ctx.go('salas');
        return;
      }
      events = Array.isArray(message.events) ? message.events.slice() : [];
      participants = Array.isArray(message.participants) ? message.participants : participants;
      owner = message.salaOwner || owner;
      aiName = message.salaAiName || aiName;
      aiLabel = message.salaAiLabel || aiLabel;
      status = message.status || status;
      acta = message.acta?.text ? message.acta : null;
      const unread = Math.max(0, Number(message.salaUnread) || 0);
      const sayIndexes = events.map((event, index) => event?.type === 'say' ? index : -1).filter((index) => index >= 0);
      unreadStartIndex = unread && sayIndexes.length ? sayIndexes[Math.max(0, sayIndexes.length - unread)] : -1;
      streamText = '';
      streamingCountedAsNew = false;
      connected = true;
      paintPeers(); paintActions(); paintActa(); paintThread(); paintFooter();
      notifyPanels();
      void loadCandidates({ quiet: true });
      return;
    }
    if (message.type === 'delta') {
      streamText += String(message.text || '');
      const live = thread.querySelector('[data-streaming]');
      if (live) live.replaceWith(aiNode({ text: streamText }, true));
      else {
        thread.querySelector('.cab-sala-typing.cab-sala-sys')?.remove();
        thread.appendChild(aiNode({ text: streamText }, true));
        streamingCountedAsNew = !stuckToBottom;
        if (streamingCountedAsNew) addNewMessage();
      }
      if (stuckToBottom) scrollBottom();
      return;
    }
    if (message.type === 'react') { applyReaction(message); paintThread(); notifyPanels(); return; }
    if (message.type === 'status') {
      status = message.state || 'waiting';
      if (status !== 'working') streamText = '';
      paintThread(); paintFooter(); return;
    }
    if (message.type === 'participants') {
      participants = Array.isArray(message.participants) ? message.participants : participants;
      owner = message.salaOwner || owner;
      paintPeers(); paintActions(); return;
    }
    if (message.type === 'acta') {
      acta = message.text ? { text: message.text, at: message.at, stale: message.stale } : null;
      paintActa(); return;
    }
    if (message.type === 'cut-pending') { cutPending = true; paintFooter(); return; }
    if (message.type === 'typing') { setTyping(String(message.by || '')); paintThread(); return; }
    if (message.type === 'error') {
      ctx.toast(message.message || t('cabina.salas.actionError', 'No se pudo completar esa acción.'));
      if (/te sacaron de la sala/i.test(String(message.message || ''))) ctx.go('salas');
      return;
    }
    if (['say', 'cut', 'assistant', 'orquestado'].includes(message.type)) {
      let countAsNew = true;
      if (message.type === 'assistant') {
        countAsNew = !streamingCountedAsNew;
        streamText = '';
        streamingCountedAsNew = false;
      }
      if (message.type === 'cut') cutPending = false;
      events.push(message);
      paintThread(); paintFooter(); scheduleRead();
      notifyPanels();
      if (countAsNew) addNewMessage();
    }
    // Herramientas, permisos y demás maquinaria quedan fuera de Modo Cabina.
  };
  const connect = () => {
    if (!active) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/ws/chat?id=${encodeURIComponent(id)}`);
    socket.addEventListener('open', () => { if (active) { connected = true; paintFooter(); } });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      onMessage(message);
    });
    socket.addEventListener('error', () => socket?.close());
    socket.addEventListener('close', () => {
      if (!active) return;
      connected = false;
      paintFooter();
      reconnectTimer = window.setTimeout(connect, 1500);
    });
  };
  const showLeave = () => {
    leavePanel.replaceChildren(node('span', '', t('cabina.salas.leaveConfirmation', '¿Querés salir de esta sala? Dejarás de ver sus mensajes.')));
    const yes = makeButton('cab-btn', t('cabina.salas.confirmLeave', 'Sí, salir')); yes.dataset.leaveConfirm = '';
    const no = makeButton('cab-btn', t('cabina.salas.stayInRoom', 'Seguir en la sala')); no.dataset.leaveCancel = '';
    leavePanel.append(yes, no); leavePanel.hidden = false;
  };
  const showStop = () => {
    stopPanel.replaceChildren(node('span', '', t('cabina.salas.stopConfirmation', '¿Querés detener el trabajo actual de {aiLabel}?', { aiLabel })));
    const yes = makeButton('cab-btn', t('cabina.salas.confirmStop', 'Sí, detener')); yes.dataset.stopConfirm = '';
    const no = makeButton('cab-btn', t('cabina.salas.keepWorking', 'Dejar que continúe')); no.dataset.stopCancel = '';
    stopPanel.append(yes, no); stopPanel.hidden = false;
  };
  const onClick = async (event) => {
    if (event.target.closest('[data-back]')) return ctx.go('salas');
    if (event.target.closest('[data-invite-open]')) return loadCandidates();
    if (event.target.closest('[data-invite-close]')) { invitePanel.hidden = true; return; }
    const invite = event.target.closest('[data-invite-user]');
    if (invite) {
      try {
        const data = await ctx.api.post('/api/chat/collab/invite', { id, user: invite.dataset.inviteUser });
        participants = Array.isArray(data?.participants) ? data.participants : participants;
        paintPeers(); invitePanel.hidden = true; ctx.toast(t('cabina.salas.invitationSent', 'Invitación enviada.'));
      } catch (error) { ctx.toast(error.message || t('cabina.salas.inviteError', 'No se pudo invitar a esa persona.')); }
      return;
    }
    if (event.target.closest('[data-leave-open]')) return showLeave();
    if (event.target.closest('[data-leave-cancel]')) { leavePanel.hidden = true; return; }
    if (event.target.closest('[data-leave-confirm]')) {
      try { await ctx.api.post('/api/chat/collab/leave', { id }); ctx.go('salas'); }
      catch (error) { ctx.toast(error.message || t('cabina.salas.leaveRoomError', 'No se pudo salir de la sala.')); }
      return;
    }
    const react = event.target.closest('[data-react]');
    if (react) {
      // Una reacción es coordinación humana: nunca entra al contexto de Cucho.
      if (!send({ type: 'react', msgId: react.dataset.msgId, emoji: react.dataset.react })) ctx.toast(t('cabina.salas.waitToReact', 'Esperá a que la sala vuelva a conectarse para reaccionar.'));
      return;
    }
    const answer = event.target.closest('[data-reply-msg]');
    if (answer) {
      const original = events.find((item) => item?.type === 'say' && item.id === answer.dataset.replyMsg);
      if (original) { reply = { id: original.id, by: original.by || t('cabina.salas.someone', 'Alguien'), text: original.text || '' }; paintReply(); input.focus(); }
      return;
    }
    if (event.target.closest('[data-reply-clear]')) { reply = null; paintReply(); return; }
    const jump = event.target.closest('[data-jump-msg]');
    if (jump) {
      const index = events.findIndex((item) => String(item?.id || '') === jump.dataset.jumpMsg);
      if (index >= 0) goToEvent(index);
      return;
    }
    if (event.target.closest('[data-stop-cancel]')) { stopPanel.hidden = true; return; }
    if (event.target.closest('[data-stop-confirm]')) {
      if (!send({ type: 'interrupt' })) ctx.toast(t('cabina.salas.waitForConnection', 'Esperá a que la sala vuelva a conectarse.'));
      stopPanel.hidden = true; return;
    }
    if (event.target.closest('[data-cut]')) {
      if (status === 'working') return showStop();
      // `cut` es la única palanca que despierta a la IA; `say` nunca la saltea.
      if (!send({ type: 'cut' })) {
        try { await ctx.api.post('/api/chat/cut', { id }); }
        catch (error) { ctx.toast(error.message || t('cabina.salas.sendConversationError', 'No se pudo enviar la conversación a la IA.')); }
      }
      return;
    }
    const mention = event.target.closest('[data-mention-name]');
    if (mention) {
      const before = input.value.slice(0, input.selectionStart);
      const after = input.value.slice(input.selectionEnd);
      const match = before.match(/(^|\s)@[A-Za-z0-9._-]*$/);
      if (match) {
        const start = before.length - match[0].length + match[1].length;
        const inserted = `@${mention.dataset.mentionName} `;
        input.value = input.value.slice(0, start) + inserted + after;
        input.setSelectionRange(start + inserted.length, start + inserted.length);
      }
      mentionsEl.hidden = true; input.focus();
    }
  };
  const updateMentions = () => {
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(^|\s)@([A-Za-z0-9._-]*)$/);
    if (!match) { mentionsEl.hidden = true; return; }
    const needle = match[2].toLocaleLowerCase();
    // Si una persona se llama como la IA, el arroba queda reservado para la IA,
    // igual que en el servidor.
    const choices = [...people().filter((name) => name.toLocaleLowerCase() !== aiName.toLocaleLowerCase()), aiName]
      .filter((name) => name.toLocaleLowerCase().startsWith(needle));
    mentionsEl.replaceChildren();
    for (const name of choices) {
      const item = makeButton('cab-sala-mention-item', `@${name}`);
      item.dataset.mentionName = name;
      mentionsEl.appendChild(item);
    }
    mentionsEl.hidden = choices.length === 0;
  };
  const onInput = () => {
    const length = input.value.length;
    charCount.hidden = length <= 3500;
    charCount.textContent = `${length}/${MAX_MENSAJE}`;
    updateMentions();
    const now = Date.now();
    if (length && now - typingSentAt > 2000 && send({ type: 'typing' })) typingSentAt = now;
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') { mentionsEl.hidden = true; return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
  };
  const onSubmit = async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const payload = { type: 'say', text };
    // En una sala no existe el turno directo `user`: siempre se publica con
    // `say` para que el grupo elija después el único corte que cobra contexto.
    if (reply) {
      payload.replyTo = String(reply.id);
      // El backend actual normaliza estos nombres; también aceptamos los alias
      // cortos al pintar historiales generados por otros clientes.
      payload.replyToBy = String(reply.by);
      payload.replyToText = excerpt(reply.text, 200);
    }
    if (!send(payload)) {
      try {
        const fallback = { id, text };
        if (reply) Object.assign(fallback, { replyTo: payload.replyTo, replyToBy: payload.replyToBy, replyToText: payload.replyToText });
        const result = await ctx.api.post('/api/chat/say', fallback);
        if (result?.say && !events.some((item) => item?.id === result.say.id)) events.push(result.say);
      } catch (error) { ctx.toast(error.message || t('cabina.salas.publishMessageError', 'No se pudo publicar el mensaje.')); return; }
    }
    input.value = ''; reply = null; mentionsEl.hidden = true; paintReply(); onInput();
    setStuckToBottom(true); paintThread(); paintFooter(); notifyPanels();
  };
  const onScroll = () => {
    if (scrollProgrammatic) return;
    setStuckToBottom(nearBottom());
    if (stuckToBottom) scheduleRead();
  };
  const onScrollKeydown = (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      cancelProgrammaticScroll();
    }
  };
  const onJumpLatest = () => {
    setStuckToBottom(true);
    scrollBottom();
  };

  panelDock.addEventListener('click', onPanelDockClick);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeydown);
  for (const name of ['acta', 'artefactos']) {
    const slot = el.querySelector(`[data-cabina-panel="${name}"]`);
    const observer = new MutationObserver(() => updatePanelCount(name));
    observer.observe(slot, { childList: true, subtree: true });
    panelCountObservers.push(observer);
    updatePanelCount(name);
  }
  layoutObserver?.observe(form);
  layoutObserver?.observe(root);
  window.addEventListener('resize', syncFloatingGeometry);
  syncFloatingGeometry();
  let restoredPanel = null;
  try { restoredPanel = localStorage.getItem(panelStorageKey); } catch { /* localStorage puede estar bloqueado */ }
  if (['acta', 'artefactos'].includes(restoredPanel)) setOpenPanel(restoredPanel, { restoreFocus: false, persist: false });
  void Promise.all([
    mountPanel('acta', './panel-acta.js'),
    mountPanel('artefactos', './panel-artefactos.js'),
  ]);

  root.addEventListener('click', onClick);
  form.addEventListener('submit', onSubmit);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  scrollTarget.addEventListener('wheel', cancelProgrammaticScroll, { passive: true });
  scrollTarget.addEventListener('touchstart', cancelProgrammaticScroll, { passive: true });
  scrollTarget.addEventListener('pointerdown', cancelProgrammaticScroll, { passive: true });
  scrollTarget.addEventListener('keydown', onScrollKeydown);
  jumpLatest.addEventListener('click', onJumpLatest);
  updateJumpLatest();
  paintPeers(); paintActions(); paintFooter(); connect();
  dispose = () => {
    active = false;
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(readTimer);
    window.clearTimeout(scrollProgrammaticTimer);
    window.clearTimeout(highlightTimer);
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    typingTimers.forEach((timer) => window.clearTimeout(timer));
    root.removeEventListener('click', onClick);
    form.removeEventListener('submit', onSubmit);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
    scrollTarget.removeEventListener('scroll', onScroll);
    scrollTarget.removeEventListener('wheel', cancelProgrammaticScroll);
    scrollTarget.removeEventListener('touchstart', cancelProgrammaticScroll);
    scrollTarget.removeEventListener('pointerdown', cancelProgrammaticScroll);
    scrollTarget.removeEventListener('keydown', onScrollKeydown);
    jumpLatest.removeEventListener('click', onJumpLatest);
    panelDock.removeEventListener('click', onPanelDockClick);
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeydown);
    window.removeEventListener('resize', syncFloatingGeometry);
    layoutObserver?.disconnect();
    panelCountObservers.forEach((observer) => observer.disconnect());
    socket?.close();
    for (const panel of panels) {
      try { panel.unmount?.(); } catch { /* panel opcional */ }
    }
  };
}

export default {
  name: 'salas',
  async mount(el, ctx) {
    dispose();
    const generation = ++mountGeneration;
    const isCurrent = () => generation === mountGeneration;
    const id = routeId();
    if (id) await mountDetail(el, ctx, id, isCurrent);
    else await mountList(el, ctx, isCurrent);
  },
  unmount() {
    mountGeneration += 1;
    dispose();
    dispose = () => {};
  },
};
