import { renderMarkdown } from '../ui/markdown.js';
import { openZoomViewer } from '../ui/zoom-viewer.js';
import { PLACES, resolvePlace } from '../ui/places.js';
import { icon } from '../ui/icons.js';

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
  if (chat.archived) return 'Archivada';
  if (state === 'working') return chat.delegating ? 'Delegando' : 'Trabajando';
  if (state === 'waiting') {
    const permissions = Number(chat.pendingPermsCount) || (chat.pendingPerms || []).length;
    return permissions ? `Espera permiso (${permissions})` : 'Te espera';
  }
  return 'En reposo';
}

function stateIcon(ctx, state) {
  if (state === 'working') return '<span class="cab-status-bars" aria-hidden="true"><i></i><i></i><i></i></span>';
  return ctx.icon(state === 'waiting' ? 'warning' : 'rest');
}

function conversationMeta(chat, state) {
  const model = chat.modelChoice === 'auto'
    ? `AutoTux · ${chat.model || 'modelo automático'}`
    : (chat.modelChoice === 'tandem' ? 'Tándem' : (chat.model || 'Sin modelo'));
  const place = String(chat.cwd || '').split('/').filter(Boolean).pop() || 'Mi Consola';
  if (state === 'working' && chat.bgTasks?.length) return `${chat.bgTasks.length} trabajo(s) en segundo plano · ${place}`;
  if (state === 'working' && chat.delegatingCount) return `${chat.delegatingCount} subagente(s) · ${place}`;
  if (chat.viewMode === 'tui') return `En modo Terminal · ${place}`;
  return `${model} · ${place}`;
}

const WORLD_ORDER = ['__aduana', '__limbo', ...PLACES.map((place) => place.rel), '__otros'];

function chatWorld(chat) {
  if (chat.limbo) return '__limbo';
  return resolvePlace(chat.cwd)?.rel || '__otros';
}

function worldLabel(world) {
  if (world === '__aduana') return 'Aduana';
  if (world === '__limbo') return 'Limbo';
  if (world === '__otros') return 'Otros lugares';
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
  return '<svg class="cab-fs-icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 4h5l2 2h7v8H2z"></path></svg>';
}

function conversationIcon() {
  return '<svg class="cab-fs-icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 3h12v9H8l-3 3v-3H3z"></path></svg>';
}

function floatingPanelIcon(name) {
  const body = name === 'acta'
    ? '<path d="M3 3h10M3 8h10M3 13h10"></path><path d="M1 3h.01M1 8h.01M1 13h.01"></path>'
    : '<path d="M3 1h7l3 3v11H3z"></path><path d="M10 1v4h3M6 9h4M6 12h4"></path>';
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
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
          <span class="cab-fs-item-name">${escapeHtml(chat.title || 'Conversación sin título')}</span>
          <span class="cab-fs-item-meta">${escapeHtml(conversationMeta(chat, state))}</span>
        </span>
        <span class="cab-status-chip cab-status-chip--${state}">
          ${stateIcon(ctx, state)}
          ${escapeHtml(stateLabel(chat, state))}
        </span>
      </div>
      <button class="cab-fs-more" type="button" data-chat-menu aria-label="Opciones de ${escapeHtml(chat.title || 'la conversación')}" title="Opciones">⋯</button>
    </div>`;
}

function greeting() {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat('es', { weekday: 'long' }).format(now);
  const day = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  const hour = now.getHours();
  const period = hour < 6 ? 'de madrugada' : (hour < 12 ? 'a la mañana' : (hour < 20 ? 'a la tarde' : 'a la noche'));
  return `${day} ${period}`;
}

function joinSummary(parts) {
  if (parts.length < 2) return parts[0] || '';
  if (parts.length === 2) return `${parts[0]} y ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
}

function unreadRoomCount(rooms) {
  if (!Array.isArray(rooms)) return null;
  if (!rooms.every((room) => room.salaUnread != null && Number.isFinite(Number(room.salaUnread)))) return null;
  return rooms.reduce((sum, room) => sum + Math.max(0, Number(room.salaUnread)), 0);
}

