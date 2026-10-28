import { renderMarkdown } from '../ui/markdown.js';
import { openZoomViewer } from '../ui/zoom-viewer.js';
import { PLACES, resolvePlace } from '../ui/places.js';
import { icon } from '../ui/icons.js';
import { t } from '../ui/i18n.js';
import { confirmDialog, promptDialog } from '../ui/dialog.js';

let dispose = () => {};
let mountGeneration = 0;
const UMBRAL_FONDO_PX = 120;
const DURACION_SCROLL_PROGRAMATICO_MS = 800;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function routeId() {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0];
  const [, encodedId] = path.split('/');
  if (!encodedId) return null;
  try { return decodeURIComponent(encodedId); } catch { return encodedId; }
}

// El backend expone `status` (waiting|working) y `alive`. Hay que leerlos juntos:
// status puede quedar congelado cuando el motor se duerme o el chat pasa a TUI,
// por eso solo es "working" si TAMBIÉN está alive; alive sin turno es "waiting"
// (espera input) y sin motor vivo es "resting". Archivado siempre está en reposo.
function stateOf(chat) {
  if (!chat.archived && chat.alive && chat.status === 'working') return 'working';
  if (!chat.archived && chat.alive) return 'waiting';
  return 'resting';
}

function belongsToIdentity(chat, identity) {
  const me = identity?.username || identity?.host || null;
  if (!me) return true;
  const owner = chat.owner || identity.host || null;
  return owner === me || (chat.participants || []).some((participant) => participant?.user === me);
}

function stateLabel(chat, state) {
  if (chat.archived) return t('cabina.conversaciones.archived', 'Archivada');
  if (state === 'working') return chat.delegating
    ? t('cabina.conversaciones.delegating', 'Delegando')
    : t('cabina.conversaciones.working', 'Trabajando');
  if (state === 'waiting') {
    const permissions = Number(chat.pendingPermsCount) || (chat.pendingPerms || []).length;
    return permissions
      ? t('cabina.conversaciones.waitingPermission', 'Espera permiso ({permissions})', { permissions })
      : t('cabina.conversaciones.waitingForYou', 'Te espera');
  }
  return t('cabina.conversaciones.resting', 'En reposo');
}

function stateIcon(ctx, state) {
  if (state === 'working') return '<span class="cab-status-bars" aria-hidden="true"><i></i><i></i><i></i></span>';
  return ctx.icon(state === 'waiting' ? 'warning' : 'rest');
}

function conversationMeta(chat, state) {
  const model = chat.modelChoice === 'auto'
    ? t('cabina.conversaciones.autoModel', 'AutoTux · {model}', {
      model: chat.model || t('cabina.conversaciones.automaticModel', 'modelo automático'),
    })
    : (chat.modelChoice === 'tandem'
      ? t('cabina.conversaciones.tandem', 'Tándem')
      : (chat.model || t('cabina.conversaciones.noModel', 'Sin modelo')));
  const place = String(chat.cwd || '').split('/').filter(Boolean).pop()
    || t('cabina.conversaciones.myConsole', 'Mi Consola');
  if (state === 'working' && chat.bgTasks?.length) {
    return t('cabina.conversaciones.backgroundJobs', '{count} trabajo(s) en segundo plano · {place}', {
      count: chat.bgTasks.length,
      place,
    });
  }
  if (state === 'working' && chat.delegatingCount) {
    return t('cabina.conversaciones.subagents', '{count} subagente(s) · {place}', {
      count: chat.delegatingCount,
      place,
    });
  }
  if (chat.viewMode === 'tui') return t('cabina.conversaciones.terminalMode', 'En modo Terminal · {place}', { place });
  return t('cabina.conversaciones.modelAndPlace', '{model} · {place}', { model, place });
}

const WORLD_ORDER = ['__aduana', '__limbo', ...PLACES.map((place) => place.rel), '__otros'];

function chatWorld(chat) {
  if (chat.limbo) return '__limbo';
  return resolvePlace(chat.cwd)?.rel || '__otros';
}

function worldLabel(world) {
  if (world === '__aduana') return t('cabina.conversaciones.customs', 'Aduana');
  if (world === '__limbo') return t('cabina.conversaciones.limbo', 'Limbo');
  if (world === '__otros') return t('cabina.conversaciones.otherPlaces', 'Otros lugares');
  return PLACES.find((place) => place.rel === world)?.label || world;
}

function compareWorlds(a, b) {
  const aRank = WORLD_ORDER.indexOf(a);
  const bRank = WORLD_ORDER.indexOf(b);
  return (aRank < 0 ? WORLD_ORDER.length : aRank) - (bRank < 0 ? WORLD_ORDER.length : bRank)
    || worldLabel(a).localeCompare(worldLabel(b));
}

function compareFolders(a, b) {
  return (Number(a.order) || 0) - (Number(b.order) || 0)
    || String(a.name || '').localeCompare(String(b.name || ''));
}

function chatKey(chat) {
  return `chat:${chat.id}`;
}

function applyOrder(container, chats, order) {
  const saved = order[container];
  if (!Array.isArray(saved) || !saved.length) return [...chats];
  const rank = new Map(saved.map((key, index) => [key, index]));
  const placed = [];
  const rest = [];
  for (const chat of chats) {
    const position = rank.get(chatKey(chat));
    if (position === undefined) rest.push(chat);
    else placed.push({ chat, position });
  }
  placed.sort((a, b) => a.position - b.position);
  return [...placed.map(({ chat }) => chat), ...rest];
}

function readFolderOpen(id) {
  try { return localStorage.getItem(`cwc.cabina.folder.${id}.open`) !== '0'; }
  catch { return true; }
}

function folderIcon() {
  return icon('folder', { className: 'cab-fs-icon' });
}

function conversationIcon() {
  return icon('room', { className: 'cab-fs-icon' });
}

function floatingPanelIcon(name) {
  return icon(name === 'acta' ? 'list' : 'fileGeneric', { size: 16 });
}

function rowHtml(chat, ctx, container, { draggable = true } = {}) {
  const state = stateOf(chat);
  return `
    <div class="cab-fs-item cab-fs-item--${state}${state === 'working' ? ' cab-fs-item--active' : ''}"
      data-chat-id="${escapeHtml(chat.id)}" data-order-key="${escapeHtml(chatKey(chat))}"
      data-container="${escapeHtml(container || '')}" data-world="${escapeHtml(chatWorld(chat))}"
      draggable="${draggable ? 'true' : 'false'}">
      <div class="cab-fs-item-main" role="button" tabindex="0" data-open-chat>
        ${conversationIcon()}
        <span class="cab-fs-item-copy">
          <span class="cab-fs-item-name">${escapeHtml(chat.title || t('cabina.conversaciones.untitledConversation', 'Conversación sin título'))}</span>
          <span class="cab-fs-item-meta">${escapeHtml(conversationMeta(chat, state))}</span>
        </span>
        <span class="cab-status-chip cab-status-chip--${state}">
          ${stateIcon(ctx, state)}
          ${escapeHtml(stateLabel(chat, state))}
        </span>
      </div>
      <button class="cab-fs-more" type="button" data-chat-menu aria-label="${escapeHtml(t('cabina.conversaciones.conversationOptions', 'Opciones de {title}', { title: chat.title || t('cabina.conversaciones.theConversation', 'la conversación') }))}" title="${t('cabina.conversaciones.options', 'Opciones')}">⋯</button>
    </div>`;
}

function greeting() {
  const now = new Date();
  const weekdayEs = new Intl.DateTimeFormat('es', { weekday: 'long' }).format(now);
  const weekday = {
    domingo: t('cabina.conversaciones.sunday', 'domingo'),
    lunes: t('cabina.conversaciones.monday', 'lunes'),
    martes: t('cabina.conversaciones.tuesday', 'martes'),
    miércoles: t('cabina.conversaciones.wednesday', 'miércoles'),
    jueves: t('cabina.conversaciones.thursday', 'jueves'),
    viernes: t('cabina.conversaciones.friday', 'viernes'),
    sábado: t('cabina.conversaciones.saturday', 'sábado'),
  }[weekdayEs] || weekdayEs;
  const day = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  const hour = now.getHours();
  const period = hour < 6
    ? t('cabina.conversaciones.earlyMorning', 'de madrugada')
    : (hour < 12
      ? t('cabina.conversaciones.morning', 'a la mañana')
      : (hour < 20
        ? t('cabina.conversaciones.afternoon', 'a la tarde')
        : t('cabina.conversaciones.night', 'a la noche')));
  return t('cabina.conversaciones.greeting', '{day} {period}', { day, period });
}

function joinSummary(parts) {
  if (parts.length < 2) return parts[0] || '';
  if (parts.length === 2) return t('cabina.conversaciones.joinTwo', '{first} y {last}', { first: parts[0], last: parts[1] });
  return t('cabina.conversaciones.joinMany', '{items} y {last}', { items: parts.slice(0, -1).join(', '), last: parts.at(-1) });
}

