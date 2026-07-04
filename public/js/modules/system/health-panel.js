// modules/system/health-panel.js — pestaña "Salud" del menú Sistema.
//
// Arriba: chequeos rápidos en vivo (GET /api/health/checks, gratis).
// Abajo: última revisión profunda con Claude (caché) + botón para correrla
// (POST /api/health/review — admin, consume tokens, con confirm previo).
// SOLO salud: la gestión de bugfixes/PRs vive en el modal "Enviar PR" de la
// sección Tolkien (se quitó de acá por redundante).
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';
import { openHealthReview } from './health-review-modal.js';

const API = '/api/health';

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
      <span class="hp-title">🧠 Optimización IA</span>
      <button class="btn-ghost btn--sm btn--icon" data-ref="optreload" title="Refrescar censo y análisis">${icon('refresh', { size: 13 })}</button>
    </div>
    <div class="hp-opt" data-ref="opt">cargando…</div>`;

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

  // ===== revisión exhaustiva (resumen compacto + botón que abre el modal) =====
  // El detalle vive en la sub-ventana full-screen (health-review-modal.js):
  // barra de progreso, módulos y hallazgos accionables. Acá solo el último
  // veredicto cacheado y el acceso.
  function renderReview(d) {
    const parts = [];
    if (d.verdict) {
      parts.push(`
        <div class="hp-verdict hp-verdict--${esc(d.verdict)}">
          <b>${VERDICT_LABEL[d.verdict] || 'Sin veredicto'}</b>
          <span class="hp-when">${d.findings?.length || 0} hallazgo(s)${d.updatedAt ? ` · ${fmtDate(d.updatedAt)}` : ''}</span>
        </div>`);
    } else {
      parts.push('<p class="hp-empty">Todavía no se corrió ninguna revisión exhaustiva.</p>');
    }
    if (d.running) {
      parts.push(`<p class="hp-running">${pacman()} Revisión en curso · ${d.done || 0}/${d.total || '?'} módulos…</p>`);
    }
    parts.push(`<button class="btn btn--block" data-ref="open">${icon('gear', { size: 14 })}<span>${d.running ? 'Ver revisión en curso' : 'Revisión exhaustiva →'}</span></button>`);
    refs.review.innerHTML = parts.join('');
    refs.review.querySelector('[data-ref="open"]')?.addEventListener('click', () => {
      openHealthReview(ctx, { isAdmin });
      // al cerrar el modal, refrescar el resumen
      setTimeout(loadReview, 500);
    });
  }

  async function loadReview() {
    try {
      const d = await (await fetch(`${API}/review`)).json();
      if (!alive) return;
      renderReview(d);
      if (d.running) setTimeout(loadReview, 5000); // mantener el resumen fresco
    } catch {
      if (alive) refs.review.innerHTML = '<p class="hp-empty">No se pudo leer la revisión.</p>';
    }
  }

  // ===== Optimización IA: censo de motores (gratis) + análisis con propuestas =====
  // El censo (GET /ai-census) es determinístico y 0 tokens: qué modelo/turnos/
  // blindaje usa cada corrida del SDK. El análisis (POST /optimize) corre en un
  // runner desacoplado (sonnet, read-only, CONSUME TOKENS → confirm) y deja
  // propuestas PENDIENTES: Aplicar = chat supervisado, nunca auto-aplicar.
  const RISK_LABEL = { bajo: '🟢 bajo', medio: '🟡 medio', alto: '🔴 alto' };
  const TIPO_ICON = { modelo: '🤖', turnos: '🔁', timeout: '⏱', flujo: '🕸', fusion: '🧩', paralelismo: '⚡', prompt: '📝', otro: '🔧' };
  let optTimer = null;

  const engineName = (f) => String(f || '').split('/').pop().replace(/^cwc-|\.js$/g, '') || f;

  function censusHtml(census) {
    const rows = (census?.engines || []).map((e) => {
      const model = e.models?.length ? e.models.join('/') : (e.modelDynamic ? 'dinámico' : 'default');
      const capas = (e.layers?.preToolUse ? 1 : 0) + (e.layers?.canUseTool ? 1 : 0);
      const blind = capas === 2 ? '🔒×2' : capas === 1 ? '🔓×1' : '—';
      return `<tr title="${esc(e.file)}${e.purpose ? ` — ${esc(e.purpose)}` : ''}">
        <td>${esc(engineName(e.file))}</td>
        <td><b>${esc(model)}</b></td>
        <td>${esc((e.maxTurns || []).join('/') || '—')}</td>
        <td>${blind}</td>
        <td>${esc(e.settingSources || '—')}</td>
      </tr>`;
    }).join('');
    return `<details class="hp-opt-census">
      <summary>${(census?.engines || []).length} motor(es) IA en el censo · ver detalle</summary>
      <table class="hp-opt-table">
        <thead><tr><th>Motor</th><th>Modelo</th><th>Turnos</th><th>Capas</th><th>Settings</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
  }

  function proposalHtml(p) {
    const decided = p.status === 'accepted' ? '<span class="hp-opt-done">✅ aceptada</span>' : '';
    const actions = isAdmin && p.status === 'pending' ? `
      <div class="hp-opt-actions">
        <button class="btn-ghost btn--sm" data-act="optreject" data-id="${esc(p.id)}">✕ Descartar</button>
        <button class="btn btn--sm" data-act="optapply" data-id="${esc(p.id)}">💬 Aplicar en chat</button>
      </div>` : decided;
    return `<div class="hp-opt-card">
      <div class="hp-opt-head">
        <span>${TIPO_ICON[p.tipo] || '🔧'}</span>
        <b>${esc(p.motor)}</b>
        <span class="hp-opt-risk hp-opt-risk--${esc(p.riesgo)}">${RISK_LABEL[p.riesgo] || esc(p.riesgo)}</span>
      </div>
      <div class="hp-opt-diff"><s>${esc(p.actual)}</s> → <b>${esc(p.propuesta)}</b></div>
      <div class="hp-detail">${esc(p.razon)}${p.impacto ? ` · <b>Gana:</b> ${esc(p.impacto)}` : ''}</div>
      ${actions}
    </div>`;
  }

  function renderOpt(census, d) {
    const parts = [censusHtml(census)];
    if (d.running) {
      parts.push(`<p class="hp-running">${pacman()} Analizando · ${esc(d.progress?.phase || '…')}</p>`);
    } else if (d.error) {
      parts.push(`<p class="hp-error">El último análisis falló: ${esc(d.error)}</p>`);
    }
    if (d.updatedAt && d.resumen) {
      const pend = (d.propuestas || []).filter((p) => p.status === 'pending').length;
      parts.push(`<div class="hp-verdict hp-verdict--${pend ? 'atencion' : 'ok'}">
        <b>${pend ? `${pend} propuesta(s) pendiente(s)` : 'Sin propuestas pendientes'}</b>
        <span class="hp-when">${fmtDate(d.updatedAt)}</span>
      </div>
      <p class="hp-opt-resumen">${esc(d.resumen)}</p>`);
      parts.push((d.propuestas || []).filter((p) => p.status !== 'rejected').map(proposalHtml).join(''));
      if (d.flujoNuevo?.vale) {
        parts.push(`<div class="hp-opt-card hp-opt-card--flow">
          <div class="hp-opt-head"><span>🕸</span><b>Flujo nuevo propuesto: ${esc(d.flujoNuevo.titulo)}</b></div>
          <div class="hp-detail">${esc(d.flujoNuevo.descripcion)}</div>
          <ul class="hp-opt-flow">${(d.flujoNuevo.diseno || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
          ${isAdmin ? '<div class="hp-opt-actions"><button class="btn-ghost btn--sm" data-act="optflow">💬 Explorar en chat (plan)</button></div>' : ''}
        </div>`);
      }
    } else if (!d.running) {
      parts.push('<p class="hp-empty">Todavía no se corrió ningún análisis de optimización.</p>');
    }
    if (isAdmin) {
      parts.push(`<button class="btn btn--block" data-act="optrun" ${d.running ? 'disabled' : ''}>${icon('gear', { size: 14 })}<span>${d.running ? 'Análisis en curso…' : 'Analizar con IA'}</span></button>`);
    }
    refs.opt.innerHTML = parts.join('');

    refs.opt.querySelector('[data-act="optrun"]')?.addEventListener('click', runOptimize);
    refs.opt.querySelector('[data-act="optflow"]')?.addEventListener('click', () => exploreFlow(d.flujoNuevo));
    for (const b of refs.opt.querySelectorAll('[data-act="optapply"]')) {
      b.addEventListener('click', () => {
        const p = (d.propuestas || []).find((x) => x.id === b.dataset.id);
        if (p) applyProposal(p);
      });
    }
    for (const b of refs.opt.querySelectorAll('[data-act="optreject"]')) {
      b.addEventListener('click', async () => {
        await decideProposal(b.dataset.id, 'reject');
        loadOpt();
      });
    }
  }

  async function loadOpt() {
    clearTimeout(optTimer);
    try {
      const [census, d] = await Promise.all([
        fetch(`${API}/ai-census`).then((r) => r.json()),
        fetch(`${API}/optimization`).then((r) => r.json()),
      ]);
      if (!alive) return;
      renderOpt(census, d);
      if (d.running) optTimer = setTimeout(loadOpt, 4000);
    } catch {
      if (alive) refs.opt.innerHTML = '<p class="hp-empty">No se pudo leer la optimización.</p>';
    }
  }

  async function runOptimize() {
    const ok = await dialog.confirmDialog({
      title: 'Optimización IA',
      message: 'Analiza el flujo de TODOS los motores IA de la consola (censo + consumo real + lectura del código con Sonnet) y propone optimizaciones.\n\nCorre desacoplado (sobrevive reinicios) y CONSUME TOKENS. Nada se aplica solo: cada propuesta la aprobás vos.',
      confirmLabel: 'Analizar (usa tokens)',
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API}/optimize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.status);
    } catch (err) {
      await dialog.alertDialog({ title: 'Optimización IA', message: `No se pudo lanzar: ${err.message || err}` });
    }
    loadOpt();
  }

  async function decideProposal(id, action) {
    try {
      const res = await fetch(`${API}/optimize-proposal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.status);
    } catch (err) {
      await dialog.alertDialog({ title: 'Optimización IA', message: `No se pudo guardar la decisión: ${err.message || err}` });
    }
  }

  // Aprobar una propuesta = marcarla aceptada + abrir un chat SUPERVISADO
  // (acceptEdits) con todo el contexto para aplicarla. Nunca se aplica sola.
  async function applyProposal(p) {
    const prompt = [
      'La Optimización IA de la consola (Claude Web Console) propuso esta mejora sobre un motor IA. Aplicala de forma supervisada.',
      '',
      `Motor: ${p.motor}${p.archivo ? ` (${p.archivo})` : ''}`,
      `Tipo: ${p.tipo} · Riesgo: ${p.riesgo}`,
      `Actual: ${p.actual}`,
      `Propuesta: ${p.propuesta}`,
      `Razón: ${p.razon}`,
      p.impacto ? `Impacto esperado: ${p.impacto}` : '',
      p.archivos?.length ? `Archivos a tocar: ${p.archivos.join(', ')}` : '',
      p.pasos?.length ? `Pasos sugeridos:\n${p.pasos.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
      '',
      'Reglas ESTRICTAS:',
      '1. Leé el CLAUDE.md de la raíz ANTES de tocar nada: las reglas duras (1-9) son inviolables — en particular el blindaje read-only de dos capas de las corridas headless y los runners desacoplados.',
      '2. Verificá leyendo el código que la propuesta sigue vigente y es correcta. Si no aplica, avisame y no toques nada.',
      '3. Verificá cada archivo .js que edites con `node --check`.',
      '4. FRENÁ y pedime confirmación ANTES de cualquier acción de alto riesgo (git push, reiniciar el servicio, borrar datos).',
      '5. Al terminar, resumí qué cambiaste, en qué archivos y cómo verificarlo.',
    ].filter(Boolean).join('\n');
    await decideProposal(p.id, 'accept');
    await ctx.openChat?.({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: `Optimizar: ${p.motor}`.slice(0, 40) });
  }

  // El flujo nuevo se EXPLORA en modo plan (no toca nada hasta que apruebes).
  async function exploreFlow(fn) {
    const prompt = [
      'La Optimización IA de la consola (Claude Web Console) propuso este FLUJO NUEVO. Explorá el diseño en modo plan: evaluá si conviene, cómo encaja con la arquitectura (runners desacoplados, regla de oro, regla 6 de CLAUDE.md) y armá el plan de implementación. NO implementes nada todavía.',
      '',
      `Título: ${fn.titulo}`,
      `Descripción: ${fn.descripcion}`,
      fn.diseno?.length ? `Diseño propuesto:\n${fn.diseno.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    await ctx.openChat?.({ cwd: 'claude-web-console', mode: 'plan', prompt, title: `Flujo: ${fn.titulo}`.slice(0, 40) });
  }

  refs.reload.addEventListener('click', loadChecks);
  refs.optreload.addEventListener('click', loadOpt);
  loadChecks();
  loadReview();
  loadOpt();
}
