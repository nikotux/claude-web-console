// modules/system/backup-panel.js — panel de backups (pestaña del menú Sistema).
//
// Misma lógica de siempre (crear / listar solo fecha-hora / restaurar con
// reinicio automático / eliminar), embebida en el modal Sistema y con
// diálogos propios. El backend no cambió.
import { icon } from '../../ui/icons.js';

const API = '/api/backup';

function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtSize(b) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Espera a que el server vuelva tras el reinicio del restore.
function waitForServer() {
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const r = await fetch('/api/whoami', { cache: 'no-store' });
        if (r.status < 500) return resolve();
      } catch { /* aún caído */ }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 2500);
  });
}

export function mountBackupPanel(el, ctx) {
  const { dialog } = ctx;
  let busy = false;

  el.innerHTML = `
    <button class="btn btn--block" data-ref="create">${icon('archive', { size: 15 })}<span>Crear backup ahora</span></button>
    <p class="bk-msg" data-ref="msg" hidden></p>
    <div class="bk-list" data-ref="list"></div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

  function msg(text, kind = 'info') {
    refs.msg.textContent = text;
    refs.msg.className = `bk-msg ${kind}`;
    refs.msg.hidden = !text;
  }
  function setBusy(on) {
    busy = on;
    refs.create.disabled = on;
    for (const b of refs.list.querySelectorAll('button')) b.disabled = on;
  }

  async function loadList() {
    try {
      const { backups } = await (await fetch(`${API}/list`)).json();
      if (!backups.length) {
        refs.list.innerHTML = '<div class="bk-empty">Todavía no hay backups.</div>';
        return;
      }
      refs.list.innerHTML = backups.map((b) => `
        <div class="bk-row" title="${b.id} · ${fmtSize(b.size)}">
          <span class="bk-date">${fmtDate(b.date)}</span>
          <span class="bk-actions">
            <button class="btn-ghost btn--sm" data-restore="${b.id}">Restaurar</button>
            <button class="btn-ghost btn--sm btn--icon btn--danger" data-del="${b.id}" title="Eliminar backup">${icon('trash', { size: 13 })}</button>
          </span>
        </div>`).join('');
      for (const b of refs.list.querySelectorAll('[data-restore]')) b.addEventListener('click', () => restore(b.dataset.restore));
      for (const b of refs.list.querySelectorAll('[data-del]')) b.addEventListener('click', () => del(b.dataset.del));
    } catch {
      refs.list.innerHTML = '<div class="bk-empty">No se pudo listar los backups.</div>';
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
    const ok = await dialog.confirmDialog({
      title: 'Restaurar backup',
      message: 'Se sobrescribe el estado actual de la consola y el servidor se reinicia (la página se recargará sola). Si el backup es viejo, puede pedirte iniciar sesión de nuevo.',
      confirmLabel: 'Restaurar',
      danger: true,
    });
    if (!ok) return;
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
      await waitForServer();
      location.reload();
    } catch (e) {
      msg(e.message, 'err');
      setBusy(false);
    }
  }

  async function del(id) {
    if (busy) return;
    const ok = await dialog.confirmDialog({
      title: 'Eliminar backup',
      message: 'Se elimina definitivamente. Esto no se puede deshacer.',
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
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

  refs.create.addEventListener('click', create);
  loadList();
}
