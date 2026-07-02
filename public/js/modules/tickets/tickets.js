// modules/tickets/tickets.js — "Bugs": triage de tickets de Tolkien.
//
// Sección compacta bajo Tolkien. Muestra la caché del triage (GET /api/tickets)
// y permite correrlo BAJO DEMANDA (POST /api/tickets/refresh) — con aviso de
// que consume tokens reales; NUNCA hay polling automático. "Expandir" abre una
// ventana flotante con la tabla; un click en un ticket abre una conversación
// Chat en el proyecto (modo plan) con el contexto del bug precargado.
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
      if (busy) { refs.line.innerHTML = '<span class="cwc-spinner"></span> triando…'; return; }
      if (cache.error) {
        refs.line.innerHTML = `<span class="tickets-err">Error: ${escapeHtml(cache.error)}</span>`;
        return;
      }
      refs.line.textContent = n
        ? `${n} bug${n === 1 ? '' : 's'} · ${fmtAgo(cache.updatedAt)}`
        : (cache.updatedAt ? `Sin bugs abiertos · ${fmtAgo(cache.updatedAt)}` : 'Sin datos · corré el triage');
    }

    async function load() {
      try { cache = await (await fetch('/api/tickets')).json(); } catch { /* noop */ }
      render();
    }

    async function refresh() {
      if (busy) return;
      const ok = await dialog.confirmDialog({
        title: 'Correr triage de bugs',
        message: 'Ejecuta el triage con Claude sobre los tickets [Tolkien Bug] de Zoho Desk.\nCONSUME TOKENS reales y puede tardar 1–3 minutos. Es de solo lectura (no crea ni cambia nada).',
        confirmLabel: 'Correr triage',
      });
      if (!ok) return;
      busy = true; render();
      try {
        cache = await (await fetch('/api/tickets/refresh', { method: 'POST' })).json();
      } catch {
        cache = { ...cache, error: 'No se pudo correr el triage (red o servidor).' };
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
          <button class="btn-ghost btn--sm" data-ref="mcontext" title="Cómo se trabaja un bug (verificación previa, proceso); se inyecta en cada 'Trabajar en Chat'">${icon('edit', { size: 13 })}<span>Contexto</span></button>
          <button class="btn-ghost btn--sm" data-ref="mrefresh">${icon('refresh', { size: 13 })}<span>Re-triar</span></button>
        </div>
        <div class="tickets-table-wrap" data-ref="table"></div>`;
      m.body.appendChild(wrap);
      const sub = wrap.querySelector('[data-ref="sub"]');
      const tableEl = wrap.querySelector('[data-ref="table"]');
      const mrefresh = wrap.querySelector('[data-ref="mrefresh"]');

      // Contexto de TRABAJO del bug (kind=work): es parte del módulo Bugs.
      // (La redacción de las notas del PR se edita en el modal Enviar PR.)
      wrap.querySelector('[data-ref="mcontext"]').addEventListener('click', async () => {
        let data = { context: '' };
        try { data = await (await fetch('/api/bugfixes/context?kind=work')).json(); }
        catch { return dialog.alertDialog({ title: 'Contexto', message: 'No se pudo leer el contexto.' }); }
        dialog.textEditorDialog({
          title: 'Contexto de trabajo de bugs',
          hint: `Define CÓMO se trabaja un bug (verificación previa del ticket y de PRs de Chris, proceso de resolución, no enviar el PR desde el chat). Se inyecta en cada "Trabajar en Chat"${data.isDefault ? ' — estás viendo el default' : ''}.`,
          value: data.context,
          onSave: async (text) => {
            const res = await fetch('/api/bugfixes/context', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ kind: 'work', context: text }),
            });
            const out = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(out.error || 'No se pudo guardar.');
          },
        });
      });

      function paint() {
        sub.textContent = cache.error
          ? `Error: ${cache.error}`
          : `${cache.tickets.length} bug(s) · actualizado ${fmtAgo(cache.updatedAt)}`;
        mrefresh.disabled = busy;
        tableEl.innerHTML = '';
        if (busy) { tableEl.innerHTML = '<div class="cwc-loading"><span class="cwc-spinner"></span>triando…</div>'; return; }
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
      // Contextos EDITABLES: 'work' (botón Contexto de la vista expandida de
      // Bugs — cómo se trabaja el bug) y 'pr' (botón Contexto del modal
      // Enviar PR — cómo se redacta el cierre que alimenta las notas del PR).
      // Si no se pueden leer, el chat sale igual sin ellos.
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
