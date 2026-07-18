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

const API = '/api/interfono';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m}min`;
  return `hace ${Math.round(m / 60)}h`;
};
const KIND_ICON = { tui: '🖥️', 'tui-chat': '💬', chat: '💬', desconocida: '❔' };
// PLAN-469 · 2a: ícono del MUNDO de cada sesión (🏠 Mi Consola · 🌳 Tolkien · 📁 otro).
const WORLD_ICON = (w) => (w === 'Mi Consola' ? '🏠' : w === 'Tolkien' ? '🌳' : (w ? '📁' : ''));
// Cómo llegó (o no) cada mensaje al humano (ver core/interfono-log.js ROUTES).
const ROUTE_LABEL = {
  'auto-deliver': '📨 auto-entregado', 'tui-nudge': '🖥️ nudge TUI',
  'hook-inject': '🪝 inyectado', badge: '🔔 badge',
  'popup-shown': '🪟 popup', 'popup-resume': '▶ entregado', 'popup-dismiss': '✕ archivado',
  expired: '⌛ vencido',
};

export function mountInterfonoPanel(el, ctx) {
  const { isAdmin } = ctx;

  el.innerHTML = `
    <div class="if-head">
      <span class="hp-title">📻 Interfono entre sesiones</span>
      <button class="btn-ghost btn--sm btn--icon" data-ref="reload" title="Refrescar">${icon('refresh', { size: 13 })}</button>
    </div>
    <p class="if-hint">Las sesiones de Claude se avisan y evitan pisarse solas. Acá lo ves y podés escribirles vos.</p>

    <div class="if-send" data-ref="send">
      <select class="if-select" data-ref="to"></select>
      <textarea class="if-text" data-ref="text" rows="2" placeholder="Mensaje a la sesión…"></textarea>
      <input class="dlg-input if-pkg-in" data-ref="pkg" placeholder="📦 Pasar un paquete (PKG-N, opcional)">
      <button class="btn btn--sm" data-ref="do-send">${icon('play', { size: 13 })}<span>Enviar</span></button>
      <span class="if-sendmsg" data-ref="sendmsg"></span>
    </div>

    <details class="if-group" open>
      <summary><span class="if-gtitle">Sesiones activas</span> <span class="if-count" data-ref="dir-n"></span></summary>
      <div class="if-list" data-ref="dir"><span class="cwc-spinner"></span></div>
    </details>

    <details class="if-group">
      <summary><span class="if-gtitle">Reservas de archivo</span> <span class="if-count" data-ref="claims-n"></span></summary>
      <div class="if-list" data-ref="claims"></div>
    </details>

    <details class="if-group">
      <summary><span class="if-gtitle">Mensajes recientes</span> <span class="if-count" data-ref="msgs-n"></span></summary>
      <div class="if-list" data-ref="msgs"></div>
    </details>

    <details class="if-group">
      <summary><span class="if-gtitle">Bitácora de entrega</span> <span class="if-count" data-ref="deliv-n"></span></summary>
      <div class="if-list" data-ref="deliv"></div>
    </details>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;
  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); clearInterval(timer); } });
  obs.observe(document.body, { childList: true, subtree: true });

  function renderDir(dir) {
    refs['dir-n'].textContent = dir.length ? `(${dir.length})` : '(0)';
    refs.to.innerHTML = `<option value="all">📢 Todas (broadcast)</option>` +
      dir.map((e) => `<option value="${esc(e.handle)}">${KIND_ICON[e.kind] || '•'} ${esc(e.name)}${e.packageRef ? ` · ${esc(e.packageRef)}` : ''}${e.world ? ` · ${WORLD_ICON(e.world)}` : ''}${e.archived ? ' · 📦' : ''}</option>`).join('');
    refs.dir.innerHTML = dir.length ? dir.map((e) => `
      <div class="if-item">
        <span class="if-kind">${KIND_ICON[e.kind] || '•'}</span>
        <span class="if-name">${esc(e.name)}${e.packageRef ? ` <span class="if-pkg">${esc(e.packageRef)}</span>` : ''}</span>
        ${e.world ? `<span class="if-world" title="Mundo: ${esc(e.world)}">${WORLD_ICON(e.world)} ${esc(e.world)}</span>` : ''}
        ${e.archived ? '<span class="if-arch">📦 archivada</span>' : ''}
        <span class="if-sub">${esc(e.cwd || '')}</span>
      </div>`).join('') : '<div class="hp-empty">No hay otras sesiones activas.</div>';
  }

  function renderClaims(claims) {
    refs['claims-n'].textContent = claims.length ? `(${claims.length})` : '(0)';
    if (!claims.length) { refs.claims.innerHTML = '<div class="hp-empty">Nadie está reservando archivos.</div>'; return; }
    refs.claims.innerHTML = claims.map((c) => {
      const v = c.verdict || {};
      const rel = isAdmin
        ? `<button class="btn-ghost btn--sm if-rel" data-file="${esc(c.file)}" data-handle="${esc(c.handle)}">Liberar</button>` : '';
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
          if (refs.sendmsg) refs.sendmsg.textContent = `⚠ ${j.error || 'no se pudo liberar'}`;
          b.disabled = false;
        } catch {
          if (refs.sendmsg) refs.sendmsg.textContent = '⚠ error de red';
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
      </div>`).join('') : '<div class="hp-empty">Sin mensajes recientes.</div>';
  }

  function renderDeliveries(rows) {
    refs['deliv-n'].textContent = rows.length ? `(${rows.length})` : '(0)';
    refs.deliv.innerHTML = rows.length ? rows.map((d) => `
      <div class="if-item if-msg">
        <span class="if-name">${ROUTE_LABEL[d.route] || esc(d.route)}</span>
        <span class="if-body">${esc(d.from || '—')} → ${esc(d.to || '—')}${d.kind ? ` · ${esc(d.kind)}` : ''}</span>
        <span class="if-sub">${ago(d.ts)}</span>
      </div>`).join('') : '<div class="hp-empty">Sin entregas registradas.</div>';
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
      if (alive) refs.dir.innerHTML = '<div class="hp-empty">No se pudo leer el Interfono.</div>';
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
      if (res.ok) { refs.text.value = ''; if (refs.pkg) refs.pkg.value = ''; refs.sendmsg.textContent = `✅ enviado a ${j.toName}`; load(); }
      else refs.sendmsg.textContent = `⚠ ${j.error || 'no se pudo enviar'}`;
    } catch { refs.sendmsg.textContent = '⚠ error de red'; }
    finally { refs['do-send'].disabled = false; }
  }

  refs.reload.addEventListener('click', load);
  refs['do-send'].addEventListener('click', doSend);
  load();
  const timer = setInterval(() => { if (alive && !document.hidden) load(); }, 5000);
}
