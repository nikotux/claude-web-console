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
    <div class="bk-list" data-ref="list"></div>

    <div class="bk-git">
      <div class="bk-git-title">${icon('gitBranch', { size: 14 })}<span>Backup del código a GitHub</span></div>
      <div class="bk-git-body" data-ref="git">cargando…</div>
    </div>`;

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

  // ===== Backup del código a GitHub personal =====
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function loadGit() {
    let info;
    try { info = await (await fetch(`${API}/git-info`)).json(); }
    catch { refs.git.innerHTML = '<div class="bk-empty">No se pudo leer el estado de git.</div>'; return; }

    if (!info.isRepo) {
      refs.git.innerHTML = '<div class="bk-empty">El proyecto no es un repositorio git.</div>';
      return;
    }

    const excluded = (info.excluded || []).join(' · ') || '(ninguno en disco)';

    // Sin remote `personal`: mostrar los comandos exactos para que los corra el usuario.
    if (!info.remote) {
      refs.git.innerHTML = `
        <p class="bk-git-hint">No hay remote <b>personal</b>. Creá un repo <b>privado</b> vacío en GitHub y agregá el remote (los comandos son tuyos, la app no lo configura):</p>
        <pre class="bk-git-cmds">${esc((info.setupCommands || []).join('\n'))}</pre>
        <p class="bk-git-out">Queda FUERA del push (ignorado): <span class="bk-git-secrets">${esc(excluded)}</span></p>`;
      return;
    }

    if (info.remote.forbidden) {
      refs.git.innerHTML = `
        <p class="bk-msg err">El remote <b>personal</b> apunta a <b>Mordor-Staffing</b> (${esc(info.remote.url)}). Push BLOQUEADO por seguridad.</p>`;
      return;
    }

    refs.git.innerHTML = `
      <p class="bk-git-remote">→ <code>${esc(info.remote.url)}</code> · rama <b>${esc(info.branch)}</b></p>
      <p class="bk-git-out">Queda FUERA (ignorado): <span class="bk-git-secrets">${esc(excluded)}</span></p>
      ${info.untracked?.length ? `<p class="bk-git-out">No se subirán ${info.untracked.length} archivo(s) sin trackear (agregalos a git a mano si querés incluirlos).</p>` : ''}
      <p class="bk-git-out">${info.dirtyCount ? `${info.dirtyCount} cambio(s) trackeado(s) pendientes` : 'Sin cambios pendientes'}${info.lastCommit ? ` · último: <code>${esc(info.lastCommit)}</code>` : ''}</p>
      <button class="btn btn--block" data-ref="push">${icon('upload', { size: 15 })}<span>Push a GitHub ahora</span></button>
      <p class="bk-msg" data-ref="gmsg" hidden></p>`;

    const pushBtn = refs.git.querySelector('[data-ref="push"]');
    const gmsg = refs.git.querySelector('[data-ref="gmsg"]');
    const setGMsg = (t, kind = 'info') => { gmsg.textContent = t; gmsg.className = `bk-msg ${kind}`; gmsg.hidden = !t; };

    pushBtn.addEventListener('click', async () => {
      if (busy) return;
      const ok = await dialog.confirmDialog({
        title: 'Push del código a GitHub',
        message: `Se commitean los cambios trackeados y se empuja SOLO al remote personal:\n${info.remote.url}\n\nNunca se suben .env, users.json, sessions.json, certs/ ni otros ignorados.`,
        confirmLabel: 'Push',
      });
      if (!ok) return;
      setBusy(true); pushBtn.disabled = true; setGMsg('Empujando a GitHub…');
      try {
        const res = await fetch(`${API}/push`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falló el push.');
        const parts = [];
        if (data.committed) parts.push(`commit ${data.committed}`);
        parts.push('push OK');
        if (data.untrackedSkipped?.length) parts.push(`${data.untrackedSkipped.length} sin trackear omitidos`);
        setGMsg(parts.join(' · '), 'ok');
        loadGit();
      } catch (e) {
        setGMsg(e.message, 'err');
      } finally {
        setBusy(false);
      }
    });
  }

  refs.create.addEventListener('click', create);
  loadList();
  loadGit();
}
