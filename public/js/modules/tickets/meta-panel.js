// modules/tickets/meta-panel.js — 2ª columna COMPARTIDA por ticket-detail y
// pr-detail: "Contexto adicional" (una charla/transcripción interpretada por IA)
// + "Histórico del trabajo" (resumen de cada sesión que trabajó el ítem). Fuente
// única: el MISMO HTML, los MISMOS handlers y la MISMA inyección al prompt del
// chat para tickets, features y PRs (no se duplica render entre las dos ventanas).
//
// Backend: GET /api/tickets/{ticket|pr} trae `meta` (overlay de meta-store.js).
// `key` = ticketNumber ('123' — tickets y features) o 'pr:<n>' (PRs).
import { icon } from '../../ui/icons.js';
import { confirmDialog } from '../../ui/dialog.js';
import { t } from '../../ui/i18n.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDate(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

// HTML de la 2ª columna (aside). `meta` = { contextoAdicional, contextoAt, historico[] }.
export function metaSideHtml(meta) {
  const m = meta || { contextoAdicional: '', contextoAt: null, historico: [] };
  const ctx = m.contextoAdicional || '';
  const hist = Array.isArray(m.historico) ? m.historico : [];

  const ctxHtml = ctx
    ? `<div class="tkm-ctx-text">${esc(ctx)}</div>
       <div class="tkm-ctx-acts">
         <button class="btn-ghost btn--sm" data-act="ctx-edit">${icon('edit', { size: 12 })}<span>${t('tickets.meta.edit', 'Editar')}</span></button>
         <button class="btn-ghost btn--sm" data-act="ctx-clear">${icon('close', { size: 12 })}<span>${t('tickets.meta.delete', 'Borrar')}</span></button>
       </div>
       ${m.contextoAt ? `<div class="bf-sub">${t('tickets.meta.updatedShort', 'act. {d}', { d: fmtDate(m.contextoAt) })}</div>` : ''}`
    : `<div class="bf-sub">${t('tickets.meta.noContext', 'Sin contexto adicional. Pegá una transcripción de una charla y la IA la interpreta.')}</div>`;

  const histHtml = hist.length
    ? hist.slice().reverse().map((h) => `<details class="tkm-hist-item">
        <summary>${icon('clock', { size: 11 })} ${fmtDate(h.at)}${h.files?.length ? ` · ${h.files.length} ${t('tickets.common.filesAbbr', 'arch.')}` : ''}</summary>
        ${h.resumen ? `<div class="tkm-hist-sum">${esc(h.resumen)}</div>` : `<div class="bf-sub">${t('tickets.meta.noSummary', '(sin resumen)')}</div>`}
        ${h.files?.length ? `<div class="tkm-hist-files">${h.files.map((f) => `<code>${esc(f)}</code>`).join('')}</div>` : ''}
      </details>`).join('')
    : `<div class="bf-sub">${t('tickets.meta.noHistory', 'Todavía no se trabajó este ítem en un chat. Al cerrar una sesión de trabajo se guarda el resumen acá.')}</div>`;

  // Contenido interno (SIN <aside>): cada ventana lo ubica en su columna derecha
  // — ticket-detail lo envuelve en un aside propio; pr-detail lo suma al aside
  // del Pad ya existente.
  return `
    <div class="tkm-side">
      <div class="bv2-sec-h">${icon('sparkle', { size: 12 })} ${t('tickets.meta.contextHeading', 'Contexto adicional')}</div>
      <div class="tkm-ctx" data-ref="ctxbox">${ctxHtml}</div>
      <details class="tkm-add">
        <summary>${icon('play', { size: 11 })} ${t('tickets.meta.interpretSummary', 'Interpretar una charla / transcripción')}</summary>
        <textarea class="tkm-ta" data-ref="ta" rows="5" placeholder="${t('tickets.meta.transcriptPlaceholder', 'Pegá acá la transcripción de la conversación con el cliente o el equipo…')}"></textarea>
        <div class="tkm-add-acts">
          <button class="btn-ghost btn--sm" data-act="ctx-analyze">${icon('sparkle', { size: 12 })}<span>${t('tickets.meta.interpretAi', 'Interpretar con IA')}</span></button>
          <span class="tkm-status bf-sub" data-ref="status"></span>
        </div>
      </details>
      <div class="bv2-sec-h">${icon('clock', { size: 12 })} ${t('tickets.meta.historyHeading', 'Histórico del trabajo · {n}', { n: hist.length })}</div>
      <div class="tkm-hist">${histHtml}</div>
    </div>`;
}

