// modules/tickets/tickets.js — "Bugs": triage de tickets de Tolkien.
//
// Sección compacta bajo Tolkien. Muestra la caché del triage (GET /api/tickets)
// y permite correrlo BAJO DEMANDA (POST /api/tickets/refresh) — con aviso de
// que consume tokens reales; NUNCA hay polling automático. "Expandir" abre una
// ventana flotante con la tabla; un click en un ticket abre una conversación
// Chat en el proyecto (modo plan) con el contexto del bug precargado.
import { pacman } from '../../ui/pacman.js';

export default {
  name: 'tickets',

  mount(el, ctx) {
    const { icon, dialog, openChat } = ctx;
    let cache = { updatedAt: null, tickets: [], error: null, running: false };
    let projectRel = 'tolkien';
    let busy = false;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-title">Bugs</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Correr triage (consume tokens)">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="tk-card tickets-card">
        <div class="tickets-line" data-ref="line">…</div>
        <div class="tk-actions">
          <button class="btn-ghost btn--sm" data-ref="expand">${icon('grid', { size: 13 })}<span>Expandir</span></button>
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

    function render() {
      const n = cache.tickets?.length || 0;
      refs.count.textContent = n ? String(n) : '';
      refs.refresh.disabled = busy;
      refs.expand.disabled = busy || !n;
      if (busy) { refs.line.innerHTML = `${pacman()} triando…`; return; }
      if (cache.error) {
        refs.line.innerHTML = `<span class="tickets-err">Error: ${escapeHtml(cache.error)}</span>`;
        return;
      }
      refs.line.textContent = n
        ? `${n} bug${n === 1 ? '' : 's'} · ${fmtAgo(cache.updatedAt)}`
        : (cache.updatedAt ? `Sin bugs abiertos · ${fmtAgo(cache.updatedAt)}` : 'Sin datos · corré el triage');
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const POLL_MS = 3000;
    const MAX_ATTEMPTS = 3;

    async function fetchStatus() {
      return (await fetch('/api/tickets')).json();
    }

    // Espera el FIN del triage encuestando el estado cada 3 s. Aguanta cortes
    // de red (fetch fallido = seguir esperando: la corrida vive en el server,
    // no en este fetch) y reinicios del server (vuelve a contestar y se sigue).
    async function waitForRun() {
      for (;;) {
        await sleep(POLL_MS);
        let st;
        try { st = await fetchStatus(); } catch { continue; } // red caída: reintentar el poll
        if (!st.running) return st;
      }
    }

    async function load() {
      try { cache = await fetchStatus(); } catch { /* noop */ }
      // Triage ya corriendo (otro usuario/pestaña, o recarga a mitad de una
      // corrida): reflejarlo y esperar el resultado en vez de mostrarlo quieto.
      if (cache.running && !busy) {
        busy = true; render();
        cache = await waitForRun();
        busy = false;
      }
      render();
    }

    // Corre el triage con ARRANCAR + ENCUESTAR + REINTENTO: el POST responde
    // al instante y el resultado se espera por polling (un POST de 1–3 min se
    // cortaba en móvil aunque el triage siguiera corriendo). Si el server se
    // reinició a mitad de corrida (la corrida vive en el proceso Node y muere
    // con él), se detecta —dejó de correr SIN datos nuevos ni error— y se
    // RE-DISPARA solo, hasta 3 intentos con 3 s de espera.
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
          // Disparo. Si este fetch falla (red/reinicio justo ahora) no es
          // fatal: el poll de abajo averigua la verdad y se reintenta.
          try {
            const res = await fetch('/api/tickets/refresh', { method: 'POST' });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error || 'No se pudo iniciar el triage.');
          } catch (e) {
            if (String(e.message || '').includes('administrador')) { // 403: reintentar no ayuda
              cache = { ...cache, error: e.message };
              return;
            }
          }
          const st = await waitForRun();
          cache = st;
          const finished = st.updatedAt !== prevUpdatedAt || st.error;
          if (finished) return;
          // Terminó sin datos nuevos NI error: la corrida se perdió (reinicio
          // del server a mitad de triage). Reintentar con espera.
          if (attempt >= MAX_ATTEMPTS) {
            cache = { ...st, error: `El triage se interrumpió ${MAX_ATTEMPTS} veces (¿el servidor se está reiniciando?). Probá de nuevo en un rato.` };
            return;
          }
          await sleep(3000);
        }
      } finally {
        busy = false; render();
      }
    }

    // ===== Ventana flotante con la tabla =====
    function expand() {
      const m = dialog.openModal({ title: 'Bugs de Tolkien · triage', width: '90vw' });
      m.card.classList.add('dlg-card--tickets');
      const wrap = document.createElement('div');
      wrap.className = 'tickets-modal';
      wrap.innerHTML = `
        <div class="tickets-modal-head">
          <span class="tickets-modal-sub" data-ref="sub"></span>
          <button class="btn-ghost btn--sm" data-ref="mrefresh">${icon('refresh', { size: 13 })}<span>Re-triar</span></button>
        </div>
        <div class="tickets-table-wrap" data-ref="table"></div>`;
      m.body.appendChild(wrap);
      const sub = wrap.querySelector('[data-ref="sub"]');
      const tableEl = wrap.querySelector('[data-ref="table"]');
      const mrefresh = wrap.querySelector('[data-ref="mrefresh"]');

      // El contexto de TRABAJO del bug (kind=work) ya no se edita acá: se
      // mudó a ⚙ Sistema → Proyectos ("Bugfixes: Trabajo"). Acá solo queda
      // el triage/tabla.

      function paint() {
        sub.textContent = cache.error
          ? `Error: ${cache.error}`
          : `${cache.tickets.length} bug(s) · actualizado ${fmtAgo(cache.updatedAt)}`;
        mrefresh.disabled = busy;
        tableEl.innerHTML = '';
        if (busy) { tableEl.innerHTML = `<div class="cwc-loading">${pacman()}triando…</div>`; return; }
        if (!cache.tickets.length) { tableEl.innerHTML = '<div class="tickets-empty">Sin bugs abiertos.</div>'; return; }
        const table = document.createElement('table');
        table.className = 'tickets-table';
        table.innerHTML = `
          <thead><tr>
            <th>#</th><th>Qué se rompió</th><th>Ruta</th><th>Sev.</th><th>Rec.</th>
          </tr></thead><tbody></tbody>`;
        const tbody = table.querySelector('tbody');
        for (const t of cache.tickets) {
          const tr = document.createElement('tr');
          tr.className = 'tickets-row';
          tr.title = 'Abrir una conversación para trabajar este bug';
          tr.innerHTML = `
            <td class="tk-num">${escapeHtml(t.ticketNumber)}</td>
            <td class="tk-what">${escapeHtml(t.whatBroke)}${t.duplicate ? ` <span class="tk-dup">dup: ${escapeHtml(t.duplicate)}</span>` : ''}</td>
            <td class="tk-route">${escapeHtml(t.route || '—')}</td>
            <td><span class="tk-sev tk-sev-${t.severity}">${t.severity}</span></td>
            <td class="tk-rec">${escapeHtml(t.recommendation)}</td>`;
          tr.addEventListener('click', () => { m.close(); openDetail(t); });
          tbody.appendChild(tr);
        }
        tableEl.appendChild(table);
      }

      mrefresh.addEventListener('click', async () => { await refresh(); paint(); });
      paint();
    }

    // Vista detallada de UN bug: todos los datos + contexto del triage.
    // Desde acá se decide abrir la conversación (no directo desde la tabla).
    function openDetail(t) {
      const m = dialog.openModal({ title: `Bug · ticket #${t.ticketNumber}`, width: 620 });
      const d = document.createElement('div');
      d.className = 'ticket-detail';
      d.innerHTML = `
        <div class="ticket-detail-head">
          <span class="tk-sev tk-sev-${t.severity}">${t.severity}</span>
          <span class="ticket-detail-rec">${escapeHtml(t.recommendation)}</span>
          ${t.duplicate ? `<span class="tk-dup">dup: ${escapeHtml(t.duplicate)}</span>` : ''}
        </div>
        <p class="ticket-detail-what">${escapeHtml(t.whatBroke)}</p>
        <div class="ticket-detail-meta">
          ${t.route ? `<div><span class="tdm-label">Ruta</span><code>${escapeHtml(t.route)}</code></div>` : ''}
          ${t.reporter ? `<div><span class="tdm-label">Reportó</span>${escapeHtml(t.reporter)}</div>` : ''}
          ${t.webUrl ? `<div><span class="tdm-label">Ticket</span><a href="${escapeHtml(t.webUrl)}" target="_blank" rel="noopener">abrir en Zoho Desk ↗</a></div>` : ''}
        </div>
        <div class="ticket-detail-ctx">
          <div class="tdm-label">Contexto (según el triage)</div>
          <p>${t.context ? escapeHtml(t.context) : 'Sin contexto guardado — re-corré el triage para generarlo.'}</p>
        </div>
        <div class="dlg-actions">
          <button class="btn-ghost" data-ref="back">‹ Volver a la lista</button>
          <button class="btn" data-ref="work">${icon('sparkle', { size: 14 })}<span>Trabajar en Chat (plan)</span></button>
        </div>`;
      m.body.appendChild(d);
      d.querySelector('[data-ref="back"]').addEventListener('click', () => { m.close(); expand(); });
      d.querySelector('[data-ref="work"]').addEventListener('click', () => { m.close(); openTicketChat(t); });
    }

    async function openTicketChat(t) {
      // Contextos EDITABLES desde ⚙ Sistema → Proyectos ("Bugfixes: Trabajo"
      // / "Bugfixes: PR"): 'work' cómo se trabaja el bug, 'pr' cómo se
      // redacta el cierre que alimenta las notas del PR. Si no se pueden
      // leer, el chat sale igual sin ellos.
      let workContext = '';
      let prContext = '';
      try {
        [workContext, prContext] = (await Promise.all([
          fetch('/api/bugfixes/context?kind=work').then((r) => r.json()),
          fetch('/api/bugfixes/context?kind=pr').then((r) => r.json()),
        ])).map((d) => d.context || '');
      } catch { /* noop */ }
      const prompt = [
        `Trabajemos el bug del ticket Desk #${t.ticketNumber}.`,
        '',
        `Qué se rompió: ${t.whatBroke}`,
        `Ruta: ${t.route || '(sin ruta)'}`,
        `Severidad: ${t.severity} · Recomendación del triage: ${t.recommendation}`,
        t.reporter ? `Reportó: ${t.reporter}` : '',
        t.webUrl ? `Ticket: ${t.webUrl}` : '',
        t.context ? `\nContexto del triage:\n${t.context}` : '',
        workContext ? `\n--- CONTEXTO DE TRABAJO (seguilo al pie de la letra) ---\n${workContext}\n---` : '',
        prContext ? `\n--- REDACCIÓN DEL PR (así se escribe tu cierre) ---\n${prContext}\n---` : '',
        '',
        'Estás en modo PLAN: investigá el código relevante y proponé un plan de arreglo antes de tocar nada.',
      ].filter(Boolean).join('\n');
      // La conversación nace nombrada como el ticket y VINCULADA a él: al
      // cerrarla, el server registra el fix propuesto (pestaña Salud → PR).
      openChat({
        cwd: projectRel,
        mode: 'plan',
        prompt,
        title: `TKT #${t.ticketNumber} — ${t.whatBroke}`.slice(0, 60),
        ticket: { number: t.ticketNumber, url: t.webUrl || null },
      });
    }

    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    refs.refresh.addEventListener('click', refresh);
    refs.expand.addEventListener('click', expand);

    (async () => {
      try { const st = await (await fetch('/api/tolkien/status')).json(); if (st?.rel) projectRel = st.rel; } catch { /* noop */ }
      load();
    })();
  },
};
