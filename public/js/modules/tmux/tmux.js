// modules/tmux/tmux.js — control de sesiones tmux (todos los sockets).
//   - Lista agrupada por socket; marca las propias (cwc) y las adjuntas.
//   - Adjuntar: abre una terminal nueva envolviendo esa sesión.
//   - Matar: con confirmación (control total => cuidado con las ajenas).
import { icon } from '../../ui/icons.js';

let listEl = null;
let countEl = null;
let openAttachCb = null;

function shortCwd(p) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

async function refresh() {
  if (!listEl) return;
  listEl.innerHTML = '<div class="tmux-msg">cargando…</div>';
  try {
    const res = await fetch('/api/tmux/sessions');
    if (!res.ok) throw new Error();
    const { sessions } = await res.json();
    render(sessions);
  } catch {
    listEl.innerHTML = '<div class="tmux-msg tmux-err">error al listar</div>';
  }
}

function render(sessions) {
  if (countEl) countEl.textContent = sessions.length ? String(sessions.length) : '';
  if (!sessions.length) {
    listEl.innerHTML = '<div class="tmux-msg">sin sesiones</div>';
    return;
  }
  // Agrupamos por socket.
  const bySocket = new Map();
  for (const s of sessions) {
    if (!bySocket.has(s.socketName)) bySocket.set(s.socketName, []);
    bySocket.get(s.socketName).push(s);
  }

  listEl.innerHTML = '';
  for (const [sockName, list] of bySocket) {
    const grp = document.createElement('div');
    grp.className = 'tmux-grp';
    grp.innerHTML = `<div class="tmux-grp-h">socket: ${sockName}</div>`;
    for (const s of list) grp.appendChild(row(s));
    listEl.appendChild(grp);
  }
}

// Pinta el modelo actual (con su color) en el elemento dado.
function setCurModel(el, model) {
  if (!el) return;
  if (model) {
    el.innerHTML = `<span class="tmux-flag" style="background:${model.color}"></span>${model.name}`;
    el.style.color = model.color;
    el.title = `Modelo en uso: ${model.name} (${model.id})`;
  } else {
    el.innerHTML = '<span class="tmux-flag off"></span><span class="tmux-nomodel">sin Claude</span>';
    el.style.color = '';
    el.title = 'No se detectó una sesión de Claude en uso';
  }
}

function row(s) {
  const el = document.createElement('div');
  el.className = 'tmux-row' + (s.owned ? ' owned' : '');
  el.dataset.key = `${s.socket}\n${s.name}`;

  const line = document.createElement('div');
  line.className = 'tmux-line';

  const dot = s.attached ? '●' : '○';
  const info = document.createElement('div');
  info.className = 'tmux-info';
  info.innerHTML = `
    <span class="tmux-dot ${s.attached ? 'on' : ''}">${dot}</span>
    <span class="tmux-name">${s.name}</span>
    <span class="tmux-cwd">${shortCwd(s.cwd)}</span>`;

  line.append(info);

  // Acciones DEBAJO de la fila (no flotando a la derecha).
  const actions = document.createElement('div');
  actions.className = 'tmux-actions';

  const attachBtn = document.createElement('button');
  attachBtn.className = 'tmux-btn';
  attachBtn.innerHTML = `${icon('play')}<span>Adjuntar</span>`;
  attachBtn.title = 'Adjuntar en una terminal';
  attachBtn.addEventListener('click', () => openAttachCb?.({ socket: s.socket, session: s.name }));

  const killBtn = document.createElement('button');
  killBtn.className = 'tmux-btn danger';
  killBtn.innerHTML = `${icon('trash')}<span>Matar</span>`;
  killBtn.title = 'Matar sesión';
  killBtn.addEventListener('click', () => kill(s));

  actions.append(attachBtn, killBtn);

  // Modelo EN USO (arriba del dropdown), con el color del banderín.
  const cur = document.createElement('div');
  cur.className = 'tmux-curmodel';
  setCurModel(cur, s.model);

  // Selector de modelo de Claude Code (envía /model a la sesión).
  const sel = document.createElement('select');
  sel.className = 'tmux-model';
  sel.title = 'Modelo de Claude para esta sesión';
  sel.innerHTML = `
    <option value="" disabled selected>◈ modelo…</option>
    <option value="opusplan">Auto (Opus plan / Sonnet)</option>
    <option value="opus">Opus</option>
    <option value="sonnet">Sonnet</option>
    <option value="haiku">Haiku</option>
    <option value="default">Default</option>`;
  sel.addEventListener('click', (e) => e.stopPropagation());
  sel.addEventListener('change', () => setModel(s, sel.value));

  el.append(line, actions, cur, sel);
  return el;
}

// Actualiza SOLO las etiquetas de modelo en su lugar (sin reconstruir la
// lista, para no interrumpir los dropdowns). Corre mientras la sección se ve.
async function updateModelsInPlace() {
  if (!listEl || document.hidden || !listEl.offsetParent) return;
  try {
    const { sessions } = await (await fetch('/api/tmux/sessions')).json();
    const map = new Map(sessions.map((s) => [`${s.socket}\n${s.name}`, s.model]));
    for (const rowEl of listEl.querySelectorAll('.tmux-row')) {
      if (map.has(rowEl.dataset.key)) setCurModel(rowEl.querySelector('.tmux-curmodel'), map.get(rowEl.dataset.key));
    }
  } catch { /* noop */ }
}

async function setModel(s, model) {
  if (!model) return;
  try {
    const res = await fetch('/api/tmux/set-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ socket: s.socket, session: s.name, model }),
    });
    if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'No se pudo cambiar el modelo.');
  } catch {
    alert('No se pudo cambiar el modelo.');
  }
}

async function kill(s) {
  const warn = s.owned
    ? `¿Matar la sesión ${s.name}?`
    : `¿Matar la sesión AJENA ${s.name} (socket ${s.socketName})?\nEsto puede interrumpir algo que estés usando por fuera.`;
  if (!confirm(warn)) return;
  try {
    const res = await fetch('/api/tmux/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ socket: s.socket, session: s.name }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error || 'No se pudo matar la sesión.');
    }
  } finally {
    refresh();
  }
}

export function initTmux({ list, count, refreshBtn, openAttach }) {
  listEl = list;
  countEl = count;
  openAttachCb = openAttach;
  if (refreshBtn) refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); refresh(); });
  // Mantiene vivo el "modelo en uso" mientras la sección esté visible.
  setInterval(updateModelsInPlace, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateModelsInPlace(); });
}

export { refresh as refreshTmux };
