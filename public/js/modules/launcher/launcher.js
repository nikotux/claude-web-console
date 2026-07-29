// modules/launcher/launcher.js — "Nueva sesión": LA acción prominente de la app.
//
// Modal lanzador completo: tipo (Chat/Claude TUI/Terminal), modelo cuando
// corresponde y destino con atajos fijos (Tolkien/lugar propio — Mi Consola
// para host/admin, Mi espacio para inquilinos no-admin; su identidad sale de
// ui/places.js) más un navegador de carpetas con breadcrumb
// (GET /api/files/list, solo directorios).
// [Iniciar] crea y enfoca la sesión.
import { MYSPACE_PLACE, placeFor } from '../../ui/places.js';
import { CHAT_MODEL_OPTIONS, TUI_MODEL_OPTIONS, CHAT_ONLY_MODELS } from '../../ui/models.js';
import { pacman } from '../../ui/pacman.js';
import { t } from '../../ui/i18n.js';
import { helpBtn } from '../../ui/help.js';

// "Mi Consola" (este proyecto): atajo fijo con identidad propia (pedido del
// usuario 2026-07-05, para ubicarla de un vistazo y no confundirla con Tolkien).
const CONSOLE_PLACE = placeFor('claude-web-console');

// AutoTux (2026-07-06): predeterminado de TODA conversación de Chat nueva.
// Las opciones del chat y la lista sin alias para el CLI real vienen de la
// fuente única ui/models.js (CHAT_MODEL_OPTIONS/TUI_MODEL_OPTIONS).
const MODELS = CHAT_MODEL_OPTIONS;

export default {
  name: 'launcher',

  mount(el, ctx) {
    const { icon, dialog, bus, openSession } = ctx;
    let homePlace = CONSOLE_PLACE;

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
      const user = await Promise.resolve(ctx.whoami).catch(() => null);
      if (modal) return;
      const showConsoleShortcut = !user
        || user.type === 'token'
        || !!user.admin
        || (!!user.username && user.username === user.host);
      // Sin identidad conservamos el destino histórico. Host/admin ve el repo
      // real; únicamente un inquilino no-admin usa su mi-espacio aislado.
      homePlace = showConsoleShortcut ? CONSOLE_PLACE : MYSPACE_PLACE;
      // Ancho angosto (360): con solo 3 tarjetas por fila + dropdown + CTA, 440
      // dejaba las tarjetas anchas y vacías. Acorde al diseño compacto (pedido
      // del usuario 2026-07-10).
      modal = dialog.openModal({ title: t('launcher.newSession', 'Nueva sesión'), width: 360, onClose: () => { modal = null; } });
      modal.card.querySelector('.dlg-head')?.insertAdjacentHTML('beforeend', helpBtn('launcher'));
      st.view = 'list';
      st.dest = null;
      if (st.type === 'sala') st.dest = freshSalaDest();
      if (st.type === 'sala' && !MODELS.some(([value]) => value === st.model)) st.model = 'tandem';
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

    function freshSalaDest() {
      const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 10)
        || Math.random().toString(36).slice(2, 12);
      const salaId = `sala-${Date.now().toString(36)}-${random}`.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
      return {
        rel: `.cwc-aduana/salas/${salaId}`,
        label: t('launcher.aduana.newSala', '🛃 Nueva sala'),
        sala: true,
      };
    }

    async function ensureSalaFolder(dest) {
      const salaId = String(dest?.rel || '').split('/').pop();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(salaId)) {
        throw new Error(t('launcher.aduana.invalidId', 'No se pudo generar un identificador válido para la sala.'));
      }
      const steps = [
        { path: '', name: '.cwc-aduana' },
        { path: '.cwc-aduana', name: 'salas' },
        { path: '.cwc-aduana/salas', name: salaId },
      ];
      for (const [index, step] of steps.entries()) {
        const res = await fetch('/api/files/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(step),
        });
        if (res.ok || (res.status === 409 && index < steps.length - 1)) continue;
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('launcher.aduana.mkdirError', 'No se pudo preparar la carpeta de la sala.'));
      }
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
          ${typeCard('sala', 'relay', t('launcher.type.aduanaSala', '🛃 Sala'))}
        </div>
        <div class="ln-sec-title">${t('launcher.section.project', 'Proyecto')}</div>
        <div class="ln-area">${st.view === 'list' ? listHTML() : browseHTML()}</div>
        <div class="ln-model-row" ${st.type === 'terminal' ? 'hidden' : ''}>
          <label class="ln-sec-title" for="ln-model">${t('launcher.model', 'Modelo')}</label>
          <select id="ln-model" class="ln-model">
            ${(st.type === 'chat' ? MODELS : TUI_MODEL_OPTIONS).map(([v, l]) => `<option value="${v}" ${v === st.model ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn--block ln-start" ${st.dest ? '' : 'disabled'}>${icon('play', { size: 15 })}<span>${st.dest ? t('launcher.startIn', 'Iniciar en {dest}', { dest: st.dest.label }) : t('launcher.pickDest', 'Elegí un destino')}</span></button>`;

      if (st.type === 'sala') {
        const area = body.querySelector('.ln-area');
        if (area) {
          area.hidden = true;
          if (area.previousElementSibling) area.previousElementSibling.hidden = true;
        }
        const select = body.querySelector('#ln-model');
        if (select) {
          const options = MODELS.map(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            option.selected = value === st.model;
            return option;
          });
          select.replaceChildren(...options);
        }
      }

      // Tipo
      for (const b of body.querySelectorAll('.ln-type')) {
        b.addEventListener('click', () => {
          st.type = b.dataset.type;
          if (st.type === 'sala') {
            st.dest = freshSalaDest();
            if (!MODELS.some(([value]) => value === st.model)) st.model = 'tandem';
            render();
            return;
          }
          if (st.dest?.sala) st.dest = null;
          // Los alias de chat ('auto' AutoTux, 'tandem' Tándem) no existen para
          // el CLI real de una sesión TUI/terminal: sin este saneo el <select>
          // muestra la primera opción pero st.model conserva el alias (el evento
          // 'change' nunca dispara) y el backend responde 400 — console:PLAN-2115.
          if (st.type !== 'chat' && CHAT_ONLY_MODELS.includes(st.model)) st.model = 'opusplan';
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
      // Grid: Tolkien · lugar propio · Otra carpeta. Host/admin ve el repo de la
      // consola; un inquilino no-admin ve mi-espacio dentro de su workspace.
      // Identidad de ui/places.js; el tinte de la consola es .ln-dest--console.
      // "Otra carpeta" queda activa si el destino es una carpeta navegada (≠ los
      // dos proyectos), para que la selección se vea al volver del navegador.
      const other = !!st.dest && st.dest.rel !== st.project.rel && st.dest.rel !== homePlace.rel;
      const homeLabel = homePlace.rel === MYSPACE_PLACE.rel
        ? t('launcher.place.mySpace', homePlace.label)
        : t('launcher.place.console', homePlace.label);
      return `
        <div class="ln-dests">
          ${card(st.project.rel, st.project.name, 'gitBranch')}
          ${card(homePlace.rel, homeLabel, homePlace.ico, 'ln-dest--console')}
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
      if (st.type === 'sala') {
        try {
          await ensureSalaFolder(dest);
        } catch (e) {
          dialog.alertDialog({ title: t('launcher.aduana.createErrorTitle', 'No se pudo crear la sala'), message: e.message });
          return;
        }
        await ctx.openChat({ cwd: dest.rel, model: st.model, mode: 'default' });
        return;
      }
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
