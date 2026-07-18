// modules/system/users.js — panel de usuarios (pestaña del menú Sistema).
//
// Misma lógica CRUD contra /api/admin/*, con diálogos propios. Lo usa tanto
// la pestaña "Usuarios" del modal Sistema como la página /admin (admin.js).
import { icon } from '../../ui/icons.js';
import { confirmDialog, promptDialog } from '../../ui/dialog.js';

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
    <form class="users-new" data-ref="form">
      <input data-ref="user" placeholder="Usuario" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <input data-ref="pass" type="password" placeholder="Contraseña" />
      <label class="users-chk"><input data-ref="admin" type="checkbox" /> admin</label>
      <button type="submit" class="btn btn--sm">Crear</button>
    </form>
    <p class="bk-msg" data-ref="msg" hidden></p>
    <div class="users-list" data-ref="list"></div>
    <div class="users-invites" style="margin-top:1rem;border-top:1px solid var(--cwc-border);padding-top:.75rem">
      <h4 style="margin:0 0 .35rem;font-size:var(--cwc-fs-sm);color:var(--cwc-text)">🎫 Invitaciones de acceso</h4>
      <p style="margin:0 0 .5rem;font-size:var(--cwc-fs-xs);color:var(--cwc-text-dim)">Generá un token de un solo uso. La persona lo usa en <code>/onboard</code> para crear su cuenta y conectar su propia cuenta de Claude. Vence en 24 h.</p>
      <form class="users-new" data-ref="invform">
        <label class="users-chk"><input data-ref="invadmin" type="checkbox" /> admin</label>
        <button type="submit" class="btn btn--sm">Generar invitación</button>
      </form>
      <div data-ref="invtoken" hidden style="margin:.5rem 0;padding:.5rem .6rem;border:1px solid var(--cwc-accent);border-radius:6px;background:var(--cwc-bg-elevated)"></div>
      <div class="users-list" data-ref="invlist"></div>
    </div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

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
      render(users);
    } catch (e) {
      msg(e.message);
    }
  }

  function render(users) {
    refs.list.innerHTML = '';
    if (!users.length) {
      refs.list.innerHTML = '<p class="bk-empty">No hay usuarios todavía. Creá el primero arriba.</p>';
      return;
    }
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'users-row';

      const name = document.createElement('span');
      name.className = 'users-name';
      name.innerHTML = u.username + (u.admin ? ' <span class="users-badge">admin</span>' : '');

      const actions = document.createElement('div');
      actions.className = 'users-actions';

      const adm = document.createElement('button');
      adm.className = 'btn-ghost btn--sm';
      adm.textContent = u.admin ? 'quitar admin' : 'hacer admin';
      adm.addEventListener('click', () => update(u.username, { admin: !u.admin }));

      const pw = document.createElement('button');
      pw.className = 'btn-ghost btn--sm';
      pw.textContent = 'contraseña';
      pw.addEventListener('click', async () => {
        const p = await promptDialog({ title: `Contraseña de ${u.username}`, placeholder: 'Nueva contraseña' });
        if (p) update(u.username, { password: p });
      });

      const del = document.createElement('button');
      del.className = 'btn-ghost btn--sm btn--icon btn--danger';
      del.innerHTML = icon('trash', { size: 13 });
      del.title = 'Eliminar usuario';
      del.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Eliminar usuario',
          message: `Se elimina la cuenta "${u.username}". Sus sesiones dejarán de valer.`,
          confirmLabel: 'Eliminar',
          danger: true,
        });
        if (ok) remove(u.username);
      });

      actions.append(adm, pw, del);
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
    p1.textContent = invite.admin ? 'Invitación de ADMIN — pasale a la persona:' : 'Pasale a la persona:';
    const pre = document.createElement('div');
    pre.style.cssText = 'font-family:var(--cwc-font-mono,monospace);font-size:var(--cwc-fs-xs);word-break:break-all;color:var(--cwc-text);white-space:pre-wrap';
    const message = `Entrá a ${url} y usá este token de invitación:\n${invite.token}`;
    pre.textContent = message;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn--sm';
    copy.style.marginTop = '.4rem';
    copy.textContent = 'Copiar invitación';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(message);
        copy.textContent = '✓ Copiado';
        setTimeout(() => { copy.textContent = 'Copiar invitación'; }, 1500);
      } catch {
        copy.textContent = 'copiá a mano ↑';
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
      refs.invlist.innerHTML = '<p class="bk-empty" style="font-size:var(--cwc-fs-xs)">Sin invitaciones pendientes.</p>';
      return;
    }
    for (const inv of pend) {
      const row = document.createElement('div');
      row.className = 'users-row';
      const name = document.createElement('span');
      name.className = 'users-name';
      const label = document.createElement('span');
      label.textContent = (inv.status === 'locked' ? `en uso · ${inv.lockedTo || ''}` : 'pendiente') + (inv.admin ? '  ' : '');
      name.appendChild(label);
      if (inv.admin) {
        const b = document.createElement('span');
        b.className = 'users-badge';
        b.textContent = 'admin';
        name.appendChild(b);
      }
      const meta = document.createElement('span');
      meta.style.cssText = 'font-size:var(--cwc-fs-xs);color:var(--cwc-text-dim);margin-left:.4rem';
      meta.textContent = 'vence ' + fmtWhen(inv.expiresAt);
      name.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'users-actions';
      const rev = document.createElement('button');
      rev.className = 'btn-ghost btn--sm btn--danger';
      rev.textContent = 'revocar';
      rev.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Revocar invitación',
          message: 'El token dejará de servir.',
          confirmLabel: 'Revocar',
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
      msg('Usuario actualizado.', true);
      load();
    } catch (e) { msg(e.message); }
  }

  async function remove(username) {
    try {
      await api('/users/' + encodeURIComponent(username), { method: 'DELETE' });
      msg('Usuario eliminado.', true);
      load();
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
      msg('Usuario creado.', true);
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
