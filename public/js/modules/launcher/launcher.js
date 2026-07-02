// modules/launcher/launcher.js — "Nueva sesión": LA acción prominente de la app.
//
// Renderiza el botón primario del sidebar y el modal lanzador. En esta fase el
// cuerpo es interino (Home / Tolkien); el selector de carpetas con recientes
// llega en la fase siguiente. También se abre vía el evento 'open-launcher'
// del bus (lo usan el ＋ del rail y el arranque sin sesiones).
export default {
  name: 'launcher',

  mount(el, ctx) {
    const { icon, dialog, bus, openSession } = ctx;
    let type = 'claude'; // claude | terminal (default: Claude Code)
    let modal = null;

    el.innerHTML = `<button class="btn btn--block" id="ln-open">${icon('plus')}<span>Nueva sesión</span></button>`;
    el.querySelector('#ln-open').addEventListener('click', open);
    bus.addEventListener('open-launcher', open);

    function open() {
      if (modal) return;
      modal = dialog.openModal({ title: 'Nueva sesión', width: 420, onClose: () => { modal = null; } });
      render();
    }

    function render() {
      const body = modal.body;
      body.innerHTML = `
        <div class="ln-types">
          <button class="btn-ghost ln-type" data-type="claude">${icon('sparkle')}<span>Claude Code</span></button>
          <button class="btn-ghost ln-type" data-type="terminal">${icon('terminal')}<span>Terminal</span></button>
        </div>
        <div class="ln-sec-title">Abrir en</div>
        <div class="ln-dests">
          <button class="btn-ghost ln-dest" data-cwd="">${icon('home')}<span>Home</span></button>
          <button class="btn-ghost ln-dest" data-cwd="tolkien">${icon('gitBranch')}<span>Tolkien</span></button>
        </div>
        <p class="ln-hint">El selector de carpetas y los recientes llegan en la próxima fase.</p>`;

      const syncTypes = () => {
        for (const b of body.querySelectorAll('.ln-type')) b.classList.toggle('active', b.dataset.type === type);
      };
      syncTypes();
      for (const b of body.querySelectorAll('.ln-type')) {
        b.addEventListener('click', () => { type = b.dataset.type; syncTypes(); });
      }
      for (const b of body.querySelectorAll('.ln-dest')) {
        b.addEventListener('click', async () => {
          const cwd = b.dataset.cwd;
          modal.close();
          await openSession({ cwd, runClaude: type === 'claude' });
        });
      }
    }
  },
};
