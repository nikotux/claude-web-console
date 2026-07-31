// modules/system/interfono-panel.js — pestaña "Interfono" del menú Sistema.
//
// Ventana al bus de comunicación entre sesiones (src/core/bus.js, vía
// /api/interfono). Muestra, colapsable + árbol (regla de UI del proyecto):
//   1) Sesiones activas (directorio) — a quién se le puede escribir.
//   2) Enviar mensaje manual desde la consola (canal humano).
//   3) Mensajes recientes del bus.
//   4) Reservas de archivo (claims) con semáforo 🔴🟡🟢 + liberar (admin).
// Solo LEE (0 tokens); el tráfico real lo generan los hooks de las sesiones.
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const API = '/api/interfono';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return t('system.interfono.agoSeconds', 'hace {n}s', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('system.interfono.agoMinutes', 'hace {n}min', { n: m });
  return t('system.interfono.agoHours', 'hace {n}h', { n: Math.round(m / 60) });
};
const KIND_ICON = { tui: '🖥️', 'tui-chat': '💬', chat: '💬', desconocida: '❔' };
// PLAN-469 · 2a: ícono del MUNDO de cada sesión (🏠 Mi Consola · 🌳 Tolkien · 📁 otro).
const WORLD_ICON = (w) => (w === 'Mi Consola' ? '🏠' : w === 'Tolkien' ? '🌳' : (w ? '📁' : ''));
// Cómo llegó (o no) cada mensaje al humano (ver core/interfono-log.js ROUTES).
function routeLabel(route) {
  return {
    'auto-deliver': `📨 ${t('system.interfono.routeAutoDelivered', 'auto-entregado')}`,
    'tui-nudge': `🖥️ ${t('system.interfono.routeTuiNudge', 'nudge TUI')}`,
    'hook-inject': `🪝 ${t('system.interfono.routeHookInjected', 'inyectado')}`,
    badge: `🔔 ${t('system.interfono.routeBadge', 'badge')}`,
    'popup-shown': `🪟 ${t('system.interfono.routePopup', 'popup')}`,
    'popup-resume': `▶ ${t('system.interfono.routeDelivered', 'entregado')}`,
    'popup-dismiss': `✕ ${t('system.interfono.routeArchived', 'archivado')}`,
    expired: `⌛ ${t('system.interfono.routeExpired', 'vencido')}`,
  }[route];
}

