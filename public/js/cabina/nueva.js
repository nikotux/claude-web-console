import { PLACES, resolvePlace } from '../ui/places.js';

const ROOT_WORLD = '__otros';
const NON_NEW_CHAT_WORLDS = new Set(['__aduana', '__limbo']);
const WORLD_ORDER = [...PLACES.map((place) => place.rel), ROOT_WORLD];

function isNewChatWorld(world) {
  return typeof world === 'string'
    && /^[a-z0-9_-]{1,40}$/i.test(world)
    && !NON_NEW_CHAT_WORLDS.has(world);
}

function chatWorld(chat) {
  if (chat?.limbo) return '__limbo';
  return resolvePlace(chat?.cwd)?.rel || ROOT_WORLD;
}

function belongsToIdentity(chat, identity) {
  const me = identity?.username || identity?.host || null;
  if (!me) return false;
  const owner = chat?.owner || identity.host || null;
  return owner === me || (chat?.participants || []).some((participant) => participant?.user === me);
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

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function errorMessage(error, fallback) {
  return error?.message || fallback;
}

export async function abrirMenuNuevaConversacion(ctx) {
  const previousFocus = document.activeElement;
  const [foldersResult, chatsResult, whoamiResult] = await Promise.allSettled([
    ctx.api.get('/api/folders/list'),
    ctx.api.get('/api/chat/list'),
    ctx.api.get('/api/whoami'),
  ]);
  const identity = whoamiResult.status === 'fulfilled' ? whoamiResult.value : null;
  const folders = foldersResult.status === 'fulfilled'
    ? (Array.isArray(foldersResult.value?.folders) ? foldersResult.value.folders : [])
      .filter((folder) => folder?.parentId === null && isNewChatWorld(folder.world))
    : [];
  const chats = chatsResult.status === 'fulfilled' && identity
    ? (Array.isArray(chatsResult.value?.chats) ? chatsResult.value.chats : [])
      .filter((chat) => !chat?.archived && !chat?.isSala && belongsToIdentity(chat, identity))
    : [];
  const worlds = new Set(folders.map((folder) => folder.world));
  for (const chat of chats) {
    const world = chatWorld(chat);
    if (isNewChatWorld(world)) worlds.add(world);
  }
  const availableWorlds = [...worlds].sort(compareWorlds);
  const overlay = makeElement('div', 'cab-nueva-overlay');
  const panel = makeElement('div', 'cab-nueva-panel');
  const title = makeElement('h1', 'cab-nueva-title', 'Nueva conversación');
  const folderGroup = makeElement('section', 'cab-nueva-group');
  const folderLabel = makeElement('p', 'cab-nueva-group-label', 'Guardarla en');
  const thinkingGroup = makeElement('section', 'cab-nueva-group');
  const thinkingLabel = makeElement('p', 'cab-nueva-group-label', 'Cuánto tiene que pensarlo');
  const error = makeElement('p', 'cab-nueva-error');
  const actions = makeElement('footer', 'cab-nueva-actions');
  const cancelButton = makeElement('button', 'cab-btn', 'Cancelar');
  const createButton = makeElement('button', 'cab-btn cab-btn--hot', 'Crear');
  const folderOptions = [];
  const placeGroups = new Map();
  const modelOptions = [];
  let selectedFolder = null;
  let selectedWorld = null;
  let selectedModel = 'tandem';
  let busy = false;
  let finished = false;

  title.id = 'new-conversation-title';
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', title.id);
  folderGroup.setAttribute('role', 'radiogroup');
  folderGroup.setAttribute('aria-labelledby', 'new-conversation-folder-label');
  folderLabel.id = 'new-conversation-folder-label';
  thinkingGroup.setAttribute('role', 'radiogroup');
  thinkingGroup.setAttribute('aria-labelledby', 'new-conversation-thinking-label');
  thinkingLabel.id = 'new-conversation-thinking-label';
  error.hidden = true;
  error.setAttribute('role', 'alert');
  cancelButton.type = 'button';
  createButton.type = 'button';

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }

  function selectableOption({ name, hint, selected, onSelect }) {
    const option = makeElement('button', `cab-nueva-option${selected ? ' cab-nueva-option--on' : ''}`);
    const mark = makeElement('span', 'cab-nueva-option-mark');
    const optionName = makeElement('span', 'cab-nueva-option-name', name);
    const optionHint = makeElement('span', 'cab-nueva-option-hint', hint);
    option.type = 'button';
    option.disabled = busy;
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', selected ? 'true' : 'false');
    mark.setAttribute('aria-hidden', 'true');
    option.append(mark, optionName, optionHint);
    option.addEventListener('click', onSelect);
    return option;
  }

  function updateSelection(options, selectedOption) {
    for (const option of options) {
      const on = option === selectedOption;
      option.classList.toggle('cab-nueva-option--on', on);
      option.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function chooseFolder(value, world, option) {
    if (busy) return;
    selectedFolder = value;
    selectedWorld = world;
    updateSelection(folderOptions, option);
    for (const [placeWorld, group] of placeGroups) {
      group.newFolderRow.hidden = value !== 'new' || world !== placeWorld;
    }
    clearError();
    if (value === 'new') placeGroups.get(world)?.newFolderInput.focus();
  }

  function addFolderOption(folder) {
    const existing = folderOptions.find((item) => item.dataset.folderId === folder.id);
    if (existing) return existing;
    const group = placeGroups.get(folder.world);
    if (!group) return null;
    const option = selectableOption({
      name: folder.name,
      hint: 'La conversación aparecerá dentro de esta carpeta.',
      selected: selectedFolder === folder.id,
      onSelect: () => chooseFolder(folder.id, folder.world, option),
    });
    option.dataset.folderId = folder.id;
    folderOptions.push(option);
    group.element.insertBefore(option, group.newFolderOption);
    return option;
  }

  const noFolderOption = selectableOption({
    name: 'Sin carpeta',
    hint: 'Queda suelta en la lista de conversaciones.',
    selected: true,
    onSelect: () => chooseFolder(null, null, noFolderOption),
  });
  folderOptions.push(noFolderOption);
  folderGroup.append(folderLabel, noFolderOption);

  function addNewFolderTarget(world, { grouped, cwd, description }) {
    const element = grouped ? makeElement('div', 'cab-nueva-place') : folderGroup;
    const newFolderRow = makeElement('div', 'cab-nueva-newfolder');
    const newFolderInput = makeElement('input', 'cab-nueva-newfolder-input');
    let newFolderOption;
    newFolderInput.type = 'text';
    newFolderInput.maxLength = 40;
    newFolderInput.placeholder = 'Nombre de la carpeta';
    newFolderInput.setAttribute('aria-label', `Nombre de la carpeta nueva en ${description}`);
    newFolderRow.hidden = true;
    newFolderRow.appendChild(newFolderInput);
    newFolderOption = selectableOption({
      name: '+ Nueva carpeta…',
      hint: `Creá una carpeta en ${description} y guardá ahí esta conversación.`,
      selected: false,
      onSelect: () => chooseFolder('new', world, newFolderOption),
    });
    folderOptions.push(newFolderOption);
    placeGroups.set(world, {
      element,
      cwd,
      newFolderOption,
      newFolderRow,
      newFolderInput,
    });
    if (grouped) {
      element.append(makeElement('p', 'cab-nueva-place-label', worldLabel(world)));
    }
    element.append(newFolderOption, newFolderRow);
    if (grouped) folderGroup.appendChild(element);
  }

  for (const world of availableWorlds) {
    addNewFolderTarget(world, {
      grouped: true,
      cwd: world === ROOT_WORLD ? null : world,
      description: worldLabel(world),
    });
  }
  if (!availableWorlds.length) {
    // conversaciones.js clasifica como __otros los cwd que resolvePlace no reconoce.
    // Usamos ese mismo mundo para la carpeta inicial, pero omitimos cwd al crear el
    // chat: así el backend lo ubica en la raíz real (y siempre existente) del usuario.
    addNewFolderTarget(ROOT_WORLD, {
      grouped: false,
      cwd: null,
      description: 'tu espacio',
    });
  }

  const allModels = [
    { name: 'Rápido', model: 'haiku', hint: 'Responde enseguida; va bien para cosas simples.' },
    { name: 'Equilibrado', model: 'tandem', hint: 'Es el ritmo normal y sirve para casi todo.' },
    { name: 'A fondo', model: 'opus', hint: 'Se toma más tiempo; conviene para temas difíciles.' },
  ];
  const profile = identity?.profile || 'sponsored';
  // En Cabina los turnos los paga el sponsor, no quien los pide; por eso el nivel más caro
  // no se ofrece a quien no lo paga. Esto es recorte de experiencia, no seguridad: ocultar
  // una opción no autoriza ni bloquea; el gate real vive en el backend. Hoy, deliberadamente,
  // POST /api/chat/create todavía acepta model: 'opus' si alguien lo llama a mano.
  const models = profile === 'sponsored' ? allModels.slice(0, 2) : allModels;
  thinkingGroup.appendChild(thinkingLabel);
  for (const model of models) {
    const option = selectableOption({
      name: model.name,
      hint: model.hint,
      selected: model.model === selectedModel,
      onSelect: () => {
        if (busy) return;
        selectedModel = model.model;
        updateSelection(modelOptions, option);
        clearError();
      },
    });
    modelOptions.push(option);
    thinkingGroup.appendChild(option);
  }

  actions.append(cancelButton, createButton);
  panel.append(title, folderGroup, thinkingGroup, error, actions);
  overlay.appendChild(panel);

  function setBusy(value) {
    busy = value;
    createButton.disabled = value;
    cancelButton.disabled = value;
    for (const group of placeGroups.values()) group.newFolderInput.disabled = value;
    for (const option of [...folderOptions, ...modelOptions]) option.disabled = value;
    if (value) createButton.setAttribute('aria-busy', 'true');
    else createButton.removeAttribute('aria-busy');
  }

  function onDocumentKeydown(event) {
    if (event.key === 'Escape') {
      if (!busy) finish(null);
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...panel.querySelectorAll('button, input')]
      .filter((control) => !control.disabled && !control.closest('[hidden]'));
    if (!controls.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onOverlayPointerdown(event) {
    if (event.target === overlay && !busy) finish(null);
  }

  let resolveMenu;
  const result = new Promise((resolve) => { resolveMenu = resolve; });

  function finish(chat) {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onDocumentKeydown, true);
    overlay.removeEventListener('pointerdown', onOverlayPointerdown);
    overlay.remove();
    resolveMenu(chat);
    window.setTimeout(() => previousFocus?.focus?.(), 0);
  }

  cancelButton.addEventListener('click', () => finish(null));
  overlay.addEventListener('pointerdown', onOverlayPointerdown);
  document.addEventListener('keydown', onDocumentKeydown, true);
  document.body.appendChild(overlay);
  panel.focus();

  folders.sort((a, b) => compareWorlds(a.world, b.world) || compareFolders(a, b));
  for (const folder of folders) addFolderOption(folder);
  if (foldersResult.status === 'rejected') {
    showError(errorMessage(foldersResult.reason, 'No se pudieron cargar tus carpetas.'));
  }
  if (chatsResult.status === 'rejected') {
    showError(errorMessage(chatsResult.reason, 'No se pudieron cargar tus conversaciones.'));
  }

  createButton.addEventListener('click', async () => {
    if (busy) return;
    clearError();
    const selectedPlaceGroup = selectedWorld ? placeGroups.get(selectedWorld) : null;
    if (selectedFolder === 'new' && !selectedPlaceGroup?.newFolderInput.value.trim()) {
      showError('Escribí un nombre para la carpeta.');
      selectedPlaceGroup?.newFolderInput.focus();
      return;
    }

    setBusy(true);
    try {
      let folderId = selectedFolder;
      if (folderId === 'new') {
        const folderData = await ctx.api.post('/api/folders/create', {
          name: selectedPlaceGroup.newFolderInput.value.trim(),
          world: selectedWorld,
        });
        if (!folderData?.folder?.id) throw new Error('El servidor no devolvió la carpeta creada.');
        folderId = folderData.folder.id;
        const createdOption = addFolderOption(folderData.folder);
        selectedFolder = folderId;
        updateSelection(folderOptions, createdOption);
        selectedPlaceGroup.newFolderRow.hidden = true;
      }

      const model = models.some((option) => option.model === selectedModel)
        ? selectedModel
        : 'tandem';
      const chatRequest = {
        model,
        permissionMode: 'bypassPermissions',
      };
      if (folderId && selectedPlaceGroup?.cwd) chatRequest.cwd = selectedPlaceGroup.cwd;
      const chatData = await ctx.api.post('/api/chat/create', chatRequest);
      const chat = chatData?.chat;
      if (!chat?.id) throw new Error('El servidor no devolvió la conversación creada.');

      if (folderId) {
        try {
          await ctx.api.post('/api/folders/assign', { key: `chat:${chat.id}`, folderId });
        } catch (assignError) {
          const detail = errorMessage(assignError, 'Error desconocido.');
          ctx.toast(`La conversación se creó, pero no se pudo guardar en la carpeta: ${detail}`);
        }
      }
      finish(chat);
    } catch (createError) {
      showError(errorMessage(createError, 'No se pudo crear la conversación.'));
      setBusy(false);
    }
  });

  return result;
}
