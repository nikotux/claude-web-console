// main.js — SHELL de la app: gestiona pestañas de terminal, el rail derecho y
// el sidebar; monta los módulos frontend en sus slots [data-module] y les
// inyecta servicios vía `ctx` (patrón espejo del registry backend — ver
// docs/frontend-modules.md).
import { TerminalTab } from './modules/terminal/terminal.js';
import { ChatTab } from './modules/chat/chat-tab.js';
import { icon, hydrateIcons } from './ui/icons.js';
import { modelColor } from './ui/models.js';
import { openModal, confirmDialog, promptDialog, alertDialog } from './ui/dialog.js';
import { initAuxBar } from './modules/mobile/auxbar.js';

import launcher from './modules/launcher/launcher.js';
import sessions from './modules/sessions/sessions.js';
import tolkien from './modules/tolkien/tolkien.js';
import stats from './modules/stats/stats.js';
import usage from './modules/usage/usage.js';
import system from './modules/system/system.js';

const MODULES = [launcher, sessions, tolkien, stats, usage, system];

// ===== Shell: pestañas de terminal + rail =====
const tabsEl = document.getElementById('rail-tabs');
const terminalsEl = document.getElementById('terminals');

const tabs = new Map(); // id -> { tab, tabButton, pane, flag, session }
let activeId = null;

const getActiveTab = () => tabs.get(activeId)?.tab || null;
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
const hideSidebarOnMobile = () => { if (isMobile()) document.getElementById('sidebar').classList.add('hidden'); };

// Iniciales para el chip de la pestaña (1-2 letras del título).
function chipLabel(title) {
  const s = (title || '').replace(/[^a-z0-9]/gi, '');
  return s ? s.slice(0, 2).toUpperCase() : '•';
}

function setActive(id) {
  activeId = id;
  for (const [tid, entry] of tabs) {
    const on = tid === id;
    entry.pane.classList.toggle('active', on);
    entry.tabButton.classList.toggle('active', on);
    if (on) entry.tab.focus();
  }
}

function addTab(session, { type = 'pty' } = {}) {
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  terminalsEl.appendChild(pane);

  const tabButton = document.createElement('div');
  tabButton.className = 'rail-tab';
  tabButton.dataset.type = type; // pty | chat: estilo distinguible
  tabButton.title = session.title || 'terminal';
  const chip = document.createElement('button');
  chip.className = 'rail-chip';
  chip.textContent = chipLabel(session.title);
  const close = document.createElement('button');
  close.className = 'rail-close';
  close.textContent = '×';
  const flag = document.createElement('span');
  flag.className = 'rail-flag'; // banderín: modelo de Claude en uso
  tabButton.append(chip, close, flag);
  tabsEl.appendChild(tabButton);

  const entry = { tab: null, tabButton, pane, flag, session, type };
  tabs.set(session.id, entry);

  if (type === 'chat') {
    // Una CONVERSACIÓN: la pestaña es estable (keyed por chat.id) y su panel
    // alterna entre vista Chat (SDK) y Terminal (TUI) sobre la misma sesión.
    entry.viewMode = session.viewMode === 'tui' ? 'tui' : 'chat';
    buildConversationInner(entry, session);
  } else {
    entry.tab = new TerminalTab({ id: session.id, title: session.title, container: pane });
    entry.tab.connect();
  }

  chip.addEventListener('click', () => setActive(session.id));
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(session.id); });

  setActive(session.id);
  updateModelFlag(session.id);
}

// ===== Conversación: vista Chat <-> TUI (nunca ambas a la vez) =====
// Construye (o reconstruye) el CONTENIDO del panel de una conversación según
// su viewMode. La pestaña del rail no se toca: solo cambia el inner view.
function buildConversationInner(entry, info) {
  entry.pane.innerHTML = '';
  entry.pane.className = 'terminal-pane';
  if (entry.viewMode === 'tui' && info.terminalId) {
    entry.pane.classList.add('conv-tui-host');
    const bar = document.createElement('div');
    bar.className = 'conv-tui-bar';
    const ttl = document.createElement('span');
    ttl.className = 'conv-tui-title';
    ttl.textContent = `${info.title || 'claude'} · TUI`;
    const back = document.createElement('button');
    back.className = 'btn-ghost btn--sm conv-toback';
    back.title = 'Volver a Chat';
    back.innerHTML = `${icon('sparkle', { size: 14 })}<span>Chat</span>`;
    back.addEventListener('click', () => toggleConversation(entry.session.id));
    bar.append(ttl, back);
    const host = document.createElement('div');
    host.className = 'conv-tui-term';
    entry.pane.append(bar, host);
    entry.tab = new TerminalTab({ id: info.terminalId, title: info.title, container: host });
  } else {
    entry.viewMode = 'chat';
    entry.tab = new ChatTab({
      id: entry.session.id,
      title: info.title,
      container: entry.pane,
      onToggleMode: () => toggleConversation(entry.session.id),
      onViewMode: (m) => onServerViewMode(entry, m),
    });
  }
  entry.tab.connect();
  updateConvChipMode(entry);
}

