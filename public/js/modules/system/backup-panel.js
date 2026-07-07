// modules/system/backup-panel.js — panel de backups (pestaña del menú Sistema).
//
// Misma lógica de siempre (crear / listar solo fecha-hora / restaurar con
// reinicio automático / eliminar), embebida en el modal Sistema y con
// diálogos propios. El backend no cambió.
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';

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
    </div>

    <div class="bk-git">
      <div class="bk-git-title">${icon('refresh', { size: 14 })}<span>Mantenimiento</span></div>
      <button class="btn-ghost btn--block" data-ref="recycle" title="Recicla los motores de chat vivos (SIGTERM). Se reabren solos con el historial intacto y vuelven a leer las credenciales del disco (arregla el MCP pad que no carga tras una credencial vieja).">🔄<span>Reiniciar sesiones</span></button>
      <p class="bk-msg" data-ref="rmsg" hidden></p>
    </div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

  // `running:true` antepone el Pac-Man (SOLO para textos estáticos de proceso
  // largo — los mensajes de error vienen del server y van por textContent).
  function msg(text, kind = 'info', { running = false } = {}) {
    if (running) refs.msg.innerHTML = `${pacman()} ${text}`;
    else refs.msg.textContent = text;
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
    msg('Creando backup…', 'info', { running: true });
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
    msg('Restaurando… el servidor se está reiniciando.', 'info', { running: true });
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
      const res = await fetch(`${API}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falló la eliminación.');
    } catch (e) {
      msg(e.message, 'err');
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
    try {
      const res = await fetch(`${API}/git-info`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Error');
      info = d;
    } catch (e) {
      refs.git.innerHTML = `<div class="bk-empty">No se pudo leer el estado de git${e.message ? `: ${esc(e.message)}` : ''}.</div>`;
      return;
    }

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
      ${info.untracked?.length ? `<p class="bk-git-out">${info.untracked.length} archivo(s) nuevos sin trackear — al hacer Push podés elegir cuáles incluir.</p>` : ''}
      <p class="bk-git-out">${info.dirtyCount ? `${info.dirtyCount} cambio(s) trackeado(s) pendientes` : 'Sin cambios pendientes'}${info.lastCommit ? ` · último: <code>${esc(info.lastCommit)}</code>` : ''}</p>
      <button class="btn-ghost btn--block" data-ref="commit" title="Commit local descriptivo de los cambios pendientes — NO empuja nada a GitHub (eso sigue siendo Push)">${icon('gitCommit', { size: 15 })}<span>Commit (sin push)</span></button>
      <button class="btn btn--block" data-ref="push">${icon('upload', { size: 15 })}<span>Push a GitHub ahora</span></button>
      <button class="btn-ghost btn--block" data-ref="pull" title="Trae el código desde GitHub (restauración): fetch + fast-forward; tus cambios locales quedan a salvo en un stash que se reaplica">${icon('download', { size: 15 })}<span>Pull desde GitHub (restaurar)</span></button>
      <p class="bk-msg" data-ref="gmsg" hidden></p>`;

    const commitBtn = refs.git.querySelector('[data-ref="commit"]');
    const pushBtn = refs.git.querySelector('[data-ref="push"]');
    const pullBtn = refs.git.querySelector('[data-ref="pull"]');
    const gmsg = refs.git.querySelector('[data-ref="gmsg"]');
    // running=true antepone el Pac-Man (solo textos estáticos de proceso largo).
    const setGMsg = (t, kind = 'info', { running = false } = {}) => {
      if (running) gmsg.innerHTML = `${pacman()} ${t}`;
      else gmsg.textContent = t;
      gmsg.className = `bk-msg ${kind}`;
      gmsg.hidden = !t;
    };

    // Confirmación de push. Con archivos nuevos sin trackear, el diálogo los
    // lista con un checkbox cada uno: NADA nuevo viaja sin selección humana
    // explícita (la guarda anti-secretos del backend igual re-valida).
    function confirmPush(untracked) {
      return new Promise((resolve) => {
        const m = dialog.openModal({ title: 'Push del código a GitHub', width: 460, onClose: () => resolve(null) });
        const box = document.createElement('div');
        box.innerHTML = `
          <p class="dlg-msg">Se commitean los cambios trackeados y se empuja SOLO al remote personal:\n${esc(info.remote.url)}\n\nNunca se suben .env, users.json, sessions.json, certs/ ni otros ignorados.</p>
          ${untracked.length ? `
            <p class="dlg-msg"><b>Archivos NUEVOS sin trackear</b> — marcá los que quieras incluir en el backup (sin marcar, no viajan):</p>
            <div class="bk-untracked" data-ref="list">
              ${untracked.map((f) => `<label class="bk-untracked-item"><input type="checkbox" value="${esc(f)}"><code>${esc(f)}</code></label>`).join('')}
            </div>` : ''}
          <div class="dlg-actions">
            <button class="btn-ghost" data-ref="cancel">Cancelar</button>
            <button class="btn" data-ref="ok">Push</button>
          </div>`;
        m.body.appendChild(box);
        box.querySelector('[data-ref="cancel"]').addEventListener('click', () => m.close());
        box.querySelector('[data-ref="ok"]').addEventListener('click', () => {
          const selected = [...box.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
          resolve(selected); // [] = push sin untracked (el comportamiento de siempre)
          m.close();
        });
      });
    }

    // Diálogo de commit: lista de cambios trackeados (solo lectura) +
    // checkboxes de untracked (mismo patrón que el push: nada nuevo viaja sin
    // selección explícita) + mensaje editable con "Generar con IA" a demanda
    // (job + runner desacoplado; acá solo se encuesta el resultado).
    function commitDialog() {
      return new Promise((resolve) => {
        let alive = true;
        const m = dialog.openModal({
          title: 'Commit (sin push)', width: 520,
          onClose: () => { alive = false; resolve(null); },
        });
        const box = document.createElement('div');
        const dirty = info.dirty || [];
        const fmtStatus = (l) => {
          const [code, ...paths] = l.split('\t');
          return `<b>${esc((code || '')[0] || '?')}</b> <code>${esc(paths.join(' → '))}</code>`;
        };
        box.innerHTML = `
          <p class="dlg-msg">Commit LOCAL de los cambios pendientes — no toca GitHub (el push sigue siendo el otro botón). Reversible con git.</p>
          ${dirty.length ? `
            <div class="bk-untracked">
              ${dirty.map((l) => `<div class="bk-untracked-item">${fmtStatus(l)}</div>`).join('')}
            </div>` : '<p class="dlg-msg">Sin cambios trackeados pendientes.</p>'}
          ${info.untracked?.length ? `
            <p class="dlg-msg"><b>Archivos NUEVOS sin trackear</b> — marcá los que quieras incluir (sin marcar, quedan afuera):</p>
            <div class="bk-untracked">
              ${info.untracked.map((f) => `<label class="bk-untracked-item"><input type="checkbox" value="${esc(f)}"><code>${esc(f)}</code></label>`).join('')}
            </div>` : ''}
          <textarea class="dlg-editor-text" data-ref="cmsg" rows="4" spellcheck="false" placeholder="Mensaje del commit (en español, asunto ≤72 caracteres)…"></textarea>
          <p class="bk-msg" data-ref="gen-state" hidden></p>
          <div class="dlg-actions">
            <button class="btn-ghost" data-ref="gen" title="Genera una propuesta de mensaje con IA (haiku, corrida corta) — siempre editable">${icon('sparkle', { size: 14 })}<span>Generar con IA</span></button>
            <button class="btn-ghost" data-ref="cancel">Cancelar</button>
            <button class="btn" data-ref="ok">Commit</button>
          </div>`;
        m.body.appendChild(box);

        const ta = box.querySelector('[data-ref="cmsg"]');
        const genBtn = box.querySelector('[data-ref="gen"]');
        const genState = box.querySelector('[data-ref="gen-state"]');
        const selected = () => [...box.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
        const state = (t, kind = 'info', { running = false } = {}) => {
          // 'delegating': acá siempre es la IA (runner desacoplado
          // cwc-commitmsg-runner.js) generando el mensaje — nunca la corrida
          // sincrónica del propio commit.
          if (running) genState.innerHTML = `${pacman({ state: 'delegating' })} ${t}`;
          else genState.textContent = t;
          genState.className = `bk-msg ${kind}`;
          genState.hidden = !t;
        };

        genBtn.addEventListener('click', async () => {
          genBtn.disabled = true;
          state('Generando mensaje con IA…', 'info', { running: true });
          try {
            const res = await fetch(`${API}/commit-message`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ includeUntracked: selected() }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || 'No se pudo lanzar la generación.');
            // Encuesta resiliente: el runner es desacoplado, el GET solo lee
            // disco; si se cierra el modal, se deja de encuestar y ya.
            const t0 = Date.now();
            while (alive && Date.now() - t0 < 95000) {
              await new Promise((ok) => setTimeout(ok, 1500));
              const jr = await fetch(`${API}/commit-message/${d.id}`);
              const j = await jr.json().catch(() => ({}));
              if (!jr.ok) throw new Error(j.error || 'Se perdió el job de generación.');
              if (j.status === 'running') continue;
              if (j.status === 'done' && j.message) {
                ta.value = j.message;
                state('');
              } else {
                throw new Error(j.error || 'La generación falló — escribí el mensaje a mano.');
              }
              return;
            }
            if (alive) throw new Error('La generación tardó demasiado — escribí el mensaje a mano.');
          } catch (e) {
            if (alive) state(e.message, 'err');
          } finally {
            genBtn.disabled = false;
          }
        });

        box.querySelector('[data-ref="cancel"]').addEventListener('click', () => m.close());
        box.querySelector('[data-ref="ok"]').addEventListener('click', () => {
          const message = ta.value.trim();
          if (!message) { state('Escribí (o generá) el mensaje del commit.', 'err'); return; }
          alive = false;
          resolve({ message, includeUntracked: selected() });
          m.close();
        });
      });
    }

    commitBtn.addEventListener('click', async () => {
      if (busy) return;
      const sel = await commitDialog();
      if (!sel) return; // canceló
      setBusy(true); commitBtn.disabled = true;
      setGMsg('Commiteando…', 'info', { running: true });
      try {
        const res = await fetch(`${API}/commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sel),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falló el commit.');
        const parts = [`commit ${data.committed}`, `${data.staged.length} archivo(s)`];
        if (data.includedUntracked?.length) parts.push(`${data.includedUntracked.length} nuevo(s) incluidos`);
        parts.push('sin push (usá "Push a GitHub" cuando quieras respaldarlo)');
        setGMsg(parts.join(' · '), 'ok');
        loadGit();
      } catch (e) {
        setGMsg(e.message, 'err');
      } finally {
        setBusy(false);
        commitBtn.disabled = false; // tras un error, el botón sigue usable (el éxito re-renderiza)
      }
    });

    pushBtn.addEventListener('click', async () => {
      if (busy) return;
      const includeUntracked = await confirmPush(info.untracked || []);
      if (includeUntracked === null) return; // canceló
      setBusy(true); pushBtn.disabled = true; setGMsg('Empujando a GitHub…', 'info', { running: true });
      try {
        const res = await fetch(`${API}/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ includeUntracked }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falló el push.');
        const parts = [];
        if (data.committed) parts.push(`commit ${data.committed}`);
        parts.push('push OK');
        if (data.includedUntracked?.length) parts.push(`${data.includedUntracked.length} archivo(s) nuevos incluidos`);
        if (data.untrackedSkipped?.length) parts.push(`${data.untrackedSkipped.length} sin trackear omitidos`);
        if (data.changelogUpdated) parts.push('changelog actualizado');
        if (data.description?.ok) parts.push('descripción de GitHub actualizada');
        else if (data.description?.skipped) parts.push(`descripción sin actualizar (${data.description.skipped})`);
        setGMsg(parts.join(' · '), 'ok');
        loadGit();
      } catch (e) {
        setGMsg(e.message, 'err');
      } finally {
        setBusy(false);
      }
    });

    // Pull = restauración del código desde GitHub. Si actualizó, el server se
    // reinicia solo (mismo flujo que restaurar un backup: esperar y recargar).
    pullBtn.addEventListener('click', async () => {
      if (busy) return;
      const ok = await dialog.confirmDialog({
        title: 'Pull desde GitHub (restaurar código)',
        message: `Se trae el código desde el remote personal:\n${info.remote.url}\n\nSolo avanza en línea recta (fast-forward): si tu historial local divergió, NO se fuerza nada. Los cambios locales sin commitear quedan a salvo en un stash que se reaplica. Si hay actualización, el servidor se reinicia solo (la página se recarga).`,
        confirmLabel: 'Pull',
      });
      if (!ok) return;
      setBusy(true); pullBtn.disabled = true; pushBtn.disabled = true;
      setGMsg('Trayendo el código desde GitHub…', 'info', { running: true });
      try {
        const res = await fetch(`${API}/pull`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falló el pull.');
        if (data.upToDate) {
          setGMsg(data.ahead
            ? `Nada que traer: tu copia local va ${data.ahead} commit(s) ADELANTE de GitHub (${data.head}) — hacé push.`
            : `Ya estás al día con GitHub (${data.head}).`, 'ok');
          setBusy(false);
          return;
        }
        const parts = [`actualizado ${data.from} → ${data.to}`, `${data.files} archivo(s)`];
        if (data.stashed) parts.push(data.popConflict ? 'CONFLICTO al reaplicar tus cambios (quedaron en el stash)' : 'cambios locales reaplicados');
        if (data.npmRan) parts.push(data.npmOk ? 'dependencias instaladas' : 'npm install FALLÓ');
        if (data.restarting) {
          setGMsg(`${parts.join(' · ')} · reiniciando…`, 'ok', { running: true });
          await waitForServer();
          location.reload();
          return;
        }
        // Árbol con conflicto o npm roto: NO se reinició — requiere mano.
        setGMsg(`${parts.join(' · ')} · el servidor NO se reinició: revisá el árbol (conflicto/deps) y reiniciá a mano.`, 'err');
        setBusy(false);
      } catch (e) {
        setGMsg(e.message, 'err');
        setBusy(false);
      }
    });
  }

  // Reciclar los motores de chat: manda SIGTERM a cada runner vivo. Se reabren
  // solos (--resume) con el historial intacto y RE-LEEN ~/.claude/.credentials.json
  // al re-inicializar sus MCP — arregla el MCP `pad` que no carga tras una
  // credencial OAuth vieja.
  function rmsg(text, kind = 'info', { running = false } = {}) {
    if (running) refs.rmsg.innerHTML = `${pacman()} ${text}`;
    else refs.rmsg.textContent = text;
    refs.rmsg.className = `bk-msg ${kind}`;
    refs.rmsg.hidden = !text;
  }

  async function recycle() {
    if (busy) return;
    const ok = await dialog.confirmDialog({
      title: 'Reiniciar sesiones',
      message: '¿Reiniciar todas las sesiones? Se reabren solas con el historial intacto. Los motores vuelven a leer las credenciales del disco (arregla el MCP que no carga tras una credencial vieja).',
      confirmLabel: 'Reiniciar',
    });
    if (!ok) return;
    setBusy(true);
    refs.recycle.disabled = true;
    rmsg('Reiniciando sesiones…', 'info', { running: true });
    try {
      const res = await fetch('/api/admin/restart-runners', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falló el reinicio de sesiones.');
      rmsg(data.killed
        ? `${data.killed} sesión(es) reiniciada(s) — se reabren solas al interactuar.`
        : 'No había sesiones vivas para reiniciar.', 'ok');
    } catch (e) {
      rmsg(e.message, 'err');
    } finally {
      setBusy(false);
      refs.recycle.disabled = false;
    }
  }

  refs.create.addEventListener('click', create);
  refs.recycle.addEventListener('click', recycle);
  loadList();
  loadGit();
}
