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
    <div class="users-list" data-ref="list"></div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

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

  load();
}
