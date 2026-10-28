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
import { initInterfonoCenter } from './ui/interfono-center.js';
import { initI18n, applyI18n, t } from './ui/i18n.js';
import { bindHelp, helpBtn, openHelpIndex } from './ui/help.js';
import { allowModule } from './ui/profile.js';
import { initAuxBar } from './modules/mobile/auxbar.js';

import launcher from './modules/launcher/launcher.js';
import sessions from './modules/sessions/sessions.js';
import tolkien from './modules/tolkien/tolkien.js';
import stats from './modules/stats/stats.js';
import planLimits from './modules/stats/plan-limits.js';
import usage from './modules/usage/usage.js';
import system from './modules/system/system.js';
import retro from './modules/retro/retro.js';
import visado from './modules/visado/visado.js';
import forja from './modules/forja/forja.js';

const MODULES = [launcher, sessions, tolkien, forja, visado, retro, planLimits, stats, usage, system];

// ===== Shell: pestañas de terminal + rail =====
const tabsEl = document.getElementById('rail-tabs');
const terminalsEl = document.getElementById('terminals');

// ===== Modo SOLO: ventana desanclada de UNA conversación =====
// `/?solo=<chatId>` monta esa conversación SOLA, sin sidebars ni rail: la
// ventana existe para que el gestor de ventanas del SO la ponga en pantalla
// dividida. Reusa el shell entero (misma ChatTab, mismos permisos/interfono)
// en vez de una página aparte, para que no haya dos vistas que mantener.
const SOLO_ID = new URLSearchParams(location.search).get('solo') || null;
if (SOLO_ID) document.body.classList.add('cwc-solo');

const tabs = new Map(); // id -> { tab, tabButton, pane, flag, session }
let activeId = null;
let permCenter = null; // centro global de permisos (se inicializa más abajo)
let intercomCenter = null; // centro global de interfono (se inicializa más abajo)

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
    if (on) {
      // Lazy-connect: una conversación (vista Chat) abre su WebSocket —y recién
      // ahí el server le baja el historial— al MOSTRARSE por primera vez, no al
      // arranque. connect() es idempotente, así que reactivarla no reconecta.
      if (entry.type === 'chat' && entry.viewMode === 'chat') entry.tab?.connect?.();
      entry.tab.focus();
    }
  }
  // El popup del chat que quedó activo se suprime (su tarjeta inline ya está a
  // la vista); el del que dejó de estarlo reaparece.
  permCenter?.refresh();
  intercomCenter?.refresh();
}