function workSummary(working, waiting, rooms) {
  const parts = [];
  if (working) parts.push(`${working} ${working === 1 ? 'conversación' : 'conversaciones'} trabajando`);
  if (waiting) parts.push(`${waiting} ${waiting === 1 ? 'te espera' : 'te esperan'}`);
  const unread = unreadRoomCount(rooms);
  if (unread) parts.push(`hay ${unread} mensaje${unread === 1 ? '' : 's'} nuevo${unread === 1 ? '' : 's'} en ${rooms.length === 1 ? 'la sala compartida' : 'las salas compartidas'}`);
  const text = joinSummary(parts);
  return text ? `${text}.` : 'No hay conversaciones activas ahora.';
}

function summaryCardsHtml(rooms, retroCounts) {
  const unread = unreadRoomCount(rooms);
  const proposalsValue = retroCounts?.propuesta;
  const proposals = proposalsValue != null && Number.isFinite(Number(proposalsValue))
    ? Math.max(0, Number(proposalsValue))
    : null;
  const roomMeta = unread == null
    ? ''
    : `<span class="cab-summary-meta"><i class="cab-peer-mark" aria-hidden="true"></i>${unread ? `${unread} mensaje${unread === 1 ? '' : 's'} nuevo${unread === 1 ? '' : 's'}` : 'Sin mensajes nuevos'}</span>`;
  const roomCard = `
    <button class="cab-summary-card" type="button" data-cabina-view="salas">
      <span class="cab-summary-eyebrow">Sala compartida</span>
      <span class="cab-summary-title">${rooms.length} sala${rooms.length === 1 ? '' : 's'} compartida${rooms.length === 1 ? '' : 's'}</span>
      ${roomMeta}
    </button>`;
  const lessonCard = proposals == null ? '' : `
    <button class="cab-summary-card" type="button" data-cabina-view="lecciones">
      <span class="cab-summary-eyebrow">Lecciones</span>
      <span class="cab-summary-title">${proposals} esperando tu visto bueno</span>
      <span class="cab-summary-meta">Lo que aprendió de cómo trabajás</span>
    </button>`;
  return `<div class="cab-summary-grid">${roomCard}${lessonCard}</div>`;
}

