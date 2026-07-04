// modules/bugs/board/index.js — tablero unificado "Bugs & PRs" (admin).
//
// UNA vista para toda la línea de trabajo del bug: triage de Desk → chat de
// trabajo → fix registrado → PR → feedback/iteraciones → merge → ticket.
// Fuentes por fila (correlación por número de ticket):
//   - registro de bugfixes (~/.cwc-data/bugfixes.json, con history[])
//   - triage de Desk (caché /api/bugs: severidad, duplicado, frescura)
//   - PRs propios SOLO en GitHub (refresh-prs)
// Lo abre el botón "Abrir tablero" de la sección Bugs & Features.
//
// ARQUITECTURA (refactor 2026-07-04, docs/plan-rediseno-movil-tickets.md §2):
//   store.js    estado único (datos + estado UI) — el DOM no guarda NADA (R1)
//   render.js   funciones puras estado→HTML; un solo punto de re-render
//   actions.js  handlers/endpoints; escriben al store, jamás al DOM
//   polls.js    encuestas POR CLAVE, inmunes a re-renders (R2)
//   prompts.js  textos de los chats del ciclo
//   labels.js   fuente única de etiquetas/estados derivados (R3/R4)
//   util.js     esc/fmtDate/fmtAgo compartidos
// Este archivo: composición — modal, wiring de eventos, timers, ciclo de vida.
// Como el re-render es seguro (estado fuera del DOM), el auto-refresh de
// GitHub YA NO se pausa con un detalle abierto (era la deuda 6 del contexto).

import * as store from './store.js';
import * as A from './actions.js';
import { initRender, render, renderHeader, helpHtml, pendingOf } from './render.js';
import { stopAll } from './polls.js';
import { rowKey, ticketOfPr } from './labels.js';
import { dismissablePopup } from '../../../ui/popup.js';