// Cablea los handlers del panel. `key` = ticketNumber o 'pr:<n>'. `onChanged`
// se llama tras interpretar/guardar/borrar (para re-fetchear y re-renderizar).
export function wireMetaPanel({ box, key, itemTitle = '', itemDesc = '', onChanged }) {
  const statusEl = box.querySelector('[data-ref="status"]');
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t || ''; };
  const btn = box.querySelector('[data-act="ctx-analyze"]');

  box.querySelector('[data-act="ctx-clear"]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: t('tickets.meta.clearTitle', 'Borrar contexto adicional'), message: t('tickets.meta.clearMsg', '¿Seguro? Se elimina el contexto adicional guardado de este ítem.'), confirmLabel: t('tickets.meta.delete', 'Borrar'), danger: true });
    if (!ok) return;
    try { await fetch('/api/tickets/meta/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, text: '' }) }); } catch { /* noop */ }
    onChanged?.();
  });

  // Editar el texto ya guardado: lo cargamos en el textarea del bloque de abajo.
  box.querySelector('[data-act="ctx-edit"]')?.addEventListener('click', () => {
    const cur = box.querySelector('.tkm-ctx-text')?.textContent || '';
    const ta = box.querySelector('[data-ref="ta"]');
    const details = box.querySelector('.tkm-add');
    if (ta && details) { details.open = true; ta.value = cur; ta.dataset.editing = '1'; if (btn) btn.querySelector('span').textContent = t('tickets.meta.saveEdit', 'Guardar edición'); ta.focus(); }
  });

  box.querySelector('[data-act="ctx-analyze"]')?.addEventListener('click', async () => {
    const ta = box.querySelector('[data-ref="ta"]');
    const text = (ta?.value || '').trim();
    // Edición manual del texto ya guardado → guardar directo, sin IA ni tokens.
    if (ta?.dataset.editing === '1') {
      setStatus(t('tickets.meta.saving', 'Guardando…'));
      try { await fetch('/api/tickets/meta/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, text }) }); } catch { setStatus(t('tickets.meta.netError', 'Error de red.')); return; }
      onChanged?.();
      return;
    }
    if (text.length < 20) { setStatus(t('tickets.meta.pasteMin', 'Pegá una transcripción (mín. 20 caracteres).')); return; }
    const ok = await confirmDialog({ title: t('tickets.meta.interpretAi', 'Interpretar con IA'), message: t('tickets.meta.interpretMsg', 'Corre una interpretación con IA (consume tokens) y se guarda como Contexto adicional del ítem. ¿Seguir?'), confirmLabel: t('tickets.meta.interpret', 'Interpretar') });
    if (!ok) return;
    setStatus(t('tickets.meta.interpreting', 'Interpretando…'));
    if (btn) btn.disabled = true;
    let res;
    try {
      res = await (await fetch('/api/tickets/meta/context-analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, transcript: text, itemTitle, itemDesc }) })).json();
    } catch { setStatus(t('tickets.meta.netError', 'Error de red.')); if (btn) btn.disabled = false; return; }
    if (!res?.id) { setStatus(res?.error || t('tickets.meta.cantStart', 'No se pudo iniciar.')); if (btn) btn.disabled = false; return; }
    if (res.status === 'done') { onChanged?.(); return; }
    let n = 0;
    const poll = async () => {
      n += 1;
      let job = null;
      try { job = await (await fetch(`/api/tickets/meta/context-analyze/${res.id}`)).json(); } catch { /* red intermitente: reintenta */ }
      if (job?.status === 'done') { setStatus(t('tickets.meta.done', 'Listo ✓')); onChanged?.(); return; }
      if (job?.status === 'error') { setStatus(job.error || t('tickets.meta.interpretFailed', 'Falló la interpretación.')); if (btn) btn.disabled = false; return; }
      if (n > 150) { setStatus(t('tickets.meta.timeout', 'Tardó demasiado.')); if (btn) btn.disabled = false; return; }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  });
}

// Contextos de trabajo EDITABLES (Sistema → Proyectos → "Tickets & Features"):
//   'work' = cómo se trabaja un ticket (Pensamiento Profundo, triage, causa raíz,
//            gate de push).
//   'pr'   = house style de la descripción del PR.
// Se guardan en ~/.cwc-data/bugfix-*.md y se sirven por GET /api/tickets/context.
// Se inyectan en cada chat de "Continuar en el chat" (ticket, feature y PR).
// Migrado de v1 (board/prompts.js:fetchContexts) al portar el ciclo a Tickets v2.
export async function fetchWorkflowContexts() {
  try {
    const [work, pr] = await Promise.all([
      fetch('/api/tickets/context?kind=work').then((r) => r.json()),
      fetch('/api/tickets/context?kind=pr').then((r) => r.json()),
    ]);
    return { work: work?.context || '', pr: pr?.context || '' };
  } catch { return { work: '', pr: '' }; }
}

// Bloques de texto de esos contextos, listos para apendear al prompt del chat.
// Devuelve un array de líneas (vacío si no hay nada configurado).
export function workflowContextBlocks({ work, pr } = {}) {
  const out = [];
  if (work) out.push(`\n--- CONTEXTO DE TRABAJO (seguilo al pie de la letra) ---\n${work}\n---`);
  if (pr) out.push(`\n--- REDACCIÓN DEL PR (así se escribe tu cierre) ---\n${pr}\n---`);
  return out;
}

// Bloques para inyectar en el prompt del chat (contexto + histórico de sesiones
// previas). Devuelve un array de líneas (vacío si no hay nada que aportar).
export function metaPromptBlocks(meta) {
  const m = meta || {};
  const out = [];
  if (m.contextoAdicional) out.push('== Contexto adicional ==', m.contextoAdicional, '');
  const hist = Array.isArray(m.historico) ? m.historico : [];
  if (hist.length) {
    out.push('== Histórico del trabajo (sesiones anteriores) ==');
    for (const h of hist.slice(-8)) {
      out.push(`— ${fmtDate(h.at)}${h.files?.length ? ` · archivos: ${h.files.slice(0, 10).join(', ')}` : ''}`);
      if (h.resumen) out.push(h.resumen);
    }
    out.push('');
  }
  return out;
}