function updateConvChipMode(entry) {
  entry.tabButton.dataset.view = entry.viewMode; // chat | tui (estilo del chip)
  const base = entry.session.title || 'chat';
  entry.tabButton.title = entry.viewMode === 'tui' ? `${base} · TUI` : base;
}

// El usuario pidió alternar Chat<->TUI. Secuencial y verificado en el server:
// respondemos según el estado REAL que devuelve /api/chat/mode.
async function toggleConversation(convId) {
  const entry = tabs.get(convId);
  if (!entry || entry.type !== 'chat' || entry.switching) return;
  const target = entry.viewMode === 'tui' ? 'chat' : 'tui';
  entry.switching = true;
  try {
    const res = await fetch('/api/chat/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: convId, mode: target }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo cambiar de modo.');
    entry.switching = false;
    applyConversationMode(entry, data.chat);
    bus.dispatchEvent(new Event('sessions-changed'));
  } catch (err) {
    entry.switching = false;
    if (entry.tab?.toggleBtn) entry.tab.toggleBtn.disabled = false;
    alertDialog({ title: 'Cambio de modo', message: err.message });
  }
}

// Aplica el modo efectivo (idempotente): si ya coincide, no hace nada.
function applyConversationMode(entry, info) {
  if (!info) return;
  const target = info.viewMode === 'tui' ? 'tui' : 'chat';
  entry.session = { ...entry.session, ...info };
  if (entry.viewMode === target) { updateConvChipMode(entry); return; }
  entry.viewMode = target;
  const wasActive = activeId === entry.session.id;
  try { entry.tab?.dispose(); } catch { /* noop */ }
  buildConversationInner(entry, entry.session);
  if (wasActive) entry.tab.focus();
}

// El server anunció (por WS) un cambio de modo (p.ej. desde otro dispositivo).
function onServerViewMode(entry, m) {
  if (m.viewMode !== 'tui' && m.viewMode !== 'chat') return; // ignoramos 'switching'
  applyConversationMode(entry, {
    viewMode: m.viewMode,
    terminalId: m.terminalId ?? entry.session.terminalId,
    title: entry.session.title,
  });
}

function closeTab(id) {
  const entry = tabs.get(id);
  if (!entry) return;
  // Cerrar la pestaña NO mata la sesión (persiste en el server); solo la vista.
  entry.tab.dispose();
  entry.pane.remove();
  entry.tabButton.remove();
  tabs.delete(id);
  if (activeId === id) {
    const next = tabs.keys().next().value || null;
    if (next) setActive(next);
    else activeId = null;
  }
}

// Banderín de color con el modelo de Claude en uso (leído del transcript).
// Solo aplica a pestañas PTY: el chat muestra su modelo en la cabecera.
async function updateModelFlag(id) {
  const entry = tabs.get(id);
  if (!entry || entry.tabButton.dataset.type === 'chat') return;
  try {
    const { model } = await (await fetch(`/api/terminal/model?id=${encodeURIComponent(id)}`)).json();
    if (model) {
      entry.flag.style.background = modelColor(model.key);
      entry.flag.style.display = 'block';
      entry.tabButton.title = `${entry.session.title || 'terminal'} · ${model.name}`;
    } else {
      entry.flag.style.display = 'none';
      entry.tabButton.title = entry.session.title || 'terminal';
    }
  } catch { /* noop */ }
}
function pollModels() {
  if (document.hidden) return;
  for (const id of tabs.keys()) updateModelFlag(id);
}
setInterval(pollModels, 8000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollModels(); });

