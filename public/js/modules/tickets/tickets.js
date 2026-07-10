// modules/tickets/tickets.js — sección "Tickets & Features" del sidebar. Muestra un
// resumen barato del dashboard determinístico (GET /api/tickets/dashboard, sin
// IA, sin tokens) y abre el modal con las vistas completas. Reemplazó a
// "Bugs & Features" v1 (archivado en _archived/) — ver plan en
// ~/pool of documents/2026-07-06_plan-backend-deterministico-lectura-desk_v01.md.
import { openBugsV2Dashboard } from './dashboard.js';

export default {
  name: 'tickets',

  mount(el, ctx) {
    const { icon, openChat } = ctx;
    let isAdmin = false;
    let busy = false;
    let data = null;
    let projectRel = 'tolkien';
    // Rel del proyecto para el cwd de las sesiones que abren los tickets.
    (async () => { try { const st = await (await fetch('/api/tolkien/status')).json(); if (st?.rel) projectRel = st.rel; } catch { /* noop */ } })();

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot sec-dot--idle" data-ref="dot" title="Tickets & Features"></span>
        <span class="sec-title">Tickets &amp; Features</span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Leer Zoho (determinístico, sin tokens)">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="tk-card bf-card">
        <div class="bv2-sum" data-ref="sum"><span class="bf-sub">sin cargar</span></div>
        <div class="tk-actions">
          <button class="btn-ghost btn--sm btn--block" data-ref="open" hidden>${icon('grid', { size: 13 })}<span>Ver dashboard</span></button>
        </div>
      </div>`;

    const refs = {};
    for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

    function render() {
      if (busy) { refs.sum.innerHTML = `<span class="bf-sub">${icon('clock', { size: 11 })} leyendo…</span>`; return; }
      if (!data) { refs.sum.innerHTML = '<span class="bf-sub">sin cargar · tocá ↻</span>'; return; }
      if (data.error) { refs.sum.innerHTML = `<span class="bf-err">${escapeHtml(data.error)}</span>`; return; }
      if (data.loading) { refs.sum.innerHTML = `<span class="bf-sub">${icon('clock', { size: 11 })} generando snapshot…</span>`; return; }
      const c = data.counts || {};
      refs.sum.innerHTML = `
        <div class="bv2-sum-main">${c.open ?? 0} abiertos</div>
        <div class="bv2-sum-chips">
          <span class="bb-chip bb-chip--info" title="Nuevos · sin triar">🆕 ${c.nuevos ?? 0}</span>
          <span class="bb-chip bb-chip--danger" title="Vencidos (SLA roto o 7+ días sin update)">🔴 ${c.vencidos ?? 0}</span>
          <span class="bb-chip bb-chip--warn" title="En progreso">🔧 ${c.enProgreso ?? 0}</span>
        </div>`;
      if (refs.dot) refs.dot.className = `sec-dot sec-dot--${(c.vencidos > 0) ? 'alert' : (c.open ? 'ok' : 'idle')}`;
    }

    async function load(force) {
      if (busy || !isAdmin) return;
      busy = true;
      // Solo mostramos el placeholder "leyendo…" en la PRIMERA carga o en un
      // refresh manual (↻). En el auto-refresh de fondo (cada 60s) NO pisamos
      // el contenido: si no, la altura salta (1 línea "leyendo…" ↔ 2 líneas de
      // resumen) y parece que la sección se contrae/expande sola (reportado
      // por el usuario 2026-07-07).
      if (!data || force) render();
      try {
        const res = await fetch(`/api/tickets/dashboard${force ? '?force=1' : ''}`);
        data = await res.json();
      } catch (e) {
        data = { error: `Error de red: ${e?.message || e}` };
      } finally {
        busy = false;
        refs.open.hidden = !isAdmin;
        render();
      }
    }

    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    refs.refresh.addEventListener('click', () => load(true));
    refs.open.addEventListener('click', () => openBugsV2Dashboard({ openChat, projectRel: () => projectRel }));

    ctx.whoami?.then?.((me) => {
      isAdmin = !!me?.admin;
      refs.refresh.disabled = !isAdmin;
      if (isAdmin) {
        refs.open.hidden = false;
        load(false);
        // Auto-refresh del resumen cada 60s: lee del snapshot (instantáneo,
        // sin forzar) — el backend ya se re-computa solo en background.
        setInterval(() => { if (!document.hidden && !busy) load(false); }, 60_000);
      } else {
        refs.sum.innerHTML = '<span class="bf-sub">requiere admin</span>';
      }
    });
  },
};
