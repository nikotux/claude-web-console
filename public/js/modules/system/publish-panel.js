// modules/system/publish-panel.js — pestaña "Publicar a la consola" (PLAN-488).
//
// Publica el repo INTERNO al repo LIMPIO (la-consola) aplicando el transform de
// limpieza + gates bloqueantes. Acción hacia AFUERA (push a GitHub) ⇒ confirm
// fuerte. Admin-only. Encuesta el estado del runner desacoplado (0 tokens).
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';

const API = '/api/publish';

export function mountPublishPanel(el, ctx) {
  const { dialog } = ctx;
  let polling = null;

  el.innerHTML = `
    <p class="pub-hint">
      Publica el estado actual de <b>este</b> repo al repo limpio
      <code>la-consola</code> (el que instala tu compañero). Antes de subir, quita
      lo interno (identidad, secretos, changelog, docs internos) y corre dos
      <b>controles de seguridad</b>: si detecta un secreto o identidad hardcodeada,
      <b>no publica</b>. Es un espejo de una sola dirección: nunca trae cambios de vuelta.
    </p>
    <button class="btn btn--block" data-ref="go">${icon('upload', { size: 15 })}<span>Publicar a la consola</span></button>
    <div class="pub-status" data-ref="status" hidden></div>`;

  const refs = {};
  for (const n of el.querySelectorAll('[data-ref]')) refs[n.dataset.ref] = n;

  function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function renderState(state, running) {
    if (!state) { refs.status.hidden = true; return; }
    refs.status.hidden = false;
    if (running) {
      refs.status.className = 'pub-status pub-status--run';
      refs.status.innerHTML = `${pacman({ state: 'delegating', size: 'sm' })} <span>${esc(state.phase || 'trabajando…')}</span>`;
      return;
    }
    if (state.status === 'error') {
      const gates = state.result?.gates;
      refs.status.className = 'pub-status pub-status--err';
      refs.status.innerHTML = `❌ <b>No se publicó.</b> ${esc(state.error || '')}` +
        (gates?.length ? `<ul class="pub-gates">${gates.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : '');
      return;
    }
    if (state.status === 'done') {
      const r = state.result || {};
      refs.status.className = 'pub-status pub-status--ok';
      refs.status.innerHTML = `✅ ${esc(r.message || 'Listo.')}` +
        (r.published && r.files ? ` <span class="pub-dim">(${r.files} archivos)</span>` : '') +
        (r.transforms?.length ? `<details class="pub-det"><summary>Detalle de limpieza</summary><ul>${r.transforms.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : '');
      return;
    }
    refs.status.className = 'pub-status';
    refs.status.textContent = esc(state.phase || '');
  }

  async function load() {
    try {
      const r = await fetch(API, { cache: 'no-store' });
      if (r.status === 403) { el.innerHTML = '<p class="pub-hint">Requiere administrador.</p>'; return; }
      const j = await r.json();
      renderState(j.state, j.running);
      if (j.running) startPoll();
    } catch { /* noop */ }
  }

  function startPoll() {
    if (polling) return;
    polling = setInterval(async () => {
      try {
        const r = await fetch(API, { cache: 'no-store' });
        const j = await r.json();
        renderState(j.state, j.running);
        if (!j.running) { clearInterval(polling); polling = null; refs.go.disabled = false; }
      } catch { /* reintenta al próximo tick */ }
    }, 2000);
  }

  refs.go.addEventListener('click', async () => {
    const ok = await dialog.confirmDialog({
      title: 'Publicar a la consola',
      message: 'Vas a PUBLICAR el estado actual de este repo al repo limpio la-consola (push a GitHub). '
        + 'Se quita lo interno y se corren los controles de seguridad; si detectan algo, no publica.\n\n¿Confirmás?',
      confirmText: 'Publicar',
      danger: true,
    });
    if (!ok) return;
    refs.go.disabled = true;
    try {
      const r = await fetch(API, { method: 'POST' });
      const j = await r.json();
      if (!r.ok && r.status !== 409) throw new Error(j?.error || 'No se pudo iniciar.');
      renderState(j.state, true);
      startPoll();
    } catch (e) {
      refs.go.disabled = false;
      renderState({ status: 'error', error: String(e.message || e) }, false);
    }
  });

  el._cleanup = () => { if (polling) { clearInterval(polling); polling = null; } };
  load();
}
