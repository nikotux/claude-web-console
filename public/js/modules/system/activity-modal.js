// system/activity-modal.js — ventana de detalle del panel de "Actividad en
// Segundo Plano" (proyecto ROAD-76). Tabla dinámica, agrupada tipo árbol
// (convención UI colapsable+árbol), con los SUBAGENTES (chats delegando) y los
// PROCESOS/runners desacoplados vivos ahora. La abre el widget del pie de la
// barra derecha (ui/activity-widget.js). Es DINÁMICA en dos planos:
//   1. El widget, en cada poll de 8 s, llama refreshActivityModal(data) si la
//      ventana está abierta → filas aparecen/desaparecen en vivo.
//   2. Un timer propio de 1 s hace "tictac" el "tiempo corriendo" sin esperar
//      al poll (percepción de vivo).
// 0 tokens: solo pinta lo que ya trae el poll (/api/health/active-runners +
// /api/chat/list).
import { openModal } from '../../ui/dialog.js';
import { icon, hydrateIcons } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { modelColor, modelName } from '../../ui/models.js';

const KNOWN_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
let handle = null; // { modal, opts, render, timer } mientras está abierta

export function activityModalOpen() { return !!handle; }

export function refreshActivityModal(data) {
  if (handle) handle.render(data);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Formato relativo vivo ("45s", "1m 20s", "1h 5m").
function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function modelChip(model) {
  const m = KNOWN_MODELS.includes(model) ? model : null;
  return m
    ? `<span class="act-model" style="--m:${modelColor(m)}">${esc(modelName(m))}</span>`
    : '<span class="act-model act-model--none">—</span>';
}

function rowHtml(item) {
  const isAgent = item.kind === 'agent';
  const ico = isAgent ? 'sparkle' : (item.icon || 'gear');
  const what = isAgent
    ? `${t('system.activity.subagent', 'Subagente')}${item.count > 1 ? ` ×${item.count}` : ''}`
    : (item.label || item.key || t('system.activity.process', 'Proceso'));
  const phase = item.phase ? `<span class="act-phase">${esc(item.phase)}</span>` : '';
  const session = isAgent
    ? `<a class="act-session" role="button" tabindex="0" data-chat="${esc(item.chatId)}">${esc(item.session || item.chatId || '')}</a>`
    : `<span class="act-session act-session--sys">${t('system.activity.systemSession', 'sistema')}</span>`;
  return `
    <tr class="act-row act-row--${isAgent ? 'agent' : 'proc'}">
      <td class="act-c-type" title="${isAgent ? t('system.activity.subagentTitle', 'Subagente') : t('system.activity.backgroundProcessTitle', 'Proceso en segundo plano')}">${icon(ico, { size: 15 })}</td>
      <td class="act-c-what">${esc(what)}${phase}</td>
      <td class="act-c-sess">${session}</td>
      <td class="act-c-time" data-start="${item.startedAt || ''}">${fmtAgo(item.startedAt)}</td>
      <td class="act-c-model">${modelChip(item.model)}</td>
    </tr>`;
}

function groupHtml(ico, label, items) {
  if (!items.length) return '';
  return `<details class="act-group" open>
    <summary>${icon(ico, { size: 14 })} <span class="act-g-label">${esc(label)}</span> <span class="act-count">${items.length}</span></summary>
    <table class="act-table"><tbody>${items.map(rowHtml).join('')}</tbody></table>
  </details>`;
}

function renderInto(modal, data, opts) {
  const agents = data?.agents || [];
  const procs = data?.processes || [];
  const body = modal.body;
  if (!agents.length && !procs.length) {
    body.innerHTML = `<p class="act-empty">${t('system.activity.empty', 'Nada corriendo en segundo plano ahora mismo.')} 🟢</p>`;
    return;
  }
  body.innerHTML = groupHtml('sparkle', t('system.activity.groupSubagents', 'Subagentes'), agents) + groupHtml('gear', t('system.activity.groupBackgroundProcesses', 'Procesos en segundo plano'), procs);
  hydrateIcons(body);
  // Ir al chat de origen de un subagente (patrón perm-center openChat).
  body.querySelectorAll('.act-session[data-chat]').forEach((a) => {
    const go = () => { opts.openChat?.(a.dataset.chat); modal.close(); };
    a.addEventListener('click', go);
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

// "Tictac" del tiempo corriendo cada segundo (sin esperar el poll de 8 s).
function tickTimes(body) {
  body.querySelectorAll('.act-c-time[data-start]').forEach((td) => {
    const start = Number(td.dataset.start) || 0;
    if (start) td.textContent = fmtAgo(start);
  });
}

export function openActivityModal(data, opts = {}) {
  if (handle) { handle.render(data); return handle; }
  const modal = openModal({
    title: t('system.activity.modalTitle', 'Actividad en segundo plano'),
    width: 620,
    onClose: () => { if (handle?.timer) clearInterval(handle.timer); handle = null; },
  });
  handle = { modal, opts, render: (d) => renderInto(modal, d, opts), timer: null };
  handle.timer = setInterval(() => tickTimes(modal.body), 1000);
  handle.render(data);
  return handle;
}