function addTab(session, { type = 'pty', initialPrompt = null, activate = true } = {}) {
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

  // El arranque agrega TODAS las pestañas con activate:false y activa UNA sola
  // al final (lazy-connect): así solo esa conversación conecta su WS. Los demás
  // caminos (abrir/retomar a mano) activan enseguida como siempre.
  if (activate) setActive(session.id);
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
    // La barra se arma con createElement; helpBtn devuelve el HTML del botón estándar.
    bar.insertAdjacentHTML('beforeend', helpBtn('terminal'));
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
      onPopout: () => popoutChat(entry.session.id, entry.session.title),
      soloMode: !!SOLO_ID,
      initialPrompt, // solo en la primera construcción (no en toggles/recarga)
    });
  }
  // Las vistas TUI/PTY conectan al construirse; una vista Chat conecta de forma
  // DIFERIDA (lazy) al mostrarse — ver setActive. Así el arranque no abre N
  // WebSockets ni baja N historiales de conversaciones que no estás mirando.
  if (entry.viewMode !== 'chat') entry.tab.connect();
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
  if (wasActive) {
    // Reconstruida y visible: si es vista Chat, conectarla ahora (lazy).
    if (entry.viewMode === 'chat') entry.tab.connect();
    entry.tab.focus();
  }
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
    // En modo solo el WS ya pertenece únicamente al chat abierto; filtramos
    // también el catch-up del centro de permisos para evitar ruido ajeno.
    permCenter?.syncFromList(SOLO_ID ? chats.filter((c) => tabs.has(c.id)) : chats);
    intercomCenter?.syncFromList(chats);
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
          if (SOLO_ID === id) document.title = `${c.title} — Mi Consola`;
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
  if (!res.ok) {
    // El backend responde motivos accionables ("Destino de adjuntado
    // inválido.", "Modelo inválido."); sin esto el modal repetía un texto
    // genérico y no había forma de diagnosticar desde la UI.
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch { /* respuesta sin JSON */ }
    throw new Error(detail || `No se pudo crear la sesión (HTTP ${res.status})`);
  }
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
async function openChat({ cwd, model, mode, resume, prompt, title, ticket, learningId, sala } = {}) {
  try {
    const res = await fetch('/api/chat/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, model, permissionMode: mode, resume, title, ticket, learningId, sala }),
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

// Desancla una conversación en su propia ventana del navegador. El `name` de
// la ventana es determinístico por chat: si esa ventana ya existe, el navegador
// la REUSA y la enfoca en vez de abrir una segunda copia del mismo chat.
function popoutChat(chatId, title) {
  if (!chatId) return null;
  const w = window.open(
    `/?solo=${encodeURIComponent(chatId)}`,
    `cwc-solo-${chatId}`,
    'popup=yes,width=1100,height=920,menubar=no,toolbar=no,location=no,status=no',
  );
  if (!w) {
    alertDialog({
      title: t('chat.popout.blockedTitle', 'Ventana desanclada'),
      message: t('chat.popout.blocked', 'El navegador bloqueó la ventana emergente. Permití las ventanas emergentes para esta consola y volvé a intentar.'),
    });
    return null;
  }
  try { w.focus(); } catch { /* algunos navegadores lo niegan; la ventana ya está abierta */ }
  return w;
}

// Sincroniza una pestaña de conversación abierta con el estado del server
// (título renombrado, viewMode cambiado desde la tarjeta, etc.).
function syncConversation(chatInfo) {
  const entry = tabs.get(chatInfo.id);
  if (!entry || entry.type !== 'chat') return;
  applyConversationMode(entry, chatInfo); // idempotente; rebuilds si cambió el modo
  const ttl = entry.pane.querySelector('.chat-title');
  if (ttl && chatInfo.title) { ttl.textContent = chatInfo.title; ttl.title = chatInfo.title; }
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
const openChatById = async (chatId) => {
  if (focusSession(chatId)) return;
  // Chat sin pestaña en este navegador: traer su info y abrir la vista.
  const chats = await fetch('/api/chat/list').then((r) => r.json()).then((d) => d.chats || []).catch(() => []);
  const info = chats.find((c) => c.id === chatId);
  if (info) openChatView(info);
};
permCenter = initPermCenter({
  isChatActive: (chatId) => activeId === chatId && tabs.has(chatId),
  chatTitle: (chatId) => tabs.get(chatId)?.session?.title || null,
  openChat: openChatById,
});

// Centro global de interfono: popups con los mensajes de otras sesiones que un
// chat aún no tomó (ui/interfono-center.js). Mismo poll de 8 s + supresión del
// chat activo que el centro de permisos.
intercomCenter = initInterfonoCenter({
  isChatActive: (chatId) => activeId === chatId && tabs.has(chatId),
  // Rediseño 2026-07-10 (Fase 1): una ventana SOLO se entera de los mensajes de
  // los chats que ESTA ventana tiene abiertos (en cualquier pestaña). Mata el
  // ruido cross-ventana: un mensaje de un chat que esta ventana ni tiene abierto
  // ya no dispara nada acá. El hueco de "ningún ventana lo tiene abierto" lo
  // cubre la señal pasiva (badge en Sesiones) de la Fase 2.
  isChatRelevant: (chatId) => tabs.has(chatId),
  openChat: openChatById,
});

const ctx = {
  icon,
  dialog: { openModal, confirmDialog, promptDialog, alertDialog, textEditorDialog },
  bus,
  whoami,
  openSession,
  openChat,
  openChatView,
  popoutChat,
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

// ===== Idioma de interfaz (PLAN i18n, 2026-07-19) =====
// Se carga ANTES de montar módulos para que arranquen ya en el idioma
// correcto (sin parpadeo ES→EN). `whoami` se re-resuelve más abajo con
// `.then()` para el pie de página — awaitearla acá también es gratis (la
// promesa ya está en vuelo o resuelta; top-level await es válido en un
// <script type="module">).
bootMsg('cargando idioma…', 28);
const meForLang = await whoami;
await initI18n(meForLang?.lang || 'es');
applyI18n(document);
bindHelp(document);

// ===== Montaje de módulos (espejo del registry backend) =====
bootMsg('montando módulos…', 35);
if (!SOLO_ID) {
  // La ventana suelta no monta sidebars ni dispara sus fetches de módulos.
  for (const mod of MODULES) {
    const el = document.querySelector(`[data-module="${mod.name}"]`);
    if (!allowModule(meForLang, mod.name)) {
      if (el) el.hidden = true;
      continue;
    }
    if (el) {
      try { mod.mount(el, ctx); }
      catch (err) { console.error(`[modules] Falló el montaje de "${mod.name}":`, err); }
    }
  }
}

// ===== Shell: sidebar (colapsable a rail), auxbar, viewport =====
const sidebarEl = document.getElementById('sidebar');
const sidebarRightEl = document.getElementById('sidebar-right');
const COLLAPSE_KEY = 'cwc.sidebar.collapsed';
const COLLAPSE_KEY_R = 'cwc.sidebar-right.collapsed';

// El botón ☰ (izquierda): en desktop contrae/expande el panel a un rail
// (persistido); en móvil actúa como el overlay de siempre (mostrar/ocultar).
document.getElementById('toggle-sidebar').addEventListener('click', () => {
  if (isMobile()) { sidebarEl.classList.toggle('hidden'); return; }
  const collapsed = !sidebarEl.classList.contains('collapsed');
  sidebarEl.classList.toggle('collapsed', collapsed);
  localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
});

// El botón ☰ (derecha, barra de Sesiones): mismo comportamiento, key propia.
document.getElementById('toggle-sidebar-right').addEventListener('click', () => {
  if (isMobile()) { sidebarRightEl.classList.toggle('hidden'); return; }
  const collapsed = !sidebarRightEl.classList.contains('collapsed');
  sidebarRightEl.classList.toggle('collapsed', collapsed);
  localStorage.setItem(COLLAPSE_KEY_R, collapsed ? '1' : '0');
});

// Cualquier vista puede pedir el panel lateral IZQUIERDO (☰ móvil de los
// headers de chat/TUI y tecla ☰ de la auxbar): en móvil el panel es overlay y
// su propio ☰ queda fuera de pantalla al ocultarse.
window.addEventListener('cwc:open-sidebar', () => {
  sidebarEl.classList.remove('hidden');
  if (isMobile()) sidebarEl.classList.remove('collapsed');
});

// El drawer DERECHO (Sesiones) en móvil: lo abre el asa flotante y lo cierra
// su scrim. En desktop el asa/scrim no se ven (CSS).
const openRightDrawer = () => { sidebarRightEl.classList.remove('hidden'); if (isMobile()) sidebarRightEl.classList.remove('collapsed'); };
document.getElementById('sidebar-right-handle').addEventListener('click', openRightDrawer);

// Velos de fondo (solo visibles/clickeables en móvil, vía CSS): tocar afuera
// del panel lo cierra, como cualquier drawer/overlay estándar.
document.getElementById('sidebar-scrim').addEventListener('click', () => {
  if (isMobile()) sidebarEl.classList.add('hidden');
});
document.getElementById('sidebar-right-scrim').addEventListener('click', () => {
  if (isMobile()) sidebarRightEl.classList.add('hidden');
});

// Aplica el estado colapsado guardado de AMBAS barras (solo desktop; en móvil
// nunca colapsan — son drawers overlay).
function applySidebarState() {
  if (isMobile()) { sidebarEl.classList.remove('collapsed'); sidebarRightEl.classList.remove('collapsed'); return; }
  sidebarEl.classList.toggle('collapsed', localStorage.getItem(COLLAPSE_KEY) === '1');
  sidebarRightEl.classList.toggle('collapsed', localStorage.getItem(COLLAPSE_KEY_R) === '1');
}
applySidebarState();
window.addEventListener('resize', applySidebarState);

// El ＋ del rail abre el mismo lanzador (una sola puerta de entrada).
document.getElementById('rail-new').addEventListener('click', () => bus.dispatchEvent(new Event('open-launcher')));

// El ? del pie abre el índice unificado de ayudas de toda la consola.
document.getElementById('help-index-btn')?.addEventListener('click', openHelpIndex);

// El asa flotante IZQUIERDA (solo móvil) abre el drawer de módulos — gemela de
// la derecha, ubicada sobre el composer para estorbar menos (pedido del usuario
// 2026-07-07). Reusa el mismo evento que el ☰ del header.
document.getElementById('sidebar-handle').addEventListener('click', () => window.dispatchEvent(new Event('cwc:open-sidebar')));

// Las secciones del sidebar YA NO son colapsables (pedido del usuario
// 2026-07-07): la distribución en dos barras deja espacio de sobra, así que
// todo nace expandido y sin chevron. Se quitó el listener de toggle y el
// estado .sec-collapsed en localStorage (era `cwc.sec.<mod>.collapsed`).

initAuxBar({ getActiveTab });
hydrateIcons();

// Identidad en la CABECERA del panel izquierdo (se movió del pie el 2026-07-31).
// El avatar muestra la inicial: es lo único que sobrevive al rail colapsado,
// donde el nombre se oculta con .only-expanded.
whoami.then((me) => {
  const acct = document.getElementById('acct-user');
  const avatar = document.getElementById('acct-avatar');
  const chip = document.getElementById('acct-chip');
  let name = '';
  if (me?.type === 'user') name = me.username || '';
  else if (me?.type === 'token') name = '(token)';
  if (acct) acct.textContent = name;
  if (avatar) avatar.textContent = (name.replace(/[^A-Za-z0-9]/g, '')[0] || '?').toUpperCase();
  if (chip && name) chip.title = name;
  // Ni Uso ni Raw requieren gate: el backend aplica scope por usuario (BUG-1874).
});

// Mantiene el layout sobre el teclado virtual (móvil). Al enfocar el input del
// chat, el navegador (sobre todo iOS) DESPLAZA la página para "mostrar" el
// campo; como el body está bloqueado (position:fixed en móvil, ver style.css)
// no puede scrollear, pero el visualViewport SÍ se desplaza y quedaba un hueco
// negro entre el chat y el teclado (reportado 2026-07-07). Fix: además de
// ajustar la ALTURA de #app al viewport visible, lo REANCLAMOS con un
// translateY(offsetTop) para que su tope siga al del viewport visible.
// Fix 2026-10-26 (temblor tras el auto-zoom de iOS): con zoom (vv.scale > 1) no
// perseguimos el viewport; los eventos se agrupan en un solo rAF y solo se
// escribe si algo cambió; con el teclado cerrado se limpian los estilos inline
// para que #app vuelva a su 100dvh de CSS; y el scrollTo ya no corre en el evento
// scroll del viewport porque alimentaba el bucle.
if (window.visualViewport) {
  const app = document.getElementById('app');
  const vv = window.visualViewport;
  let raf = 0;
  let last = '';
  const clearFit = () => { app.style.height = ''; app.style.transform = ''; };
  const fitViewport = () => {
    raf = 0;
    // Con zoom (pinch del usuario o auto-zoom de iOS) NO perseguimos el
    // viewport: moverlo dispara otro scroll del viewport y entra en bucle.
    if (vv.scale > 1.01) {
      if (last !== 'zoom') { clearFit(); last = 'zoom'; }
      return;
    }
    const h = Math.round(vv.height);
    const top = Math.round(vv.offsetTop);
    // Alto del viewport de LAYOUT: iOS no lo achica con el teclado (window.innerHeight
    // sí, porque sigue al visual) — compararlo contra innerHeight daba "teclado
    // cerrado" con el teclado abierto y el composer quedaba tapado.
    const layoutH = document.documentElement.clientHeight;
    const keyboardClosed = top === 0 && Math.abs(layoutH - h) < 2;
    const key = keyboardClosed ? 'closed' : `${h}:${top}`;
    if (key === last) return;
    last = key;
    if (keyboardClosed) { clearFit(); return; }
    app.style.height = `${h}px`;
    app.style.transform = top ? `translateY(${top}px)` : '';
  };
  const scheduleFit = () => { if (!raf) raf = requestAnimationFrame(fitViewport); };
  vv.addEventListener('resize', () => {
    // Por las dudas, deshacer cualquier scroll que el navegador haya forzado
    // (solo en resize y sin zoom: en el evento scroll alimentaba el bucle).
    if (vv.scale <= 1.01 && (window.scrollY || window.scrollX)) window.scrollTo(0, 0);
    scheduleFit();
  });
  vv.addEventListener('scroll', scheduleFit);
  // Último ajuste tras cerrar el teclado, por si el navegador no emite el
  // resize final de su animación.
  document.addEventListener('focusout', () => setTimeout(scheduleFit, 300));
  fitViewport();
}
if (isMobile()) {
  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('sidebar-right').classList.add('hidden');
}

// ===== Arranque: re-adjunta sesiones PTY y conversaciones vivas; /?focus=<id> =====
(async () => {
  bootMsg('restaurando sesiones…', 60);
  try {
    if (SOLO_ID) {
      bootMsg('abriendo la conversación…', 70);
      const chats = await fetch('/api/chat/list').then((r) => r.json()).then((d) => d.chats || []).catch(() => []);
      const info = chats.find((c) => c.id === SOLO_ID);
      if (!info) {
        // conversación inexistente/ajena: aviso legible, no una pantalla en blanco
        terminalsEl.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'solo-missing';
        const msg = document.createElement('p');
        msg.textContent = 'Esta conversación ya no está disponible.';
        const back = document.createElement('button');
        back.className = 'btn';
        back.textContent = 'Abrir la consola';
        back.addEventListener('click', () => { location.href = '/'; });
        box.append(msg, back);
        terminalsEl.appendChild(box);
        return; // el finally del try/finally igual destapa el splash
      }
      document.title = `${info.title || 'Conversación'} — Mi Consola`;
      addTab(info, { type: 'chat' });
      const act = tabs.get(activeId);
      if (act?.tab?.ready) {
        bootMsg('cargando la conversación…', 85);
        await Promise.race([act.tab.ready, new Promise((r) => setTimeout(r, 8000))]);
      }
      return;
    }
    const [existing, chats] = await Promise.all([
      apiListSessions(),
      fetch('/api/chat/list').then((r) => r.json()).then((d) => d.chats || []).catch(() => []),
    ]);
    const live = existing.filter((s) => s.alive);
    // B — progreso honesto: mostrar cuánto se restaura DE VERDAD, no un salto seco.
    const total = live.length + chats.length;
    if (total) bootMsg(`restaurando ${total} ${total === 1 ? 'sesión' : 'sesiones'}…`, 72);
    // A — lazy-connect: agregamos TODAS las pestañas SIN activarlas (activate:false),
    // así ninguna conversación abre su WebSocket ni baja su historial todavía.
    // Recién activamos UNA (la del ?focus= o la última) → solo ESA conecta al
    // arranque: O(1) en vez de O(n) conversaciones abiertas.
    live.forEach((s) => addTab(s, { activate: false }));
    chats.forEach((c) => addTab(c, { type: 'chat', activate: false }));
    const focus = new URLSearchParams(location.search).get('focus');
    const initial = (focus && tabs.has(focus)) ? focus : ([...tabs.keys()].pop() || null);
    if (initial) setActive(initial);
    if (focus) history.replaceState(null, '', '/');
    if (!live.length && !chats.length) bus.dispatchEvent(new Event('open-launcher'));
    // Si el tab ACTIVO es un chat, esperar a que su historial esté renderizado
    // DE VERDAD (promesa `ready` del ChatTab, resuelta al procesar el primer
    // `history` del attach — no un timer) antes de destapar: sin esto el
    // splash caía y el chat aparecía vacío unos segundos. Con lazy-connect su WS
    // ya se abrió en setActive. Tope de 8 s por si el WS no conecta (la red
    // inline del HTML fuerza a los 12 s igual).
    const act = tabs.get(activeId);
    if (act?.type === 'chat' && act.tab?.ready) {
      bootMsg('cargando la conversación…', 85);
      await Promise.race([act.tab.ready, new Promise((r) => setTimeout(r, 8000))]);
    }
  } finally {
    // App lista (o el boot falló y el error ya está a la vista): fuera splash.
    window.__bootHide?.();
    pollTabStatus();
  }
})();

// Service Worker (Capa 1): cachea los estáticos de la app en el navegador
// para acelerar cargas/reconexiones. Se auto-invalida por BUILD_ID en cada
// deploy (ver public/sw.js + la ruta /sw.js del server). Registro
// no-bloqueante y best-effort: si falla, la app funciona igual sin caché.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .catch((err) => console.warn('[sw] no se pudo registrar', err));
  });
}
