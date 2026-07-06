// modules/launcher/launcher.js — "Nueva sesión": LA acción prominente de la app.
//
// Modal lanzador completo: tipo (Claude/Terminal), modelo (recuerda el último
// usado), y destino con atajos fijos (Home/Tolkien/Mi Consola — los lugares
// con identidad salen de ui/places.js: nombre + ícono + diferenciador),
// carpetas RECIENTES (GET /api/terminal/recents) y navegador de carpetas con
// breadcrumb (GET /api/files/list, solo directorios). [Iniciar] crea y enfoca.
// Flujos: Home = 2 taps · reciente = 3 taps · carpeta nueva = navegar + Iniciar.
import { placeFor } from '../../ui/places.js';
import { CHAT_MODEL_OPTIONS } from '../../ui/models.js';

const LAST_MODEL_KEY = 'cwc:lastModel';
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

    el.innerHTML = `<button class="btn btn--block" id="ln-open">${icon('plus')}<span>Nueva sesión</span></button>`;
    el.querySelector('#ln-open').addEventListener('click', open);
    bus.addEventListener('open-launcher', open);

    let modal = null;
    const st = {
      type: 'chat', // chat (SDK, default) | claude (PTY) | terminal
      model: localStorage.getItem(LAST_MODEL_KEY) || 'auto',
      dest: { rel: '', label: 'Home' },
      view: 'list',       // list | browse
      browseRel: '',
      recents: [],
      project: { rel: 'tolkien', name: 'Tolkien' },
    };

    async function open() {
      if (modal) return;
      modal = dialog.openModal({ title: 'Nueva sesión', width: 440, onClose: () => { modal = null; } });
      st.view = 'list';
      st.dest = { rel: '', label: 'Home' };
      render();
      // Datos frescos en paralelo (no bloquean el primer render).
      try {
        const [rec, tk] = await Promise.all([
          fetch('/api/terminal/recents').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText)))).catch(() => ({ recents: [] })),
          fetch('/api/tolkien/status').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText)))).catch(() => null),
        ]);
        st.recents = rec.recents || [];
        if (tk?.rel) st.project = { rel: tk.rel, name: tk.name || 'Proyecto' };
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
      body.innerHTML = `
        <div class="ln-types">
          <button class="btn-ghost ln-type ${st.type === 'chat' ? 'active' : ''}" data-type="chat">${icon('sparkle')}<span>Chat</span></button>
          <button class="btn-ghost ln-type ${st.type === 'claude' ? 'active' : ''}" data-type="claude">${icon('keyboard')}<span>Claude (TUI)</span></button>
          <button class="btn-ghost ln-type ${st.type === 'terminal' ? 'active' : ''}" data-type="terminal">${icon('terminal')}<span>Terminal</span></button>
        </div>
        <div class="ln-model-row" ${st.type === 'terminal' ? 'hidden' : ''}>
          <label class="ln-sec-title" for="ln-model">Modelo</label>
          <select id="ln-model" class="ln-model">
            ${(st.type === 'chat' ? MODELS : TUI_MODELS).map(([v, l]) => `<option value="${v}" ${v === st.model ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="ln-sec-title">Abrir en</div>
        <div class="ln-area">${st.view === 'list' ? listHTML() : browseHTML()}</div>
        <button class="btn btn--block ln-start">${icon('play', { size: 15 })}<span>Iniciar en ${st.dest.label}</span></button>`;

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
      const dest = (rel, label, sub, ic, cls = '') => `
        <button class="btn-ghost ln-dest ${cls} ${st.dest.rel === rel ? 'active' : ''}" data-rel="${rel}" data-label="${label}">
          ${icon(ic, { size: 15 })}<span class="ln-dest-label">${label}</span><span class="ln-sub">${sub}</span>
        </button>`;
      // Atajos fijos: Home + Tolkien + Mi Consola (identidad de ui/places.js;
      // el diferenciador visual es la clase ln-dest--console de style.css).
      const shortcuts = dest('', 'Home', '~', 'home')
        + dest(st.project.rel, st.project.name, `~/${st.project.rel}`, 'gitBranch')
        + dest(CONSOLE_PLACE.rel, CONSOLE_PLACE.label, `~/${CONSOLE_PLACE.rel}`, CONSOLE_PLACE.ico, 'ln-dest--console');
      const rec = st.recents.filter((r) => r.cwd !== st.project.rel && r.cwd !== CONSOLE_PLACE.rel);
      // Solo los 3 recientes más usados; el resto vive en el modal "Ver más"
      // para no empujar el botón Iniciar fuera de pantalla en móvil.
      let visible = rec.slice(0, 3);
      // Si el destino elegido vino del modal y no está en el top 3, se lo
      // muestra en el tercer lugar para que la selección activa se vea.
      if (st.dest.rel && !visible.some((r) => r.cwd === st.dest.rel)) {
        const sel = rec.find((r) => r.cwd === st.dest.rel);
        if (sel) visible = visible.slice(0, 2).concat(sel);
      }
      // Un reciente que sea (o cuelgue de) un lugar conocido hereda su
      // nombre + ícono (p.ej. una subcarpeta de Mi Consola no queda genérica).
      const recents = visible.map((r) => {
        const p = placeFor(r.cwd);
        return dest(r.cwd, p?.label || baseName(r.cwd), `~/${r.cwd}`, p?.ico || 'folder', p?.cls === 'is-console' ? 'ln-dest--console' : '');
      }).join('');
      const more = rec.length > visible.length
        ? `<button class="btn-ghost btn--sm ln-dests-more">${icon('chevronRight', { size: 13 })}<span>Ver más (${rec.length})</span></button>`
        : '';
      const resume = st.type === 'chat' ? '<div class="ln-resume" data-ref="resume"></div>' : '';
      return `
        <div class="ln-dests">${shortcuts}${recents}</div>
        <div class="ln-list-actions">
          <button class="btn-ghost btn--sm ln-browse-open">${icon('folder', { size: 14 })}<span>Elegir otra carpeta…</span></button>
          ${more}
        </div>
        ${resume}`;
    }

    // "Ver más" de ubicaciones: modal emergente con todos los recientes.
    function openDestsMore() {
      const rec = st.recents.filter((r) => r.cwd !== st.project.rel && r.cwd !== CONSOLE_PLACE.rel);
      const m = dialog.openModal({ title: 'Abrir en…', width: 440 });
      const list = document.createElement('div');
      list.className = 'ln-dests ln-dests--dlg';
      list.innerHTML = rec.map((r) => `
        <button class="btn-ghost ln-dest ${st.dest.rel === r.cwd ? 'active' : ''}" data-rel="${r.cwd}" data-label="${baseName(r.cwd)}">
          ${icon('folder', { size: 15 })}<span class="ln-dest-label">${baseName(r.cwd)}</span><span class="ln-sub">~/${r.cwd}</span>
        </button>`).join('');
      m.body.appendChild(list);
      for (const b of list.querySelectorAll('.ln-dest')) {
        b.addEventListener('click', () => {
          st.dest = { rel: b.dataset.rel, label: b.dataset.label };
          m.close();
          render();
        });
      }
    }

    function fmtAgo(ms) {
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 3600) return `hace ${Math.max(1, Math.floor(s / 60))} min`;
      if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
      return `hace ${Math.floor(s / 86400)} d`;
    }

    // Retomar una conversación pasada: guarda el modelo, cierra el lanzador
    // (y el modal "Ver más" si está abierto) y abre el chat con resume.
    async function resumeChat(dest, sessionId) {
      localStorage.setItem(LAST_MODEL_KEY, st.model);
      modal?.close();
      // Default del lanzador: "Todo" (bypassPermissions) — pedido del usuario
      // 2026-07-06: todo chat/sesión nuevo arranca sin pedir permisos. Los chats
      // de bugfixes/headless NO pasan por acá (mantienen su modo explícito).
      await ctx.openChat({ cwd: dest.rel, model: st.model, mode: 'bypassPermissions', resume: sessionId });
    }

    // Pinta botones de conversación (snippet vía textContent, nunca HTML).
    function renderResumeItems(container, conversations, dest, onPick) {
      container.insertAdjacentHTML('beforeend', conversations.map((c) => `
        <button class="btn-ghost btn--sm ln-resume-item" data-sid="${c.sessionId}">
          <span class="ln-resume-snip"></span><span class="ln-sub">${fmtAgo(c.ts)}</span>
        </button>`).join(''));
      const btns = container.querySelectorAll('.ln-resume-item');
      conversations.forEach((c, i) => {
        const b = btns[btns.length - conversations.length + i];
        b.querySelector('.ln-resume-snip').textContent = c.snippet;
        b.addEventListener('click', () => onPick(c));
      });
    }

    // "Ver más": modal emergente con el historial completo (hasta 10).
    function openResumeHistory(conversations, dest) {
      const m = dialog.openModal({ title: `Retomar en ${dest.label}`, width: 440 });
      const list = document.createElement('div');
      list.className = 'ln-resume ln-resume--dlg';
      m.body.appendChild(list);
      renderResumeItems(list, conversations, dest, (c) => { m.close(); resumeChat(dest, c.sessionId); });
    }

    // "Retomar conversación": las 2 últimas de la carpeta seleccionada (solo
    // chat); el resto queda detrás de "Ver más" para que la lista no empuje
    // el botón Iniciar fuera de pantalla en móvil.
    async function loadResume() {
      const box = modal?.body?.querySelector('[data-ref="resume"]');
      if (!box) return;
      const rel = st.dest.rel;
      try {
        const { conversations } = await (await fetch(`/api/chat/history?cwd=${encodeURIComponent(rel)}`)).json();
        if (!modal || st.dest.rel !== rel || !conversations.length) { box.innerHTML = ''; return; }
        const dest = st.dest;
        box.innerHTML = `<div class="ln-sec-title">Retomar en ${dest.label}</div>`;
        renderResumeItems(box, conversations.slice(0, 2), dest, (c) => resumeChat(dest, c.sessionId));
        if (conversations.length > 2) {
          const more = document.createElement('button');
          more.className = 'btn-ghost btn--sm ln-resume-more';
          more.innerHTML = `${icon('chevronRight', { size: 13 })}<span>Ver más (${conversations.length})</span>`;
          more.addEventListener('click', () => openResumeHistory(conversations, dest));
          box.appendChild(more);
        }
      } catch { box.innerHTML = ''; }
    }

    function browseHTML() {
      return `
        <button class="btn-ghost btn--sm ln-back">${icon('chevronLeft', { size: 13 })}<span>Atajos y recientes</span></button>
        <div class="ln-crumbs" data-ref="crumbs"></div>
        <div class="ln-dirs" data-ref="dirs"><div class="cwc-loading"><span class="cwc-spinner"></span>cargando…</div></div>`;
    }

    function wireArea(body) {
      for (const b of body.querySelectorAll('.ln-dest')) {
        b.addEventListener('click', () => {
          st.dest = { rel: b.dataset.rel, label: b.dataset.label };
          render();
        });
      }
      body.querySelector('.ln-dests-more')?.addEventListener('click', openDestsMore);
      body.querySelector('.ln-browse-open')?.addEventListener('click', () => {
        st.view = 'browse';
        st.browseRel = st.dest.rel;
        render();
        browse(st.browseRel);
      });
      body.querySelector('.ln-back')?.addEventListener('click', () => { st.view = 'list'; render(); });
      if (st.view === 'browse') browse(st.browseRel);
      if (st.view === 'list' && st.type === 'chat') loadResume();
    }

    // Navegador de carpetas: navegar implica seleccionar la carpeta actual.
    async function browse(rel) {
      st.browseRel = rel;
      // Un lugar conocido conserva su nombre también al llegar navegando.
      st.dest = { rel, label: placeFor(rel)?.label || baseName(rel) };
      const body = modal?.body;
      if (!body) return;
      const startBtn = body.querySelector('.ln-start span');
      if (startBtn) startBtn.textContent = `Iniciar en ${st.dest.label}`;

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
          : '<div class="ln-hint">Sin subcarpetas — podés iniciar acá.</div>';
        for (const b of dirsEl.querySelectorAll('.ln-dir')) {
          b.addEventListener('click', () => browse(rel ? `${rel}/${b.dataset.name}` : b.dataset.name));
        }
      } catch {
        dirsEl.innerHTML = '<div class="ln-hint">No se pudo listar esta carpeta.</div>';
      }
    }

    async function start() {
      const dest = st.dest;
      if (st.type !== 'terminal') localStorage.setItem(LAST_MODEL_KEY, st.model);
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
