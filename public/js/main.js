// main.js — SHELL de la app: gestiona pestañas de terminal, el rail derecho y
// el sidebar; monta los módulos frontend en sus slots [data-module] y les
// inyecta servicios vía `ctx` (patrón espejo del registry backend — ver
// docs/frontend-modules.md).
import { TerminalTab } from './modules/terminal/terminal.js';
import { ChatTab } from './modules/chat/chat-tab.js';
import { icon, hydrateIcons } from './ui/icons.js';
import { modelColor } from './ui/models.js';
import { openModal, confirmDialog, promptDialog, alertDialog, textEditorDialog } from './ui/dialog.js';
import { initPermCenter } from './ui/perm-center.js';
import { initAuxBar } from './modules/mobile/auxbar.js';

import launcher from './modules/launcher/launcher.js';
import sessions from './modules/sessions/sessions.js';
import tolkien from './modules/tolkien/tolkien.js';
import bugs from './modules/bugs/bugs.js';
import stats from './modules/stats/stats.js';
import usage from './modules/usage/usage.js';
import system from './modules/system/system.js';

const MODULES = [launcher, sessions, tolkien, bugs, stats, usage, system];

// ===== Shell: pestañas de terminal + rail =====
const tabsEl = document.getElementById('rail-tabs');
const terminalsEl = document.getElementById('terminals');

const tabs = new Map(); // id -> { tab, tabButton, pane, flag, session }
let activeId = null;
let permCenter = null; // centro global de permisos (se inicializa más abajo)

const getActiveTab = () => tabs.get(activeId)?.tab || null;
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
const hideSidebarOnMobile = () => { if (isMobile()) document.getElementById('sidebar').classList.add('hidden'); };

// Key semántica de modelo a partir de un nombre tipo 'opusplan'/'fable'.
function modelKeyOf(m) {
  const low = (m || '').toLowerCase();
  for (const k of ['fable', 'opus', 'sonnet', 'haiku']) if (low.includes(k)) return k;
  return null;
}

// Pinta el chip de una pestaña: ícono por TIPO (terminal / chat ✦ / TUI) y
// color por MODELO en uso; terminal sin Claude = fantasma apagado.
function paintChip(entry, modelKey) {
  const { chip } = entry;
  if (entry.type === 'chat') {
    chip.innerHTML = icon(entry.viewMode === 'tui' ? 'terminal' : 'sparkle', { size: 17 });
    chip.style.color = modelKey ? modelColor(modelKey) : 'var(--cwc-accent)';
  } else if (modelKey) {
    chip.innerHTML = icon('terminal', { size: 17 });
    chip.style.color = modelColor(modelKey);
  } else {
    chip.innerHTML = icon('ghost', { size: 17 });
    chip.style.color = 'var(--cwc-text-dim)';
  }
}

function setActive(id) {
  activeId = id;
  for (const [tid, entry] of tabs) {
    const on = tid === id;
    entry.pane.classList.toggle('active', on);
    entry.tabButton.classList.toggle('active', on);
    if (on) entry.tab.focus();
  }
  // El popup del chat que quedó activo se suprime (su tarjeta inline ya está a
  // la vista); el del que dejó de estarlo reaparece.
  permCenter?.refresh();
}

