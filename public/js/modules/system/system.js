// modules/system/system.js — menú "Sistema": todo lo administrativo, ahora
// organizado en GRUPOS con submenú (master-detail), no una fila plana de tabs.
//
// Botón ⚙ en el pie → modal con:
//   ⚙️ Configuración   → Conexiones (MCP) · Skills · Idioma · Variables de entorno · Proyectos
//   🩺 Diagnóstico     → Salud · Dashboard · Actualizaciones · UniFi · Interfono
//   🛠️ Administración  → Backup · Usuarios          (solo admins)
// No-admin: Conexiones · Skills · Idioma · Proyectos · Interfono.
//
// Desktop (≥720px): rail de grupos+items a la izquierda + panel a la derecha
// (master-detail). Móvil (<720px): drill-down — se ve el índice, tocás un ítem
// y el panel ocupa todo con "‹ Sistema" para volver. Los paneles reutilizan la
// lógica de los módulos backup/admin/health/etc.; solo cambia dónde viven.
import { mountBackupPanel } from './backup-panel.js';
import { mountUsersPanel } from './users.js';
import { mountHealthPanel } from './health-panel.js';
import { mountDashboardPanel } from './dashboard-panel.js';
import { mountUnifiPanel } from './unifi-panel.js';
import { mountProjectContextPanel } from './project-context-panel.js';
import { mountInterfonoPanel } from './interfono-panel.js';
import { mountEnvVarsPanel } from './env-vars-panel.js';
import { mountSkillsPanel } from './skills-panel.js';
import { mountMcpsPanel } from './mcps-panel.js';
import { mountUpdatesPanel } from './updates-panel.js';
import { mountLanguagePanel } from './language-panel.js';
import { t } from '../../ui/i18n.js';

export default {
  name: 'system',

  mount(el, ctx) {
    const { icon, dialog, whoami } = ctx;
    el.innerHTML = `<button class="btn-ghost btn--sm btn--icon" title="${t('system.menu.title', 'Sistema')}">${icon('gear', { size: 15 })}</button>`;

    el.querySelector('button').addEventListener('click', async () => {
      const me = await whoami;
      const isAdmin = !!me?.admin;
      const m = dialog.openModal({ title: t('system.menu.title', 'Sistema'), width: 880 });

      // Grupos → items. Diagnóstico del server + config de instancia y
      // Administración son admin-only; lo per-usuario queda visible para todos.
      const groups = [
        {
          label: `⚙️ ${t('system.menu.groupConfig', 'Configuración')}`,
          items: [
            { emoji: '🔌', label: t('system.menu.connections', 'Conexiones'), mount: (c) => mountMcpsPanel(c, { ...ctx, isAdmin }) },
            { emoji: '🧩', label: t('system.menu.skills', 'Skills'), mount: (c) => mountSkillsPanel(c, { ...ctx, isAdmin }) },
            { emoji: '🌐', label: t('system.menu.language', 'Idioma'), mount: (c) => mountLanguagePanel(c, ctx) },
            ...(isAdmin
              ? [{ emoji: '🪪', label: t('system.menu.envVars', 'Variables de entorno'), mount: (c) => mountEnvVarsPanel(c, { ...ctx, isAdmin }) }]
              : []),
            { emoji: '📁', label: t('system.menu.projects', 'Proyectos'), mount: (c) => mountProjectContextPanel(c, { ...ctx, isAdmin }) },
          ],
        },
        {
          label: `🩺 ${t('system.menu.groupDiagnostics', 'Diagnóstico')}`,
          items: [
            ...(isAdmin
              ? [
                  { emoji: '❤️', label: t('system.menu.health', 'Salud'), mount: (c) => mountHealthPanel(c, { ...ctx, isAdmin }) },
                  { emoji: '📊', label: t('system.menu.dashboard', 'Dashboard'), mount: (c) => mountDashboardPanel(c, { ...ctx, isAdmin }) },
                  { emoji: '🔄', label: t('system.menu.updates', 'Actualizaciones'), mount: (c) => mountUpdatesPanel(c, { ...ctx, isAdmin }) },
                  { emoji: '🛰️', label: t('system.menu.unifi', 'UniFi'), mount: (c) => mountUnifiPanel(c, { ...ctx, isAdmin }) },
                ]
              : []),
            { emoji: '📡', label: t('system.menu.interfono', 'Interfono'), mount: (c) => mountInterfonoPanel(c, { ...ctx, isAdmin }) },
          ],
        },
        ...(isAdmin
          ? [{
              label: `🛠️ ${t('system.menu.groupAdmin', 'Administración')}`,
              items: [
                { emoji: '💾', label: t('system.menu.backup', 'Backup'), mount: (c) => mountBackupPanel(c, ctx) },
                { emoji: '👥', label: t('system.menu.users', 'Usuarios'), mount: (c) => mountUsersPanel(c, ctx) },
              ],
            }]
          : []),
      ].filter((g) => g.items.length);

      // Aplanamos a una lista con índice global para el ruteo.
      const flat = [];
      groups.forEach((g, gi) => g.items.forEach((it) => flat.push({ ...it, gi })));

      const railHtml = groups.map((g, gi) => `
        <div class="sys-group">
          <div class="sys-group-h">${g.label}</div>
          ${g.items.map((it) => {
            const i = flat.findIndex((f) => f.gi === gi && f.label === it.label);
            return `<button class="sys-item" data-i="${i}"><span class="sys-item-ic">${it.emoji}</span><span class="sys-item-lb">${it.label}</span></button>`;
          }).join('')}
        </div>`).join('');

      m.body.innerHTML = `
        <div class="sys-shell" data-view="index">
          <nav class="sys-rail">${railHtml}</nav>
          <section class="sys-panel">
            <button class="sys-back" data-ref="back">${icon('chevronLeft', { size: 14 })}<span>${t('system.menu.title', 'Sistema')}</span></button>
            <div class="sys-panel-body" data-ref="body"></div>
          </section>
        </div>
        <div class="sys-foot">
          <span class="sys-user">${me?.type === 'user' ? me.username : me?.type === 'token' ? t('system.menu.masterToken', '(token maestro)') : ''}</span>
          <button class="btn-ghost btn--sm btn--danger" data-ref="logout">${icon('logout', { size: 14 })}<span>${t('system.menu.logout', 'Salir')}</span></button>
        </div>`;

      const shell = m.body.querySelector('.sys-shell');
      const body = m.body.querySelector('[data-ref="body"]');
      const items = Array.from(m.body.querySelectorAll('.sys-item'));
      const isMobile = () => window.matchMedia('(max-width: 719px)').matches;

      function select(i) {
        items.forEach((b) => b.classList.toggle('active', Number(b.dataset.i) === i));
        body.innerHTML = '';
        flat[i].mount(body);
        if (isMobile()) shell.dataset.view = 'content'; // drill-down: mostrar el panel
      }

      items.forEach((b) => b.addEventListener('click', () => select(Number(b.dataset.i))));
      m.body.querySelector('[data-ref="back"]').addEventListener('click', () => { shell.dataset.view = 'index'; });

      // Desktop arranca con el primer ítem abierto; móvil arranca en el índice.
      if (!isMobile() && flat.length) select(0);

      m.body.querySelector('[data-ref="logout"]').addEventListener('click', async () => {
        try { await fetch('/logout', { method: 'POST' }); } catch { /* noop */ }
        window.location.href = '/login';
      });
    });
  },
};
