// modules/system/health-panel.js — pestaña "Salud" del menú Sistema.
//
// Arriba: chequeos rápidos en vivo (GET /api/health/checks, gratis).
// Medio: última revisión profunda con Claude (caché) + botón para correrla
// (POST /api/health/review — admin, consume tokens, con confirm previo).
// Abajo: Bugfixes → PR (registro de fixes de tickets trabajados en chat;
// subir PR a Chris y scan retroactivo de chats sin registro — /api/bugfixes).
import { icon } from '../../ui/icons.js';

const API = '/api/health';
const BF_API = '/api/bugfixes';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => {
  const d = new Date(ms);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' +
    d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
};

const VERDICT_LABEL = { ok: 'Todo en orden', atencion: 'Requiere atención', critico: 'CRÍTICO' };

export function mountHealthPanel(el, ctx) {
  const { dialog, isAdmin } = ctx;

  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">Chequeos rápidos</span>
      <button class="btn-ghost btn--sm btn--icon" data-ref="reload" title="Refrescar chequeos">${icon('refresh', { size: 13 })}</button>
    </div>
    <div class="hp-checks" data-ref="checks"><span class="cwc-spinner"></span></div>

    <div class="hp-head hp-head--review">
      <span class="hp-title">Revisión profunda con Claude</span>
    </div>
    <div class="hp-review" data-ref="review">cargando…</div>

    <div class="hp-head hp-head--review">
      <span class="hp-title">Bugfixes → PR</span>
      ${ctx.isAdmin ? `<button class="btn-ghost btn--sm" data-ref="scan" title="Busca chats de tickets viejos que no dejaron registro y los registra">${icon('refresh', { size: 13 })}<span>Buscar no registrados</span></button>` : ''}
    </div>
    <div class="hp-bugfixes" data-ref="bugfixes">cargando…</div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;
  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  // ===== chequeos rápidos =====
  async function loadChecks() {
    refs.reload.disabled = true;
    try {
      const data = await (await fetch(`${API}/checks`)).json();
      if (!alive) return;
      refs.checks.innerHTML = data.checks.map((c) => `
        <div class="hp-row" title="${esc(c.id)}">
          <span class="hp-dot hp-dot--${c.status}"></span>
          <span class="hp-label">${esc(c.label)}</span>
          <span class="hp-detail">${esc(c.detail)}</span>
        </div>`).join('') + `
        <div class="hp-sum">${data.ok} ok${data.warn ? ` · ${data.warn} aviso(s)` : ''}${data.fail ? ` · ${data.fail} FALLA(s)` : ''}</div>`;
    } catch {
      if (alive) refs.checks.innerHTML = '<div class="hp-empty">No se pudieron correr los chequeos.</div>';
    } finally {
      refs.reload.disabled = false;
    }
  }

  // ===== revisión IA =====
  function renderReview(data) {
    const parts = [];
    if (data.updatedAt) {
      parts.push(`
        <div class="hp-verdict hp-verdict--${esc(data.verdict || 'atencion')}">
          <b>${VERDICT_LABEL[data.verdict] || 'Sin veredicto'}</b>
          <span class="hp-when">${fmtDate(data.updatedAt)}</span>
        </div>
        ${data.summary ? `<p class="hp-summary">${esc(data.summary)}</p>` : ''}`);
      if (data.findings?.length) {
        parts.push(`<div class="hp-findings">${data.findings.map((f) => `
          <details class="hp-finding">
            <summary><span class="hp-dot hp-dot--${f.severity === 'low' ? 'ok' : f.severity === 'critical' || f.severity === 'high' ? 'fail' : 'warn'}"></span>
              <b>${esc(f.area)}</b> <span class="hp-sev">${esc(f.severity)}</span></summary>
            <p>${esc(f.detail)}${f.file ? ` <code>${esc(f.file)}</code>` : ''}</p>
          </details>`).join('')}</div>`);
      }
    } else {
      parts.push('<p class="hp-empty">Todavía no se corrió ninguna revisión.</p>');
    }
    if (data.error) parts.push(`<p class="hp-error">Último intento falló: ${esc(data.error)}</p>`);
    if (data.running) {
      parts.push('<p class="hp-running"><span class="cwc-spinner"></span> Claude está revisando el proyecto… (puede tardar unos minutos)</p>');
    } else if (isAdmin) {
      parts.push(`<button class="btn btn--block" data-ref="run">${icon('gear', { size: 14 })}<span>Revisar ahora con Claude</span></button>`);
    }
    refs.review.innerHTML = parts.join('');
    refs.review.querySelector('[data-ref="run"]')?.addEventListener('click', runReview);
  }

  async function loadReview() {
    try {
      const data = await (await fetch(`${API}/review`)).json();
      if (!alive) return;
      renderReview(data);
      if (data.running) setTimeout(pollReview, 5000);
    } catch {
      if (alive) refs.review.innerHTML = '<p class="hp-empty">No se pudo leer la última revisión.</p>';
    }
  }

  async function pollReview() {
    if (!alive) return;
    try {
      const data = await (await fetch(`${API}/review`)).json();
      renderReview(data);
      if (data.running) setTimeout(pollReview, 5000);
    } catch { /* reintenta el próximo open */ }
  }

  async function runReview() {
    const ok = await dialog.confirmDialog({
      title: 'Revisión profunda con Claude',
      message: 'Claude Code va a leer la guía del proyecto y auditar el código (solo lectura). Tarda unos minutos y CONSUME TOKENS de tu suscripción.',
      confirmLabel: 'Revisar',
    });
    if (!ok) return;
    renderReview({ ...(await (await fetch(`${API}/review`)).json().catch(() => ({}))), running: true });
    try {
      const res = await fetch(`${API}/review`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!alive) return;
      if (!res.ok) { renderReview({ ...data, error: data.error || 'Falló la revisión.', running: false }); return; }
      renderReview({ ...data, running: false });
    } catch (e) {
      if (alive) renderReview({ error: e.message, running: false });
    }
  }

  // ===== Bugfixes → PR =====
  function renderBugfixes(list) {
    if (!list.length) {
      refs.bugfixes.innerHTML = '<p class="hp-empty">Sin fixes registrados. Cerrá una conversación abierta desde un ticket (o corré la búsqueda) y aparece acá.</p>';
      return;
    }
    refs.bugfixes.innerHTML = list.map((b) => `
      <details class="hp-finding hp-bf" data-id="${esc(b.sessionId)}">
        <summary>
          <span class="hp-dot hp-dot--${b.status === 'subido' ? 'ok' : 'warn'}"></span>
          <b>${esc(b.title)}</b>
          <span class="hp-sev">${b.status === 'subido' ? 'PR subido' : 'pendiente'}</span>
          <span class="hp-when">${fmtDate(b.updatedAt)}</span>
        </summary>
        <p class="hp-bf-summary">${esc(b.summary || '(sin resumen)')}</p>
        ${b.files?.length ? `<p class="hp-bf-files">${b.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>`
        : '<p class="hp-bf-files hp-bf-files--none">Sin archivos editados (quedó en plan): trabajá el fix en el chat y volvé a cerrarlo.</p>'}
        ${b.ticketUrl ? `<p><a href="${esc(b.ticketUrl)}" target="_blank" rel="noopener">Ticket Desk #${esc(b.ticketNumber)} ↗</a></p>` : ''}
        ${b.prUrl ? `<p><a href="${esc(b.prUrl)}" target="_blank" rel="noopener">Ver PR (${esc(b.branch || 'branch')}) ↗</a></p>` : ''}
        ${isAdmin ? `<div class="dlg-actions hp-bf-actions">
          <button class="btn-ghost btn--sm" data-act="del">Descartar</button>
          ${b.status !== 'subido' ? `<button class="btn btn--sm" data-act="pr" ${b.files?.length ? '' : 'disabled'}>${icon('gitBranch', { size: 13 })}<span>Subir PR</span></button>` : ''}
        </div>` : ''}
      </details>`).join('');

    for (const card of refs.bugfixes.querySelectorAll('.hp-bf')) {
      const id = card.dataset.id;
      card.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
        const ok = await dialog.confirmDialog({ title: 'Descartar registro', message: 'Se borra solo el registro local del fix (no toca código ni PRs).', confirmLabel: 'Descartar', danger: true });
        if (!ok) return;
        await fetch(`${BF_API}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        loadBugfixes();
      });
      card.querySelector('[data-act="pr"]')?.addEventListener('click', async (e) => {
        const ok = await dialog.confirmDialog({
          title: 'Subir PR a Tolkien',
          message: 'Se crea un branch desde origin/main con los archivos del fix, se PUSHEA al repo de la empresa y se abre un PR para revisión. Tu árbol de trabajo de Tolkien no se toca.',
          confirmLabel: 'Subir PR',
        });
        if (!ok) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="cwc-spinner"></span><span>Subiendo…</span>';
        try {
          const res = await fetch(`${BF_API}/pr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Falló la subida.');
          await dialog.alertDialog({ title: 'PR subido', message: `Branch ${data.branch} pusheado.\n${data.prUrl || ''}` });
        } catch (err) {
          await dialog.alertDialog({ title: 'Subir PR', message: err.message });
        }
        loadBugfixes();
      });
    }
  }

  async function loadBugfixes() {
    try {
      const data = await (await fetch(BF_API)).json();
      if (alive) renderBugfixes(data.bugfixes || []);
    } catch {
      if (alive) refs.bugfixes.innerHTML = '<p class="hp-empty">No se pudo leer el registro de bugfixes.</p>';
    }
  }

  refs.scan?.addEventListener('click', async () => {
    refs.scan.disabled = true;
    try {
      const res = await fetch(`${BF_API}/scan`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falló la búsqueda.');
      await dialog.alertDialog({
        title: 'Búsqueda de fixes sin registro',
        message: data.added
          ? `Se registraron ${data.added} fix(es) de chats anteriores (${data.scanned} transcripts revisados).`
          : `Nada nuevo: ${data.scanned} transcripts revisados, todos los chats de tickets ya estaban registrados.`,
      });
      renderBugfixes(data.bugfixes || []);
    } catch (err) {
      await dialog.alertDialog({ title: 'Buscar no registrados', message: err.message });
    } finally {
      refs.scan.disabled = false;
    }
  });

  refs.reload.addEventListener('click', loadChecks);
  loadChecks();
  loadReview();
  loadBugfixes();
}