function addTab(session, { type = 'pty', initialPrompt = null } = {}) {
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  terminalsEl.appendChild(pane);

  const tabButton = document.createElement('div');
  tabButton.className = 'rail-tab';
  tabButton.dataset.type = type; // pty | chat: estilo distinguible
  tabButton.title = session.title || 'terminal';
  const chip = document.createElement('button');
  chip.className = 'rail-chip';
  const close = document.createElement('button');
  close.className = 'rail-close';
  close.textContent = '×';
  const flag = document.createElement('span');
  flag.className = 'rail-flag'; // banderín: modelo de Claude en uso
  const statusDot = document.createElement('span');
  statusDot.className = 'rail-status'; // punto de estado (trabajando/esperando)
  tabButton.append(chip, close, statusDot, flag);
  tabsEl.appendChild(tabButton);

  const entry = { tab: null, tabButton, chip, pane, flag, statusDot, session, type };
  tabs.set(session.id, entry);

  if (type === 'chat') {
    // Una CONVERSACIÓN: la pestaña es estable (keyed por chat.id) y su panel
    // alterna entre vista Chat (SDK) y Terminal (TUI) sobre la misma sesión.
    entry.viewMode = session.viewMode === 'tui' ? 'tui' : 'chat';
    buildConversationInner(entry, session, initialPrompt);
  } else {
    paintChip(entry, null); // fantasma hasta detectar Claude (pollModels)
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
function buildConversationInner(entry, info, initialPrompt = null) {
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
    // ☰ móvil: mismo acceso al panel lateral que el header del chat.
    const menuBtn = document.createElement('button');
    menuBtn.className = 'btn-ghost btn--icon mobile-menu-btn';
    menuBtn.title = 'Abrir panel lateral';
    menuBtn.innerHTML = icon('menu', { size: 16 });
    menuBtn.addEventListener('click', () => window.dispatchEvent(new Event('cwc:open-sidebar')));
    bar.append(menuBtn, ttl, back);
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
      initialPrompt, // solo en la primera construcción (no en toggles/recarga)
    });
  }
  entry.tab.connect();
  updateConvChipMode(entry);
}

function updateConvChipMode(entry) {
  entry.tabButton.dataset.view = entry.viewMode; // chat | tui (estilo del chip)
  const base = entry.session.title || 'chat';
  const model = entry.session.model ? ` · ${entry.session.model}` : '';
  entry.tabButton.title = (entry.viewMode === 'tui' ? `${base} · TUI` : base) + model;
  paintChip(entry, modelKeyOf(entry.session.model));
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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const { model } = await (await fetch(`/api/terminal/model?id=${encodeURIComponent(id)}`, { signal: ac.signal })).json();
    if (model) {
      entry.flag.style.background = modelColor(model.key);
      entry.flag.style.display = 'block';
      entry.tabButton.title = `${entry.session.title || 'terminal'} · ${model.name}`;
      paintChip(entry, model.key);
    } else {
      entry.flag.style.display = 'none';
      entry.tabButton.title = entry.session.title || 'terminal';
      paintChip(entry, null); // fantasma: terminal sin Claude
    }
  } catch { /* noop */ } finally { clearTimeout(timer); }
}
function pollModels() {
  if (document.hidden) return;
  for (const id of tabs.keys()) updateModelFlag(id);
}

// Punto de estado por pestaña (trabajando/esperando), leído de las mismas
// fuentes que las tarjetas de Sesiones. Una sola pasada para todas las tabs.
async function pollTabStatus() {
  // OJO: sin pestañas abiertas IGUAL se consulta /api/chat/list — el centro
  // global de permisos debe avisar de chats vivos en el server aunque este
  // navegador no los tenga abiertos (p.ej. lanzados desde el teléfono).
  if (document.hidden) return;
  try {
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), 5000);
    const [tmux, chats] = await Promise.all([
      tabs.size
        ? fetch('/api/tmux/sessions', { signal: ac.signal }).then((r) => r.json()).then((d) => d.sessions || []).catch(() => [])
        : Promise.resolve([]),
      fetch('/api/chat/list', { signal: ac.signal }).then((r) => r.json()).then((d) => d.chats || []).catch(() => []),
    ]).finally(() => clearTimeout(killer));
    permCenter?.syncFromList(chats);
    const byName = new Map(tmux.map((s) => [s.name, s]));
    const byChat = new Map(chats.map((c) => [c.id, c]));
    let titleChanged = false;
    for (const [id, entry] of tabs) {
      if (!entry.statusDot) continue;
      let cls = 'st-idle';
      if (entry.type === 'chat') {
        const c = byChat.get(id);
        cls = c ? (c.status === 'working' ? 'st-working' : 'st-waiting') : 'st-idle';
        // Auto-título (IA) o renombre desde otro dispositivo: reflejarlo en
        // header + chip; las tarjetas de Sesiones se refrescan al final.
        if (c && c.title && c.title !== entry.session.title) {
          entry.session.title = c.title;
          syncConversation(c);
          updateConvChipMode(entry);
          titleChanged = true;
        }
      } else {
        const s = byName.get(`cwc-${id}`);
        const st = s?.state?.status;
        cls = st === 'working' ? 'st-working' : st === 'waiting' ? 'st-waiting' : s?.model ? 'st-idle' : 'st-shell';
      }
      entry.statusDot.className = `rail-status ${cls}`;
    }
    if (titleChanged) bus.dispatchEvent(new Event('sessions-changed'));
  } catch { /* noop */ }
}

