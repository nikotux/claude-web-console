// modules/system/system.js — menú "Sistema": todo lo administrativo, ahora
// organizado en GRUPOS con submenú (master-detail), no una fila plana de tabs.
//
// Botón ⚙ en el pie → modal con:
//   ⚙️ Configuración   → Novedades · Mi configuración · Patrocinio · Conexiones (MCP) · Skills · Idioma · Variables de entorno · Proyectos
//   🩺 Diagnóstico     → Salud · Dashboard · Actualizaciones · UniFi · Interfono
//   🛠️ Administración  → Backup · Usuarios          (solo admins)
// No-admin usuario: Novedades · Mi configuración · Patrocinio · Conexiones ·
// Skills · Idioma · Proyectos · Interfono.
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
import { mountMyConfigPanel } from './my-config-panel.js';
import { mountSponsorshipPanel } from './sponsorship-panel.js';
import { mountNewsPanel } from './news-panel.js';
import { t } from '../../ui/i18n.js';
import { isSponsored, HIDDEN_SYSTEM_PANELS_FOR_SPONSORED } from '../../ui/profile.js';

export default {
  name: 'system',

  mount(el, ctx) {
    const { icon, dialog, whoami } = ctx;
    el.innerHTML = `
      <button class="btn-ghost btn--sm btn--icon news-launcher" title="${t('system.menu.title', 'Sistema')}">
        ${icon('gear', { size: 15 })}
        <span class="news-badge-dot" aria-hidden="true" hidden></span>
      </button>`;

    const launcher = el.querySelector('button');
    const dot = el.querySelector('.news-badge-dot');
    const railCounters = new Set();
    let newsUnread = 0;
    let badgeVersion = 0;

    function paintNewsBadge() {
      dot.hidden = newsUnread <= 0;
      for (const counter of railCounters) {
        if (!counter.isConnected) {
          railCounters.delete(counter);
          continue;
        }
        counter.hidden = newsUnread <= 0;
        counter.textContent = String(newsUnread);
      }
    }

    function setNewsUnread(value) {
      newsUnread = Math.max(0, Number(value) || 0);
      paintNewsBadge();
    }

    function clearNewsBadge() {
      badgeVersion += 1;
      setNewsUnread(0);
    }

    // El badge es best-effort: una falla nunca demora ni rompe el pie.
    async function loadNewsBadge() {
      const version = badgeVersion;
      try {
        const res = await fetch('/api/news');
        const data = await res.json().catch(() => ({}));
        if (res.ok && version === badgeVersion) setNewsUnread(data.unread);
      } catch {
        // Sin conexión, el botón Sistema funciona igual y queda sin marca.
      }
    }

    ctx.bus?.addEventListener?.('cwc:news-seen', clearNewsBadge);
    window.addEventListener('cwc:news-seen', clearNewsBadge);
    loadNewsBadge();

    launcher.addEventListener('click', async () => {
      const me = await whoami;
      const isAdmin = !!me?.admin;
      const sponsoredProfile = isSponsored(me);
      let railCounter = null;
      const m = dialog.openModal({
        title: t('system.menu.title', 'Sistema'),
        width: 880,
        onClose: () => {
          if (railCounter) railCounters.delete(railCounter);
        },
      });

      // Grupos → items. Diagnóstico del server + config de instancia y
      // Administración son admin-only; lo per-usuario queda visible para todos.
      const groups = [
        {
          label: `⚙️ ${t('system.menu.groupConfig', 'Configuración')}`,
          items: [
            { emoji: '🆕', label: t('system.menu.news', 'Novedades'), news: true, mount: (c) => mountNewsPanel(c, { ...ctx, isAdmin }) },
            ...(me?.type === 'user'
              ? [
                  { emoji: '✅', label: t('system.menu.myConfig', 'Mi configuración'), mount: (c) => mountMyConfigPanel(c, { ...ctx, me }) },
                  { emoji: '🤝', label: t('system.menu.sponsorship', 'Patrocinio'), mount: (c) => mountSponsorshipPanel(c, { ...ctx, me }) },
                ]
              : []),
            { emoji: '🔌', label: t('system.menu.connections', 'Conexiones'), mount: (c) => mountMcpsPanel(c, { ...ctx, isAdmin }) },
            { id: 'skills', emoji: '🧩', label: t('system.menu.skills', 'Skills'), mount: (c) => mountSkillsPanel(c, { ...ctx, isAdmin }) },
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
            { id: 'interfono', emoji: '📡', label: t('system.menu.interfono', 'Interfono'), mount: (c) => mountInterfonoPanel(c, { ...ctx, isAdmin }) },
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
      ]
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => (
            !sponsoredProfile || !HIDDEN_SYSTEM_PANELS_FOR_SPONSORED.has(item.id)
          )),
        }))
        .filter((group) => group.items.length);

      // Aplanamos a una lista con índice global para el ruteo.
      const flat = [];
      groups.forEach((g, gi) => g.items.forEach((it) => flat.push({ ...it, gi })));

      const railHtml = groups.map((g, gi) => `
        <div class="sys-group">
          <div class="sys-group-h">${g.label}</div>
          ${g.items.map((it) => {
            const i = flat.findIndex((f) => f.gi === gi && f.label === it.label);
            const count = it.news
              ? `<span class="news-count" data-ref="news-count"${newsUnread > 0 ? '' : ' hidden'}>${newsUnread}</span>`
              : '';
            return `<button class="sys-item" data-i="${i}"><span class="sys-item-ic">${it.emoji}</span><span class="sys-item-lb">${it.label}</span>${count}</button>`;
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

      // El modal de Sistema es el ÚNICO que scrollea por columna: el body deja
      // de ser el scroller y cada columna maneja el suyo (ver la regla
      // correspondiente en style.css). Se marca por clase para no tocar el resto de modales.
      m.body.classList.add('sys-modal-body');

      const shell = m.body.querySelector('.sys-shell');
      const body = m.body.querySelector('[data-ref="body"]');
      const items = Array.from(m.body.querySelectorAll('.sys-item'));
      const isMobile = () => window.matchMedia('(max-width: 719px)').matches;
      railCounter = m.body.querySelector('[data-ref="news-count"]');
      if (railCounter) {
        railCounters.add(railCounter);
        paintNewsBadge();
      }

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
