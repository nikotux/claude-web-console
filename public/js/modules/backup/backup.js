// modules/backup/backup.js — modal de backups: crear y restaurar snapshots.
//
// La lista muestra SOLO fecha y hora (pedido del usuario); el tamaño va en el
// tooltip. Restaurar reinicia el servidor: se espera a que vuelva (poll a
// /api/whoami) y se recarga la página.
import { icon } from '../../ui/icons.js';

const API = '/api/backup';

let modal, msgEl, listEl, createBtn;
let busy = false;

function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtSize(b) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function msg(text, kind = 'info') {
  msgEl.textContent = text;
  msgEl.className = `bk-msg ${kind}`;
  msgEl.hidden = !text;
}

function setBusy(on) {
  busy = on;
  createBtn.disabled = on;
  for (const b of listEl.querySelectorAll('button')) b.disabled = on;
}

async function loadList() {
  try {
    const res = await fetch(`${API}/list`);
    if (!res.ok) throw new Error();
    const { backups } = await res.json();
    if (!backups.length) {
      listEl.innerHTML = '<div class="bk-empty">Todavía no hay backups.</div>';
      return;
    }
    listEl.innerHTML = backups.map((b) => `
      <div class="bk-row" title="${b.id} · ${fmtSize(b.size)}">
        <span class="bk-date">${fmtDate(b.date)}</span>
        <span class="bk-actions">
          <button class="bk-btn" data-restore="${b.id}">Restaurar</button>
          <button class="bk-btn danger" data-del="${b.id}" title="Eliminar backup">${icon('trash', { size: 13 })}</button>
        </span>
      </div>`).join('');
    for (const b of listEl.querySelectorAll('[data-restore]')) {
      b.addEventListener('click', () => restore(b.dataset.restore));
    }
    for (const b of listEl.querySelectorAll('[data-del]')) {
      b.addEventListener('click', () => del(b.dataset.del));
    }
  } catch {
    listEl.innerHTML = '<div class="bk-empty">No se pudo listar los backups.</div>';
  }
}

async function create() {
  if (busy) return;
  setBusy(true);
  msg('Creando backup…');
  try {
    const res = await fetch(`${API}/create`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falló el backup.');
    msg(`Backup creado (${fmtSize(data.backup.size)}).`, 'ok');
    loadList();
  } catch (e) {
    msg(e.message, 'err');
  } finally {
    setBusy(false);
  }
}

async function restore(id) {
  if (busy) return;
  if (!confirm('¿Restaurar este backup?\n\nSe sobrescribe el estado actual de la consola y el servidor se reinicia (la página se recargará sola). Si el backup es viejo, puede pedirte iniciar sesión de nuevo.')) return;
  setBusy(true);
  msg('Restaurando… el servidor se está reiniciando.');
  try {
    const res = await fetch(`${API}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falló la restauración.');
    // Esperar a que el server vuelva y recargar.
    await waitForServer();
    location.reload();
  } catch (e) {
    msg(e.message, 'err');
    setBusy(false);
  }
}

async function del(id) {
  if (busy) return;
  if (!confirm('¿Eliminar este backup definitivamente?')) return;
  try {
    await fetch(`${API}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } finally {
    loadList();
  }
}

// Poll hasta que el server responda de nuevo (tras el reinicio por restore).
function waitForServer() {
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const r = await fetch('/api/whoami', { cache: 'no-store' });
        if (r.status < 500) return resolve(); // 200 o 401: el server ya volvió
      } catch { /* aún caído */ }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 2500); // margen para que alcance a bajar/subir
  });
}

function open() {
  modal.hidden = false;
  msg('');
  loadList();
}
function close() {
  if (busy) return; // no cerrar en medio de una restauración
  modal.hidden = true;
}

export function initBackup({ isAdmin }) {
  modal = document.getElementById('backup-modal');
  msgEl = document.getElementById('bk-msg');
  listEl = document.getElementById('bk-list');
  createBtn = document.getElementById('bk-create');
  const openBtn = document.getElementById('backup-btn');

  if (isAdmin) openBtn.hidden = false; // el backend igual exige admin

  openBtn.addEventListener('click', open);
  document.getElementById('bk-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
  createBtn.addEventListener('click', create);
}
