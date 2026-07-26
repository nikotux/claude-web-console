// modules/launcher/launcher.js — "Nueva sesión": LA acción prominente de la app.
//
// Modal lanzador completo: tipo (Chat/Claude TUI/Terminal), modelo cuando
// corresponde y destino con atajos fijos (Tolkien/Mi Consola — los lugares
// con identidad salen de ui/places.js: nombre + ícono + diferenciador) más un
// navegador de carpetas con breadcrumb (GET /api/files/list, solo directorios).
// [Iniciar] crea y enfoca la sesión.
import { placeFor } from '../../ui/places.js';
import { CHAT_MODEL_OPTIONS } from '../../ui/models.js';
import { pacman } from '../../ui/pacman.js';
import { t } from '../../ui/i18n.js';
import { helpBtn } from '../../ui/help.js';

// "Mi Consola" (este proyecto): atajo fijo con identidad propia (pedido del
// usuario 2026-07-05, para ubicarla de un vistazo y no confundirla con Tolkien).
const CONSOLE_PLACE = placeFor('claude-web-console');

// AutoTux (2026-07-06): predeterminado de TODA conversación de Chat nueva —
// fuente única en ui/models.js (mismo listado/orden que el picker de
// Sesiones). "Claude (TUI)" usa una lista SIN AutoTux (TUI_MODELS abajo): el
// CLI real de esas sesiones no conoce ese alias — ver core/model-router.js.
const MODELS = CHAT_MODEL_OPTIONS;
const TUI_MODELS = CHAT_MODEL_OPTIONS.filter(([v]) => v !== 'auto');

