// modules/system/system.js — menú "Sistema": todo lo administrativo compacto.
//
// Botón ⚙ en el pie → modal con pestañas: Backup · Usuarios (solo admins) ·
// Proyectos (contexto + memorias de Tolkien Y de esta consola, con selector;
// visible a todos, edición admin) · Salud y Salir siempre al pie. Los
// paneles reutilizan la lógica existente de los módulos backup/admin, solo
// cambia dónde viven.
import { mountBackupPanel } from './backup-panel.js';
import { mountUsersPanel } from './users.js';
import { mountHealthPanel } from './health-panel.js';
import { mountProjectContextPanel } from './project-context-panel.js';

export default {
  name: 'system',

  mount(el, ctx) {
    const { icon, dialog, whoami } = ctx;
    el.innerHTML = `<button class="btn-ghost btn--sm btn--icon" title="Sistema">${icon('gear', { size: 15 })}</button>`;

    el.querySelector('button').addEventListener('click', async () => {
      const me = await whoami;
      const isAdmin = !!me?.admin;
      const m = dialog.openModal({ title: 'Sistema', width: 520 });

      // Salud y Proyectos son para todos (con acciones de edición gateadas
      // adentro por admin); Backup/Usuarios solo admins.
      const tabs = [
        ...(isAdmin
          ? [
              { label: 'Backup', mount: (c) => mountBackupPanel(c, ctx) },
              { label: 'Usuarios', mount: (c) => mountUsersPanel(c, ctx) },
            ]
          : []),
        { label: 'Proyectos', mount: (c) => mountProjectContextPanel(c, { ...ctx, isAdmin }) },
        { label: 'Salud', mount: (c) => mountHealthPanel(c, { ...ctx, isAdmin }) },
      ];

      m.body.innerHTML = `
        <div class="sys-tabs" data-ref="tabs"></div>
        <div class="sys-body" data-ref="body"></div>
        <div class="sys-foot">
          <span class="sys-user">${me?.type === 'user' ? me.username : me?.type === 'token' ? '(token maestro)' : ''}</span>
          <button class="btn-ghost btn--sm btn--danger" data-ref="logout">${icon('logout', { size: 14 })}<span>Salir</span></button>
        </div>`;

      const body = m.body.querySelector('[data-ref="body"]');
      const tabsEl = m.body.querySelector('[data-ref="tabs"]');

      function select(i) {
        Array.from(tabsEl.children).forEach((b, j) => b.classList.toggle('active', j === i));
        body.innerHTML = '';
        tabs[i].mount(body);
      }
      if (tabs.length) {
        tabs.forEach((t, i) => {
          const b = document.createElement('button');
          b.className = 'btn-ghost btn--sm sys-tab';
          b.textContent = t.label;
          b.addEventListener('click', () => select(i));
          tabsEl.appendChild(b);
        });
        select(0);
      }

      m.body.querySelector('[data-ref="logout"]').addEventListener('click', async () => {
        try { await fetch('/logout', { method: 'POST' }); } catch { /* noop */ }
        window.location.href = '/login';
      });
    });
  },
};
