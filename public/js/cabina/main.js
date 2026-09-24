import { icon as uiIcon } from '../ui/icons.js';
import { t, getLang, setLang, initI18n, applyI18n } from '../ui/i18n.js';

const VIEW_MODULES = {
  conversaciones: './conversaciones.js',
  archivos: './archivos.js',
  conexiones: './conexiones.js',
  'como-trabajo': './como-trabajo.js',
  lecciones: './lecciones.js',
  salas: './salas.js',
};

const DEFAULT_VIEW = 'conversaciones';
const slot = document.querySelector('[data-cabina-view].cab-main');
const toastRegion = document.querySelector('[data-cabina-toasts]');
let mountedModule = null;
let navigationGeneration = 0;
let currentIdentity = null;
let creatingConversation = false;
let requestingLifeline = false;

function backendMessage(payload, fallback) {
  if (payload && typeof payload === 'object') return payload.error || payload.message || fallback;
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  return fallback;
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(backendMessage(payload, t(
      'cabina.shell.serverError',
      'Error {status} al consultar el servidor.',
      { status: response.status },
    )));
  }
  return payload;
}

const api = {
  get(path) {
    return request(path);
  },
  post(path, body) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  },
};

function toast(message) {
  const item = document.createElement('div');
  item.className = 'cab-toast';
  item.textContent = String(message || '');
  toastRegion?.appendChild(item);
  window.setTimeout(() => item.remove(), 4200);
}

function fmtDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(getLang(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function icon(name) {
  const paths = {
    back: '<path d="M14 8H3m4-4L3 8l4 4"></path>',
    search: '<rect x="2" y="2" width="9" height="9"></rect><path d="M12 12l4 4"></path>',
    send: '<path d="M2 3l13 5-13 5 3-5z"></path><path d="M5 8h10"></path>',
    warning: '<path d="M8 1l7 14H1z"></path><path d="M8 6v4"></path>',
    rest: '<polygon points="8,2 14,8 8,14 2,8"></polygon>',
  };
  const body = paths[name] || '<circle cx="8" cy="8" r="5"></circle>';
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="miter" aria-hidden="true">${body}</svg>`;
}

function readRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const requested = segments[0] || DEFAULT_VIEW;
  const viewName = Object.hasOwn(VIEW_MODULES, requested) ? requested : DEFAULT_VIEW;
  const params = Object.fromEntries(new URLSearchParams(queryPart));
  if ((viewName === 'conversaciones' || viewName === 'salas') && segments[1]) params.id = segments[1];
  return { viewName, params };
}

function go(viewName, params = {}) {
  const target = Object.hasOwn(VIEW_MODULES, viewName) ? viewName : DEFAULT_VIEW;
  let path = `#/${target}`;
  const query = new URLSearchParams();
  // Conversaciones y salas son las dos únicas vistas con detalle propio.
  if ((target === 'conversaciones' || target === 'salas') && params?.id != null) {
    path += `/${encodeURIComponent(String(params.id))}`;
  }
  for (const [key, value] of Object.entries(params || {})) {
    if (key === 'id' || value == null || value === '') continue;
    query.set(key, String(value));
  }
  const nextHash = path + (query.size ? `?${query}` : '');
  if (location.hash === nextHash) void mountRoute();
  else location.hash = nextHash;
}

function setActiveNav(viewName) {
  document.querySelectorAll('.cab-nav-item[data-cabina-view]').forEach((item) => {
    if (item.dataset.cabinaView === viewName) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

function loading() {
  slot.innerHTML = `<div class="cab-view-state cab-view-state--loading"><span class="cab-spinner" aria-hidden="true"></span><span>${t('cabina.shell.loading', 'Cargando…')}</span></div>`;
}

function placeholder() {
  slot.innerHTML = `<section class="cab-main-inner"><div class="cab-view-state"><p>${t('cabina.shell.sectionNotConnected', 'Esta sección todavía no está conectada')}</p></div></section>`;
}

function showError(error) {
  slot.innerHTML = '';
  const state = document.createElement('div');
  state.className = 'cab-view-state cab-view-state--error';
  const title = document.createElement('strong');
  title.textContent = t('cabina.shell.openSectionError', 'No se pudo abrir esta sección.');
  const detail = document.createElement('span');
  detail.textContent = error?.message || t('cabina.shell.unknownError', 'Error desconocido.');
  state.append(title, detail);
  slot.appendChild(state);
}

function missingModule(error) {
  return error instanceof TypeError
    && /module|import|fetch|loading|load/i.test(String(error.message || ''));
}

async function mountRoute() {
  const generation = ++navigationGeneration;
  const { viewName } = readRoute();
  setActiveNav(viewName);
  try {
    mountedModule?.unmount?.();
  } catch (error) {
    console.error('[cabina] unmount falló:', error);
  }
  mountedModule = null;
  loading();

  let imported;
  try {
    imported = await import(VIEW_MODULES[viewName]);
  } catch (error) {
    if (generation !== navigationGeneration) return;
    if (missingModule(error)) placeholder();
    else showError(error);
    return;
  }
  if (generation !== navigationGeneration) return;

  const module = imported?.default;
  if (!module || module.name !== viewName || typeof module.mount !== 'function') {
    placeholder();
    return;
  }
  mountedModule = module;
  try {
    await module.mount(slot, { go, api, toast, fmtDate, icon });
  } catch (error) {
    if (generation === navigationGeneration) showError(error);
  }
}

async function createConversation(button) {
  if (creatingConversation) return;
  creatingConversation = true;
  try {
    const { abrirMenuNuevaConversacion } = await import('./nueva.js');
    const menu = abrirMenuNuevaConversacion({ go, api, toast, fmtDate, icon });
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const chat = await menu;
    if (!chat?.id) return;
    go('conversaciones', { id: chat.id });
    void refreshBadges();
  } catch (error) {
    toast(error?.message || t('cabina.shell.createConversationError', 'No se pudo crear la conversación.'));
  } finally {
    creatingConversation = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function requestLifeline(button) {
  if (requestingLifeline) return;
  requestingLifeline = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const data = await api.post('/api/chat/salvavidas');
    const chat = data?.chat;
    if (!chat?.id) throw new Error(t('cabina.shell.lifelineMissingRoom', 'El servidor no devolvió la sala de ayuda creada.'));
    location.hash = '#/salas/' + encodeURIComponent(chat.id);
    void refreshBadges();
  } catch (error) {
    toast(error?.message || t('cabina.shell.lifelineError', 'No se pudo abrir una sala de ayuda.'));
  } finally {
    requestingLifeline = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

function closeLogoutConfirmation(confirmBox, returnFocus = true) {
  const trigger = document.querySelector('[data-cabina-logout]');
  confirmBox?.remove();
  if (returnFocus) trigger?.focus();
}

function openLogoutConfirmation() {
  if (document.querySelector('.cab-cuenta-confirm')) return;
  const account = document.querySelector('.cab-account');
  if (!account) return;

  const confirmBox = document.createElement('div');
  const question = document.createElement('p');
  const actions = document.createElement('div');
  const cancelButton = document.createElement('button');
  const acceptButton = document.createElement('button');
  const questionId = 'cabina-logout-question';

  confirmBox.className = 'cab-cuenta-confirm';
  confirmBox.setAttribute('role', 'alertdialog');
  confirmBox.setAttribute('aria-modal', 'true');
  confirmBox.setAttribute('aria-labelledby', questionId);
  question.id = questionId;
  question.textContent = t('cabina.shell.logout.question', '¿Querés cerrar tu sesión?');
  cancelButton.type = 'button';
  cancelButton.className = 'cab-btn cab-btn--cold';
  cancelButton.dataset.cabinaLogoutCancel = '';
  cancelButton.textContent = t('cabina.shell.logout.cancel', 'Cancelar');
  acceptButton.type = 'button';
  acceptButton.className = 'cab-btn cab-btn--cold';
  acceptButton.dataset.cabinaLogoutAccept = '';
  acceptButton.textContent = t('cabina.shell.logout.accept', 'Cerrar sesión');
  actions.append(cancelButton, acceptButton);
  confirmBox.append(question, actions);
  account.appendChild(confirmBox);
  cancelButton.focus();
}

async function logout(confirmBox, button) {
  const controls = [...confirmBox.querySelectorAll('button')];
  controls.forEach((control) => { control.disabled = true; });
  button.setAttribute('aria-busy', 'true');
  try {
    await api.post('/logout');
    location.assign('/login');
  } catch (error) {
    toast(error?.message || t('cabina.shell.logout.error', 'No se pudo cerrar la sesión.'));
    controls.forEach((control) => { control.disabled = false; });
    button.removeAttribute('aria-busy');
  }
}

function hydrateAccountIcons() {
  document.querySelectorAll('[data-cabina-account-icon]').forEach((button) => {
    button.innerHTML = uiIcon(button.dataset.cabinaAccountIcon, { size: 18 });
    button.setAttribute('aria-label', button.title);
  });
  const langButton = document.querySelector('[data-cabina-lang]');
  if (!langButton) return;
  const currentLang = getLang();
  const nextTitle = currentLang === 'en'
    ? t('cabina.shell.language.switchToSpanish', 'Cambiar a español')
    : t('cabina.shell.language.switchToEnglish', 'Cambiar a inglés');
  langButton.innerHTML = uiIcon('language', { size: 16 });
  const code = document.createElement('span');
  code.textContent = currentLang.toUpperCase();
  langButton.appendChild(code);
  langButton.title = nextTitle;
  langButton.setAttribute('aria-label', nextTitle);
}

function setBadge(name, text, hot = false) {
  const badge = document.querySelector(`[data-cabina-badge="${name}"]`);
  if (!badge) return;
  badge.hidden = !text;
  badge.classList.toggle('cab-nav-badge--hot', hot);
  badge.replaceChildren();
  if (!text) return;
  if (hot) {
    const dot = document.createElement('i');
    dot.className = 'cab-live-dot';
    dot.setAttribute('aria-hidden', 'true');
    badge.appendChild(dot);
  }
  badge.append(String(text));
}

function updateBadges(chats) {
  const me = currentIdentity?.username || currentIdentity?.host || null;
  const belongsToMe = (chat) => {
    if (!me) return true;
    const owner = chat.owner || currentIdentity?.host || null;
    return owner === me || (chat.participants || []).some((participant) => participant?.user === me);
  };
  const open = (Array.isArray(chats) ? chats : []).filter((chat) => !chat.archived && belongsToMe(chat));
  const conversations = open.filter((chat) => !chat.isSala);
  const working = conversations.filter((chat) => chat.alive && chat.status === 'working').length;
  const waiting = conversations.filter((chat) => chat.alive && chat.status !== 'working').length;
  const unread = open.filter((chat) => chat.isSala)
    .reduce((sum, chat) => sum + Math.max(0, Number(chat.salaUnread) || 0), 0);
  setBadge('conversaciones', working || waiting ? `${working || waiting}` : '', Boolean(working));
  const unreadLabel = unread === 1
    ? t('cabina.shell.badges.oneNew', '{count} nuevo', { count: unread })
    : t('cabina.shell.badges.manyNew', '{count} nuevos', { count: unread });
  setBadge('salas', unread ? unreadLabel : '', false);
}

async function refreshBadges(identityOverride) {
  try {
    const [data, identity] = await Promise.all([
      api.get('/api/chat/list'),
      identityOverride !== undefined
        ? Promise.resolve(identityOverride)
        : (currentIdentity ? Promise.resolve(currentIdentity) : api.get('/api/whoami')),
    ]);
    currentIdentity = identity;
    updateBadges(data?.chats);
  } catch {
    // Los badges son información auxiliar; el módulo activo muestra su error completo.
  }
}

function hydrateAccount(me) {
  if (!me) return;
  currentIdentity = me;
  const name = me?.type === 'user'
    ? me.username
    : (me?.type === 'token'
      ? me.host || t('cabina.shell.account.host', 'Host')
      : t('cabina.shell.account.name', 'Mi cuenta'));
  const role = me?.type === 'user'
    ? t('cabina.shell.account.personal', 'Cuenta personal')
    : t('cabina.shell.account.hostAccess', 'Acceso del host');
  const mark = String(name || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const nameEl = document.querySelector('[data-cabina-account-name]');
  const roleEl = document.querySelector('[data-cabina-account-role]');
  const markEl = document.querySelector('[data-cabina-account-mark]');
  if (nameEl) nameEl.textContent = name;
  if (roleEl) roleEl.textContent = role;
  if (markEl) markEl.textContent = mark;
}

document.addEventListener('click', async (event) => {
  const langButton = event.target.closest('[data-cabina-lang]');
  if (langButton) {
    event.preventDefault();
    if (langButton.disabled) return;
    langButton.disabled = true;
    langButton.setAttribute('aria-busy', 'true');
    try {
      await setLang(getLang() === 'en' ? 'es' : 'en');
    } catch (error) {
      toast(error?.message || t('cabina.shell.language.error', 'No se pudo cambiar el idioma.'));
      langButton.disabled = false;
      langButton.removeAttribute('aria-busy');
    }
    return;
  }
  const newButton = event.target.closest('[data-cabina-new]');
  if (newButton) {
    event.preventDefault();
    void createConversation(newButton);
    return;
  }
  const lifelineButton = event.target.closest('[data-cabina-sos]');
  if (lifelineButton) {
    event.preventDefault();
    void requestLifeline(lifelineButton);
    return;
  }
  const helpButton = event.target.closest('[data-cabina-help]');
  if (helpButton) {
    event.preventDefault();
    void import('./ayuda.js')
      .then(({ abrirAyuda }) => abrirAyuda({ go, api, toast, fmtDate, icon }, readRoute().viewName))
      .catch((error) => toast(error?.message || t('cabina.shell.helpError', 'No se pudo abrir la ayuda.')));
    return;
  }
  const logoutButton = event.target.closest('[data-cabina-logout]');
  if (logoutButton) {
    event.preventDefault();
    openLogoutConfirmation();
    return;
  }
  const logoutCancelButton = event.target.closest('[data-cabina-logout-cancel]');
  if (logoutCancelButton) {
    event.preventDefault();
    closeLogoutConfirmation(logoutCancelButton.closest('.cab-cuenta-confirm'));
    return;
  }
  const logoutAcceptButton = event.target.closest('[data-cabina-logout-accept]');
  if (logoutAcceptButton) {
    event.preventDefault();
    const confirmBox = logoutAcceptButton.closest('.cab-cuenta-confirm');
    if (confirmBox) void logout(confirmBox, logoutAcceptButton);
    return;
  }
  const target = event.target.closest('[data-cabina-view]');
  if (!target || target === slot) return;
  const viewName = target.dataset.cabinaView;
  if (!Object.hasOwn(VIEW_MODULES, viewName)) return;
  event.preventDefault();
  go(viewName);
});
window.addEventListener('hashchange', mountRoute);
window.addEventListener('cabina:chats', (event) => updateBadges(event.detail?.chats));

if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/conversaciones`);
const meForLang = await request('/api/whoami').catch(() => null);
await initI18n(meForLang?.lang || 'es');
document.documentElement.lang = getLang();
applyI18n(document);
hydrateAccountIcons();
hydrateAccount(meForLang);
void refreshBadges(meForLang);
window.setInterval(refreshBadges, 15000);
void mountRoute();