export default {
  name: 'launcher',

  mount(el, ctx) {
    const { icon, dialog, bus, openSession } = ctx;

    // Botón compacto: misma altura/diseño que el ☰ de colapsar (rail-btn),
    // con tipografía acorde. Va al lado del toggle en la cabecera derecha.
    el.innerHTML = `<button class="btn sb-new-btn" id="ln-open">${icon('plus', { size: 16 })}<span>${t('launcher.newSession', 'Nueva sesión')}</span></button>`;
    el.querySelector('#ln-open').addEventListener('click', open);
    bus.addEventListener('open-launcher', open);

    let modal = null;
    const st = {
      type: 'chat', // chat (SDK, default) | claude (PTY) | terminal
      // Default del sistema = Tándem (Niko 2026-07-21). Ya NO se recuerda el
      // último modelo usado: cada sesión nueva arranca en Tándem salvo que se
      // elija otro en ESTE modal (así el default no queda pegado a una elección
      // puntual vieja guardada en localStorage).
      model: 'tandem',
      dest: null,         // nada pre-seleccionado: se elige a mano (pedido del usuario 2026-07-10)
      view: 'list',       // list | browse
      browseRel: '',
      project: { rel: 'tolkien', name: 'Tolkien' },
    };

    async function open() {
      if (modal) return;
      // Ancho angosto (360): con solo 3 tarjetas por fila + dropdown + CTA, 440
      // dejaba las tarjetas anchas y vacías. Acorde al diseño compacto (pedido
      // del usuario 2026-07-10).
      modal = dialog.openModal({ title: t('launcher.newSession', 'Nueva sesión'), width: 360, onClose: () => { modal = null; } });
      modal.card.querySelector('.dlg-head')?.insertAdjacentHTML('beforeend', helpBtn('launcher'));
      st.view = 'list';
      st.dest = null;
      render();
      // Solo el estado de Tolkien (para el atajo): los recientes ya no se listan
      // en "Abrir en" (pedido del usuario: solo Tolkien · Consola · otra carpeta).
      try {
        const tk = await fetch('/api/tolkien/status')
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
          .catch(() => null);
        if (tk?.rel) st.project = { rel: tk.rel, name: tk.name || t('launcher.projectFallback', 'Proyecto') };
        if (modal) render();
      } catch { /* noop */ }
    }

    function baseName(rel) {
      const parts = String(rel).split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '~';
    }

    function render() {
      if (!modal) return;
      const body = modal.body;
      // Card genérica (ícono arriba + label abajo). Tipos y proyecto comparten
      // la clase .ln-card para que la grilla 3×3 quede pareja (rediseño
      // 2026-07-10: solo 3 tipos + 3 proyectos + modelo + Iniciar).
      const typeCard = (type, ic, label) =>
        `<button class="btn-ghost ln-type ln-card ${st.type === type ? 'active' : ''}" data-type="${type}">${icon(ic, { size: 16 })}<span class="ln-card-label">${label}</span></button>`;
      body.innerHTML = `
        <div class="ln-sec-title">${t('launcher.sessionType', 'Tipo de sesión')}</div>
        <div class="ln-types">
          ${typeCard('chat', 'sparkle', t('launcher.type.chat', 'Chat'))}
          ${typeCard('claude', 'keyboard', t('launcher.type.claudeTui', 'Claude TUI'))}
          ${typeCard('terminal', 'terminal', t('launcher.type.terminal', 'Terminal'))}
        </div>
        <div class="ln-sec-title">${t('launcher.section.project', 'Proyecto')}</div>
        <div class="ln-area">${st.view === 'list' ? listHTML() : browseHTML()}</div>
        <div class="ln-model-row" ${st.type === 'terminal' ? 'hidden' : ''}>
          <label class="ln-sec-title" for="ln-model">${t('launcher.model', 'Modelo')}</label>
          <select id="ln-model" class="ln-model">
            ${(st.type === 'chat' ? MODELS : TUI_MODELS).map(([v, l]) => `<option value="${v}" ${v === st.model ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn--block ln-start" ${st.dest ? '' : 'disabled'}>${icon('play', { size: 15 })}<span>${st.dest ? t('launcher.startIn', 'Iniciar en {dest}', { dest: st.dest.label }) : t('launcher.pickDest', 'Elegí un destino')}</span></button>`;

      // Tipo
      for (const b of body.querySelectorAll('.ln-type')) {
        b.addEventListener('click', () => {
          st.type = b.dataset.type;
          // AutoTux ('auto') no existe fuera de "Chat": el CLI real de una
          // sesión TUI/terminal no conoce ese alias (ver TUI_MODELS arriba).
          if (st.type !== 'chat' && st.model === 'auto') st.model = 'opusplan';
          render();
        });
      }
      // Modelo
      body.querySelector('#ln-model')?.addEventListener('change', (e) => { st.model = e.target.value; });
      // Destinos
      wireArea(body);
      // Iniciar
      body.querySelector('.ln-start').addEventListener('click', start);
    }

    function listHTML() {
      const card = (rel, label, ic, cls = '') => `
        <button class="btn-ghost ln-dest ln-card ${cls} ${st.dest?.rel === rel ? 'active' : ''}" data-rel="${rel}" data-label="${label}">
          ${icon(ic, { size: 16 })}<span class="ln-card-label">${label}</span>
        </button>`;
      // Grid 3 tarjetas: Tolkien · Mi Consola · Otra carpeta (abre el navegador).
      // Identidad de ui/places.js; el tinte de la consola es .ln-dest--console.
      // "Otra carpeta" queda activa si el destino es una carpeta navegada (≠ los
      // dos proyectos), para que la selección se vea al volver del navegador.
      const other = !!st.dest && st.dest.rel !== st.project.rel && st.dest.rel !== CONSOLE_PLACE.rel;
      return `
        <div class="ln-dests">
          ${card(st.project.rel, st.project.name, 'gitBranch')}
          ${card(CONSOLE_PLACE.rel, CONSOLE_PLACE.label, CONSOLE_PLACE.ico, 'ln-dest--console')}
          <button class="btn-ghost ln-card ln-browse-open ${other ? 'active' : ''}">${icon('folder', { size: 22 })}<span class="ln-card-label">${t('launcher.otherFolder', 'Otra carpeta')}</span></button>
        </div>`;
    }

    function browseHTML() {
      return `
        <button class="btn-ghost btn--sm ln-back">${icon('chevronLeft', { size: 13 })}<span>${t('launcher.backToProjects', 'Volver a proyectos')}</span></button>
        <div class="ln-crumbs" data-ref="crumbs"></div>
        <div class="ln-dirs" data-ref="dirs"><div class="cwc-loading">${pacman({ size: 'sm' })}${t('launcher.loading', 'cargando…')}</div></div>`;
    }

    function wireArea(body) {
      for (const b of body.querySelectorAll('.ln-dest')) {
        b.addEventListener('click', () => {
          st.dest = { rel: b.dataset.rel, label: b.dataset.label };
          render();
        });
      }
      body.querySelector('.ln-browse-open')?.addEventListener('click', () => {
        st.view = 'browse';
        st.browseRel = st.dest?.rel || '';
        render();
        browse(st.browseRel);
      });
      body.querySelector('.ln-back')?.addEventListener('click', () => { st.view = 'list'; render(); });
      if (st.view === 'browse') browse(st.browseRel);
    }

    // Navegador de carpetas: navegar implica seleccionar la carpeta actual.
    async function browse(rel) {
      st.browseRel = rel;
      // Un lugar conocido conserva su nombre también al llegar navegando.
      st.dest = { rel, label: placeFor(rel)?.label || baseName(rel) };
      const body = modal?.body;
      if (!body) return;
      // Navegar SIEMPRE selecciona una carpeta ⇒ el botón queda habilitado.
      const startBtn = body.querySelector('.ln-start');
      if (startBtn) {
        startBtn.disabled = false;
        const sp = startBtn.querySelector('span');
        if (sp) sp.textContent = t('launcher.startIn', 'Iniciar en {dest}', { dest: st.dest.label });
      }

      // Breadcrumb
      const crumbs = body.querySelector('[data-ref="crumbs"]');
      if (crumbs) {
        const parts = rel ? rel.split('/') : [];
        let acc = '';
        crumbs.innerHTML =
          `<button class="ln-crumb" data-rel="">${icon('home', { size: 13 })}</button>` +
          parts.map((p) => {
            acc = acc ? `${acc}/${p}` : p;
            return `<span class="ln-crumb-sep">${icon('chevronRight', { size: 11 })}</span><button class="ln-crumb" data-rel="${acc}">${p}</button>`;
          }).join('');
        for (const c of crumbs.querySelectorAll('.ln-crumb')) {
          c.addEventListener('click', () => browse(c.dataset.rel));
        }
      }

      // Subcarpetas
      const dirsEl = body.querySelector('[data-ref="dirs"]');
      if (!dirsEl) return;
      try {
        const res = await fetch(`/api/files/list?path=${encodeURIComponent(rel)}`);
        if (!res.ok) throw new Error();
        const { entries } = await res.json();
        const dirs = entries.filter((e) => e.type === 'dir');
        dirsEl.innerHTML = dirs.length
          ? dirs.map((d) => `<button class="ln-dir" data-name="${d.name}">${icon('folder', { size: 14 })}<span>${d.name}</span></button>`).join('')
          : `<div class="ln-hint">${t('launcher.noSubfolders', 'Sin subcarpetas — podés iniciar acá.')}</div>`;
        for (const b of dirsEl.querySelectorAll('.ln-dir')) {
          b.addEventListener('click', () => browse(rel ? `${rel}/${b.dataset.name}` : b.dataset.name));
        }
      } catch {
        dirsEl.innerHTML = `<div class="ln-hint">${t('launcher.listError', 'No se pudo listar esta carpeta.')}</div>`;
      }
    }

    async function start() {
      const dest = st.dest;
      if (!dest) return; // botón deshabilitado sin destino; guarda por si acaso
      modal.close();
      if (st.type === 'chat') {
        // Default "Todo" (bypassPermissions) para chat nuevo del lanzador.
        await ctx.openChat({ cwd: dest.rel, model: st.model, mode: 'bypassPermissions' });
      } else {
        const runClaude = st.type === 'claude';
        await openSession({ cwd: dest.rel, runClaude, model: runClaude ? st.model : undefined });
      }
    }
  },
};