function unreadRoomCount(rooms) {
  if (!Array.isArray(rooms)) return null;
  if (!rooms.every((room) => room.salaUnread != null && Number.isFinite(Number(room.salaUnread)))) return null;
  return rooms.reduce((sum, room) => sum + Math.max(0, Number(room.salaUnread)), 0);
}

function workSummary(working, waiting, rooms) {
  const parts = [];
  if (working) parts.push(working === 1
    ? t('cabina.conversaciones.workingOne', '{working} conversación trabajando', { working })
    : t('cabina.conversaciones.workingMany', '{working} conversaciones trabajando', { working }));
  if (waiting) parts.push(waiting === 1
    ? t('cabina.conversaciones.waitingOne', '{waiting} te espera', { waiting })
    : t('cabina.conversaciones.waitingMany', '{waiting} te esperan', { waiting }));
  const unread = unreadRoomCount(rooms);
  if (unread) parts.push(t('cabina.conversaciones.newRoomMessages', 'hay {unread} mensaje{s} nuevo{s} en {rooms}', {
    unread,
    s: unread === 1 ? '' : 's',
    rooms: rooms.length === 1
      ? t('cabina.conversaciones.theSharedRoom', 'la sala compartida')
      : t('cabina.conversaciones.theSharedRooms', 'las salas compartidas'),
  }));
  const text = joinSummary(parts);
  return text
    ? t('cabina.conversaciones.summarySentence', '{text}.', { text })
    : t('cabina.conversaciones.noActiveConversations', 'No hay conversaciones activas ahora.');
}

function summaryCardsHtml(rooms, retroCounts) {
  const unread = unreadRoomCount(rooms);
  const proposalsValue = retroCounts?.propuesta;
  const proposals = proposalsValue != null && Number.isFinite(Number(proposalsValue))
    ? Math.max(0, Number(proposalsValue))
    : null;
  const roomMeta = unread == null
    ? ''
    : `<span class="cab-summary-meta"><i class="cab-peer-mark" aria-hidden="true"></i>${unread
      ? t('cabina.conversaciones.newMessages', '{unread} mensaje{s} nuevo{s}', { unread, s: unread === 1 ? '' : 's' })
      : t('cabina.conversaciones.noNewMessages', 'Sin mensajes nuevos')}</span>`;
  const roomCard = `
    <button class="cab-summary-card" type="button" data-cabina-view="salas">
      <span class="cab-summary-eyebrow">${t('cabina.conversaciones.sharedRoom', 'Sala compartida')}</span>
      <span class="cab-summary-title">${t('cabina.conversaciones.sharedRoomsCount', '{count} sala{s} compartida{s}', { count: rooms.length, s: rooms.length === 1 ? '' : 's' })}</span>
      ${roomMeta}
    </button>`;
  const lessonCard = proposals == null ? '' : `
    <button class="cab-summary-card" type="button" data-cabina-view="lecciones">
      <span class="cab-summary-eyebrow">${t('cabina.conversaciones.lessons', 'Lecciones')}</span>
      <span class="cab-summary-title">${t('cabina.conversaciones.lessonsWaiting', '{proposals} esperando tu visto bueno', { proposals })}</span>
      <span class="cab-summary-meta">${t('cabina.conversaciones.learnedHowYouWork', 'Lo que aprendió de cómo trabajás')}</span>
    </button>`;
  return `<div class="cab-summary-grid">${roomCard}${lessonCard}</div>`;
}

function archivedHtml(chats, ctx, expanded) {
  if (!chats.length) return '';
  return `
    <details class="cab-fs-folder cab-fs-archive" ${expanded ? 'open' : ''}>
      <summary class="cab-fs-folder-head"><span class="cab-fs-chevron" aria-hidden="true"></span>${folderIcon()}<span>${t('cabina.conversaciones.archivedConversations', 'Archivadas')}</span><span class="cab-fs-count">${chats.length}</span></summary>
      <div class="cab-fs-folder-body cab-fs-conversation-grid">
        ${chats.map((chat) => rowHtml(chat, ctx, '', { draggable: false })).join('')}
      </div>
    </details>`;
}

