// modules/launcher/launcher.js — "Nueva sesión": LA acción prominente de la app.
//
// Modal lanzador completo: tipo (Claude/Terminal), modelo (recuerda el último
// usado), y destino con atajos fijos (Home/Tolkien), carpetas RECIENTES
// (GET /api/terminal/recents) y navegador de carpetas con breadcrumb
// (GET /api/files/list, solo directorios). [Iniciar] crea y enfoca.
// Flujos: Home = 2 taps · reciente = 3 taps · carpeta nueva = navegar + Iniciar.
const LAST_MODEL_KEY = 'cwc:lastModel';

const MODELS = [
  ['opusplan', 'Auto (Opus plan / Sonnet)'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['default', 'Default de la cuenta'],
];

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
      model: localStorage.getItem(LAST_MODEL_KEY) || 'opusplan',
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
          fetch('/api/terminal/recents').then((r) => r.json()).catch(() => ({ recents: [] })),
          fetch('/api/tolkien/status').then((r) => r.json()).catch(() => null),
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
            ${MODELS.map(([v, l]) => `<option value="${v}" ${v === st.model ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="ln-sec-title">Abrir en</div>
        <div class="ln-area">${st.view === 'list' ? listHTML() : browseHTML()}</div>
        <button class="btn btn--block ln-start">${icon('play', { size: 15 })}<span>Iniciar en ${st.dest.label}</span></button>`;

      // Tipo
      for (const b of body.querySelectorAll('.ln-type')) {
        b.addEventListener('click', () => { st.type = b.dataset.type; render(); });
      }
      // Modelo
      body.querySelector('#ln-model')?.addEventListener('change', (e) => { st.model = e.target.value; });
      // Destinos
      wireArea(body);
      // Iniciar
      body.querySelector('.ln-start').addEventListener('click', start);
    }

    function listHTML() {
      const dest = (rel, label, sub, ic) => `
        <button class="btn-ghost ln-dest ${st.dest.rel === rel ? 'active' : ''}" data-rel="${rel}" data-label="${label}">
          ${icon(ic, { size: 15 })}<span class="ln-dest-label">${label}</span><span class="ln-sub">${sub}</span>
        </button>`;
      const shortcuts = dest('', 'Home', '~', 'home') + dest(st.project.rel, st.project.name, `~/${st.project.rel}`, 'gitBranch');
      const recents = st.recents
        .filter((r) => r.cwd !== st.project.rel)
        .slice(0, 5)
        .map((r) => dest(r.cwd, baseName(r.cwd), `~/${r.cwd}`, 'folder'))
        .join('');
      return `
        <div class="ln-dests">${shortcuts}${recents}</div>
        <button class="btn-ghost btn--sm ln-browse-open">${icon('folder', { size: 14 })}<span>Elegir otra carpeta…</span></button>`;
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
      body.querySelector('.ln-browse-open')?.addEventListener('click', () => {
        st.view = 'browse';
        st.browseRel = st.dest.rel;
        render();
        browse(st.browseRel);
      });
      body.querySelector('.ln-back')?.addEventListener('click', () => { st.view = 'list'; render(); });
      if (st.view === 'browse') browse(st.browseRel);
    }

    // Navegador de carpetas: navegar implica seleccionar la carpeta actual.
    async function browse(rel) {
      st.browseRel = rel;
      st.dest = { rel, label: baseName(rel) };
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
        await ctx.openChat({ cwd: dest.rel, model: st.model, mode: 'default' });
      } else {
        const runClaude = st.type === 'claude';
        await openSession({ cwd: dest.rel, runClaude, model: runClaude ? st.model : undefined });
      }
    }
  },
};