function pollAll() { pollModels(); pollTabStatus(); }
setInterval(pollAll, 8000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAll(); });

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
async function openChat({ cwd, model, mode, resume, prompt, title, ticket } = {}) {
  try {
    const res = await fetch('/api/chat/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, model, permissionMode: mode, resume, title, ticket }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo crear el chat');
    const { chat } = await res.json();
    addTab(chat, { type: 'chat', initialPrompt: prompt || null });
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
  if (tabs.has(chatInfo.id)) { syncConversation(chatInfo); focusSession(chatInfo.id); return; }
  addTab(chatInfo, { type: 'chat' });
  hideSidebarOnMobile();
}

// Sincroniza una pestaña de conversación abierta con el estado del server
// (título renombrado, viewMode cambiado desde la tarjeta, etc.).
function syncConversation(chatInfo) {
  const entry = tabs.get(chatInfo.id);
  if (!entry || entry.type !== 'chat') return;
  applyConversationMode(entry, chatInfo); // idempotente; rebuilds si cambió el modo
  const ttl = entry.pane.querySelector('.chat-title');
  if (ttl && chatInfo.title) ttl.textContent = chatInfo.title;
}

// Enfoca la pestaña de una sesión ya existente; si no está abierta, la adjunta.
// (La usa el Explorador flotante tras crear una sesión "aquí".)
async function focusOrOpenSession(id) {
  if (focusSession(id)) return;
  const s = (await apiListSessions()).find((x) => x.id === id);
  if (s) { addTab(s); hideSidebarOnMobile(); bus.dispatchEvent(new Event('sessions-changed')); }
}

// ===== Explorador como ventana flotante =====
// Reutilizamos /archivos VERBATIM dentro de un <iframe>: fm.js es una app de
// página completa (posee document, listeners globales, drag&drop, su propio
// fm.css). Montarla como módulo exigiría refactor y arriesgaría colisiones de
// CSS con la consola; el iframe la aísla por completo y ya la servimos. El
// único puente es postMessage: al "abrir terminal/Claude aquí", el iframe avisa
// y el shell cierra la ventana y enfoca la sesión nueva.
let explorerModal = null;
function openExplorer(path = '') {
  if (explorerModal) explorerModal.close();
  const src = path ? `/archivos?path=${encodeURIComponent(path)}` : '/archivos';
  const m = openModal({ title: 'Explorador', width: '92vw', onClose: () => { explorerModal = null; } });
  m.card.classList.add('dlg-card--explorer');
  const frame = document.createElement('iframe');
  frame.className = 'explorer-frame';
  frame.src = src;
  frame.title = 'Explorador';
  m.body.appendChild(frame);
  explorerModal = m;
}

// El iframe del Explorador pide enfocar una sesión recién creada "aquí".
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const d = e.data;
  if (!d) return;
  if (d.type === 'cwc-session' && d.id) {
    if (explorerModal) explorerModal.close();
    focusOrOpenSession(d.id);
  } else if (d.type === 'cwc-explorer-close') {
    if (explorerModal) explorerModal.close();
  }
});

// Cualquier enlace a /archivos abre la ventana flotante (salvo click con
// modificador o botón central: eso abre la página directa, útil para deep-links).
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="/archivos"]');
  if (!a) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  const path = new URL(a.href, location.origin).searchParams.get('path') || '';
  openExplorer(path);
});

// Busca una pestaña abierta cuyo cwd termine en la ruta relativa dada.
function findSessionByCwd(rel) {
  const suffix = '/' + String(rel).replace(/^\/+|\/+$/g, '');
  for (const [id, entry] of tabs) {
    const cwd = entry.session.cwd || '';
    if (cwd.endsWith(suffix) || (rel === '' && cwd.split('/').filter(Boolean).length <= 2)) return id;
  }
  return null;
}

