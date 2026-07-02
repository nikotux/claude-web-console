// admin.js — UI de administración de usuarios (consume /api/admin/*).
import { hydrateIcons } from './ui/icons.js';
hydrateIcons();

const listEl = document.getElementById('user-list');
const msgEl = document.getElementById('admin-msg');

function msg(text, ok = false) {
  msgEl.textContent = text;
  msgEl.hidden = false;
  msgEl.className = 'admin-msg ' + (ok ? 'ok' : 'err');
}

async function api(path, opts) {
  const res = await fetch('/api/admin' + path, opts);
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Error ${res.status}`);
  }
  return res.json();
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
  listEl.innerHTML = '';
  if (!users.length) {
    listEl.innerHTML = '<p class="admin-empty">No hay usuarios todavía. Creá el primero arriba.</p>';
    return;
  }
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'admin-row';

    const name = document.createElement('span');
    name.className = 'admin-uname';
    name.innerHTML = u.username + (u.admin ? ' <span class="admin-badge">admin</span>' : '');

    const actions = document.createElement('div');
    actions.className = 'admin-actions';

    const adm = document.createElement('button');
    adm.textContent = u.admin ? 'quitar admin' : 'hacer admin';
    adm.onclick = () => update(u.username, { admin: !u.admin });

    const pw = document.createElement('button');
    pw.textContent = 'contraseña';
    pw.onclick = () => {
      const p = prompt(`Nueva contraseña para ${u.username}:`);
      if (p) update(u.username, { password: p });
    };

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'eliminar';
    del.onclick = () => {
      if (confirm(`¿Eliminar al usuario ${u.username}?`)) remove(u.username);
    };

    actions.append(adm, pw, del);
    row.append(name, actions);
    listEl.append(row);
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
  } catch (e) {
    msg(e.message);
  }
}

async function remove(username) {
  try {
    await api('/users/' + encodeURIComponent(username), { method: 'DELETE' });
    msg('Usuario eliminado.', true);
    load();
  } catch (e) {
    msg(e.message);
  }
}

document.getElementById('new-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('nu-user').value.trim();
  const password = document.getElementById('nu-pass').value;
  const admin = document.getElementById('nu-admin').checked;
  if (!username || !password) return;
  try {
    await api('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, admin }),
    });
    msg('Usuario creado.', true);
    e.target.reset();
    load();
  } catch (err) {
    msg(err.message);
  }
});

load();
