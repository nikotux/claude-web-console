// main.js — orquesta la UI: pestañas de terminal, sidebar (acordeón + pie fijo),
// nueva terminal, árbol de archivos, visor, stats, tokens y tmux.
import { TerminalTab } from './modules/terminal/terminal.js';
import { hydrateIcons } from './ui/icons.js';
import { initStats } from './modules/stats/stats.js';
import { initTokens } from './modules/tokens/tokens.js';
import { initTmux, refreshTmux } from './modules/tmux/tmux.js';
import { initTolkien, refreshTolkien } from './modules/tolkien/tolkien.js';
import { initBackup } from './modules/backup/backup.js';
import { initAuxBar } from './modules/mobile/auxbar.js';

const tabsEl = document.getElementById('rail-tabs');
const terminalsEl = document.getElementById('terminals');
const newBtn = document.getElementById('new-terminal');
const toggleBtn = document.getElementById('toggle-sidebar');

// Iniciales para el icono de la pestaña (1-2 letras del título).
function iconFor(title) {
  const s = (title || '').replace(/[^a-z0-9]/gi, '');
  return s ? s.slice(0, 2).toUpperCase() : '•';
}

const tabs = new Map(); // id -> { tab, tabButton, pane }
let activeId = null;

const getActiveTab = () => tabs.get(activeId)?.tab || null;

async function apiCreateSession({ cwd, runClaude, title, attach } = {}) {
  const res = await fetch('/api/terminal/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, runClaude, title, attach }),
  });
  if (!res.ok) throw new Error('No se pudo crear la sesión');
  const { session } = await res.json();
  return session;
}

async function apiListSessions() {
  const res = await fetch('/api/terminal/sessions');
  if (!res.ok) return [];
  const { sessions } = await res.json();
  return sessions;
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

function addTab(session) {
  // Pane de la terminal.
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  terminalsEl.appendChild(pane);

  // Icono de pestaña en el rail derecho.
  const tabButton = document.createElement('div');
  tabButton.className = 'rail-tab';
  tabButton.title = session.title || 'terminal';
  const chip = document.createElement('button');
  chip.className = 'rail-chip';
  chip.textContent = iconFor(session.title);
  const close = document.createElement('button');
  close.className = 'rail-close';
  close.textContent = '×';
  const flag = document.createElement('span');
  flag.className = 'rail-flag'; // banderín de color: modelo en uso
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

// Banderín de color con el modelo de Claude en uso (leído del transcript).
async function updateModelFlag(id) {
  const entry = tabs.get(id);
  if (!entry) return;
  try {
    const { model } = await (await fetch(`/api/terminal/model?id=${encodeURIComponent(id)}`)).json();
    if (model) {
      entry.flag.style.background = model.color;
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

function closeTab(id) {
  const entry = tabs.get(id);
  if (!entry) return;
  // Nota: cerrar la pestaña NO mata el PTY (persiste en el server).
  // Solo se descarta la vista local. (Matar la sesión será una acción explícita.)
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

const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

async function newTerminal(opts = {}) {
  // Título amistoso derivado del cwd (basename) cuando viene del árbol.
  if (opts.cwd && !opts.title) {
    const base = opts.cwd.split('/').filter(Boolean).pop();
    opts.title = opts.runClaude ? `claude:${base || '~'}` : base || 'terminal';
  }
  try {
    const session = await apiCreateSession(opts);
    addTab(session);
    // En móvil, tras abrir una terminal desde el árbol/tmux, ocultamos el sidebar.
    if (isMobile()) document.getElementById('sidebar').classList.add('hidden');
  } catch (err) {
    alert(err.message);
  }
}

newBtn.addEventListener('click', () => newTerminal());
toggleBtn.addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('hidden');
});

// Acordeón del sidebar: cada .side-head alterna su sección. Al expandir por
// primera vez, dispara el refresco perezoso de esa sección (onExpand).
const onExpand = {
  tmux: () => refreshTmux(),
  tolkien: () => refreshTolkien(),
};
function initAccordion() {
  for (const sec of document.querySelectorAll('.side-sec')) {
    const head = sec.querySelector('.side-head');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.side-tools')) return; // botones no togglean
      const nowOpen = !sec.classList.contains('expanded');
      sec.classList.toggle('expanded', nowOpen);
      sec.querySelector('.side-caret').textContent = nowOpen ? '▾' : '▸';
      if (nowOpen && !sec.dataset.loaded) {
        sec.dataset.loaded = '1';
        onExpand[sec.dataset.sec]?.();
      }
    });
  }
}

// Sección Archivos: acciones rápidas (navegar = Gestor de Archivos, /archivos).
document.getElementById('files-term').addEventListener('click', () => newTerminal({ cwd: '' }));
document.getElementById('files-claude').addEventListener('click', () => newTerminal({ cwd: '', runClaude: true }));

// tmux: adjuntar abre una terminal envolviendo la sesión elegida.
initTmux({
  list: document.getElementById('tmux-list'),
  count: document.getElementById('tmux-count'),
  refreshBtn: document.getElementById('tmux-refresh'),
  openAttach: (spec) => newTerminal({ attach: spec }),
});

// Tolkien: panel del proyecto principal (acciones rápidas + estado/actualización git).
initTolkien({
  openTerminal: (opts) => newTerminal(opts),
});

// Pie fijo: sistema (siempre poll) y totales de tokens; detalle por proyecto.
initStats(document.getElementById('stats-mini'));
initTokens({
  footer: document.getElementById('tokens-mini'),
  list: document.getElementById('tokens-list'),
  refreshBtn: document.getElementById('tokens-refresh'),
});

initAccordion();
hydrateIcons(); // rellena todos los [data-icon] con su SVG

// Identidad: mostramos el usuario, el enlace de administración y backups si es admin.
(async () => {
  let me = null;
  try {
    me = await (await fetch('/api/whoami')).json();
    const acct = document.getElementById('acct-user');
    if (me?.type === 'user') acct.textContent = me.username;
    else if (me?.type === 'token') acct.textContent = '(token maestro)';
    if (me?.admin) document.getElementById('admin-link').hidden = false;
  } catch { /* noop */ }
  initBackup({ isAdmin: !!me?.admin });
  hydrateIcons(); // por si initBackup destapó botones con data-icon nuevos
})();

document.getElementById('logout-btn').addEventListener('click', async () => {
  try { await fetch('/logout', { method: 'POST' }); } catch { /* noop */ }
  window.location.href = '/login';
});

// Barra de teclas auxiliares + dictado (opera sobre la terminal activa).
initAuxBar({ getActiveTab });

// Mantiene el layout (y la barra auxiliar) sobre el teclado virtual en móvil:
// seguimos la altura del visualViewport, que sí encoge al abrirse el teclado.
if (window.visualViewport) {
  const fitViewport = () => {
    document.getElementById('app').style.height = `${window.visualViewport.height}px`;
  };
  window.visualViewport.addEventListener('resize', fitViewport);
  fitViewport();
}

// En móvil arrancamos con el sidebar oculto (la terminal ocupa todo el ancho).
if (isMobile()) document.getElementById('sidebar').classList.add('hidden');

// Al abrir la app: re-adjuntamos las sesiones vivas; si no hay, creamos una.
(async () => {
  const existing = await apiListSessions();
  const live = existing.filter((s) => s.alive);
  if (live.length) {
    live.forEach(addTab);
  } else {
    newTerminal();
  }
})();