function archivedHtml(chats, ctx, expanded) {
  if (!chats.length) return '';
  return `
    <details class="cab-fs-folder cab-fs-archive" ${expanded ? 'open' : ''}>
      <summary class="cab-fs-folder-head"><span class="cab-fs-chevron" aria-hidden="true"></span>${folderIcon()}<span>Archivadas</span><span class="cab-fs-count">${chats.length}</span></summary>
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
          <p class="cab-subtitle" data-conversation-summary>Consultando tu trabajo…</p>
        </div>
        <div class="cab-fs-page-actions">
          <button class="cab-btn cab-btn--cold" type="button" data-create-folder>${folderIcon()} Nueva carpeta</button>
          <label class="cab-search">
            <input type="search" placeholder="Buscar" aria-label="Buscar conversaciones" data-conversation-search>
            ${ctx.icon('search')}
          </label>
        </div>
        <button class="cab-help-btn" type="button" data-cabina-help title="Cómo se usa esta pantalla" aria-label="Cómo se usa esta pantalla">${icon('help', { size: 16 })}</button>
      </header>
      <div class="cab-conversation-list" data-conversation-list>
        <div class="cab-view-state cab-view-state--loading"><span class="cab-spinner" aria-hidden="true"></span><span>Cargando conversaciones…</span></div>
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

  const openMenu = (items, { anchor = null, x = null, y = null, label = 'Opciones' } = {}) => {
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
    const proposed = window.prompt(`Nombre de la nueva carpeta en ${worldLabel(world)}:`);
    if (proposed === null) return;
    const name = proposed.trim();
    if (!name) {
      ctx.toast('Escribí un nombre para la carpeta.');
      return;
    }
    try {
      const data = await ctx.api.post('/api/folders/create', { name, world });
      if (data?.folder) foldersState.folders.push(data.folder);
      paint();
    } catch (error) {
      ctx.toast(error.message || 'No se pudo crear la carpeta.');
    }
  };

  const renameFolder = async (folder) => {
    const proposed = window.prompt('Nuevo nombre de la carpeta:', folder.name || '');
    if (proposed === null) return;
    const name = proposed.trim();
    if (!name) {
      ctx.toast('El nombre de la carpeta no puede quedar vacío.');
      return;
    }
    try {
      const data = await ctx.api.post('/api/folders/rename', { id: folder.id, name });
      foldersState.folders = foldersState.folders.map((item) => item.id === folder.id ? (data.folder || { ...item, name }) : item);
      paint();
    } catch (error) {
      ctx.toast(error.message || 'No se pudo cambiar el nombre de la carpeta.');
    }
  };

  const deleteFolder = async (folder) => {
    const confirmed = window.confirm(`¿Eliminar la carpeta “${folder.name}”?\n\nLas conversaciones y terminales no se borrarán: quedarán fuera de la carpeta.`);
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
      ctx.toast(error.message || 'No se pudo eliminar la carpeta.');
    }
  };

  const renameChat = async (chat) => {
    const proposed = window.prompt('Nuevo nombre de la conversación:', chat.title || '');
    if (proposed === null) return;
    try {
      const data = await ctx.api.post('/api/chat/title', { id: chat.id, title: proposed.trim() });
      updateChat(data?.chat || { ...chat, title: proposed.trim() });
    } catch (error) {
      ctx.toast(error.message || 'No se pudo cambiar el nombre de la conversación.');
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
      ctx.toast(error.message || 'No se pudo mover la conversación.');
    }
  };

  const archiveChat = async (chat) => {
    const confirmed = window.confirm(`¿Archivar “${chat.title || 'esta conversación'}”?\n\nPodrás recuperarla más adelante desde la consola.`);
    if (!confirmed) return;
    try {
      const data = await ctx.api.post('/api/chat/archive', { id: chat.id });
      updateChat(data?.chat || { ...chat, archived: true, alive: false });
    } catch (error) {
      ctx.toast(error.message || 'No se pudo archivar la conversación.');
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
      { label: `${current === null ? '✓ ' : ''}Fuera de carpetas`, action: () => assignChat(chat, null) },
      ...folders.map((folder) => ({
        label: `${current === folder.id ? '✓ ' : ''}${folder.name}`,
        action: () => assignChat(chat, folder.id),
      })),
    ], { ...position, label: 'Mover conversación' });
  };

  const openChatMenu = (chat, position) => {
    const ownerActions = canManageChat(chat);
    openMenu([
      { label: 'Cambiar el nombre', disabled: !ownerActions, action: () => renameChat(chat) },
      { label: 'Mover a una carpeta…', disabled: chat.archived, action: () => openMoveMenu(chat, position) },
      ...(!chat.archived ? [{ label: 'Archivar conversación', danger: true, disabled: !ownerActions, action: () => archiveChat(chat) }] : []),
    ], { ...position, label: `Opciones de ${chat.title || 'la conversación'}` });
  };

  const openFolderMenu = (folder, position) => {
    openMenu([
      { label: 'Cambiar el nombre', action: () => renameFolder(folder) },
      { label: 'Eliminar carpeta', danger: true, action: () => deleteFolder(folder) },
    ], { ...position, label: `Opciones de ${folder.name}` });
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
      ctx.toast('Esa carpeta pertenece a otro lugar. Mové la conversación dentro de su lugar actual.');
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
      ctx.toast(error.message || 'No se pudo guardar el nuevo orden.');
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
            <button class="cab-fs-more" type="button" data-folder-menu="${escapeHtml(folder.id)}" aria-label="Opciones de ${escapeHtml(folder.name)}" title="Opciones">⋯</button>
          </summary>
          <div class="cab-fs-folder-body cab-fs-conversation-grid">
            ${ordered.length ? ordered.map((chat) => rowHtml(chat, ctx, container, { draggable: !needle })).join('') : '<div class="cab-fs-empty">Carpeta vacía · arrastrá una conversación acá</div>'}
          </div>
        </details>`;
      }).join('');
      const rootContainer = `world:${world}`;
      const orderedLoose = orderChats(rootContainer, loose);
      sections.push(`<section class="cab-fs-world" data-world="${escapeHtml(world)}">
        <div class="cab-fs-world-head">
          <span>${escapeHtml(worldLabel(world))}</span><span class="cab-fs-count">${worldChats.length}</span>
          <button class="cab-fs-world-add" type="button" data-world-add="${escapeHtml(world)}">+ Nueva carpeta</button>
        </div>
        ${folderRows}
        <div class="cab-fs-root-drop cab-fs-conversation-grid" data-drop-container="${escapeHtml(rootContainer)}" data-drop-world="${escapeHtml(world)}">
          <div class="cab-fs-root-label">Conversaciones fuera de carpetas</div>
          ${orderedLoose.length ? orderedLoose.map((chat) => rowHtml(chat, ctx, rootContainer, { draggable: !needle })).join('') : '<div class="cab-fs-empty">Soltá acá una conversación para sacarla de una carpeta</div>'}
        </div>
      </section>`);
    }
    return `<div class="cab-fs-tree" aria-label="Explorador de conversaciones">
      ${sections.join('') || `<div class="cab-fs-empty cab-fs-empty--main">${needle ? 'No hay conversaciones que coincidan con la búsqueda.' : 'Todavía no hay conversaciones. Podés empezar creando una carpeta.'}</div>`}
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
        list.innerHTML = `<div class="cab-view-state cab-view-state--error"><strong>No se pudieron cargar las conversaciones.</strong><span>${escapeHtml(error.message)}</span></div>`;
        summary.textContent = 'La lista no está disponible.';
      } else {
        ctx.toast(`No se pudo actualizar la lista: ${error.message}`);
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
    openMenu(worlds.map((world) => ({ label: `Crear en ${worldLabel(world)}`, action: () => createFolder(world) })), {
      anchor: createButton,
      label: 'Elegir dónde crear la carpeta',
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
  { test: /^(Read|Glob|Grep)$/i, label: 'Revisando tus archivos…' },
  { test: /^(Write|Edit|MultiEdit|NotebookEdit)$/i, label: 'Escribiendo un documento…' },
  { test: /^(WebSearch|WebFetch)$/i, label: 'Buscando información…' },
  { test: /^(Task|Agent)$/i, label: 'Coordinando el trabajo…' },
  { test: /^(TodoRead|TodoWrite)$/i, label: 'Organizando los próximos pasos…' },
  { test: /^AskUserQuestion$/i, label: 'Preparando una pregunta…' },
  { test: /^Bash$/i, label: 'Realizando una tarea…' },
  { test: /^mcp__gmail__/i, label: 'Buscando en tu correo…' },
  { test: /^mcp__google_drive__/i, label: 'Revisando tus documentos…' },
  { test: /^mcp__google_calendar__/i, label: 'Revisando tu agenda…' },
  { test: /^mcp__github__/i, label: 'Revisando el proyecto…' },
];

function toolActivityLabel(name) {
  return TOOL_ACTIVITY_LABELS.find(({ test }) => test.test(String(name || '')))?.label || 'Trabajando…';
}

function eventToolId(event) {
  return event.id || event.toolUseId || event.tool_use_id || null;
}

const IMAGE_ATTACHMENT_RE = /\.(?:jpe?g|png|gif|webp)$/i;

function attachmentChip(label) {
  const chip = document.createElement('span');
  chip.className = 'cab-chat-attachment-chip';
  chip.textContent = label || 'Adjunto';
  return chip;
}

function openChatImage(src, title) {
  const image = document.createElement('img');
  image.className = 'cab-chat-zoom-image';
  image.alt = title || 'Imagen ampliada';
  image.src = src;
  const open = () => openZoomViewer({ title: title || 'Imagen', node: image });
  if (image.complete && image.naturalWidth > 0) open();
  else image.addEventListener('load', open, { once: true });
}

function zoomableImage(src, name, fallbackLabel) {
  const button = document.createElement('button');
  button.className = 'cab-chat-image-button';
  button.type = 'button';
  button.title = `Ampliar ${name}`;
  button.setAttribute('aria-label', `Ampliar ${name}`);
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
      attachments.appendChild(attachmentChip(name || attachment?.type || 'Adjunto'));
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
    note.textContent = 'No pude completar una parte del trabajo. Podés volver a intentar.';
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
    meta.innerHTML = '<span class="cab-agent-mark" aria-hidden="true">✦</span><span>Asistente</span>';
    const name = event.alt || event.name || 'Imagen compartida por el asistente';
    article.append(meta, zoomableImage(src, name, 'Imagen no disponible'));
    return article;
  }
  const isPerson = event.type === 'user' || event.type === 'say';
  const isAgent = event.type === 'assistant';
  if (!isPerson && !isAgent) return null;
  const who = isPerson ? (event.by || 'Vos') : 'Asistente';
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
  if (!chat) throw new Error('La conversación no existe o no está disponible para esta cuenta.');
  const composerDisabled = chat.archived || chat.viewMode === 'tui';
  el.innerHTML = `
    <section class="cab-main-inner cab-conversation-detail">
      <header class="cab-page-header cab-page-header--detail">
        <button class="cab-btn cab-btn--cold" type="button" data-conversation-back>${ctx.icon('back')} Conversaciones</button>
        <div class="cab-detail-heading">
          <h1 class="cab-title">${escapeHtml(chat.title || 'Conversación sin título')}</h1>
          <p class="cab-subtitle">${escapeHtml(conversationMeta(chat, stateOf(chat)))}</p>
        </div>
      </header>
      <div class="cab-detail-layout">
        <div class="cab-thread-column">
          <div class="cab-thread" data-conversation-thread>
            <div class="cab-view-state cab-view-state--loading"><span class="cab-spinner" aria-hidden="true"></span><span>Cargando historial…</span></div>
          </div>
          <form class="cab-composer" data-conversation-composer>
            <textarea class="cab-composer-field" rows="2" placeholder="Escribí un mensaje" aria-label="Mensaje" data-conversation-input ${composerDisabled ? 'disabled' : ''}></textarea>
            <div class="cab-composer-actions">
              <span class="cab-composer-status" data-conversation-status>${composerDisabled ? (chat.archived ? 'Reviví la conversación desde la consola actual para continuar.' : 'Esta conversación está en modo Terminal.') : 'Conectando…'}</span>
              <button class="cab-btn cab-btn--hot cab-composer-send" type="submit" data-conversation-send disabled>${ctx.icon('send')} Enviar</button>
            </div>
          </form>
        </div>
        <aside class="cab-panel-dock" aria-label="Paneles de la conversación" data-panel-dock>
          <section class="cab-floating-panel cab-floating-panel--acta" id="cab-floating-acta" data-floating-panel="acta" role="dialog" aria-label="Índice de la conversación" aria-hidden="true" tabindex="-1" inert>
            <button class="cab-floating-panel-close" type="button" data-panel-close="acta" aria-label="Cerrar Índice" title="Cerrar Índice">×</button>
            <div class="cab-floating-panel-content"><section data-cabina-panel="acta"></section></div>
          </section>
          <section class="cab-floating-panel cab-floating-panel--artefactos" id="cab-floating-artefactos" data-floating-panel="artefactos" role="dialog" aria-label="Artefactos de la conversación" aria-hidden="true" tabindex="-1" inert>
            <button class="cab-floating-panel-close" type="button" data-panel-close="artefactos" aria-label="Cerrar Artefactos" title="Cerrar Artefactos">×</button>
            <div class="cab-floating-panel-content"><section data-cabina-panel="artefactos"></section></div>
          </section>
          <div class="cab-panel-launchers">
            <button class="cab-panel-launcher" type="button" data-panel-toggle="acta" aria-controls="cab-floating-acta" aria-expanded="false" aria-label="Abrir Índice" title="Índice">
              ${floatingPanelIcon('acta')}<span class="cab-panel-count" data-panel-count="acta" hidden></span>
            </button>
            <button class="cab-panel-launcher" type="button" data-panel-toggle="artefactos" aria-controls="cab-floating-artefactos" aria-expanded="false" aria-label="Abrir Artefactos" title="Artefactos">
              ${floatingPanelIcon('artefactos')}<span class="cab-panel-count" data-panel-count="artefactos" hidden></span>
            </button>
          </div>
        </aside>
        <button class="cab-jump-latest" type="button" data-jump-latest aria-label="Ir al último mensaje" aria-hidden="true" tabindex="-1">
          <span aria-hidden="true">↓</span>
          <span>Ir al último</span>
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
      button.setAttribute('aria-label', `${isOpen ? 'Cerrar' : 'Abrir'} ${panelName === 'acta' ? 'Índice' : 'Artefactos'}`);
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
        ? `Ir al último mensaje, ${nuevosMensajes} ${nuevosMensajes === 1 ? 'mensaje nuevo' : 'mensajes nuevos'}`
        : 'Ir al último mensaje',
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
    thread.innerHTML = '<div class="cab-view-state"><p>Esta conversación todavía no tiene mensajes.</p></div>';
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
    status.textContent = connected ? 'Conectada' : 'Reconectando…';
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
        live.innerHTML = '<div class="cab-message-meta"><span class="cab-agent-mark" aria-hidden="true">✦</span><span>Asistente</span></div><div class="cab-message-bubble"></div>';
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
    if (message.type === 'status') status.textContent = message.state === 'working' ? 'El asistente está trabajando…' : 'Conectada';
    appendEvent(message, { countAsNew });
  };
  const connect = () => {
    if (!active) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/ws/chat?id=${encodeURIComponent(id)}`);
    socket.addEventListener('open', () => { if (active) status.textContent = 'Cargando historial…'; });
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
    status.textContent = 'Enviando…';
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