// ===== Centro global de permisos: popups de aprobación desde cualquier
// pantalla (ui/perm-center.js). Alimentado por los eventos window de las
// ChatTab abiertas (instantáneo) + el poll de 8 s (catch-up y limpieza).
permCenter = initPermCenter({
  isChatActive: (chatId) => activeId === chatId && tabs.has(chatId),
  chatTitle: (chatId) => tabs.get(chatId)?.session?.title || null,
  openChat: async (chatId) => {
    if (focusSession(chatId)) return;
    // Chat sin pestaña en este navegador: traer su info y abrir la vista.
    const chats = await fetch('/api/chat/list').then((r) => r.json()).then((d) => d.chats || []).catch(() => []);
    const info = chats.find((c) => c.id === chatId);
    if (info) openChatView(info);
  },
});

const ctx = {
  icon,
  dialog: { openModal, confirmDialog, promptDialog, alertDialog, textEditorDialog },
  bus,
  whoami,
  openSession,
  openChat,
  openChatView,
  syncConversation,
  openExplorer,
  focusSession,
  findSessionByCwd,
  isMobile,
  hideSidebarOnMobile,
};

// ===== Splash de arranque (#boot-splash en index.html) =====
// Textos de progreso REALES del boot. El desmontaje (window.__bootHide) lo
// define un script inline del HTML: funciona aunque este módulo no cargue.
const bootMsg = (t, pct) => {
  const m = document.getElementById('boot-msg');
  if (m) m.textContent = t;
  if (pct != null) window.__bootPct?.(pct);
};

// ===== Montaje de módulos (espejo del registry backend) =====
bootMsg('montando módulos…', 35);
for (const mod of MODULES) {
  const el = document.querySelector(`[data-module="${mod.name}"]`);
  if (el) {
    try { mod.mount(el, ctx); }
    catch (err) { console.error(`[modules] Falló el montaje de "${mod.name}":`, err); }
  }
}

// ===== Shell: sidebar (colapsable a rail), auxbar, viewport =====
const sidebarEl = document.getElementById('sidebar');
const COLLAPSE_KEY = 'cwc.sidebar.collapsed';

// El botón ☰: en desktop contrae/expande el panel a un rail (persistido); en
// móvil actúa como el overlay de siempre (mostrar/ocultar).
document.getElementById('toggle-sidebar').addEventListener('click', () => {
  if (isMobile()) { sidebarEl.classList.toggle('hidden'); return; }
  const collapsed = !sidebarEl.classList.contains('collapsed');
  sidebarEl.classList.toggle('collapsed', collapsed);
  localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
});

// Cualquier vista puede pedir el panel lateral (☰ móvil de los headers de
// chat/TUI y tecla ☰ de la auxbar): en móvil el panel es overlay y su propio
// ☰ queda fuera de pantalla al ocultarse.
window.addEventListener('cwc:open-sidebar', () => {
  sidebarEl.classList.remove('hidden');
  if (isMobile()) sidebarEl.classList.remove('collapsed');
});

// Velo de fondo (solo visible/clickeable en móvil, vía CSS): tocar afuera
// del panel lo cierra, como cualquier drawer/overlay estándar.
document.getElementById('sidebar-scrim').addEventListener('click', () => {
  if (isMobile()) sidebarEl.classList.add('hidden');
});

// Aplica el estado colapsado guardado (solo desktop; en móvil nunca colapsa).
function applySidebarState() {
  if (isMobile()) { sidebarEl.classList.remove('collapsed'); return; }
  sidebarEl.classList.toggle('collapsed', localStorage.getItem(COLLAPSE_KEY) === '1');
}
applySidebarState();
window.addEventListener('resize', applySidebarState);

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
  bootMsg('restaurando sesiones…', 60);
  try {
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
    // Si el tab ACTIVO es un chat, esperar a que su historial esté renderizado
    // DE VERDAD (promesa `ready` del ChatTab, resuelta al procesar el primer
    // `history` del attach — no un timer) antes de destapar: sin esto el
    // splash caía y el chat aparecía vacío unos segundos. Tope de 8 s por si
    // el WS no conecta (la red inline del HTML fuerza a los 12 s igual).
    const act = tabs.get(activeId);
    if (act?.type === 'chat' && act.tab?.ready) {
      bootMsg('cargando la conversación…', 80);
      await Promise.race([act.tab.ready, new Promise((r) => setTimeout(r, 8000))]);
    }
  } finally {
    // App lista (o el boot falló y el error ya está a la vista): fuera splash.
    window.__bootHide?.();
  }
  pollTabStatus();
})();
