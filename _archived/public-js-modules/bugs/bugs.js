// modules/bugs/bugs.js — "Bugs & Features": hub del ciclo del bug en el sidebar.
//
// Módulo `bugs` (antes `tickets`). Muestra INFO RÁPIDA y barata (sin tokens ni
// GitHub en vivo) cruzando dos fuentes cacheadas:
//   - triage de Desk (GET /api/bugs): cuántos bugs abiertos + frescura.
//   - registro de bugfixes (GET /api/bugfixes): fixes por enviar, PRs abiertos,
//     y señales de ATENCIÓN (reabierto / doble registro / ticket sin actualizar).
// El detalle vive en el TABLERO unificado "Bugs & PRs" (bugs/board/, módulos
// store/render/actions/polls — antes el monolito tolkien/bug-board.js), que
// abre el botón [Abrir tablero]. El ↻ corre el triage BAJO DEMANDA (consume
// tokens; confirm previo). Al cerrar el tablero, las stats se refrescan.
import { pacman } from '../../ui/pacman.js';
import { openBugBoard } from './board/index.js';

export default {
  name: 'bugs',

  mount(el, ctx) {
    const { icon, dialog, openChat } = ctx;
    let cache = { updatedAt: null, tickets: [], error: null, running: false };
    let fixes = [];        // registro de bugfixes plano (para las stats)
    let consTickets = [];  // tickets CONSOLIDADOS (/tickets) — mismos que el tablero
    let chatList = [];     // /api/chat/list (para el Pac-Man de actividad)
    let projectRel = 'tolkien';
    let busy = false;
    let isAdmin = false;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot" data-ref="dot" title="Estado del módulo"></span>
        <span class="sec-title">Bugs &amp; Features</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Correr triage de bugs (consume tokens)">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="tk-card bf-card">
        <div class="bf-cols" data-ref="cols"></div>
        <div class="bf-stats" data-ref="stats">…</div>
        <div class="tk-actions">
          <button class="btn-ghost btn--sm btn--block" data-ref="board" hidden>${icon('gitBranch', { size: 13 })}<span>Abrir tablero</span></button>
        </div>
      </div>`;

    const refs = {};
    for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

    function fmtAgo(ms) {
      if (!ms) return 'sin datos';
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 60) return 'recién';
      if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
      if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
      return `hace ${Math.floor(s / 86400)} d`;
    }

    // Señales de ATENCIÓN, todas locales (sin gh): un fix reabierto tras PR, dos
    // registros para el mismo ticket, o un PR subido cuyo ticket quedó sin
    // actualizar en Desk. Son exactamente los casos que el 519 nos enseñó.
    function attentionCount() {
      let n = 0;
      const porTicket = new Map();
      for (const b of fixes) {
        if (b.ticketNumber) porTicket.set(String(b.ticketNumber), (porTicket.get(String(b.ticketNumber)) || 0) + 1);
      }
      for (const b of fixes) {
        const reabierto = Array.isArray(b.history) && b.history.some((e) => e.type === 'trabajo_nuevo');
        const doble = b.ticketNumber && (porTicket.get(String(b.ticketNumber)) || 0) > 1;
        const deskPend = b.status === 'subido' && b.ticketNumber
          && b.deskStatus !== 'ok'
          && !(Array.isArray(b.history) && b.history.some((e) => e.type === 'ticket_actualizado' && e.ok));
        if (reabierto || doble || deskPend) n += 1;
      }
      return n;
    }

    // Conteos por SUBVISTA del tablero (mismo criterio que tabOfEntry de
    // board/labels.js): archivado manda sobre kind → 📦; feature → 💡; resto →
    // 🎫. La columna Tickets suma además los tickets del triage sin trabajar
    // todavía (los que no tienen ya un ticket consolidado) — igual que la
    // pestaña Tickets del tablero. Barato: sin tokens ni GitHub en vivo.
    function tabCounts() {
      const c = { tickets: 0, features: 0, archived: 0 };
      const cubiertos = new Set();
      for (const t of consTickets) {
        if (t.number) cubiertos.add(String(t.number));
        if (t.archived) c.archived += 1;
        else if (t.kind === 'feature') c.features += 1;
        else c.tickets += 1;
      }
      for (const t of (cache.tickets || [])) {
        if (!cubiertos.has(String(t.ticketNumber))) c.tickets += 1;
      }
      return c;
    }

    // Pac-Man de ACTIVIDAD por columna: ¿se está trabajando/procesando algo?
    // Fuente barata (0 tokens): estados de /api/chat/list. Un chat con ticket
    // (working o delegando un subagente) → su columna se prende; el TRIAGE
    // corriendo delega sobre Tickets. Un chat MÁS específico (working) le gana
    // al triage (delegating). FEAT-n → columna Features; el resto → Tickets.
    function computeActivity() {
      let tickets = null; let features = null;
      for (const c of (chatList || [])) {
        const active = c.status === 'working' || c.delegating;
        if (!active || !c.ticketNumber) continue;
        if (/^FEAT/i.test(String(c.ticketNumber))) features = 'working';
        else tickets = 'working';
      }
      if ((busy || cache.running) && !tickets) tickets = 'delegating';
      return { tickets, features };
    }

    function renderCols() {
      const c = tabCounts();
      const att = attentionCount();
      const act = computeActivity();
      // 3ª columna = ESCANEO PREVIO de atención (reemplaza a Archivados, que no
      // se acciona desde acá): las anomalías del ciclo (reabierto tras PR /
      // doble registro / ticket sin actualizar en Desk — los casos del 519).
      // Rojo cuando hay algo; al día si 0. Clic → tablero en Tickets (ahí viven).
      const pacTitle = (st) => (st === 'working' ? ' · 🟡 trabajando ahora' : st === 'delegating' ? ' · 🟣 procesando (triage)' : '');
      const COLS = [
        { tab: 'tickets', emoji: '🎫', label: 'Tickets', n: c.tickets, dim: !c.tickets, pac: act.tickets, title: `Abrir el tablero en Tickets (${c.tickets})${pacTitle(act.tickets)}` },
        { tab: 'features', emoji: '💡', label: 'Features', n: c.features, dim: !c.features, pac: act.features, title: `Abrir el tablero en Features (${c.features})${pacTitle(act.features)}` },
        { tab: 'tickets', emoji: '⚠', label: 'Atención', n: att, dim: !att, alert: att > 0,
          title: att ? `${att} ítem(s) requieren atención (reabierto tras PR · doble registro · ticket sin actualizar en Desk). Clic: abrir Tickets` : 'Nada requiere atención — al día' },
      ];
      refs.cols.innerHTML = COLS.map((col) => `
        <button class="bf-col${col.dim && !col.pac ? ' bf-col--dim' : ''}${col.alert ? ' bf-col--alert' : ''}" data-tab="${col.tab}"${isAdmin ? '' : ' disabled'} title="${escapeHtml(col.title)}">
          ${col.pac ? `<span class="bf-col-pac">${pacman({ state: col.pac, size: 'pac-sm' })}</span>` : ''}
          <span class="bf-col-n">${col.n}</span>
          <span class="bf-col-lbl">${col.emoji} ${col.label}</span>
        </button>`).join('');
    }

    function render() {
      const n = cache.tickets?.length || 0;
      refs.count.textContent = n ? String(n) : '';
      // Semáforo (visible colapsado): acento si triando, rojo si hay ítems de
      // atención, verde si hay tickets seguidos, tenue si no hay nada.
      if (refs.dot) {
        const dstate = busy ? 'busy' : (attentionCount() > 0 ? 'alert' : (n ? 'ok' : 'idle'));
        refs.dot.className = `sec-dot sec-dot--${dstate}`;
        refs.dot.title = busy ? 'Triando…'
          : (attentionCount() > 0 ? `${attentionCount()} requieren atención` : (n ? `${n} en seguimiento` : 'Sin ítems'));
      }
      renderCols();
      refs.refresh.disabled = busy;
      refs.board.disabled = busy;

      if (busy) { refs.stats.innerHTML = `${pacman({ state: 'delegating' })} triando…`; return; }
      if (cache.error) {
        refs.stats.innerHTML = `<span class="bf-err">Error: ${escapeHtml(cache.error)}</span>`;
        return;
      }
      // Leyenda inferior REDUCIDA (pedido del usuario 2026-07-05): las líneas de
      // resolución/por-enviar eran redundantes con las columnas; el escaneo de
      // atención vive ahora en la 3ª columna. Abajo queda SOLO la frescura del
      // triage (cuán viejo es), que las columnas no muestran.
      refs.stats.innerHTML = cache.updatedAt
        ? `<span class="bf-sub" title="Frescura del último triage de Desk (corré el ↻ para actualizar)">${icon('clock', { size: 11 })} triage ${fmtAgo(cache.updatedAt)}</span>`
        : '<span class="bf-sub">Sin triage · corré el ↻</span>';
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const POLL_MS = 3000;
    const MAX_ATTEMPTS = 3;

    async function fetchTriage() { return (await fetch('/api/bugs')).json(); }
    async function fetchFixes() {
      try { return (await (await fetch('/api/bugfixes')).json()).bugfixes || []; } catch { return fixes; }
    }
    // Tickets CONSOLIDADOS (misma fuente que el tablero: 1 = 1 ticket, con
    // kind/archived derivados). Barato: usa la caché server de PRs, sin gh vivo.
    async function fetchTickets() {
      try { return (await (await fetch('/api/bugfixes/tickets')).json()).tickets || []; } catch { return consTickets; }
    }
    // Estados de chat (para el Pac-Man de actividad). Mismo GET barato que el
    // poll de main.js; solo miramos status/delegating/ticketNumber.
    async function fetchChats() {
      try { return (await (await fetch('/api/chat/list')).json()).chats || []; } catch { return chatList; }
    }
    // Poll liviano de actividad: refresca solo el Pac-Man de las columnas (no
    // re-pega triage ni bugfixes). Corre mientras el módulo está montado.
    async function pollActivity() {
      chatList = await fetchChats();
      if (!busy) renderCols(); // en busy, render() ya repinta con el estado vivo
    }

    async function waitForRun() {
      for (;;) {
        await sleep(POLL_MS);
        let st;
        try { st = await fetchTriage(); } catch { continue; }
        if (!st.running) return st;
      }
    }

    async function reloadStats() {
      [cache, fixes, consTickets, chatList] = await Promise.all([
        fetchTriage().catch(() => cache),
        fetchFixes(),
        fetchTickets(),
        fetchChats(),
      ]);
      if (cache.running && !busy) {
        busy = true; render();
        cache = await waitForRun();
        busy = false;
      }
      render();
    }

    // Corre el triage (LENTO, tokens) — arrancar + encuestar + reintento (mismo
    // patrón robusto de antes: sobrevive a cortes de red y reinicios del server).
    async function refresh() {
      if (busy) return;
      const ok = await dialog.confirmDialog({
        title: 'Correr triage de bugs',
        message: 'Ejecuta el triage con Claude sobre los tickets [Tolkien Bug] de Zoho Desk.\nCONSUME TOKENS reales y puede tardar 1–3 minutos. Es de solo lectura (no crea ni cambia nada).',
        confirmLabel: 'Correr triage',
      });
      if (!ok) return;
      busy = true; render();
      const prevUpdatedAt = cache.updatedAt || null;
      try {
        for (let attempt = 1; ; attempt += 1) {
          try {
            const res = await fetch('/api/bugs/refresh', { method: 'POST' });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error || 'No se pudo iniciar el triage.');
          } catch (e) {
            if (String(e.message || '').includes('administrador')) {
              cache = { ...cache, error: e.message };
              return;
            }
          }
          const st = await waitForRun();
          cache = st;
          const finished = st.updatedAt !== prevUpdatedAt || st.error;
          if (finished) return;
          if (attempt >= MAX_ATTEMPTS) {
            cache = { ...st, error: `El triage se interrumpió ${MAX_ATTEMPTS} veces (¿el servidor se está reiniciando?). Probá de nuevo en un rato.` };
            return;
          }
          await sleep(3000);
        }
      } finally {
        busy = false;
        [fixes, consTickets] = await Promise.all([fetchFixes(), fetchTickets()]);
        render();
      }
    }

    // Abre el TABLERO unificado; al cerrarlo, refresca las stats (pudo cambiar
    // el registro: envíos, cancelaciones, etc.). initialTab (opcional) lo abre
    // directo en una subvista (clic en una columna del panel).
    function openBoard(initialTab) {
      openBugBoard({
        dialog, icon, openChat, initialTab,
        projectRel: () => projectRel,
        updateRepo: async () => {
          try {
            const res = await fetch('/api/tolkien/update', { method: 'POST' });
            if (!res.ok) {
              const d = await res.json().catch(() => ({ error: 'Error' }));
              return { ok: false, message: `${d.error || 'No se pudo actualizar el repo.'}\nNo se subió ningún PR.` };
            }
            const up = await res.json();
            if (up.error) return { ok: false, message: `${up.error}\nNo se subió ningún PR.` };
            if (up.popConflict) return { ok: false, message: 'Conflicto al reaplicar cambios locales (stash). Resolvelo antes de subir PRs.' };
            return { ok: true };
          } catch { return { ok: false, message: 'No se pudo actualizar el repo.' }; }
        },
        onClose: () => { reloadStats(); },
      });
    }

    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    refs.refresh.addEventListener('click', refresh);
    refs.board.addEventListener('click', () => openBoard());
    // Columnas Tickets/Features/Archivados: abren el tablero en esa subvista.
    refs.cols.addEventListener('click', (e) => {
      const col = e.target.closest('[data-tab]');
      if (!col || col.disabled || !isAdmin) return;
      openBoard(col.dataset.tab);
    });
    // El tablero y el triage son admin (el backend igual los exige).
    ctx.whoami?.then?.((me) => { isAdmin = !!me?.admin; if (isAdmin) refs.board.hidden = false; renderCols(); });

    (async () => {
      try { const st = await (await fetch('/api/tolkien/status')).json(); if (st?.rel) projectRel = st.rel; } catch { /* noop */ }
      reloadStats();
    })();

    // Pac-Man de actividad: poll liviano mientras el panel está montado (el
    // módulo del sidebar vive toda la sesión, igual que el poll de main.js).
    setInterval(() => { if (!document.hidden) pollActivity(); }, 8000);
  },
};