export function openBugBoard({ dialog, icon, openChat, projectRel, updateRepo, onClose }) {
  const m = dialog.openModal({ title: 'Bugs & PRs — Tolkien', width: '90vw', onClose });
  m.card.classList.add('dlg-card--tickets');
  // El maxWidth INLINE de openModal le ganaría al media query fullscreen de
  // .dlg-card--tickets en móvil: se limpia para que mande el CSS.
  m.card.style.maxWidth = '';
  const wrap = document.createElement('div');
  wrap.className = 'bb';
  wrap.innerHTML = `
    <div class="bb-actions">
      <button class="btn btn--sm" data-ref="send" disabled>${icon('gitBranch', { size: 13 })}<span>Enviar pendientes</span></button>
      <button class="btn-ghost btn--sm" data-ref="scan" title="Re-busca en los chats de tickets cambios sin registrar">${icon('sparkle', { size: 13 })}<span>Buscar bugfixes</span></button>
      <button class="btn-ghost btn--sm" data-ref="ghsync" title="Refresca desde GitHub el estado de los PRs (automático mientras el tablero está abierto)">${icon('refresh', { size: 13 })}<span>GitHub</span></button>
      <button class="btn-ghost btn--sm" data-ref="desksync" title="Consulta Zoho Desk el estado REAL de los tickets activos (respuesta publicada, resuelto). CONSUME TOKENS — con confirmación">${icon('download', { size: 13 })}<span>🎫 Desk</span></button>
      <button class="btn-ghost btn--sm btn--icon" data-ref="help" title="¿Cómo leer este tablero? (pipeline, chips, estados)">${icon('help', { size: 15 })}</button>
      <span class="bb-state" data-ref="ghstate"></span>
      <span class="bb-triage" data-ref="triage"></span>
    </div>
    <div class="bb-mhead">
      <div class="bb-mrow">
        <input class="bb-search" data-ref="q" type="search" placeholder="Buscar por #, título, archivo…" autocomplete="off">
        <button class="btn-ghost btn--sm btn--icon bb-more" data-ref="more" title="Más acciones (buscar bugfixes, GitHub, Desk, ayuda)">${icon('more', { size: 16 })}</button>
      </div>
      <div class="bb-segs" data-ref="segs"></div>
      <span class="bb-mfresh" data-ref="mfresh"></span>
    </div>
    <div class="bb-box" data-ref="box">
      <table class="bb-table">
        <thead><tr><th></th><th>TKT</th><th>Título</th><th class="bb-col-pipe">Pipeline</th><th class="bb-col-stats">Cambios</th><th title="¿Implementado en un PR?">PR</th><th title="¿Respondido en Zoho Desk?">Desk</th><th>Estado</th></tr></thead>
        <tbody data-ref="tbody"><tr><td colspan="8"><span class="cwc-spinner"></span></td></tr></tbody>
      </table>
      <div class="bb-cards" data-ref="cards"></div>
    </div>`;
  m.body.appendChild(wrap);
  const mr = {};
  for (const r of wrap.querySelectorAll('[data-ref]')) mr[r.dataset.ref] = r;

  // Estado limpio por apertura (el store es singleton de módulo) + wiring.
  store.reset();
  initRender({ icon, refs: mr });
  A.initActions({ dialog, openChat, projectRel, updateRepo });
  store.subscribe(render);

  // Resuelve la info mínima de una fila por su clave (para las cargas lazy).
  function rowInfoOf(key) {
    const s = store.get();
    const b = s.entries.find((x) => rowKey(x) === key);
    if (b) return b;
    if (key.startsWith('pr:')) {
      const pr = s.ghRows.find((p) => `pr:${p.number}` === key);
      if (pr) return { prNumber: pr.number, ticketNumber: ticketOfPr(pr) };
    }
    if (key.startsWith('tkt:')) return { ticketNumber: key.slice(4) };
    return null;
  }

  // ===== Interacción (listener delegado — las claves salen del data-key).
  // El MISMO handler sirve a la tabla (desktop) y a las cards (móvil): ambas
  // vistas usan .bb-row/.bb-detail + data-key, así que closest() resuelve igual.
  const onListClick = async (e) => {
    const liveBtn = e.target.closest('[data-livefresh]');
    if (liveBtn) { await A.loadLive(Number(liveBtn.dataset.livefresh), true); return; }
    // Investigar a fondo un PR: dispara el runner IA (consume tokens, bajo botón).
    const invBtn = e.target.closest('[data-investigate]');
    if (invBtn) { await A.runInvestigation(invBtn.dataset.investigate, invBtn.dataset.invticket); return; }
    // Investigar el CONTEXTO de un ticket sin PR: lee el código de Tolkien (tokens).
    const tktInvBtn = e.target.closest('[data-tktinvestigate]');
    if (tktInvBtn) {
      let problem = {};
      try { problem = JSON.parse(tktInvBtn.dataset.invproblem || '{}'); } catch { /* enunciado vacío */ }
      await A.runTicketInvestigation(tktInvBtn.dataset.tktinvestigate, problem);
      return;
    }
    // Desk: botón "Traer estado" (primera carga) y ↻ (fresca).
    const deskLoadBtn = e.target.closest('[data-deskload]');
    if (deskLoadBtn) { await A.deskLoad(deskLoadBtn.dataset.deskload, false); return; }
    const deskFresh = e.target.closest('[data-deskfresh]');
    if (deskFresh) { await A.deskLoad(deskFresh.dataset.deskfresh, true); return; }
    // Cabecera "Archivo": muestra/oculta las filas archivadas.
    if (e.target.closest('[data-arch-toggle]')) { A.toggleArch(); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      // Acción sobre un PR solo-GitHub (sin registro local).
      if (act.dataset.act === 'ghdeskchat') {
        const pr = store.get().ghRows.find((p) => String(p.number) === act.dataset.prnum);
        if (pr) {
          const ticket = ticketOfPr(pr);
          m.close();
          await A.deskChat({ ticketNumber: ticket, prNumber: pr.number, prUrl: pr.url, ticketUrl: null, summary: '', history: [] });
        }
        return;
      }
      const key = act.closest('.bb-detail')?.dataset?.key;
      const b = store.get().entries.find((x) => rowKey(x) === key);
      if (act.dataset.act === 'triagework') {
        const t = (store.get().triage.tickets || []).find((x) => String(x.ticketNumber) === act.dataset.tkt);
        if (t) { m.close(); await A.workOnTriage(t); }
      } else if (act.dataset.act === 'work' && b) { m.close(); await A.workOn(b); }
      else if (act.dataset.act === 'deskchat' && b) { m.close(); await A.deskChat(b); }
      else if (act.dataset.act === 'cancelpr' && b) await A.cancelPr(b);
      else if (act.dataset.act === 'archive' && b) await A.archive(b, true);
      else if (act.dataset.act === 'unarchive' && b) await A.archive(b, false);
      else if (act.dataset.act === 'del' && b) await A.discard(b);
      return;
    }
    if (e.target.closest('a')) return;
    const row = e.target.closest('.bb-row');
    if (!row?.dataset?.key) return; // las filas solo-GitHub TAMBIÉN expanden
    A.toggleExpand(row.dataset.key, rowInfoOf(row.dataset.key));
  };
  mr.tbody.addEventListener('click', onListClick);
  mr.cards.addEventListener('click', onListClick);

  // ===== Header móvil (Fase 3): búsqueda + segmentos + menú ⋯ =====
  mr.q.addEventListener('input', () => store.set({ query: mr.q.value }));
  mr.segs.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-seg]');
    if (!chip) return;
    const seg = chip.dataset.seg;
    store.set({ filter: store.get().filter === seg ? null : seg }); // re-tap = "Todos"
  });
  // Menú ⋯: las acciones episódicas del toolbar desktop (no merecen superficie
  // permanente en 375px). "Enviar pendientes" vive acá HASTA la Fase 5 (action
  // bar sticky inferior de la lista).
  mr.more.addEventListener('click', () => {
    const pend = pendingOf(store.get().entries).length;
    const menu = document.createElement('div');
    menu.className = 'cwc-popup-menu';
    menu.innerHTML = `
      <button class="cwc-popup-item" data-mact="send" ${pend ? '' : 'disabled'}>${icon('gitBranch', { size: 14 })}<span>Enviar pendientes${pend ? ` (${pend})` : ''}</span></button>
      <button class="cwc-popup-item" data-mact="scan">${icon('sparkle', { size: 14 })}<span>Buscar bugfixes</span></button>
      <button class="cwc-popup-item" data-mact="gh">${icon('refresh', { size: 14 })}<span>Sincronizar GitHub</span></button>
      <button class="cwc-popup-item" data-mact="desk">${icon('download', { size: 14 })}<span>🎫 Consultar Desk</span></button>
      <button class="cwc-popup-item" data-mact="help">${icon('help', { size: 14 })}<span>Cómo leer el tablero</span></button>`;
    document.body.appendChild(menu);
    const r = mr.more.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    const dismiss = dismissablePopup(menu, { onDismiss: () => menu.remove() });
    menu.addEventListener('click', (e) => {
      const it = e.target.closest('[data-mact]');
      if (!it || it.disabled) return;
      dismiss();
      ({ send: () => A.sendPending(), scan: () => A.scan(), gh: () => A.ghSync(false), desk: () => A.deskSyncBulk(), help: openHelp })[it.dataset.mact]?.();
    });
  });

  // ===== Header =====
  mr.send.addEventListener('click', () => A.sendPending());
  mr.scan.addEventListener('click', () => A.scan());
  mr.ghsync.addEventListener('click', () => A.ghSync(false));
  mr.desksync.addEventListener('click', () => A.deskSyncBulk());
  // Modal "Cómo leer este tablero": explica la nomenclatura del tablero.
  const openHelp = () => {
    const h = dialog.openModal({ title: 'Cómo leer este tablero', width: 460 });
    h.body.innerHTML = helpHtml();
  };
  mr.help.addEventListener('click', openHelp);

  // Auto-refresco de GitHub (BARATO: solo gh, sin tokens) mientras el tablero
  // está abierto, para que los merges de Chris aparezcan solos. Con el estado
  // fuera del DOM el re-render preserva detalle abierto, paneles y scroll —
  // YA NO se pausa con un panel abierto (único cambio de comportamiento del
  // refactor, autorizado por el plan §Fase 1).
  const GH_AUTO_MS = 45000;
  const ghTimer = setInterval(() => { if (!document.hidden) A.ghSync(true); }, GH_AUTO_MS);
  const freshTimer = setInterval(() => renderHeader(store.get()), 20000); // solo re-pinta "hace X"
  const onVis = () => { if (!document.hidden) A.ghSync(true); };
  document.addEventListener('visibilitychange', onVis);
  const origClose = m.close;
  m.close = () => {
    clearInterval(ghTimer); clearInterval(freshTimer);
    document.removeEventListener('visibilitychange', onVis);
    stopAll(); // los runners server-side siguen; los loops del cliente mueren acá
    origClose();
  };

  // Al abrir: registro + triage al instante; GitHub completa enseguida.
  A.reload().then(() => A.ghSync(true));
  return m;
}
