// modules/system/users.js — panel de usuarios (pestaña del menú Sistema).
//
// Misma lógica CRUD contra /api/admin/*, con diálogos propios. Lo usa tanto
// la pestaña "Usuarios" del modal Sistema como la página /admin (admin.js).
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { alertDialog, confirmDialog, promptDialog } from '../../ui/dialog.js';
import { t } from '../../ui/i18n.js';

const API = '/api/admin';

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Error ${res.status}`);
  }
  return res.json();
}

export function mountUsersPanel(el) {
  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">${t('system.help.users.title', 'Usuarios')}</span>
      ${helpBtn('sys-users')}
    </div>
    <form class="users-new" data-ref="form">
      <input data-ref="user" placeholder="${t('system.users.usernamePlaceholder', 'Usuario')}" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <input data-ref="pass" type="password" placeholder="${t('system.users.passwordPlaceholder', 'Contraseña')}" />
      <label class="users-chk"><input data-ref="admin" type="checkbox" /> ${t('system.users.adminLabel', 'admin')}</label>
      <button type="submit" class="btn btn--sm">${t('system.users.create', 'Crear')}</button>
    </form>
    <p class="bk-msg" data-ref="msg" hidden></p>
    <div class="users-list" data-ref="list"></div>
    <div class="users-invites" style="margin-top:1rem;border-top:1px solid var(--cwc-border);padding-top:.75rem">
      <h4 style="margin:0 0 .35rem;font-size:var(--cwc-fs-sm);color:var(--cwc-text)">🎫 ${t('system.users.accessInvitesTitle', 'Invitaciones de acceso')}</h4>
      <p style="margin:0 0 .5rem;font-size:var(--cwc-fs-xs);color:var(--cwc-text-dim)">${t('system.users.accessInvitesHintBeforePath', 'Generá un token de un solo uso. La persona lo usa en')} <code>/onboard</code> ${t('system.users.accessInvitesHintAfterPath', 'para crear su cuenta y conectar su propia cuenta de Claude. Vence en 24 h.')}</p>
      <form class="users-new" data-ref="invform">
        <label class="users-chk"><input data-ref="invadmin" type="checkbox" /> ${t('system.users.adminLabel', 'admin')}</label>
        <button type="submit" class="btn btn--sm">${t('system.users.generateInvite', 'Generar invitación')}</button>
      </form>
      <div data-ref="invtoken" hidden style="margin:.5rem 0;padding:.5rem .6rem;border:1px solid var(--cwc-accent);border-radius:6px;background:var(--cwc-bg-elevated)"></div>
      <div class="users-list" data-ref="invlist"></div>
    </div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

  let host = null;
  const hostReady = fetch('/api/whoami', { cache: 'no-store' })
    .then((res) => res.ok ? res.json() : null)
    .then((me) => { host = me?.host || null; })
    .catch(() => {});

  async function onboardApi(path, opts) {
    const res = await fetch('/api/onboard' + path, opts);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `Error ${res.status}`);
    }
    return res.json();
  }

  function msg(text, ok = false) {
    refs.msg.textContent = text;
    refs.msg.hidden = !text;
    refs.msg.className = `bk-msg ${ok ? 'ok' : 'err'}`;
  }

  async function load() {
    try {
      const { users } = await api('/users');
      await hostReady;
      render(users);
    } catch (e) {
      msg(e.message);
    }
  }

  function render(users) {
    refs.list.innerHTML = '';
    if (!users.length) {
      refs.list.innerHTML = `<p class="bk-empty">${t('system.users.emptyUsers', 'No hay usuarios todavía. Creá el primero arriba.')}</p>`;
      return;
    }
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'users-row';

      const name = document.createElement('span');
      name.className = 'users-name';
      name.innerHTML = u.username + (u.admin ? ` <span class="users-badge">${t('system.users.adminLabel', 'admin')}</span>` : '');

      const actions = document.createElement('div');
      actions.className = 'users-actions';

      const adm = document.createElement('button');
      adm.className = 'btn-ghost btn--sm';
      adm.textContent = u.admin ? t('system.users.removeAdmin', 'quitar admin') : t('system.users.makeAdmin', 'hacer admin');
      adm.addEventListener('click', () => update(u.username, { admin: !u.admin }));

      const pw = document.createElement('button');
      pw.className = 'btn-ghost btn--sm';
      pw.textContent = t('system.users.passwordAction', 'contraseña');
      pw.addEventListener('click', async () => {
        const p = await promptDialog({ title: t('system.users.passwordDialogTitle', 'Contraseña de {username}', { username: u.username }), placeholder: t('system.users.newPasswordPlaceholder', 'Nueva contraseña') });
        if (p) update(u.username, { password: p });
      });

      actions.append(adm, pw);

      // El usuario host no se da de baja desde esta UI.
      if (!host || u.username !== host) {
        const del = document.createElement('button');
        del.className = 'btn-ghost btn--sm btn--icon btn--danger';
        del.innerHTML = icon('trash', { size: 13 });
        del.title = t('system.users.deleteUserTitle', 'Eliminar usuario');
        del.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: t('system.users.deleteUserTitle', 'Eliminar usuario'),
            message: t(
              'system.users.deleteUserMessage',
              'Se elimina la cuenta "{username}" y se cierran sus sesiones.\n\n' +
                'Su espacio de trabajo (workspace, clon del repo, chats y credenciales) se mueve a la papelera y se puede recuperar durante 30 días.\n\n' +
                'Su workspace de Pad "tenant-{username}" se borra. El Pad lo conserva como borrado y se puede restaurar desde ahí.\n\n' +
                '⚠️ Sus credenciales quedan dentro de la papelera durante esos 30 días.',
              { username: u.username },
            ),
            confirmLabel: t('system.users.deleteConfirm', 'Eliminar'),
            danger: true,
          });
          if (ok) remove(u.username);
        });
        actions.append(del);
      }

      row.append(name, actions);
      refs.list.append(row);
    }
  }

  function showInviteToken(invite) {
    const box = refs.invtoken;
    box.hidden = false;
    box.textContent = '';
    const url = location.origin + '/onboard';
    const p1 = document.createElement('p');
    p1.style.cssText = 'margin:0 0 .35rem;font-size:var(--cwc-fs-xs);color:var(--cwc-text-dim)';
    p1.textContent = invite.admin ? t('system.users.adminInviteShare', 'Invitación de ADMIN — pasale a la persona:') : t('system.users.inviteShare', 'Pasale a la persona:');
    const pre = document.createElement('div');
    pre.style.cssText = 'font-family:var(--cwc-font-mono,monospace);font-size:var(--cwc-fs-xs);word-break:break-all;color:var(--cwc-text);white-space:pre-wrap';
    const message = t('system.users.inviteMessage', 'Entrá a {url} y usá este token de invitación:\n{token}', { url, token: invite.token });
    pre.textContent = message;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn--sm';
    copy.style.marginTop = '.4rem';
    copy.textContent = t('system.users.copyInvite', 'Copiar invitación');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(message);
        copy.textContent = `✓ ${t('system.users.copied', 'Copiado')}`;
        setTimeout(() => { copy.textContent = t('system.users.copyInvite', 'Copiar invitación'); }, 1500);
      } catch {
        copy.textContent = t('system.users.copyManually', 'copiá a mano ↑');
      }
    });
    box.append(p1, pre, copy);
  }

  async function loadInvites() {
    try {
      const { invites } = await onboardApi('/admin/invites', {});
      renderInvites(invites || []);
    } catch (e) {
      /* Intento suave: no romper el panel de usuarios. */
    }
  }

  function fmtWhen(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderInvites(invites) {
    refs.invlist.innerHTML = '';
    const pend = invites.filter((i) => i.status === 'pending' || i.status === 'locked');
    if (!pend.length) {
      refs.invlist.innerHTML = `<p class="bk-empty" style="font-size:var(--cwc-fs-xs)">${t('system.users.noPendingInvites', 'Sin invitaciones pendientes.')}</p>`;
      return;
    }
    for (const inv of pend) {
      const row = document.createElement('div');
      row.className = 'users-row';
      const name = document.createElement('span');
      name.className = 'users-name';
      const label = document.createElement('span');
      label.textContent = (inv.status === 'locked' ? t('system.users.inviteInUse', 'en uso · {lockedTo}', { lockedTo: inv.lockedTo || '' }) : t('system.users.invitePending', 'pendiente')) + (inv.admin ? '  ' : '');
      name.appendChild(label);
      if (inv.admin) {
        const b = document.createElement('span');
        b.className = 'users-badge';
        b.textContent = t('system.users.adminLabel', 'admin');
        name.appendChild(b);
      }
      const meta = document.createElement('span');
      meta.style.cssText = 'font-size:var(--cwc-fs-xs);color:var(--cwc-text-dim);margin-left:.4rem';
      meta.textContent = t('system.users.expiresAt', 'vence {when}', { when: fmtWhen(inv.expiresAt) });
      name.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'users-actions';
      const rev = document.createElement('button');
      rev.className = 'btn-ghost btn--sm btn--danger';
      rev.textContent = t('system.users.revoke', 'revocar');
      rev.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: t('system.users.revokeInviteTitle', 'Revocar invitación'),
          message: t('system.users.revokeInviteMessage', 'El token dejará de servir.'),
          confirmLabel: t('system.users.revokeConfirm', 'Revocar'),
          danger: true,
        });
        if (!ok) return;
        try {
          await revokeInvite(inv.id);
        } catch (e) {
          msg(e.message);
        }
      });
      actions.appendChild(rev);
      row.append(name, actions);
      refs.invlist.append(row);
    }
  }

  async function revokeInvite(id) {
    await onboardApi('/admin/invite/' + encodeURIComponent(id) + '/revoke', { method: 'POST' });
    loadInvites();
  }

  async function update(username, body) {
    try {
      await api('/users/' + encodeURIComponent(username), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      msg(t('system.users.userUpdated', 'Usuario actualizado.'), true);
      load();
    } catch (e) { msg(e.message); }
  }

  async function remove(username) {
    try {
      const result = await api('/users/' + encodeURIComponent(username), { method: 'DELETE' });
      const cleanup = result?.cleanup ?? {};
      const lines = [t('system.users.cleanupLead', 'La cuenta se eliminó. Sobre la limpieza:')];
      let title = t('system.users.userDeleted', 'Usuario eliminado.');

      if (cleanup?.ok === false) {
        title = t('system.users.cleanupFailedTitle', 'Cuenta eliminada; limpieza fallida');
        lines.push(t(
          'system.users.cleanupFailed',
          '❌ Error de limpieza: {error}',
          { error: cleanup?.error ?? t('system.users.cleanupUnknownError', 'Error sin detalle.') },
        ));
      } else {
        const trashStatus = cleanup?.trash?.status ?? '';
        if (trashStatus === 'moved') {
          lines.push(t('system.users.cleanupTrashMoved', 'Espacio movido a la papelera (recuperable 30 días)'));
        } else if (trashStatus === 'absent') {
          lines.push(t('system.users.cleanupTrashAbsent', 'No tenía espacio en disco'));
        }

        const padStatus = cleanup?.pad?.status ?? '';
        const padSlug = cleanup?.pad?.slug ?? `tenant-${username}`;
        if (padStatus === 'deleted') {
          lines.push(t('system.users.cleanupPadDeleted', 'Workspace de Pad {slug} eliminado', { slug: padSlug }));
        } else if (padStatus === 'not-found') {
          lines.push(t('system.users.cleanupPadAbsent', 'No tenía workspace de Pad'));
        } else if (padStatus === 'no-token') {
          lines.push(t('system.users.cleanupPadNoToken', '⚠️ Sin credencial de Pad: su workspace {slug} sigue existiendo', { slug: padSlug }));
        } else if (padStatus === 'failed') {
          lines.push(t(
            'system.users.cleanupPadFailed',
            '⚠️ No se pudo borrar su workspace de Pad: {error}',
            { error: cleanup?.pad?.error ?? t('system.users.cleanupUnknownError', 'Error sin detalle.') },
          ));
        }

        const removedJobs = Array.isArray(cleanup?.jobs?.removed) ? cleanup.jobs.removed : [];
        if (removedJobs.length) {
          lines.push(t(
            'system.users.cleanupJobsRemoved',
            '{count} archivo(s) de trabajos eliminado(s)',
            { count: removedJobs.length },
          ));
        }

        const revokedInvites = Number.isFinite(cleanup?.invites?.revoked) ? cleanup.invites.revoked : 0;
        if (revokedInvites) {
          lines.push(t(
            'system.users.cleanupInvitesRevoked',
            '{count} invitación(es) revocada(s)',
            { count: revokedInvites },
          ));
        }

        const warnings = Array.isArray(cleanup?.warnings) ? cleanup.warnings : [];
        for (const warning of warnings) {
          lines.push(`⚠️ ${warning}`);
        }

        if (lines.length === 1) {
          lines.push(t('system.users.cleanupNoReport', '⚠️ El servidor no devolvió detalles de la limpieza.'));
        }
      }

      msg(t('system.users.userDeleted', 'Usuario eliminado.'), true);
      await load();
      await alertDialog({ title, message: lines.join('\n') });
    } catch (e) { msg(e.message); }
  }

  refs.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = refs.user.value.trim();
    const password = refs.pass.value;
    const admin = refs.admin.checked;
    if (!username || !password) return;
    try {
      await api('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, admin }),
      });
      msg(t('system.users.userCreated', 'Usuario creado.'), true);
      refs.form.reset();
      load();
    } catch (err) {
      msg(err.message);
    }
  });

  refs.invform.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { invite } = await onboardApi('/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin: refs.invadmin.checked }),
      });
      showInviteToken(invite);
      refs.invadmin.checked = false;
      loadInvites();
    } catch (err) {
      msg(err.message);
    }
  });

  load();
  loadInvites();
}