async function mountList(el, ctx, isCurrent) {
  el.innerHTML = `
    <section class="cab-main-inner">
      <header class="cab-page-header">
        <div>
          <h1 class="cab-title">${escapeHtml(greeting())}</h1>
          <p class="cab-subtitle" data-conversation-summary>${t('cabina.conversaciones.checkingWork', 'Consultando tu trabajo…')}</p>
        </div>
        <div class="cab-fs-page-actions">
          <button class="cab-btn cab-btn--cold" type="button" data-create-folder>${folderIcon()} ${t('cabina.conversaciones.newFolder', 'Nueva carpeta')}</button>
          <label class="cab-search">
            <input type="search" placeholder="${t('cabina.conversaciones.searchPlaceholder', 'Buscar')}" aria-label="${t('cabina.conversaciones.searchConversations', 'Buscar conversaciones')}" data-conversation-search>
            ${ctx.icon('search')}
          </label>
        </div>
        <button class="cab-help-btn" type="button" data-cabina-help title="${t('cabina.conversaciones.screenHelp', 'Cómo se usa esta pantalla')}" aria-label="${t('cabina.conversaciones.screenHelp', 'Cómo se usa esta pantalla')}">${icon('help', { size: 16 })}</button>
      </header>
      <div class="cab-conversation-list" data-conversation-list>
        <div class="cab-view-state cab-view-state--loading"><span class="cab-spinner" aria-hidden="true"></span><span>${t('cabina.conversaciones.loadingConversations', 'Cargando conversaciones…')}</span></div>
      </div>
    </section>`;

  const list = el.querySelector('[data-conversation-list]');
  const summary = el.querySelector('[data-conversation-summary]');
  const search = el.querySelector('[data-conversation-search]');
  const createButton = el.querySelector('[data-create-folder]');
  let chats = [];
  let rooms = [];
  let retroCounts;
  let foldersState = { folders: [], items: {}, order: {} };
  let identity = null;
  let active = true;
  let loading = false;
  let timer = null;
  let currentMenu = null;
  let dragged = null;
  let dragStartedOnMenu = false;
  let suppressOpenKey = null;

  const normalizeFolders = (raw) => ({
    folders: Array.isArray(raw?.folders) ? raw.folders : [],
    items: raw?.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? raw.items : {},
    order: raw?.order && typeof raw.order === 'object' && !Array.isArray(raw.order) ? raw.order : {},
  });

  const rootFolders = () => foldersState.folders
    .filter((folder) => folder?.parentId === null)
    .sort(compareFolders);

  const folderForChat = (chat) => {
    const assigned = foldersState.items[chatKey(chat)];
    return rootFolders().find((folder) => folder.id === assigned && folder.world === chatWorld(chat)) || null;
  };

  const availableWorlds = () => {
    const worlds = new Set(rootFolders().map((folder) => folder.world));
    chats.filter((chat) => !chat.archived).forEach((chat) => worlds.add(chatWorld(chat)));
    if (!worlds.size) worlds.add(PLACES[0].rel);
    return [...worlds].sort(compareWorlds);
  };

  const closeMenu = () => {
    if (!currentMenu) return;
    currentMenu.remove();
    currentMenu = null;
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeydown, true);
  };

  function onDocumentPointerDown(event) {
    if (currentMenu && !currentMenu.contains(event.target)) closeMenu();
  }

  function onDocumentKeydown(event) {
    if (event.key === 'Escape') closeMenu();
  }

  const openMenu = (items, {
    anchor = null,
    x = null,
    y = null,
    label = t('cabina.conversaciones.options', 'Opciones'),
  } = {}) => {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'cab-fs-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    for (const item of items) {
      const button = document.createElement('button');
      button.className = `cab-fs-menu-item${item.danger ? ' cab-fs-menu-item--danger' : ''}`;
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(item.disabled);
      button.textContent = item.label;
      button.addEventListener('click', () => {
        closeMenu();
        item.action?.();
      });
      menu.appendChild(button);
    }
    document.body.appendChild(menu);
    currentMenu = menu;
    const anchorRect = anchor?.getBoundingClientRect();
    const left = x ?? anchorRect?.left ?? 12;
    const top = y ?? anchorRect?.bottom ?? 12;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))}px`;
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeydown, true);
    menu.querySelector(':not([disabled])')?.focus();
  };

  const updateChat = (nextChat) => {
    if (!nextChat?.id) return;
    chats = chats.map((chat) => chat.id === nextChat.id ? nextChat : chat);
    paint();
  };

  const createFolder = async (world) => {
    const proposed = await promptDialog({
      title: t('cabina.conversaciones.newFolderName', 'Nombre de la nueva carpeta en {world}:', { world: worldLabel(world) }),
    });
    if (proposed === null) return;
    const name = proposed.trim();
    if (!name) {
      ctx.toast(t('cabina.conversaciones.folderNameRequired', 'Escribí un nombre para la carpeta.'));
      return;
    }
    try {
      const data = await ctx.api.post('/api/folders/create', { name, world });
      if (data?.folder) foldersState.folders.push(data.folder);
      paint();
    } catch (error) {
      ctx.toast(error.message || t('cabina.conversaciones.createFolderError', 'No se pudo crear la carpeta.'));
    }
  };

  const renameFolder = async (folder) => {
    const proposed = await promptDialog({
      title: t('cabina.conversaciones.renameFolderPrompt', 'Nuevo nombre de la carpeta:'),
      value: folder.name || '',
    });
    if (proposed === null) return;
    const name = proposed.trim();
    if (!name) {
      ctx.toast(t('cabina.conversaciones.emptyFolderName', 'El nombre de la carpeta no puede quedar vacío.'));
      return;
    }
    try {
      const data = await ctx.api.post('/api/folders/rename', { id: folder.id, name });
      foldersState.folders = foldersState.folders.map((item) => item.id === folder.id ? (data.folder || { ...item, name }) : item);
      paint();
    } catch (error) {
      ctx.toast(error.message || t('cabina.conversaciones.renameFolderError', 'No se pudo cambiar el nombre de la carpeta.'));
    }
  };

  const deleteFolder = async (folder) => {
    const confirmed = await confirmDialog({
      message: t(
        'cabina.conversaciones.deleteFolderConfirm',
        '¿Eliminar la carpeta “{name}”?\n\nLas conversaciones y terminales no se borrarán: quedarán fuera de la carpeta.',
        { name: folder.name },
      ),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ctx.api.post('/api/folders/delete', { id: folder.id });
      const deletedIds = new Set(foldersState.folders
        .filter((item) => item.id === folder.id || item.parentId === folder.id)
        .map((item) => item.id));
      foldersState.folders = foldersState.folders.filter((item) => !deletedIds.has(item.id));
      for (const [key, folderId] of Object.entries(foldersState.items)) {
        if (deletedIds.has(folderId)) delete foldersState.items[key];
      }
      deletedIds.forEach((folderId) => { delete foldersState.order[`folder:${folderId}`]; });
      paint();
    } catch (error) {
      ctx.toast(error.message || t('cabina.conversaciones.deleteFolderError', 'No se pudo eliminar la carpeta.'));
    }
  };

  const renameChat = async (chat) => {
    const proposed = await promptDialog({
      title: t('cabina.conversaciones.renameConversationPrompt', 'Nuevo nombre de la conversación:'),
      value: chat.title || '',
    });
    if (proposed === null) return;
    try {
      const data = await ctx.api.post('/api/chat/title', { id: chat.id, title: proposed.trim() });
      updateChat(data?.chat || { ...chat, title: proposed.trim() });
    } catch (error) {
      ctx.toast(error.message || t('cabina.conversaciones.renameConversationError', 'No se pudo cambiar el nombre de la conversación.'));
    }
  };

  const assignChat = async (chat, folderId) => {
    const key = chatKey(chat);
    try {
      await ctx.api.post('/api/folders/assign', { key, folderId });
      if (folderId) foldersState.items[key] = folderId;
      else delete foldersState.items[key];
      paint();
    } catch (error) {
      ctx.toast(error.message || t('cabina.conversaciones.moveConversationError', 'No se pudo mover la conversación.'));
    }
  };

  const archiveChat = async (chat) => {
    const confirmed = await confirmDialog({
      message: t(
        'cabina.conversaciones.archiveConfirm',
        '¿Archivar “{title}”?\n\nPodrás recuperarla más adelante desde la consola.',
        { title: chat.title || t('cabina.conversaciones.thisConversation', 'esta conversación') },
      ),
    });
    if (!confirmed) return;
    try {
      const data = await ctx.api.post('/api/chat/archive', { id: chat.id });
      updateChat(data?.chat || { ...chat, archived: true, alive: false });
    } catch (error) {
      ctx.toast(error.message || t('cabina.conversaciones.archiveError', 'No se pudo archivar la conversación.'));
    }
  };

  // F3 en la consola grande: des-archivar es "revivir" (lazy — el próximo uso
  // reanuda la sesión). Sin esto, archivar en Cabina era un viaje de ida.
  const reviveChat = async (chat) => {
    try {
      const data = await ctx.api.post('/api/chat/revive', { id: chat.id });
      updateChat(data?.chat || { ...chat, archived: false });
    } catch (error) {
      ctx.toast(error.message || t('cabina.conversaciones.reviveError', 'No se pudo sacar del archivo la conversación.'));
    }
  };

  // Borrar = /api/chat/close, que deposita en la papelera (30 días de
  // retención). Cabina NO tiene pantalla de papelera: por eso el texto no
  // promete un botón que acá no existe y remite a quien dio el acceso.
  const deleteChat = async (chat) => {
    const confirmed = await confirmDialog({
      message: t(
        'cabina.conversaciones.deleteChatConfirm',
        '¿Borrar “{title}”?\n\nSe va a la papelera y se puede recuperar durante 30 días. Para recuperarla, pedísela a quien te dio el acceso.',
        { title: chat.title || t('cabina.conversaciones.thisConversation', 'esta conversación') },
      ),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ctx.api.post('/api/chat/close', { id: chat.id });
      chats = chats.filter((item) => item.id !== chat.id);
      paint();
      ctx.toast(t('cabina.conversaciones.deleteChatDone', 'Conversación borrada. Queda 30 días en la papelera.'));
    } catch (error) {
      ctx.toast(error.message || t('cabina.conversaciones.deleteChatError', 'No se pudo borrar la conversación.'));
    }
  };

  const canManageChat = (chat) => {
    const me = identity?.username || identity?.host || null;
    return !chat.owner || !me || chat.owner === me;
  };

  const openMoveMenu = (chat, position) => {
    const current = folderForChat(chat)?.id || null;
    const folders = rootFolders().filter((folder) => folder.world === chatWorld(chat));
    openMenu([
      {
        label: t('cabina.conversaciones.outsideFolders', '{check}Fuera de carpetas', { check: current === null ? '✓ ' : '' }),
        action: () => assignChat(chat, null),
      },
      ...folders.map((folder) => ({
        label: `${current === folder.id ? '✓ ' : ''}${folder.name}`,
        action: () => assignChat(chat, folder.id),
      })),
    ], { ...position, label: t('cabina.conversaciones.moveConversation', 'Mover conversación') });
  };

  const openChatMenu = (chat, position) => {
    const ownerActions = canManageChat(chat);
    openMenu([
      { label: t('cabina.conversaciones.changeName', 'Cambiar el nombre'), disabled: !ownerActions, action: () => renameChat(chat) },
      { label: t('cabina.conversaciones.moveToFolder', 'Mover a una carpeta…'), disabled: chat.archived, action: () => openMoveMenu(chat, position) },
      ...(!chat.archived ? [{
        label: t('cabina.conversaciones.archiveConversation', 'Archivar conversación'),
        danger: true,
        disabled: !ownerActions,
        action: () => archiveChat(chat),
      }] : [
        {
          label: t('cabina.conversaciones.unarchiveConversation', 'Sacar del archivo'),
          disabled: !ownerActions,
          action: () => reviveChat(chat),
        },
        {
          label: t('cabina.conversaciones.deleteConversation', 'Borrar la conversación'),
          danger: true,
          disabled: !ownerActions,
          action: () => deleteChat(chat),
        },
      ]),
    ], {
      ...position,
      label: t('cabina.conversaciones.conversationOptions', 'Opciones de {title}', {
        title: chat.title || t('cabina.conversaciones.theConversation', 'la conversación'),
      }),
    });
  };

  const openFolderMenu = (folder, position) => {
    openMenu([
      { label: t('cabina.conversaciones.changeName', 'Cambiar el nombre'), action: () => renameFolder(folder) },
      { label: t('cabina.conversaciones.deleteFolder', 'Eliminar carpeta'), danger: true, action: () => deleteFolder(folder) },
    ], { ...position, label: t('cabina.conversaciones.folderOptions', 'Opciones de {name}', { name: folder.name }) });
  };

  const clearDragHighlights = () => {
    list.querySelectorAll('.cab-fs-dragover, .cab-fs-dragover--blocked, .cab-fs-drop-before, .cab-fs-drop-after')
      .forEach((node) => node.classList.remove('cab-fs-dragover', 'cab-fs-dragover--blocked', 'cab-fs-drop-before', 'cab-fs-drop-after'));
  };

  const visibleContainerKeys = (container) => [...list.querySelectorAll('.cab-fs-item[data-order-key]')]
    .filter((item) => item.dataset.container === container)
    .map((item) => item.dataset.orderKey)
    .filter(Boolean);

  // `order` también contiene sesiones tmux que Cabina no pinta. Al cambiar el
  // orden visible se sustituyen solo las posiciones de los chats presentes y
  // se conservan intactas las claves ocultas y su orden relativo.
  const mergeWithHiddenOrder = (container, visibleKeys, extraVisibleKeys = []) => {
    const saved = Array.isArray(foldersState.order[container]) ? foldersState.order[container] : [];
    const replaceable = new Set([...visibleContainerKeys(container), ...extraVisibleKeys]);
    const merged = [];
    let visibleIndex = 0;
    for (const key of saved) {
      if (replaceable.has(key)) {
        if (visibleIndex < visibleKeys.length) merged.push(visibleKeys[visibleIndex++]);
      } else {
        merged.push(key);
      }
    }
    merged.push(...visibleKeys.slice(visibleIndex));
    return [...new Set(merged)];
  };

  const targetFolderId = (container) => container.startsWith('folder:') ? container.slice('folder:'.length) : null;

  const persistDrop = async ({ container, referenceKey = null, after = false }) => {
    if (!dragged || dragged.world !== (container.startsWith('world:')
      ? container.slice('world:'.length)
      : rootFolders().find((folder) => folder.id === targetFolderId(container))?.world)) {
      ctx.toast(t('cabina.conversaciones.wrongPlaceFolder', 'Esa carpeta pertenece a otro lugar. Mové la conversación dentro de su lugar actual.'));
      return;
    }
    const { key, container: sourceContainer } = dragged;
    if (key === referenceKey) return;
    const targetVisibleKeys = visibleContainerKeys(container).filter((itemKey) => itemKey !== key);
    const referenceIndex = referenceKey ? targetVisibleKeys.indexOf(referenceKey) : -1;
    targetVisibleKeys.splice(referenceIndex < 0 ? targetVisibleKeys.length : referenceIndex + (after ? 1 : 0), 0, key);
    const targetKeys = mergeWithHiddenOrder(container, targetVisibleKeys, sourceContainer !== container ? [key] : []);
    const sourceKeys = sourceContainer && sourceContainer !== container
      ? mergeWithHiddenOrder(sourceContainer, visibleContainerKeys(sourceContainer).filter((itemKey) => itemKey !== key))
      : null;
    try {
      if (sourceContainer !== container) {
        await ctx.api.post('/api/folders/assign', { key, folderId: targetFolderId(container) });
      }
      const writes = [ctx.api.post('/api/folders/reorder', { container, keys: targetKeys })];
      if (sourceKeys) writes.push(ctx.api.post('/api/folders/reorder', { container: sourceContainer, keys: sourceKeys }));
      await Promise.all(writes);
      const folderId = targetFolderId(container);
      if (folderId) foldersState.items[key] = folderId;
      else delete foldersState.items[key];
      foldersState.order[container] = targetKeys;
      if (sourceKeys) foldersState.order[sourceContainer] = sourceKeys;
      paint();
    } catch (error) {
      ctx.toast(error.message || t('cabina.conversaciones.saveOrderError', 'No se pudo guardar el nuevo orden.'));
      void refresh();
    }
  };

  const orderChats = (container, values) => {
    const stateRank = { working: 0, waiting: 1, resting: 2 };
    const defaults = [...values].sort((a, b) => stateRank[stateOf(a)] - stateRank[stateOf(b)]);
    return applyOrder(container, defaults, foldersState.order);
  };

  const explorerHtml = (visible, needle) => {
    const activeChats = visible.filter((chat) => !chat.archived);
    const roots = rootFolders();
    const worlds = new Set(activeChats.map(chatWorld));
    if (!needle) roots.forEach((folder) => worlds.add(folder.world));
    const sections = [];
    for (const world of [...worlds].sort(compareWorlds)) {
      const worldChats = activeChats.filter((chat) => chatWorld(chat) === world);
      const folders = roots.filter((folder) => folder.world === world);
      const members = new Map(folders.map((folder) => [folder.id, []]));
      const loose = [];
      for (const chat of worldChats) {
        const folder = folderForChat(chat);
        if (folder && members.has(folder.id)) members.get(folder.id).push(chat);
        else loose.push(chat);
      }
      const visibleFolders = needle ? folders.filter((folder) => members.get(folder.id).length) : folders;
      if (needle && !worldChats.length) continue;
      const folderRows = visibleFolders.map((folder) => {
        const container = `folder:${folder.id}`;
        const ordered = orderChats(container, members.get(folder.id));
        // `ordered` contiene exactamente los chats visibles: excluye sesiones
        // tmux, archivados, salas, chats ajenos y, si aplica, no coincidentes.
        const visibleItems = ordered.length;
        return `<details class="cab-fs-folder" data-folder-id="${escapeHtml(folder.id)}" data-drop-container="${escapeHtml(container)}" data-drop-world="${escapeHtml(world)}" ${readFolderOpen(folder.id) ? 'open' : ''}>
          <summary class="cab-fs-folder-head" data-folder-head>
            <span class="cab-fs-chevron" aria-hidden="true"></span>${folderIcon()}
            <span class="cab-fs-folder-name">${escapeHtml(folder.name)}</span>
            <span class="cab-fs-count">${visibleItems}</span>
            <button class="cab-fs-more" type="button" data-folder-menu="${escapeHtml(folder.id)}" aria-label="${escapeHtml(t('cabina.conversaciones.folderOptions', 'Opciones de {name}', { name: folder.name }))}" title="${t('cabina.conversaciones.options', 'Opciones')}">⋯</button>
          </summary>
          <div class="cab-fs-folder-body cab-fs-conversation-grid">
            ${ordered.length
              ? ordered.map((chat) => rowHtml(chat, ctx, container, { draggable: !needle })).join('')
              : `<div class="cab-fs-empty">${t('cabina.conversaciones.emptyFolder', 'Carpeta vacía · arrastrá una conversación acá')}</div>`}
          </div>
        </details>`;
      }).join('');
      const rootContainer = `world:${world}`;
      const orderedLoose = orderChats(rootContainer, loose);
      sections.push(`<section class="cab-fs-world" data-world="${escapeHtml(world)}">
        <div class="cab-fs-world-head">
          <span>${escapeHtml(worldLabel(world))}</span><span class="cab-fs-count">${worldChats.length}</span>
          <button class="cab-fs-world-add" type="button" data-world-add="${escapeHtml(world)}">+ ${t('cabina.conversaciones.newFolder', 'Nueva carpeta')}</button>
        </div>
        ${folderRows}
        <div class="cab-fs-root-drop cab-fs-conversation-grid" data-drop-container="${escapeHtml(rootContainer)}" data-drop-world="${escapeHtml(world)}">
          <div class="cab-fs-root-label">${t('cabina.conversaciones.conversationsOutsideFolders', 'Conversaciones fuera de carpetas')}</div>
          ${orderedLoose.length
            ? orderedLoose.map((chat) => rowHtml(chat, ctx, rootContainer, { draggable: !needle })).join('')
            : `<div class="cab-fs-empty">${t('cabina.conversaciones.dropOutsideFolder', 'Soltá acá una conversación para sacarla de una carpeta')}</div>`}
        </div>
      </section>`);
    }
    return `<div class="cab-fs-tree" aria-label="${t('cabina.conversaciones.conversationExplorer', 'Explorador de conversaciones')}">
      ${sections.join('') || `<div class="cab-fs-empty cab-fs-empty--main">${needle
        ? t('cabina.conversaciones.noSearchResults', 'No hay conversaciones que coincidan con la búsqueda.')
        : t('cabina.conversaciones.noConversationsYet', 'Todavía no hay conversaciones. Podés empezar creando una carpeta.')}</div>`}
    </div>`;
  };

  dispose = () => {
    active = false;
    window.clearInterval(timer);
    closeMenu();
    search.removeEventListener('input', paint);
    list.removeEventListener('click', onClick);
    list.removeEventListener('keydown', onKeydown);
    list.removeEventListener('contextmenu', onContextMenu);
    list.removeEventListener('toggle', onToggle, true);
    list.removeEventListener('pointerdown', onPointerDown);
    list.removeEventListener('pointerup', onPointerUp);
    list.removeEventListener('dragstart', onDragStart);
    list.removeEventListener('dragend', onDragEnd);
    list.removeEventListener('dragover', onDragOver);
    list.removeEventListener('dragleave', onDragLeave);
    list.removeEventListener('drop', onDrop);
    createButton.removeEventListener('click', onCreateClick);
  };

  const paint = () => {
    if (!active) return;
    const needle = search.value.trim().toLocaleLowerCase();
    const visible = chats.filter((chat) => {
      if (!needle) return true;
      return `${chat.title || ''} ${chat.cwd || ''} ${chat.model || ''}`.toLocaleLowerCase().includes(needle);
    });
    const archived = visible.filter((chat) => chat.archived);
    const allActive = chats.filter((chat) => !chat.archived);
    const allWorking = allActive.filter((chat) => stateOf(chat) === 'working').length;
    const allWaiting = allActive.filter((chat) => stateOf(chat) === 'waiting').length;
    summary.textContent = workSummary(allWorking, allWaiting, rooms);
    list.innerHTML = explorerHtml(visible, needle)
      + summaryCardsHtml(rooms, retroCounts)
      + archivedHtml(archived, ctx, Boolean(needle));
  };

  const refresh = async () => {
    if (loading || !active) return;
    loading = true;
    try {
      const retroRequest = retroCounts === undefined
        ? ctx.api.get('/api/retro/counts').catch(() => null)
        : Promise.resolve(null);
      const [data, me, retro, folderData] = await Promise.all([
        ctx.api.get('/api/chat/list'),
        identity ? Promise.resolve(identity) : ctx.api.get('/api/whoami'),
        retroRequest,
        ctx.api.get('/api/folders/list'),
      ]);
      identity = me;
      if (retroCounts === undefined) retroCounts = retro?.counts || null;
      foldersState = normalizeFolders(folderData);
      const visibleChats = (Array.isArray(data?.chats) ? data.chats : [])
        .filter((chat) => belongsToIdentity(chat, identity));
      chats = visibleChats.filter((chat) => !chat.isSala);
      rooms = visibleChats.filter((chat) => chat.isSala && !chat.archived);
      window.dispatchEvent(new CustomEvent('cabina:chats', { detail: { chats: data?.chats || [] } }));
      paint();
    } catch (error) {
      if (!chats.length && active) {
        list.innerHTML = `<div class="cab-view-state cab-view-state--error"><strong>${t('cabina.conversaciones.loadConversationsError', 'No se pudieron cargar las conversaciones.')}</strong><span>${escapeHtml(error.message)}</span></div>`;
        summary.textContent = t('cabina.conversaciones.listUnavailable', 'La lista no está disponible.');
      } else {
        ctx.toast(t('cabina.conversaciones.updateListError', 'No se pudo actualizar la lista: {message}', { message: error.message }));
      }
    } finally {
      loading = false;
    }
  };

  const onClick = (event) => {
    const chatMenuButton = event.target.closest('[data-chat-menu]');
    if (chatMenuButton) {
      event.preventDefault();
      event.stopPropagation();
      const row = chatMenuButton.closest('[data-chat-id]');
      const chat = chats.find((item) => item.id === row?.dataset.chatId);
      if (chat) openChatMenu(chat, { anchor: chatMenuButton });
      return;
    }
    const folderMenuButton = event.target.closest('[data-folder-menu]');
    if (folderMenuButton) {
      event.preventDefault();
      event.stopPropagation();
      const folder = rootFolders().find((item) => item.id === folderMenuButton.dataset.folderMenu);
      if (folder) openFolderMenu(folder, { anchor: folderMenuButton });
      return;
    }
    const worldButton = event.target.closest('[data-world-add]');
    if (worldButton) {
      void createFolder(worldButton.dataset.worldAdd);
      return;
    }
    const row = event.target.closest('[data-chat-id]');
    if (row && event.target.closest('[data-open-chat]') && suppressOpenKey !== row.dataset.orderKey) {
      ctx.go('conversaciones', { id: row.dataset.chatId });
    }
  };

  const onContextMenu = (event) => {
    const row = event.target.closest('[data-chat-id]');
    if (row) {
      const chat = chats.find((item) => item.id === row.dataset.chatId);
      if (!chat) return;
      event.preventDefault();
      openChatMenu(chat, { x: event.clientX, y: event.clientY });
      return;
    }
    const head = event.target.closest('[data-folder-head]');
    if (!head) return;
    const folderId = head.closest('[data-folder-id]')?.dataset.folderId;
    const folder = rootFolders().find((item) => item.id === folderId);
    if (!folder) return;
    event.preventDefault();
    openFolderMenu(folder, { x: event.clientX, y: event.clientY });
  };

  const onKeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const main = event.target.closest('[data-open-chat]');
    const row = main?.closest('[data-chat-id]');
    if (!row) return;
    event.preventDefault();
    ctx.go('conversaciones', { id: row.dataset.chatId });
  };

  const onToggle = (event) => {
    const folder = event.target.closest?.('[data-folder-id]');
    if (!folder) return;
    try { localStorage.setItem(`cwc.cabina.folder.${folder.dataset.folderId}.open`, folder.open ? '1' : '0'); }
    catch { /* localStorage puede estar bloqueado */ }
  };

  const onCreateClick = () => {
    const worlds = availableWorlds();
    if (worlds.length === 1) {
      void createFolder(worlds[0]);
      return;
    }
    openMenu(worlds.map((world) => ({
      label: t('cabina.conversaciones.createInWorld', 'Crear en {world}', { world: worldLabel(world) }),
      action: () => createFolder(world),
    })), {
      anchor: createButton,
      label: t('cabina.conversaciones.chooseFolderLocation', 'Elegir dónde crear la carpeta'),
    });
  };

  const onPointerDown = (event) => { dragStartedOnMenu = Boolean(event.target.closest('[data-chat-menu]')); };
  const onPointerUp = () => { dragStartedOnMenu = false; };

  const onDragStart = (event) => {
    const row = event.target.closest('[data-chat-id][draggable="true"]');
    if (!row || dragStartedOnMenu || search.value.trim()) {
      event.preventDefault();
      return;
    }
    dragged = {
      key: row.dataset.orderKey,
      container: row.dataset.container,
      world: row.dataset.world,
    };
    event.dataTransfer.setData('text/plain', dragged.key);
    event.dataTransfer.effectAllowed = 'move';
    row.classList.add('cab-fs-item--dragging');
  };

  const onDragEnd = (event) => {
    const key = dragged?.key || null;
    event.target.closest('[data-chat-id]')?.classList.remove('cab-fs-item--dragging');
    dragged = null;
    dragStartedOnMenu = false;
    clearDragHighlights();
    suppressOpenKey = key;
    window.setTimeout(() => { if (suppressOpenKey === key) suppressOpenKey = null; }, 0);
  };

  const onDragOver = (event) => {
    if (!dragged) return;
    const item = event.target.closest('.cab-fs-item[data-container]');
    if (item && item.dataset.orderKey !== dragged.key) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      clearDragHighlights();
      if (item.dataset.world !== dragged.world) {
        item.classList.add('cab-fs-dragover', 'cab-fs-dragover--blocked');
        return;
      }
      const rect = item.getBoundingClientRect();
      item.classList.add(event.clientX < rect.left + rect.width / 2 ? 'cab-fs-drop-before' : 'cab-fs-drop-after');
      return;
    }
    const zone = event.target.closest('[data-drop-container]');
    if (!zone) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDragHighlights();
    zone.classList.add('cab-fs-dragover');
    if (zone.dataset.dropWorld !== dragged.world) zone.classList.add('cab-fs-dragover--blocked');
  };

  const onDragLeave = (event) => {
    const target = event.target.closest('.cab-fs-item, [data-drop-container]');
    if (target && event.relatedTarget && target.contains(event.relatedTarget)) return;
    clearDragHighlights();
  };

  const onDrop = (event) => {
    if (!dragged) return;
    const item = event.target.closest('.cab-fs-item[data-container]');
    if (item && item.dataset.orderKey !== dragged.key) {
      event.preventDefault();
      event.stopPropagation();
      const after = item.classList.contains('cab-fs-drop-after');
      clearDragHighlights();
      void persistDrop({ container: item.dataset.container, referenceKey: item.dataset.orderKey, after });
      return;
    }
    const zone = event.target.closest('[data-drop-container]');
    if (!zone) return;
    event.preventDefault();
    event.stopPropagation();
    clearDragHighlights();
    void persistDrop({ container: zone.dataset.dropContainer });
  };

  search.addEventListener('input', paint);
  list.addEventListener('click', onClick);
  list.addEventListener('keydown', onKeydown);
  list.addEventListener('contextmenu', onContextMenu);
  list.addEventListener('toggle', onToggle, true);
  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('pointerup', onPointerUp);
  list.addEventListener('dragstart', onDragStart);
  list.addEventListener('dragend', onDragEnd);
  list.addEventListener('dragover', onDragOver);
  list.addEventListener('dragleave', onDragLeave);
  list.addEventListener('drop', onDrop);
  createButton.addEventListener('click', onCreateClick);
  await refresh();
  if (active && isCurrent()) timer = window.setInterval(refresh, 5000);
}

function messageText(event) {
  if (typeof event.text === 'string') return event.text;
  if (typeof event.message === 'string') return event.message;
  if (typeof event.output === 'string') return event.output;
  if (event.summary) return event.summary;
  return '';
}

// Ninguna de estas claves llega a la pantalla: el mapa traduce herramientas
// técnicas a una sola frase humana mientras la acción sigue pendiente.
const TOOL_ACTIVITY_LABELS = [
  { test: /^(Read|Glob|Grep)$/i, label: t('cabina.conversaciones.reviewingFiles', 'Revisando tus archivos…') },
  { test: /^(Write|Edit|MultiEdit|NotebookEdit)$/i, label: t('cabina.conversaciones.writingDocument', 'Escribiendo un documento…') },
  { test: /^(WebSearch|WebFetch)$/i, label: t('cabina.conversaciones.searchingInformation', 'Buscando información…') },
  { test: /^(Task|Agent)$/i, label: t('cabina.conversaciones.coordinatingWork', 'Coordinando el trabajo…') },
  { test: /^(TodoRead|TodoWrite)$/i, label: t('cabina.conversaciones.organizingNextSteps', 'Organizando los próximos pasos…') },
  { test: /^AskUserQuestion$/i, label: t('cabina.conversaciones.preparingQuestion', 'Preparando una pregunta…') },
  { test: /^Bash$/i, label: t('cabina.conversaciones.performingTask', 'Realizando una tarea…') },
  { test: /^mcp__gmail__/i, label: t('cabina.conversaciones.searchingEmail', 'Buscando en tu correo…') },
  { test: /^mcp__google_drive__/i, label: t('cabina.conversaciones.reviewingDocuments', 'Revisando tus documentos…') },
  { test: /^mcp__google_calendar__/i, label: t('cabina.conversaciones.reviewingSchedule', 'Revisando tu agenda…') },
  { test: /^mcp__github__/i, label: t('cabina.conversaciones.reviewingProject', 'Revisando el proyecto…') },
];

function toolActivityLabel(name) {
  return TOOL_ACTIVITY_LABELS.find(({ test }) => test.test(String(name || '')))?.label
    || t('cabina.conversaciones.workingActivity', 'Trabajando…');
}

function eventToolId(event) {
  return event.id || event.toolUseId || event.tool_use_id || null;
}

const IMAGE_ATTACHMENT_RE = /\.(?:jpe?g|png|gif|webp)$/i;

function attachmentChip(label) {
  const chip = document.createElement('span');
  chip.className = 'cab-chat-attachment-chip';
  chip.textContent = label || t('cabina.conversaciones.attachment', 'Adjunto');
  return chip;
}

function openChatImage(src, title) {
  const image = document.createElement('img');
  image.className = 'cab-chat-zoom-image';
  image.alt = title || t('cabina.conversaciones.enlargedImage', 'Imagen ampliada');
  image.src = src;
  const open = () => openZoomViewer({ title: title || t('cabina.conversaciones.image', 'Imagen'), node: image });
  if (image.complete && image.naturalWidth > 0) open();
  else image.addEventListener('load', open, { once: true });
}

function zoomableImage(src, name, fallbackLabel) {
  const button = document.createElement('button');
  button.className = 'cab-chat-image-button';
  button.type = 'button';
  button.title = t('cabina.conversaciones.enlargeImage', 'Ampliar {name}', { name });
  button.setAttribute('aria-label', t('cabina.conversaciones.enlargeImage', 'Ampliar {name}', { name }));
  const image = document.createElement('img');
  image.className = 'cab-message-image cab-chat-image-thumb';
  image.src = src;
  image.alt = name;
  image.loading = 'lazy';
  image.addEventListener('error', () => button.replaceWith(attachmentChip(fallbackLabel || name)), { once: true });
  button.addEventListener('click', () => openChatImage(src, name));
  button.appendChild(image);
  return button;
}

function appendAttachments(parent, event, chatId) {
  if (!Array.isArray(event.attachments) || !event.attachments.length) return;
  const attachments = document.createElement('div');
  attachments.className = 'cab-message-attachments';
  for (const attachment of event.attachments) {
    const name = String(attachment?.name || '');
    if (name && IMAGE_ATTACHMENT_RE.test(name)) {
      const src = `/api/chat/attachment?id=${encodeURIComponent(chatId)}&name=${encodeURIComponent(name)}`;
      attachments.appendChild(zoomableImage(src, name, name));
    } else {
      attachments.appendChild(attachmentChip(name || attachment?.type || t('cabina.conversaciones.attachment', 'Adjunto')));
    }
  }
  parent.appendChild(attachments);
}

function safeImageSource(event) {
  const raw = event.url || event.src || (typeof event.image === 'string' ? event.image : '');
  if (typeof raw === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try {
      const url = new URL(raw, location.origin);
      if (['http:', 'https:', 'blob:'].includes(url.protocol)) return url.href;
    } catch { /* imagen inválida */ }
  }
  const mediaType = String(event.mediaType || event.mimeType || '');
  if (typeof event.data === 'string' && /^image\/[a-z0-9.+-]+$/i.test(mediaType)) {
    return `data:${mediaType};base64,${event.data}`;
  }
  return '';
}

function eventNode(event, ctx, index, chatId) {
  if (event.type === 'error') {
    const note = document.createElement('div');
    note.className = 'cab-thread-note cab-thread-note--error';
    note.dataset.eventIndex = String(index);
    note.textContent = t('cabina.conversaciones.partialWorkError', 'No pude completar una parte del trabajo. Podés volver a intentar.');
    return note;
  }
  if (event.type === 'image') {
    const src = safeImageSource(event);
    if (!src) return null;
    const article = document.createElement('article');
    article.className = 'cab-message cab-message--agent';
    article.dataset.eventIndex = String(index);
    const meta = document.createElement('div');
    meta.className = 'cab-message-meta';
    meta.innerHTML = `<span class="cab-agent-mark" aria-hidden="true">✦</span><span>${t('cabina.conversaciones.assistant', 'Asistente')}</span>`;
    const name = event.alt || event.name || t('cabina.conversaciones.assistantSharedImage', 'Imagen compartida por el asistente');
    article.append(meta, zoomableImage(src, name, t('cabina.conversaciones.imageUnavailable', 'Imagen no disponible')));
    return article;
  }
  const isPerson = event.type === 'user' || event.type === 'say';
  const isAgent = event.type === 'assistant';
  if (!isPerson && !isAgent) return null;
  const who = isPerson
    ? (event.by || t('cabina.conversaciones.you', 'Vos'))
    : t('cabina.conversaciones.assistant', 'Asistente');
  const time = event.ts ? ctx.fmtDate(event.ts) : '';
  const article = document.createElement('article');
  article.className = `cab-message cab-message--${isPerson ? 'person' : 'agent'}`;
  article.dataset.eventIndex = String(index);
  const meta = document.createElement('div');
  meta.className = 'cab-message-meta';
  if (isAgent) {
    const mark = document.createElement('span');
    mark.className = 'cab-agent-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '✦';
    meta.appendChild(mark);
  }
  const author = document.createElement('span');
  author.textContent = who;
  meta.appendChild(author);
  if (time) {
    const timeElement = document.createElement('time');
    timeElement.textContent = time;
    meta.appendChild(timeElement);
  }
  const bubble = document.createElement('div');
  bubble.className = 'cab-message-bubble';
  if (isAgent) bubble.appendChild(renderMarkdown(messageText(event)));
  else bubble.appendChild(document.createTextNode(messageText(event)));
  appendAttachments(bubble, event, chatId);
  article.append(meta, bubble);
  return article;
}

async function mountDetail(el, ctx, id, isCurrent) {
  let active = true;
  dispose = () => { active = false; };
  const [data, identity] = await Promise.all([
    ctx.api.get('/api/chat/list'),
    ctx.api.get('/api/whoami'),
  ]);
  if (!active || !isCurrent()) return;
  const chat = (Array.isArray(data?.chats) ? data.chats : [])
    .find((item) => item.id === id && !item.isSala && belongsToIdentity(item, identity));
  if (!chat) throw new Error(t('cabina.conversaciones.conversationUnavailable', 'La conversación no existe o no está disponible para esta cuenta.'));
  const composerDisabled = chat.archived || chat.viewMode === 'tui';
  el.innerHTML = `
    <section class="cab-main-inner cab-conversation-detail">
      <header class="cab-page-header cab-page-header--detail">
        <button class="cab-btn cab-btn--cold" type="button" data-conversation-back>${ctx.icon('back')} ${t('cabina.conversaciones.conversations', 'Conversaciones')}</button>
        <div class="cab-detail-heading">
          <h1 class="cab-title">${escapeHtml(chat.title || t('cabina.conversaciones.untitledConversation', 'Conversación sin título'))}</h1>
          <p class="cab-subtitle">${escapeHtml(conversationMeta(chat, stateOf(chat)))}</p>
        </div>
      </header>
      <div class="cab-detail-layout">
        <div class="cab-thread-column">
          <div class="cab-thread" data-conversation-thread>
            <div class="cab-view-state cab-view-state--loading"><span class="cab-spinner" aria-hidden="true"></span><span>${t('cabina.conversaciones.loadingHistory', 'Cargando historial…')}</span></div>
          </div>
          <form class="cab-composer" data-conversation-composer>
            <textarea class="cab-composer-field" rows="2" placeholder="${t('cabina.conversaciones.messagePlaceholder', 'Escribí un mensaje')}" aria-label="${t('cabina.conversaciones.message', 'Mensaje')}" data-conversation-input ${composerDisabled ? 'disabled' : ''}></textarea>
            <div class="cab-composer-actions">
              <span class="cab-composer-status" data-conversation-status>${composerDisabled
                ? (chat.archived
                  ? t('cabina.conversaciones.reviveToContinue', 'Reviví la conversación desde la consola actual para continuar.')
                  : t('cabina.conversaciones.conversationInTerminal', 'Esta conversación está en modo Terminal.'))
                : t('cabina.conversaciones.connecting', 'Conectando…')}</span>
              <button class="cab-btn cab-btn--hot cab-composer-send" type="submit" data-conversation-send disabled>${ctx.icon('send')} ${t('cabina.conversaciones.send', 'Enviar')}</button>
            </div>
          </form>
        </div>
        <aside class="cab-panel-dock" aria-label="${t('cabina.conversaciones.conversationPanels', 'Paneles de la conversación')}" data-panel-dock>
          <section class="cab-floating-panel cab-floating-panel--acta" id="cab-floating-acta" data-floating-panel="acta" role="dialog" aria-label="${t('cabina.conversaciones.conversationIndex', 'Índice de la conversación')}" aria-hidden="true" tabindex="-1" inert>
            <button class="cab-floating-panel-close" type="button" data-panel-close="acta" aria-label="${t('cabina.conversaciones.closeIndex', 'Cerrar Índice')}" title="${t('cabina.conversaciones.closeIndex', 'Cerrar Índice')}">×</button>
            <div class="cab-floating-panel-content"><section data-cabina-panel="acta"></section></div>
          </section>
          <section class="cab-floating-panel cab-floating-panel--artefactos" id="cab-floating-artefactos" data-floating-panel="artefactos" role="dialog" aria-label="${t('cabina.conversaciones.conversationArtifacts', 'Artefactos de la conversación')}" aria-hidden="true" tabindex="-1" inert>
            <button class="cab-floating-panel-close" type="button" data-panel-close="artefactos" aria-label="${t('cabina.conversaciones.closeArtifacts', 'Cerrar Artefactos')}" title="${t('cabina.conversaciones.closeArtifacts', 'Cerrar Artefactos')}">×</button>
            <div class="cab-floating-panel-content"><section data-cabina-panel="artefactos"></section></div>
          </section>
          <div class="cab-panel-launchers">
            <button class="cab-panel-launcher" type="button" data-panel-toggle="acta" aria-controls="cab-floating-acta" aria-expanded="false" aria-label="${t('cabina.conversaciones.openIndex', 'Abrir Índice')}" title="${t('cabina.conversaciones.index', 'Índice')}">
              ${floatingPanelIcon('acta')}<span class="cab-panel-count" data-panel-count="acta" hidden></span>
            </button>
            <button class="cab-panel-launcher" type="button" data-panel-toggle="artefactos" aria-controls="cab-floating-artefactos" aria-expanded="false" aria-label="${t('cabina.conversaciones.openArtifacts', 'Abrir Artefactos')}" title="${t('cabina.conversaciones.artifacts', 'Artefactos')}">
              ${floatingPanelIcon('artefactos')}<span class="cab-panel-count" data-panel-count="artefactos" hidden></span>
            </button>
          </div>
        </aside>
        <button class="cab-jump-latest" type="button" data-jump-latest aria-label="${t('cabina.conversaciones.goToLatestMessage', 'Ir al último mensaje')}" aria-hidden="true" tabindex="-1">
          <span aria-hidden="true">↓</span>
          <span>${t('cabina.conversaciones.goToLatest', 'Ir al último')}</span>
          <span class="cab-jump-latest-count" data-jump-latest-count hidden></span>
        </button>
      </div>
    </section>`;

  const detail = el.querySelector('.cab-conversation-detail');
  const back = el.querySelector('[data-conversation-back]');
  const thread = el.querySelector('[data-conversation-thread]');
  const form = el.querySelector('[data-conversation-composer]');
  const input = el.querySelector('[data-conversation-input]');
  const send = el.querySelector('[data-conversation-send]');
  const status = el.querySelector('[data-conversation-status]');
  const panelDock = el.querySelector('[data-panel-dock]');
  const jumpLatest = el.querySelector('[data-jump-latest]');
  const jumpLatestCount = el.querySelector('[data-jump-latest-count]');
  let socket = null;
  let reconnectTimer = null;
  let streamText = '';
  let historyEvents = [];
  let pendingTools = new Map();
  let highlighted = null;
  let highlightTimer = null;
  const panels = [];
  const panelCountObservers = [];
  const scrollHost = el.closest('.cab-main');
  const scrollsInWindow = !scrollHost || getComputedStyle(scrollHost).overflowY === 'visible';
  const scrollTarget = scrollsInWindow ? window : scrollHost;
  const scrollElement = scrollsInWindow ? document.scrollingElement : scrollHost;
  const panelStorageKey = `cabina:panel-abierto:${id}`;
  let openPanelName = null;
  let pegadoAlFondo = true;
  let nuevosMensajes = 0;
  let streamingContadoComoNuevo = false;
  let scrollProgramatico = null;
  let scrollProgramaticoTimer = null;
  let scrollFrame = null;

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
      button.setAttribute('aria-label', t('cabina.conversaciones.togglePanel', '{action} {panel}', {
        action: isOpen
          ? t('cabina.conversaciones.close', 'Cerrar')
          : t('cabina.conversaciones.open', 'Abrir'),
        panel: panelName === 'acta'
          ? t('cabina.conversaciones.index', 'Índice')
          : t('cabina.conversaciones.artifacts', 'Artefactos'),
      }));
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
    if (close) {
      setOpenPanel(null);
      return;
    }
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

  const syncPanelGeometry = () => {
    detail.style.setProperty('--cab-composer-height', `${Math.ceil(form.getBoundingClientRect().height)}px`);
    detail.style.setProperty('--cab-panel-inline-end', `${Math.max(0, Math.ceil(window.innerWidth - detail.getBoundingClientRect().right))}px`);
  };
  const layoutObserver = 'ResizeObserver' in window ? new ResizeObserver(syncPanelGeometry) : null;
  layoutObserver?.observe(form);
  layoutObserver?.observe(detail);
  window.addEventListener('resize', syncPanelGeometry);
  syncPanelGeometry();

  let restoredPanel = null;
  try { restoredPanel = localStorage.getItem(panelStorageKey); } catch { /* localStorage puede estar bloqueado */ }
  if (['acta', 'artefactos'].includes(restoredPanel)) setOpenPanel(restoredPanel, { restoreFocus: false, persist: false });

  const updateJumpLatest = () => {
    const visible = !pegadoAlFondo;
    jumpLatest.classList.toggle('cab-jump-latest--visible', visible);
    jumpLatest.setAttribute('aria-hidden', String(!visible));
    jumpLatest.tabIndex = visible ? 0 : -1;
    jumpLatestCount.textContent = nuevosMensajes ? String(nuevosMensajes) : '';
    jumpLatestCount.hidden = nuevosMensajes === 0;
    jumpLatest.setAttribute(
      'aria-label',
      nuevosMensajes
        ? (nuevosMensajes === 1
          ? t('cabina.conversaciones.goToLatestOneNew', 'Ir al último mensaje, {count} mensaje nuevo', { count: nuevosMensajes })
          : t('cabina.conversaciones.goToLatestManyNew', 'Ir al último mensaje, {count} mensajes nuevos', { count: nuevosMensajes }))
        : t('cabina.conversaciones.goToLatestMessage', 'Ir al último mensaje'),
    );
  };
  const setPegadoAlFondo = (value) => {
    pegadoAlFondo = Boolean(value);
    if (pegadoAlFondo) nuevosMensajes = 0;
    updateJumpLatest();
  };
  const estaCercaDelFondo = () => {
    if (!scrollElement) return true;
    return scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <= UMBRAL_FONDO_PX;
  };
  const finishProgrammaticScroll = () => {
    const completedMode = scrollProgramatico;
    scrollProgramatico = null;
    scrollProgramaticoTimer = null;
    if (completedMode === 'bottom') setPegadoAlFondo(estaCercaDelFondo());
  };
  const beginProgrammaticScroll = (mode) => {
    window.clearTimeout(scrollProgramaticoTimer);
    scrollProgramatico = mode;
    scrollProgramaticoTimer = window.setTimeout(finishProgrammaticScroll, DURACION_SCROLL_PROGRAMATICO_MS);
  };
  const cancelProgrammaticScroll = () => {
    if (!scrollProgramatico) return;
    window.clearTimeout(scrollProgramaticoTimer);
    scrollProgramatico = null;
    scrollProgramaticoTimer = null;
    setPegadoAlFondo(false);
  };
  const onScroll = () => {
    if (scrollProgramatico) return;
    setPegadoAlFondo(estaCercaDelFondo());
  };
  const onScrollKeydown = (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      cancelProgrammaticScroll();
    }
  };
  const addNewMessage = () => {
    if (pegadoAlFondo) return;
    nuevosMensajes += 1;
    updateJumpLatest();
  };
  const scrollToBottom = () => {
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      if (!active || !scrollElement) return;
      beginProgrammaticScroll('bottom');
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      if (scrollsInWindow) window.scrollTo({ top: scrollElement.scrollHeight, behavior });
      else scrollHost.scrollTo({ top: scrollElement.scrollHeight, behavior });
    });
  };
  const onJumpLatest = () => {
    setPegadoAlFondo(true);
    scrollToBottom();
  };

  scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  scrollTarget.addEventListener('wheel', cancelProgrammaticScroll, { passive: true });
  scrollTarget.addEventListener('touchstart', cancelProgrammaticScroll, { passive: true });
  scrollTarget.addEventListener('pointerdown', cancelProgrammaticScroll, { passive: true });
  scrollTarget.addEventListener('keydown', onScrollKeydown);
  jumpLatest.addEventListener('click', onJumpLatest);
  updateJumpLatest();

  const goToEvent = (index) => {
    const eventIndex = Number(index);
    if (!Number.isInteger(eventIndex) || eventIndex < 0) return;
    const target = thread.querySelector(`[data-event-index="${eventIndex}"]`);
    if (!target) return;
    setOpenPanel(null);
    setPegadoAlFondo(false);
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
      await panel.update?.(historyEvents);
    } catch {
      slot.replaceChildren();
    }
  };

  void Promise.all([
    mountPanel('acta', './panel-acta.js'),
    mountPanel('artefactos', './panel-artefactos.js'),
  ]);

  const notifyPanels = () => {
    for (const panel of panels) {
      try {
        Promise.resolve(panel.update?.(historyEvents)).catch(() => {});
      } catch { /* un panel opcional no puede romper el hilo */ }
    }
  };

  const removePendingTool = (event) => {
    const id = eventToolId(event);
    if (id != null && pendingTools.delete(`id:${id}`)) return;
    const fallback = [...pendingTools.keys()].at(-1);
    if (fallback) pendingTools.delete(fallback);
  };

  const updatePendingTool = (event, index) => {
    if (event.type === 'tool_use') {
      const id = eventToolId(event);
      pendingTools.set(id != null ? `id:${id}` : `event:${index}`, { event, index });
    } else if (event.type === 'tool_result') {
      removePendingTool(event);
    }
  };

  const syncPendingTools = () => {
    pendingTools = new Map();
    historyEvents.forEach(updatePendingTool);
  };

  const renderActivity = () => {
    thread.querySelector('[data-tool-activity]')?.remove();
    const current = [...pendingTools.values()].at(-1);
    if (!current) return;
    thread.querySelector('.cab-view-state')?.remove();
    const line = document.createElement('div');
    line.className = 'cab-thread-activity';
    line.dataset.toolActivity = '';
    line.dataset.eventIndex = String(current.index);
    const pulse = document.createElement('span');
    pulse.className = 'cab-activity-pulse';
    pulse.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = toolActivityLabel(current.event.name);
    line.append(pulse, text);
    thread.appendChild(line);
  };

  const ensureEmptyState = () => {
    if (thread.querySelector('[data-event-index], [data-streaming-message]')) return;
    thread.innerHTML = `<div class="cab-view-state"><p>${t('cabina.conversaciones.noMessagesYet', 'Esta conversación todavía no tiene mensajes.')}</p></div>`;
  };

  const paintHistory = (events) => {
    historyEvents = events.slice();
    const fragment = document.createDocumentFragment();
    historyEvents.forEach((event, index) => {
      const node = eventNode(event, ctx, index, id);
      if (node) fragment.appendChild(node);
    });
    thread.replaceChildren(fragment);
    syncPendingTools();
    renderActivity();
    ensureEmptyState();
    streamText = '';
    notifyPanels();
    if (pegadoAlFondo) scrollToBottom();
  };
  const appendEvent = (event, { countAsNew = true } = {}) => {
    const index = historyEvents.length;
    historyEvents.push(event);
    updatePendingTool(event, index);
    thread.querySelector('[data-tool-activity]')?.remove();
    const node = eventNode(event, ctx, index, id);
    if (node) {
      thread.querySelector('.cab-view-state')?.remove();
      thread.appendChild(node);
    }
    renderActivity();
    ensureEmptyState();
    notifyPanels();
    if (node && event.type === 'assistant' && countAsNew) addNewMessage();
    const debeSeguirAlFondo = pegadoAlFondo || event.type === 'user';
    if (event.type === 'user') setPegadoAlFondo(true);
    if (debeSeguirAlFondo) scrollToBottom();
  };
  const setConnected = (connected) => {
    if (composerDisabled) return;
    input.disabled = !connected;
    send.disabled = !connected;
    status.textContent = connected
      ? t('cabina.conversaciones.connected', 'Conectada')
      : t('cabina.conversaciones.reconnecting', 'Reconectando…');
  };
  const onMessage = (message) => {
    if (message.type === 'history') {
      paintHistory(Array.isArray(message.events) ? message.events : []);
      setConnected(true);
      return;
    }
    if (message.type === 'delta') {
      streamText += message.text || '';
      let live = thread.querySelector('[data-streaming-message]');
      if (!live) {
        thread.querySelector('.cab-view-state')?.remove();
        live = document.createElement('article');
        live.className = 'cab-message cab-message--agent cab-message--active';
        live.dataset.streamingMessage = '';
        live.dataset.eventIndex = String(historyEvents.length);
        live.innerHTML = `<div class="cab-message-meta"><span class="cab-agent-mark" aria-hidden="true">✦</span><span>${t('cabina.conversaciones.assistant', 'Asistente')}</span></div><div class="cab-message-bubble"></div>`;
        const activity = thread.querySelector('[data-tool-activity]');
        if (activity) activity.before(live);
        else thread.appendChild(live);
        streamingContadoComoNuevo = !pegadoAlFondo;
        if (streamingContadoComoNuevo) addNewMessage();
      }
      live.querySelector('.cab-message-bubble').textContent = streamText;
      if (pegadoAlFondo) scrollToBottom();
      return;
    }
    let countAsNew = true;
    if (message.type === 'assistant') {
      countAsNew = !streamingContadoComoNuevo;
      thread.querySelector('[data-streaming-message]')?.remove();
      streamText = '';
      streamingContadoComoNuevo = false;
    }
    if (message.type === 'tool_use') {
      const live = thread.querySelector('[data-streaming-message]');
      live?.removeAttribute('data-streaming-message');
      live?.classList.remove('cab-message--active');
      streamText = '';
      streamingContadoComoNuevo = false;
    }
    if (message.type === 'status') {
      status.textContent = message.state === 'working'
        ? t('cabina.conversaciones.assistantWorking', 'El asistente está trabajando…')
        : t('cabina.conversaciones.connected', 'Conectada');
    }
    appendEvent(message, { countAsNew });
  };
  const connect = () => {
    if (!active) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/ws/chat?id=${encodeURIComponent(id)}`);
    socket.addEventListener('open', () => {
      if (active) status.textContent = t('cabina.conversaciones.loadingHistory', 'Cargando historial…');
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      onMessage(message);
    });
    socket.addEventListener('error', () => socket?.close());
    socket.addEventListener('close', () => {
      if (!active) return;
      setConnected(false);
      reconnectTimer = window.setTimeout(connect, 1500);
    });
  };
  const onBack = () => ctx.go('conversaciones');
  const onSubmit = (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'user', text }));
    input.value = '';
    status.textContent = t('cabina.conversaciones.sending', 'Enviando…');
  };
  const onKeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
  back.addEventListener('click', onBack);
  form.addEventListener('submit', onSubmit);
  input.addEventListener('keydown', onKeydown);
  connect();
  dispose = () => {
    active = false;
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(highlightTimer);
    window.clearTimeout(scrollProgramaticoTimer);
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    back.removeEventListener('click', onBack);
    form.removeEventListener('submit', onSubmit);
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
    window.removeEventListener('resize', syncPanelGeometry);
    layoutObserver?.disconnect();
    panelCountObservers.forEach((observer) => observer.disconnect());
    socket?.close();
    for (const panel of panels) {
      try { panel.unmount?.(); } catch { /* panel opcional */ }
    }
  };
}

export default {
  name: 'conversaciones',
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