export function mountInterfonoPanel(el, ctx) {
  const { isAdmin } = ctx;

  el.innerHTML = `
    <div class="if-head">
      <span class="hp-title">📻 ${t('system.interfono.title', 'Interfono entre sesiones')}</span>
      <button class="btn-ghost btn--sm btn--icon" data-ref="reload" title="${t('system.interfono.refresh', 'Refrescar')}">${icon('refresh', { size: 13 })}</button>
      ${helpBtn('sys-interfono')}
    </div>
    <p class="if-hint">${isAdmin
      ? t('system.interfono.hint', 'Las sesiones de Claude se avisan y evitan pisarse solas. Acá lo ves y podés escribirles vos.')
      : t('system.interfono.hintOwn', 'Tus sesiones de Claude se avisan y evitan pisarse solas. Acá ves únicamente su actividad y podés escribirles vos.')}</p>

    <div class="if-send" data-ref="send">
      <select class="if-select" data-ref="to"></select>
      <textarea class="if-text" data-ref="text" rows="2" placeholder="${t('system.interfono.messagePlaceholder', 'Mensaje a la sesión…')}"></textarea>
      <input class="dlg-input if-pkg-in" data-ref="pkg" placeholder="📦 ${t('system.interfono.packagePlaceholder', 'Pasar un paquete (PKG-N, opcional)')}">
      <button class="btn btn--sm" data-ref="do-send">${icon('play', { size: 13 })}<span>${t('system.interfono.send', 'Enviar')}</span></button>
      <span class="if-sendmsg" data-ref="sendmsg"></span>
    </div>

    <details class="if-group">
      <summary><span class="if-gtitle">${isAdmin
        ? t('system.interfono.activeSessions', 'Sesiones activas')
        : t('system.interfono.activeSessionsOwn', 'Tus sesiones activas')}</span> <span class="if-count" data-ref="dir-n"></span></summary>
      <div class="if-list" data-ref="dir">${pacman({ size: 'sm' })}</div>
    </details>

    <details class="if-group">
      <summary><span class="if-gtitle">${isAdmin
        ? t('system.interfono.fileClaims', 'Reservas de archivo')
        : t('system.interfono.fileClaimsOwn', 'Reservas de tus sesiones')}</span> <span class="if-count" data-ref="claims-n"></span></summary>
      <div class="if-list" data-ref="claims"></div>
    </details>

    <details class="if-group">
      <summary><span class="if-gtitle">${isAdmin
        ? t('system.interfono.recentMessages', 'Mensajes recientes')
        : t('system.interfono.recentMessagesOwn', 'Mensajes de tus sesiones')}</span> <span class="if-count" data-ref="msgs-n"></span></summary>
      <div class="if-list" data-ref="msgs"></div>
    </details>

    <details class="if-group">
      <summary><span class="if-gtitle">${isAdmin
        ? t('system.interfono.deliveryLog', 'Bitácora de entrega')
        : t('system.interfono.deliveryLogOwn', 'Bitácora de tus sesiones')}</span> <span class="if-count" data-ref="deliv-n"></span></summary>
      <div class="if-list" data-ref="deliv"></div>
    </details>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;
  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); clearInterval(timer); } });
  obs.observe(document.body, { childList: true, subtree: true });

  function renderDir(dir) {
    refs['dir-n'].textContent = dir.length ? `(${dir.length})` : '(0)';
    refs.to.innerHTML = (isAdmin
      ? `<option value="all">📢 ${t('system.interfono.allBroadcast', 'Todas (broadcast)')}</option>`
      : '') +
      dir.map((e) => `<option value="${esc(e.handle)}">${KIND_ICON[e.kind] || '•'} ${esc(e.name)}${e.packageRef ? ` · ${esc(e.packageRef)}` : ''}${e.world ? ` · ${WORLD_ICON(e.world)}` : ''}${e.archived ? ' · 📦' : ''}</option>`).join('');
    refs.dir.innerHTML = dir.length ? dir.map((e) => `
      <div class="if-item">
        <span class="if-kind">${KIND_ICON[e.kind] || '•'}</span>
        <span class="if-name">${esc(e.name)}${e.packageRef ? ` <span class="if-pkg">${esc(e.packageRef)}</span>` : ''}</span>
        ${e.world ? `<span class="if-world" title="${t('system.interfono.worldTitle', 'Mundo')}: ${esc(e.world)}">${WORLD_ICON(e.world)} ${esc(e.world)}</span>` : ''}
        ${e.archived ? `<span class="if-arch">📦 ${t('system.interfono.archivedSession', 'archivada')}</span>` : ''}
        <span class="if-sub">${esc(e.cwd || '')}</span>
      </div>`).join('') : `<div class="hp-empty">${isAdmin
      ? t('system.interfono.noActiveSessions', 'No hay otras sesiones activas.')
      : t('system.interfono.noActiveSessionsOwn', 'No tenés sesiones activas en el Interfono.')}</div>`;
  }

  function renderClaims(claims) {
    refs['claims-n'].textContent = claims.length ? `(${claims.length})` : '(0)';
    if (!claims.length) { refs.claims.innerHTML = `<div class="hp-empty">${t('system.interfono.noClaims', 'Nadie está reservando archivos.')}</div>`; return; }
    refs.claims.innerHTML = claims.map((c) => {
      const v = c.verdict || {};
      const rel = isAdmin
        ? `<button class="btn-ghost btn--sm if-rel" data-file="${esc(c.file)}" data-handle="${esc(c.handle)}">${t('system.interfono.release', 'Liberar')}</button>` : '';
      return `
        <div class="if-item if-claim">
          <span class="if-badge">${esc(v.label || '')}</span>
          <span class="if-name" title="${esc(c.file)}">${esc(c.file.split('/').pop())}</span>
          <span class="if-sub">${esc(c.name)} · ${ago(c.renewedAt || c.ts)}</span>
          ${rel}
        </div>`;
    }).join('');
    for (const b of refs.claims.querySelectorAll('.if-rel')) {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const res = await fetch(`${API}/claim-release`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ file: b.dataset.file, handle: b.dataset.handle }),
          });
          if (res.ok) { load(); return; }
          const j = await res.json().catch(() => ({}));
          if (refs.sendmsg) refs.sendmsg.textContent = `⚠ ${j.error || t('system.interfono.releaseError', 'no se pudo liberar')}`;
          b.disabled = false;
        } catch {
          if (refs.sendmsg) refs.sendmsg.textContent = `⚠ ${t('system.interfono.networkError', 'error de red')}`;
          b.disabled = false;
        }
      });
    }
  }

  function renderMsgs(msgs) {
    refs['msgs-n'].textContent = msgs.length ? `(${msgs.length})` : '(0)';
    refs.msgs.innerHTML = msgs.length ? msgs.map((m) => `
      <div class="if-item if-msg">
        <span class="if-name">${esc(m.fromName)} → ${esc(m.toName)}${m.packageRef ? ` <span class="if-pkg">📦 ${esc(m.packageRef)}</span>` : ''}</span>
        <span class="if-body">${esc(m.text)}</span>
        <span class="if-sub">${ago(m.ts)}</span>
      </div>`).join('') : `<div class="hp-empty">${t('system.interfono.noRecentMessages', 'Sin mensajes recientes.')}</div>`;
  }

  function renderDeliveries(rows) {
    refs['deliv-n'].textContent = rows.length ? `(${rows.length})` : '(0)';
    refs.deliv.innerHTML = rows.length ? rows.map((d) => `
      <div class="if-item if-msg">
        <span class="if-name">${routeLabel(d.route) || esc(d.route)}</span>
        <span class="if-body">${esc(d.from || '—')} → ${esc(d.to || '—')}${d.kind ? ` · ${esc(d.kind)}` : ''}</span>
        <span class="if-sub">${ago(d.ts)}</span>
      </div>`).join('') : `<div class="hp-empty">${t('system.interfono.noDeliveries', 'Sin entregas registradas.')}</div>`;
  }

  async function load() {
    try {
      const [d, deliv] = await Promise.all([
        (await fetch(API)).json(),
        fetch(`${API}/deliveries?limit=100`).then((r) => r.json()).catch(() => ({ deliveries: [] })),
      ]);
      if (!alive) return;
      renderDir(d.directory || []);
      renderClaims(d.claims || []);
      renderMsgs(d.messages || []);
      renderDeliveries(deliv.deliveries || []);
    } catch {
      if (alive) refs.dir.innerHTML = `<div class="hp-empty">${t('system.interfono.readError', 'No se pudo leer el Interfono.')}</div>`;
    }
  }

  async function doSend() {
    const to = refs.to.value;
    const text = refs.text.value.trim();
    if (!text) return;
    const packageRef = (refs.pkg?.value || '').trim(); // PLAN-469 · 4a
    refs['do-send'].disabled = true;
    refs.sendmsg.textContent = '';
    try {
      const res = await fetch(`${API}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, text, ...(packageRef ? { packageRef } : {}) }),
      });
      const j = await res.json();
      if (res.ok) { refs.text.value = ''; if (refs.pkg) refs.pkg.value = ''; refs.sendmsg.textContent = `✅ ${t('system.interfono.sentTo', 'enviado a {name}', { name: j.toName })}`; load(); }
      else refs.sendmsg.textContent = `⚠ ${j.error || t('system.interfono.sendError', 'no se pudo enviar')}`;
    } catch { refs.sendmsg.textContent = `⚠ ${t('system.interfono.networkError', 'error de red')}`; }
    finally { refs['do-send'].disabled = false; }
  }

  refs.reload.addEventListener('click', load);
  refs['do-send'].addEventListener('click', doSend);
  load();
  const timer = setInterval(() => { if (alive && !document.hidden) load(); }, 5000);
}