// ===== API de sesiones =====
async function apiCreateSession(body) {
  const res = await fetch('/api/terminal/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('No se pudo crear la sesión');
  const { session } = await res.json();
  return session;
}
async function apiListSessions() {
  try {
    const { sessions: list } = await (await fetch('/api/terminal/sessions')).json();
    return list || [];
  } catch { return []; }
}

// ===== ctx: servicios que reciben los módulos =====
const bus = new EventTarget();
const whoami = (async () => {
  try { return await (await fetch('/api/whoami')).json(); } catch { return null; }
})();

async function openSession({ cwd, runClaude, model, title, attach } = {}) {
  if (cwd != null && !title) {
    const base = String(cwd).split('/').filter(Boolean).pop();
    title = runClaude ? `claude:${base || '~'}` : base || 'terminal';
  }
  try {
    const session = await apiCreateSession({ cwd, runClaude, model, title, attach });
    addTab(session);
    hideSidebarOnMobile();
    bus.dispatchEvent(new Event('sessions-changed'));
    return session;
  } catch (err) {
    alertDialog({ title: 'No se pudo crear la sesión', message: err.message });
    return null;
  }
}

function focusSession(id) {
  if (!tabs.has(id)) return false;
  setActive(id);
  hideSidebarOnMobile();
  return true;
}

// ===== Chat (Agent SDK) =====
async function openChat({ cwd, model, mode, resume } = {}) {
  try {
    const res = await fetch('/api/chat/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, model, permissionMode: mode, resume }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo crear el chat');
    const { chat } = await res.json();
    addTab(chat, { type: 'chat' });
    hideSidebarOnMobile();
    bus.dispatchEvent(new Event('sessions-changed'));
    return chat;
  } catch (err) {
    alertDialog({ title: 'Chat', message: err.message });
    return null;
  }
}

// Reabre la vista de una conversación viva del servidor (replay por history).
function openChatView(chatInfo) {
  if (focusSession(chatInfo.id)) return;
  addTab(chatInfo, { type: 'chat' });
  hideSidebarOnMobile();
}

// Busca una pestaña abierta cuyo cwd termine en la ruta relativa dada.
function findSessionByCwd(rel) {
  const suffix = '/' + String(rel).replace(/^\/+|\/+$/g, '');
  for (const [id, entry] of tabs) {
    const cwd = entry.session.cwd || '';
    if (cwd.endsWith(suffix) || (rel === '' && cwd.split('/').filter(Boolean).length <= 2)) return id;
  }
  return null;
}

const ctx = {
  icon,
  dialog: { openModal, confirmDialog, promptDialog, alertDialog },
  bus,
  whoami,
  openSession,
  openChat,
  openChatView,
  focusSession,
  findSessionByCwd,
  isMobile,
  hideSidebarOnMobile,
};

// ===== Montaje de módulos (espejo del registry backend) =====
for (const mod of MODULES) {
  const el = document.querySelector(`[data-module="${mod.name}"]`);
  if (el) {
    try { mod.mount(el, ctx); }
    catch (err) { console.error(`[modules] Falló el montaje de "${mod.name}":`, err); }
  }
}

// ===== Shell: rail, sidebar, auxbar, viewport =====
document.getElementById('toggle-sidebar').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('hidden');
});
// El ＋ del rail abre el mismo lanzador (una sola puerta de entrada).
document.getElementById('rail-new').addEventListener('click', () => bus.dispatchEvent(new Event('open-launcher')));

initAuxBar({ getActiveTab });
hydrateIcons();

// Identidad en el pie.
whoami.then((me) => {
  const acct = document.getElementById('acct-user');
  if (me?.type === 'user') acct.textContent = me.username;
  else if (me?.type === 'token') acct.textContent = '(token)';
});

// Mantiene el layout sobre el teclado virtual (móvil).
if (window.visualViewport) {
  const fitViewport = () => {
    document.getElementById('app').style.height = `${window.visualViewport.height}px`;
  };
  window.visualViewport.addEventListener('resize', fitViewport);
  fitViewport();
}
if (isMobile()) document.getElementById('sidebar').classList.add('hidden');

// ===== Arranque: re-adjunta sesiones PTY y conversaciones vivas; /?focus=<id> =====
(async () => {
  const [existing, chats] = await Promise.all([
    apiListSessions(),
    fetch('/api/chat/list').then((r) => r.json()).then((d) => d.chats || []).catch(() => []),
  ]);
  const live = existing.filter((s) => s.alive);
  live.forEach((s) => addTab(s));
  chats.forEach((c) => addTab(c, { type: 'chat' }));
  const focus = new URLSearchParams(location.search).get('focus');
  if (focus && tabs.has(focus)) setActive(focus);
  if (focus) history.replaceState(null, '', '/');
  if (!live.length && !chats.length) bus.dispatchEvent(new Event('open-launcher'));
})();
