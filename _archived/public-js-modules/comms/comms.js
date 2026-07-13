// modules/comms/comms.js — "Comunicaciones": status rápido en el sidebar +
// acceso al tablero. INFO BARATA (sin tokens) desde GET /api/comms: mensajes
// nuevos de un contacto, comunicaciones sin respuesta, nº de contactos. El
// detalle vive en el TABLERO (board/index.js) que abre el botón / las columnas.
import { openCommsBoard } from './board/index.js';

export default {
  name: 'comms',

  mount(el, ctx) {
    const { icon, dialog, openChat } = ctx;
    let status = { newCount: 0, awaiting: 0, perContact: {}, contacts: [], scannedAt: null, running: false };
    let projectRel = 'tolkien';
    let isAdmin = false;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot" data-ref="dot" title="Estado del módulo"></span>
        <span class="sec-title">Comunicaciones</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="scan" title="Escanear comunicaciones (GitHub, sin tokens)">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="tk-card">
        <div class="bf-cols" data-ref="cols"></div>
        <div class="bf-stats" data-ref="sub">…</div>
        <div class="tk-actions">
          <button class="btn-ghost btn--sm btn--block" data-ref="board" hidden>${icon('gitBranch', { size: 13 })}<span>Abrir Comunicaciones</span></button>
        </div>
      </div>`;

    const refs = {};
    for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

    function fmtAgo(ms) {
      if (!ms) return 'sin escanear';
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 60) return 'recién';
      if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
      if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
      return `hace ${Math.floor(s / 86400)} d`;
    }

    function render() {
      const total = (status.newCount || 0) + (status.awaiting || 0);
      refs.count.textContent = total ? String(total) : '';
      // Semáforo (visible colapsado): acento si escaneando, rojo si hay algo sin
      // responder, verde si hay mensajes nuevos, tenue si no hay novedades.
      if (refs.dot) {
        const dstate = status.running ? 'busy'
          : ((status.awaiting || 0) > 0 ? 'alert' : ((status.newCount || 0) > 0 ? 'ok' : 'idle'));
        refs.dot.className = `sec-dot sec-dot--${dstate}`;
        refs.dot.title = status.running ? 'Escaneando…'
          : ((status.awaiting || 0) > 0 ? `${status.awaiting} sin responder`
            : ((status.newCount || 0) > 0 ? `${status.newCount} nuevos` : 'Sin novedades'));
      }
      const COLS = [
        { emoji: '💬', label: 'Nuevos', n: status.newCount || 0, dim: !status.newCount },
        { emoji: '⏳', label: 'Sin responder', n: status.awaiting || 0, dim: !status.awaiting, alert: (status.awaiting || 0) > 0 },
        { emoji: '👥', label: 'Contactos', n: (status.contacts || []).length, dim: false },
      ];
      refs.cols.innerHTML = COLS.map((c) => `
        <button class="bf-col${c.dim ? ' bf-col--dim' : ''}${c.alert ? ' bf-col--alert' : ''}" data-open="1"${isAdmin ? '' : ' disabled'}>
          <span class="bf-col-n">${c.n}</span>
          <span class="bf-col-lbl">${c.emoji} ${c.label}</span>
        </button>`).join('');
      refs.sub.innerHTML = status.running
        ? `<span class="bf-sub">${icon('refresh', { size: 11 })} escaneando…</span>`
        : `<span class="bf-sub" title="Frescura del último escaneo de GitHub">${icon('clock', { size: 11 })} GitHub ${fmtAgo(status.scannedAt)}</span>`;
    }

    async function reload() {
      try { status = await (await fetch('/api/comms')).json(); } catch { /* noop */ }
      render();
    }

    async function scan() {
      const ok = await dialog.confirmDialog({
        title: 'Escanear comunicaciones',
        message: 'Trae de GitHub (gh) las reviews y comentarios de tus contactos sobre Tolkien.\nEs de SOLO LECTURA y NO consume tokens.',
        confirmLabel: 'Escanear',
      });
      if (!ok) return;
      try { await fetch('/api/comms/refresh', { method: 'POST' }); } catch { /* noop */ }
      status.running = true; render();
      for (let i = 0; i < 80; i += 1) {
        await new Promise((r) => setTimeout(r, 3000));
        try { status = await (await fetch('/api/comms')).json(); } catch { /* noop */ }
        render();
        if (!status.running) break;
      }
    }

    function openBoard() {
      openCommsBoard({ dialog, icon, openChat, projectRel: () => projectRel, onClose: () => reload() });
    }

    refs.scan.addEventListener('click', scan);
    refs.board.addEventListener('click', openBoard);
    refs.cols.addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (!b || b.disabled || !isAdmin) return;
      openBoard();
    });

    ctx.whoami?.then?.((me) => { isAdmin = !!me?.admin; if (isAdmin) refs.board.hidden = false; render(); });

    (async () => {
      try { const st = await (await fetch('/api/tolkien/status')).json(); if (st?.rel) projectRel = st.rel; } catch { /* noop */ }
      reload();
    })();
  },
};
