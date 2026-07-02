// main.js — SHELL de la app: gestiona pestañas de terminal, el rail derecho y
// el sidebar; monta los módulos frontend en sus slots [data-module] y les
// inyecta servicios vía `ctx` (patrón espejo del registry backend — ver
// docs/frontend-modules.md).
import { TerminalTab } from './modules/terminal/terminal.js';
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
  tabButton.dataset.type = type; // pty | chat (futuro): estilo distinguible
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

  const tab = new TerminalTab({ id: session.id, title: session.title, container: pane });
  tab.connect();

  chip.addEventListener('click', () => setActive(session.id));
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(session.id); });

  tabs.set(session.id, { tab, tabButton, pane, flag, session });
  setActive(session.id);
  updateModelFlag(session.id);
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
async function updateModelFlag(id) {
  const entry = tabs.get(id);
  if (!entry) return;
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

// ===== Arranque: re-adjunta las sesiones vivas; soporta /?focus=<id> =====
(async () => {
  const existing = await apiListSessions();
  const live = existing.filter((s) => s.alive);
  live.forEach((s) => addTab(s));
  const focus = new URLSearchParams(location.search).get('focus');
  if (focus && tabs.has(focus)) setActive(focus);
  if (focus) history.replaceState(null, '', '/');
  if (!live.length) bus.dispatchEvent(new Event('open-launcher'));
})();
