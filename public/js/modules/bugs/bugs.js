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
    let fixes = [];        // registro de bugfixes (para las stats)
    let projectRel = 'tolkien';
    let busy = false;
    let isAdmin = false;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-title">Bugs &amp; Features</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Correr triage de bugs (consume tokens)">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="tk-card bf-card">
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

    // Números derivados (baratos, sin tokens ni gh). Todo sale del registro que
    // ya trae fetchFixes(): 'resolution' (active|partial|complete) y las señales
    // de Desk (deskReplied/deskResolved) las deriva el motor de bugfixes.
    function stats() {
      const bugs = cache.tickets?.length || 0;
      const pendientes = fixes.filter((b) => b.status === 'pendiente' && b.files?.length).length;
      const prsAbiertos = fixes.filter((b) => b.status === 'subido' && b.prState !== 'merged').length;
      // Resolución (mismo criterio que el tablero): 🟢 completo = ticket
      // confirmado resuelto en Desk · 🟡 parcial = PR mergeado sin confirmar.
      const completos = fixes.filter((b) => b.resolution === 'complete').length;
      const parciales = fixes.filter((b) => b.resolution === 'partial').length;
      // Desk respondió pero el ticket todavía no se dio por resuelto.
      const deskResp = fixes.filter((b) => b.deskReplied && !b.deskResolved).length;
      return { bugs, pendientes, prsAbiertos, completos, parciales, deskResp, atencion: attentionCount() };
    }

    function render() {
      const n = cache.tickets?.length || 0;
      refs.count.textContent = n ? String(n) : '';
      refs.refresh.disabled = busy;
      refs.board.disabled = busy;

      if (busy) { refs.stats.innerHTML = `${pacman({ state: 'delegating' })} triando…`; return; }
      if (cache.error) {
        refs.stats.innerHTML = `<span class="bf-err">Error: ${escapeHtml(cache.error)}</span>`;
        return;
      }
      const s = stats();
      // Icónico, poco texto (mismo criterio que Tolkien): bugs+frescura arriba,
      // trabajo+PRs abajo (solo si hay), atención destacada.
      const l1 = cache.updatedAt
        ? `<span class="bf-stat" title="bugs abiertos en el último triage">${icon('bug', { size: 12 })}<b>${s.bugs}</b></span> <span class="bf-sub" title="frescura del triage">${icon('clock', { size: 11 })}${fmtAgo(cache.updatedAt)}</span>`
        : '<span class="bf-sub">Sin triage · corré el ↻</span>';
      const parts = [];
      if (s.pendientes) parts.push(`<span class="bf-stat bf-stat--warn" title="fixes listos para enviar como PR">${icon('gitBranch', { size: 12 })}<b>${s.pendientes}</b> por enviar</span>`);
      if (s.prsAbiertos) parts.push(`<span class="bf-stat" title="PRs abiertos (sin mergear)">${icon('gitCommit', { size: 12 })}<b>${s.prsAbiertos}</b> abierto${s.prsAbiertos === 1 ? '' : 's'}</span>`);
      const l2 = parts.length ? `<div class="bf-line">${parts.join(' ')}</div>` : '';
      // Línea de RESOLUCIÓN (mismo semáforo que el tablero): pipeline SIEMPRE
      // visible como mini-dashboard — 🟢 completos · 🟡 parciales · 🎫 en Desk.
      // El chip en 0 se atenúa (bf-stat--dim); cuando todo está limpio, un
      // "· al día" al final lo aclara. Así el panel nunca queda invisible.
      const res = [
        `<span class="bf-stat ${s.completos ? 'bf-stat--ok' : 'bf-stat--dim'}" title="resueltos y confirmados en Desk (completo)">${icon('check', { size: 12 })}<b>${s.completos}</b></span>`,
        `<span class="bf-stat ${s.parciales ? 'bf-stat--warn' : 'bf-stat--dim'}" title="PR mergeado, ticket sin confirmar (parcial)">${icon('gitCommit', { size: 12 })}<b>${s.parciales}</b></span>`,
        `<span class="bf-stat ${s.deskResp ? '' : 'bf-stat--dim'}" title="Desk respondió, ticket sin resolver">${icon('clipboard', { size: 12 })}<b>${s.deskResp}</b></span>`,
      ];
      const alDia = (!s.completos && !s.parciales && !s.deskResp)
        ? '<span class="bf-sub">· al día</span>' : '';
      const l3 = `<div class="bf-line" title="Resolución del ciclo (completos · parciales · en Desk)">${res.join(' ')} ${alDia}</div>`;
      const atencion = s.atencion
        ? `<div class="bf-att" title="Fixes que necesitan tu atención (reabierto, doble registro o ticket sin actualizar)">⚠ <b>${s.atencion}</b> ${s.atencion === 1 ? 'requiere' : 'requieren'} atención</div>`
        : '';
      refs.stats.innerHTML = `<div class="bf-line">${l1}</div>${l2}${l3}${atencion}`;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const POLL_MS = 3000;
    const MAX_ATTEMPTS = 3;

    async function fetchTriage() { return (await fetch('/api/bugs')).json(); }
    async function fetchFixes() {
      try { return (await (await fetch('/api/bugfixes')).json()).bugfixes || []; } catch { return fixes; }
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
      [cache, fixes] = await Promise.all([
        fetchTriage().catch(() => cache),
        fetchFixes(),
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
        fixes = await fetchFixes();
        render();
      }
    }

    // Abre el TABLERO unificado; al cerrarlo, refresca las stats (pudo cambiar
    // el registro: envíos, cancelaciones, etc.).
    function openBoard() {
      openBugBoard({
        dialog, icon, openChat,
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
    refs.board.addEventListener('click', openBoard);
    // El tablero y el triage son admin (el backend igual los exige).
    ctx.whoami?.then?.((me) => { isAdmin = !!me?.admin; if (isAdmin) refs.board.hidden = false; });

    (async () => {
      try { const st = await (await fetch('/api/tolkien/status')).json(); if (st?.rel) projectRel = st.rel; } catch { /* noop */ }
      reloadStats();
    })();
  },
};
