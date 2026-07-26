// modules/system/backup-panel.js — panel de backups (pestaña del menú Sistema).
//
// Crear / listar / restaurar con reinicio automático / eliminar, embebido en
// el modal Sistema. La lista separa los tar.gz de la consola de las bases del
// Pad y deja visible el cupo de retención independiente.
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
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
    <div class="hp-head">
      <span class="hp-title">${t('system.help.backup.title', 'Backup')}</span>
      ${helpBtn('sys-backup')}
    </div>
    <button class="btn btn--block" data-ref="create">${icon('archive', { size: 15 })}<span>${t('system.backup.createNow', 'Crear backup ahora')}</span></button>
    <p class="bk-msg" data-ref="msg" hidden></p>
    <div class="bk-list" data-ref="list"></div>

    <div class="bk-git">
      <div class="bk-git-title">${icon('gitBranch', { size: 14 })}<span>${t('system.backup.githubCodeBackupTitle', 'Backup del código a GitHub')}</span></div>
      <div class="bk-git-body" data-ref="git">${t('system.backup.loading', 'cargando…')}</div>
    </div>

    <div class="bk-git">
      <div class="bk-git-title">${icon('refresh', { size: 14 })}<span>${t('system.backup.maintenanceTitle', 'Mantenimiento')}</span></div>
      <button class="btn-ghost btn--block" data-ref="recycle" title="${t('system.backup.restartSessionsTooltip', 'Recicla los motores de chat vivos (SIGTERM). Se reabren solos con el historial intacto y vuelven a leer las credenciales del disco (arregla el MCP pad que no carga tras una credencial vieja).')}">🔄<span>${t('system.backup.restartSessions', 'Reiniciar sesiones')}</span></button>
      <p class="bk-msg" data-ref="rmsg" hidden></p>
      <button class="btn-ghost btn--block" data-ref="restart" title="${t('system.backup.restartServerTooltip', 'Reinicia el proceso del servidor (systemctl --user restart). Las terminales tmux y los motores de chat SOBREVIVEN (KillMode=process): solo se corta la web unos segundos. Hace falta para que el server tome cambios de código nuevos.')}">🔁<span>${t('system.backup.restartServer', 'Reiniciar el servidor')}</span></button>
      <p class="bk-msg" data-ref="srvmsg" hidden></p>
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
      const res = await fetch(`${API}/list`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('system.backup.listError', 'No se pudo listar los backups.'));
      const backups = data.backups || [];
      const padBackups = data.padBackups || [];
      const keepPerSet = data.keepPerSet;
      const projectRows = backups.length ? backups.map((b) => `
        <div class="bk-row" title="${b.id} · ${fmtSize(b.size)}">
          <span class="bk-date">${fmtDate(b.date)} · ${fmtSize(b.size)}</span>
          <span class="bk-actions">
            <button class="btn-ghost btn--sm" data-restore="${b.id}">${t('system.backup.restore', 'Restaurar')}</button>
            <button class="btn-ghost btn--sm btn--icon btn--danger" data-del="${b.id}" title="${t('system.backup.deleteBackupTooltip', 'Eliminar backup')}">${icon('trash', { size: 13 })}</button>
          </span>
        </div>`).join('') : `<div class="bk-empty">${t('system.backup.noProjectBackups', 'Todavía no hay backups de la consola.')}</div>`;
      const padRows = padBackups.length ? padBackups.map((b) => `
        <div class="bk-row" title="${b.id}">
          <span class="bk-date">${fmtDate(b.date)} · ${fmtSize(b.size)}</span>
        </div>`).join('') : `<div class="bk-empty">${t('system.backup.noPadBackups', 'Todavía no hay backups del Pad.')}</div>`;

      refs.list.innerHTML = `
        <p class="bk-git-hint">${t('system.backup.retentionPolicy', 'Se conservan los últimos {count} de cada tipo.', { count: keepPerSet })}</p>
        <div class="bk-git-title"><span>${t('system.backup.projectBackupsTitle', 'Consola (tar.gz)')}</span></div>
        ${projectRows}
        <div class="bk-git-title"><span>${t('system.backup.padBackupsTitle', 'Pad (base de datos)')}</span></div>
        ${padRows}`;
      for (const b of refs.list.querySelectorAll('[data-restore]')) b.addEventListener('click', () => restore(b.dataset.restore));
      for (const b of refs.list.querySelectorAll('[data-del]')) b.addEventListener('click', () => del(b.dataset.del));
    } catch {
      refs.list.innerHTML = `<div class="bk-empty">${t('system.backup.listError', 'No se pudo listar los backups.')}</div>`;
    }
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    msg(t('system.backup.creating', 'Creando backup…'), 'info', { running: true });
    try {
      const res = await fetch(`${API}/create`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('system.backup.createFailed', 'Falló el backup.'));
      msg(t('system.backup.created', 'Backup creado ({size}).', { size: fmtSize(data.backup.size) }), 'ok');
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
      title: t('system.backup.restoreTitle', 'Restaurar backup'),
      message: t('system.backup.restoreMessage', 'Se sobrescribe el estado actual de la consola y el servidor se reinicia (la página se recargará sola). Si el backup es viejo, puede pedirte iniciar sesión de nuevo.'),
      confirmLabel: t('system.backup.restore', 'Restaurar'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    msg(t('system.backup.restoring', 'Restaurando… el servidor se está reiniciando.'), 'info', { running: true });
    try {
      const res = await fetch(`${API}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('system.backup.restoreFailed', 'Falló la restauración.'));
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
      title: t('system.backup.deleteTitle', 'Eliminar backup'),
      message: t('system.backup.deleteMessage', 'Se elimina definitivamente. Esto no se puede deshacer.'),
      confirmLabel: t('system.backup.deleteConfirm', 'Eliminar'),
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
      if (!res.ok) throw new Error(data.error || t('system.backup.deleteFailed', 'Falló la eliminación.'));
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
      if (!res.ok) throw new Error(d.error || t('system.backup.genericError', 'Error'));
      info = d;
    } catch (e) {
      refs.git.innerHTML = `<div class="bk-empty">${t('system.backup.gitStatusReadError', 'No se pudo leer el estado de git{detail}.', { detail: e.message ? `: ${esc(e.message)}` : '' })}</div>`;
      return;
    }

    if (!info.isRepo) {
      refs.git.innerHTML = `<div class="bk-empty">${t('system.backup.notGitRepo', 'El proyecto no es un repositorio git.')}</div>`;
      return;
    }

    const excluded = (info.excluded || []).join(' · ') || t('system.backup.noneOnDisk', '(ninguno en disco)');

    // Sin remote `personal`: mostrar los comandos exactos para que los corra el usuario.
    if (!info.remote) {
      refs.git.innerHTML = `
        <p class="bk-git-hint">${t('system.backup.noPersonalRemoteHint', 'No hay remote <b>personal</b>. Creá un repo <b>privado</b> vacío en GitHub y agregá el remote (los comandos son tuyos, la app no lo configura):')}</p>
        <pre class="bk-git-cmds">${esc((info.setupCommands || []).join('\n'))}</pre>
        <p class="bk-git-out">${t('system.backup.excludedFromPush', 'Queda FUERA del push (ignorado):')} <span class="bk-git-secrets">${esc(excluded)}</span></p>`;
      return;
    }

    if (info.remote.forbidden) {
      refs.git.innerHTML = `
        <p class="bk-msg err">${t('system.backup.forbiddenRemote', 'El remote <b>personal</b> apunta a <b>Mordor-Staffing</b> ({url}). Push BLOQUEADO por seguridad.', { url: esc(info.remote.url) })}</p>`;
      return;
    }

    refs.git.innerHTML = `
      <p class="bk-git-remote">→ <code>${esc(info.remote.url)}</code> · ${t('system.backup.branchLabel', 'rama')} <b>${esc(info.branch)}</b></p>
      <p class="bk-git-out">${t('system.backup.excluded', 'Queda FUERA (ignorado):')} <span class="bk-git-secrets">${esc(excluded)}</span></p>
      ${info.untracked?.length ? `<p class="bk-git-out">${t('system.backup.untrackedNewFiles', '{count} archivo(s) nuevos sin trackear — al hacer Push podés elegir cuáles incluir.', { count: info.untracked.length })}</p>` : ''}
      <p class="bk-git-out">${info.dirtyCount ? t('system.backup.trackedChangesPending', '{count} cambio(s) trackeado(s) pendientes', { count: info.dirtyCount }) : t('system.backup.noPendingChanges', 'Sin cambios pendientes')}${info.lastCommit ? ` · ${t('system.backup.lastCommitLabel', 'último')}: <code>${esc(info.lastCommit)}</code>` : ''}</p>
      <button class="btn-ghost btn--block" data-ref="commit" title="${t('system.backup.commitTooltip', 'Commit local descriptivo de los cambios pendientes — NO empuja nada a GitHub (eso sigue siendo Push)')}">${icon('gitCommit', { size: 15 })}<span>${t('system.backup.commitNoPush', 'Commit (sin push)')}</span></button>
      <button class="btn btn--block" data-ref="push">${icon('upload', { size: 15 })}<span>${t('system.backup.pushNow', 'Push a GitHub ahora')}</span></button>
      <button class="btn-ghost btn--block" data-ref="pull" title="${t('system.backup.pullTooltip', 'Trae el código desde GitHub (restauración): fetch + fast-forward; tus cambios locales quedan a salvo en un stash que se reaplica')}">${icon('download', { size: 15 })}<span>${t('system.backup.pullRestore', 'Pull desde GitHub (restaurar)')}</span></button>
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
        const m = dialog.openModal({ title: t('system.backup.pushDialogTitle', 'Push del código a GitHub'), width: 460, onClose: () => resolve(null) });
        const box = document.createElement('div');
        box.innerHTML = `
          <p class="dlg-msg">${t('system.backup.pushDialogMessage', 'Se commitean los cambios trackeados y se empuja SOLO al remote personal:\n{url}\n\nNunca se suben .env, users.json, sessions.json, certs/ ni otros ignorados.', { url: esc(info.remote.url) })}</p>
          ${untracked.length ? `
            <p class="dlg-msg">${t('system.backup.untrackedSelectionHint', '<b>Archivos NUEVOS sin trackear</b> — marcá los que quieras incluir en el backup (sin marcar, no viajan):')}</p>
            <div class="bk-untracked" data-ref="list">
              ${untracked.map((f) => `<label class="bk-untracked-item"><input type="checkbox" value="${esc(f)}"><code>${esc(f)}</code></label>`).join('')}
            </div>` : ''}
          <div class="dlg-actions">
            <button class="btn-ghost" data-ref="cancel">${t('system.backup.cancel', 'Cancelar')}</button>
            <button class="btn" data-ref="ok">${t('system.backup.push', 'Push')}</button>
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
          title: t('system.backup.commitNoPush', 'Commit (sin push)'), width: 520,
          onClose: () => { alive = false; resolve(null); },
        });
        const box = document.createElement('div');
        const dirty = info.dirty || [];
        const fmtStatus = (l) => {
          const [code, ...paths] = l.split('\t');
          return `<b>${esc((code || '')[0] || '?')}</b> <code>${esc(paths.join(' → '))}</code>`;
        };
        box.innerHTML = `
          <p class="dlg-msg">${t('system.backup.commitDialogMessage', 'Commit LOCAL de los cambios pendientes — no toca GitHub (el push sigue siendo el otro botón). Reversible con git.')}</p>
          ${dirty.length ? `
            <div class="bk-untracked">
              ${dirty.map((l) => `<div class="bk-untracked-item">${fmtStatus(l)}</div>`).join('')}
            </div>` : `<p class="dlg-msg">${t('system.backup.noTrackedChangesPending', 'Sin cambios trackeados pendientes.')}</p>`}
          ${info.untracked?.length ? `
            <p class="dlg-msg">${t('system.backup.untrackedCommitHint', '<b>Archivos NUEVOS sin trackear</b> — marcá los que quieras incluir (sin marcar, quedan afuera):')}</p>
            <div class="bk-untracked">
              ${info.untracked.map((f) => `<label class="bk-untracked-item"><input type="checkbox" value="${esc(f)}"><code>${esc(f)}</code></label>`).join('')}
            </div>` : ''}
          <textarea class="dlg-editor-text" data-ref="cmsg" rows="4" spellcheck="false" placeholder="${t('system.backup.commitMessagePlaceholder', 'Mensaje del commit (en español, asunto ≤72 caracteres)…')}"></textarea>
          <p class="bk-msg" data-ref="gen-state" hidden></p>
          <div class="dlg-actions">
            <button class="btn-ghost" data-ref="gen" title="${t('system.backup.generateCommitTooltip', 'Genera una propuesta de mensaje con IA (haiku, corrida corta) — siempre editable')}">${icon('sparkle', { size: 14 })}<span>${t('system.backup.generateWithAi', 'Generar con IA')}</span></button>
            <button class="btn-ghost" data-ref="cancel">${t('system.backup.cancel', 'Cancelar')}</button>
            <button class="btn" data-ref="ok">${t('system.backup.commit', 'Commit')}</button>
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
          state(t('system.backup.generatingCommitMessage', 'Generando mensaje con IA…'), 'info', { running: true });
          try {
            const res = await fetch(`${API}/commit-message`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ includeUntracked: selected() }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || t('system.backup.generationLaunchFailed', 'No se pudo lanzar la generación.'));
            // Encuesta resiliente: el runner es desacoplado, el GET solo lee
            // disco; si se cierra el modal, se deja de encuestar y ya.
            const t0 = Date.now();
            while (alive && Date.now() - t0 < 95000) {
              await new Promise((ok) => setTimeout(ok, 1500));
              const jr = await fetch(`${API}/commit-message/${d.id}`);
              const j = await jr.json().catch(() => ({}));
              if (!jr.ok) throw new Error(j.error || t('system.backup.generationJobLost', 'Se perdió el job de generación.'));
              if (j.status === 'running') continue;
              if (j.status === 'done' && j.message) {
                ta.value = j.message;
                state('');
              } else {
                throw new Error(j.error || t('system.backup.generationFailedManual', 'La generación falló — escribí el mensaje a mano.'));
              }
              return;
            }
            if (alive) throw new Error(t('system.backup.generationTimedOutManual', 'La generación tardó demasiado — escribí el mensaje a mano.'));
          } catch (e) {
            if (alive) state(e.message, 'err');
          } finally {
            genBtn.disabled = false;
          }
        });

        box.querySelector('[data-ref="cancel"]').addEventListener('click', () => m.close());
        box.querySelector('[data-ref="ok"]').addEventListener('click', () => {
          const message = ta.value.trim();
          if (!message) { state(t('system.backup.commitMessageRequired', 'Escribí (o generá) el mensaje del commit.'), 'err'); return; }
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
      setGMsg(t('system.backup.committing', 'Commiteando…'), 'info', { running: true });
      try {
        const res = await fetch(`${API}/commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sel),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('system.backup.commitFailed', 'Falló el commit.'));
        const parts = [t('system.backup.commitHash', 'commit {hash}', { hash: data.committed }), t('system.backup.filesCount', '{count} archivo(s)', { count: data.staged.length })];
        if (data.includedUntracked?.length) parts.push(t('system.backup.newIncludedCount', '{count} nuevo(s) incluidos', { count: data.includedUntracked.length }));
        parts.push(t('system.backup.noPushHint', 'sin push (usá "Push a GitHub" cuando quieras respaldarlo)'));
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
      setBusy(true); pushBtn.disabled = true; setGMsg(t('system.backup.pushing', 'Empujando a GitHub…'), 'info', { running: true });
      try {
        const res = await fetch(`${API}/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ includeUntracked }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('system.backup.pushFailed', 'Falló el push.'));
        const parts = [];
        if (data.committed) parts.push(t('system.backup.commitHash', 'commit {hash}', { hash: data.committed }));
        parts.push(t('system.backup.pushOk', 'push OK'));
        if (data.includedUntracked?.length) parts.push(t('system.backup.newFilesIncludedCount', '{count} archivo(s) nuevos incluidos', { count: data.includedUntracked.length }));
        if (data.untrackedSkipped?.length) parts.push(t('system.backup.untrackedSkippedCount', '{count} sin trackear omitidos', { count: data.untrackedSkipped.length }));
        if (data.changelogUpdated) parts.push(t('system.backup.changelogUpdated', 'changelog actualizado'));
        if (data.description?.ok) parts.push(t('system.backup.githubDescriptionUpdated', 'descripción de GitHub actualizada'));
        else if (data.description?.skipped) parts.push(t('system.backup.githubDescriptionSkipped', 'descripción sin actualizar ({reason})', { reason: data.description.skipped }));
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
        title: t('system.backup.pullDialogTitle', 'Pull desde GitHub (restaurar código)'),
        message: t('system.backup.pullDialogMessage', 'Se trae el código desde el remote personal:\n{url}\n\nSolo avanza en línea recta (fast-forward): si tu historial local divergió, NO se fuerza nada. Los cambios locales sin commitear quedan a salvo en un stash que se reaplica. Si hay actualización, el servidor se reinicia solo (la página se recarga).', { url: info.remote.url }),
        confirmLabel: t('system.backup.pull', 'Pull'),
      });
      if (!ok) return;
      setBusy(true); pullBtn.disabled = true; pushBtn.disabled = true;
      setGMsg(t('system.backup.pulling', 'Trayendo el código desde GitHub…'), 'info', { running: true });
      try {
        const res = await fetch(`${API}/pull`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('system.backup.pullFailed', 'Falló el pull.'));
        if (data.upToDate) {
          setGMsg(data.ahead
            ? t('system.backup.localAhead', 'Nada que traer: tu copia local va {count} commit(s) ADELANTE de GitHub ({head}) — hacé push.', { count: data.ahead, head: data.head })
            : t('system.backup.upToDate', 'Ya estás al día con GitHub ({head}).', { head: data.head }), 'ok');
          setBusy(false);
          return;
        }
        const parts = [t('system.backup.updatedRange', 'actualizado {from} → {to}', { from: data.from, to: data.to }), t('system.backup.filesCount', '{count} archivo(s)', { count: data.files })];
        if (data.stashed) parts.push(data.popConflict ? t('system.backup.stashConflict', 'CONFLICTO al reaplicar tus cambios (quedaron en el stash)') : t('system.backup.localChangesReapplied', 'cambios locales reaplicados'));
        if (data.npmRan) parts.push(data.npmOk ? t('system.backup.dependenciesInstalled', 'dependencias instaladas') : t('system.backup.npmInstallFailed', 'npm install FALLÓ'));
        if (data.restarting) {
          setGMsg(`${parts.join(' · ')} · ${t('system.backup.restarting', 'reiniciando…')}`, 'ok', { running: true });
          await waitForServer();
          location.reload();
          return;
        }
        // Árbol con conflicto o npm roto: NO se reinició — requiere mano.
        setGMsg(`${parts.join(' · ')} · ${t('system.backup.serverNotRestarted', 'el servidor NO se reinició: revisá el árbol (conflicto/deps) y reiniciá a mano.')}`, 'err');
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
  function srvmsg(text, kind = 'info', { running = false } = {}) {
    if (running) refs.srvmsg.innerHTML = `${pacman()} ${text}`;
    else refs.srvmsg.textContent = text;
    refs.srvmsg.className = `bk-msg ${kind}`;
    refs.srvmsg.hidden = !text;
  }

  async function recycle() {
    if (busy) return;
    const ok = await dialog.confirmDialog({
      title: t('system.backup.restartSessionsTitle', 'Reiniciar sesiones'),
      message: t('system.backup.restartSessionsMessage', '¿Reiniciar todas las sesiones? Se reabren solas con el historial intacto. Los motores vuelven a leer las credenciales del disco (arregla el MCP que no carga tras una credencial vieja).'),
      confirmLabel: t('system.backup.restartConfirm', 'Reiniciar'),
    });
    if (!ok) return;
    setBusy(true);
    refs.recycle.disabled = true;
    rmsg(t('system.backup.restartingSessions', 'Reiniciando sesiones…'), 'info', { running: true });
    try {
      const res = await fetch('/api/admin/restart-runners', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('system.backup.restartSessionsFailed', 'Falló el reinicio de sesiones.'));
      rmsg(data.killed
        ? t('system.backup.sessionsRestarted', '{count} sesión(es) reiniciada(s) — se reabren solas al interactuar.', { count: data.killed })
        : t('system.backup.noLiveSessions', 'No había sesiones vivas para reiniciar.'), 'ok');
    } catch (e) {
      rmsg(e.message, 'err');
    } finally {
      setBusy(false);
      refs.recycle.disabled = false;
    }
  }

  // Reinicia el PROCESO del server (systemctl --user restart). Distinto de
  // "Reiniciar sesiones": acá muere el Node de la consola, no los motores de
  // chat. Las tmux y los runners SOBREVIVEN (la unidad usa KillMode=process),
  // así que el trabajo en curso no se pierde: solo se corta la web unos
  // segundos. Hace falta cuando el server tiene que tomar código nuevo.
  // El endpoint responde ANTES de morir, así que tras el POST hay que
  // ESPERAR a que vuelva a atender: encuestamos un endpoint barato hasta que
  // conteste (el fetch falla mientras el proceso está caído — es lo esperado).
  async function restartServer() {
    if (busy) return;
    const ok = await dialog.confirmDialog({
      title: t('system.backup.restartServerTitle', 'Reiniciar el servidor'),
      message: t('system.backup.restartServerMessage', '¿Reiniciar el proceso del servidor? La web se corta unos segundos y vuelve sola. Las terminales y los motores de chat NO se tocan: el trabajo en curso sobrevive.'),
      confirmLabel: t('system.backup.restartConfirm', 'Reiniciar'),
    });
    if (!ok) return;
    setBusy(true);
    refs.restart.disabled = true;
    srvmsg(t('system.backup.restartingServer', 'Reiniciando el servidor…'), 'info', { running: true });
    try {
      const res = await fetch('/api/updates/restart', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error === 'admin'
          ? t('system.backup.restartServerAdmin', 'Solo un admin puede reiniciar el servidor.')
          : (data.error || t('system.backup.restartServerFailed', 'No se pudo reiniciar el servidor.')));
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
      let volvio = false;
      for (let i = 0; i < 40; i++) {
        srvmsg(t('system.backup.waitingServer', 'Esperando que el servidor vuelva…'), 'info', { running: true });
        try {
          const p = await fetch('/api/chat/list', { cache: 'no-store' });
          if (p.ok) {
            volvio = true;
            break;
          }
        } catch { /* el server está caído: es lo esperado */ }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      if (volvio) {
        srvmsg(t('system.backup.serverBack', 'Servidor reiniciado ✓ — la web ya está al día.'), 'ok');
      } else {
        srvmsg(t('system.backup.serverNotBack', 'El servidor no respondió a tiempo. Revisá journalctl --user -u claude-web-console.'), 'err');
      }
    } catch (e) {
      srvmsg(e.message, 'err');
    } finally {
      setBusy(false);
      refs.restart.disabled = false;
    }
  }

  refs.create.addEventListener('click', create);
  refs.recycle.addEventListener('click', recycle);
  refs.restart.addEventListener('click', restartServer);
  loadList();
  loadGit();
}
