// Cabina lite — personalización. Enseña a la IA cómo trabajar con la persona
// sin exponer el CLAUDE.md completo ni los defaults técnicos de una sesión.

import { icon } from '../ui/icons.js';

const API_BASE = '/api/projects/me';

const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[char]));

const formatSize = (bytes) => {
  const value = Number(bytes) || 0;
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
};

const asList = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

function changedLines(before, after) {
  const oldLines = String(before ?? '').split('\n');
  const newLines = String(after ?? '').split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return {
    removed: oldLines.slice(start, oldEnd).join('\n'),
    added: newLines.slice(start, newEnd).join('\n'),
  };
}

let current = null;

function isCurrent(state) {
  return current === state && state.alive;
}

function waitForPoll(state) {
  return new Promise((resolve) => {
    state.pollResolve = resolve;
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null;
      state.pollResolve = null;
      resolve();
    }, 2000);
  });
}

function emptyMessage(message, action = '') {
  return `
    <div class="cab-panel" style="padding:var(--lite-space-y-lg);text-align:center">
      <p class="cab-subtitle" style="margin-inline:auto">${esc(message)}</p>
      ${action}
    </div>`;
}

function pageHeader() {
  return `
    <header class="cab-page-header">
      <div>
        <h1 class="cab-title">Cómo trabajo</h1>
        <p class="cab-subtitle">Enseñame cómo te gusta trabajar. Estas indicaciones guían a la IA en tus conversaciones.</p>
      </div>
      <button class="cab-btn cab-btn--cold" data-action="refresh" type="button">Actualizar</button>
      <button class="cab-btn" data-action="preferences-chat" type="button">${icon('sparkle', { size: 16 })}<span>Conversar para ajustarlo</span></button>
      <button class="cab-help-btn" type="button" data-cabina-help title="Cómo se usa esta pantalla" aria-label="Cómo se usa esta pantalla">${icon('help', { size: 16 })}</button>
    </header>`;
}

function renderIdentity(state) {
  if (state.identityError) {
    return `
      <div class="cab-summary-card">
        <span class="cab-summary-title">Tu identidad</span>
        <span class="cab-summary-meta">${esc(state.identityError)}</span>
      </div>`;
  }
  const data = state.identityData;
  if (!data) return '<div class="cab-summary-card"><span class="cab-summary-meta">Cargando tu identidad…</span></div>';
  const identity = data.identity || {};
  const fields = [
    ['Nombre', identity.name],
    ['Firma', identity.signature],
    ['Email', identity.email],
    ['GitHub', identity.github],
  ].filter(([, value]) => value);
  return `
    <div class="cab-summary-card">
      <span class="cab-summary-eyebrow">Tu identidad</span>
      <span class="cab-summary-title">${esc(identity.name || 'Todavía sin nombre configurado')}</span>
      <div style="display:grid;gap:8px;margin-top:12px">
        ${fields.map(([label, value]) => `<span class="cab-summary-meta"><b>${esc(label)}:</b> ${esc(value)}</span>`).join('')}
      </div>
      <p class="cab-conversation-meta" style="margin:14px 0 0">
        ${data.editable
    ? 'Esta identidad puede editarse desde tu perfil.'
    : 'Por ahora se muestra la identidad disponible en modo lectura. Cómo querés que te hablen se define en Comportamiento.'}
      </p>
    </div>`;
}

function renderHome(state) {
  state.screen = 'home';
  if (!isCurrent(state)) return;
  const data = state.sectionsData;
  let sections = '';
  if (state.sectionsError) {
    sections = emptyMessage(state.sectionsError, '<button class="cab-btn cab-btn--cold" data-action="refresh" type="button">Reintentar</button>');
  } else if (!data) {
    sections = emptyMessage('Cargando tus indicaciones…');
  } else if (!asList(data.sections).length) {
    sections = emptyMessage('Todavía no hay indicaciones de comportamiento.');
  } else {
    sections = `<div class="cab-conversation-list">${data.sections.map((section) => `
      <button class="cab-conversation-row ${section.managed ? 'cab-conversation-row--resting' : ''}" data-action="open-section" data-index="${section.i}" type="button">
        <span class="cab-conversation-copy">
          <span class="cab-conversation-title">${esc(section.title)}</span>
          <span class="cab-conversation-meta">${section.lines} líneas · ${formatSize(section.size)}${section.managed ? ' · Se mantiene automáticamente' : ''}</span>
        </span>
        <span class="cab-status-chip ${section.managed ? 'cab-status-chip--resting' : ''}">${section.managed ? 'Ver' : 'Abrir y ajustar'}</span>
      </button>`).join('')}</div>`;
  }

  state.el.innerHTML = `
    ${pageHeader()}
    <div class="cab-main-inner">
      <section aria-labelledby="behavior-title">
        <div class="cab-section-divider">
          <span id="behavior-title">Comportamiento</span>
          <span class="cab-section-divider-line"></span>
          ${data ? `<span class="cab-conversation-meta">${data.totalLines || 0} líneas · ${formatSize(data.totalSize)}</span>` : ''}
        </div>
        <p class="cab-subtitle" style="margin:0 0 var(--lite-space-y)">Cada bloque contiene una parte de lo que la IA sabe sobre tu forma de trabajar. Ajustás uno por vez.</p>
        ${sections}
      </section>
      <section aria-labelledby="identity-title" style="margin-top:var(--lite-space-y-lg)">
        <div class="cab-section-divider"><span id="identity-title">Quién sos</span><span class="cab-section-divider-line"></span></div>
        ${renderIdentity(state)}
      </section>
    </div>`;
}

function renderLoadingSection(state) {
  state.el.innerHTML = `
    <div class="cab-main-inner">
      <button class="cab-btn cab-btn--cold" data-action="home" type="button">Volver</button>
      <div style="margin-top:var(--lite-space-y-lg)">${emptyMessage('Abriendo esta indicación…')}</div>
    </div>`;
}

function renderEditor(state) {
  state.screen = 'editor';
  const section = state.section;
  if (!section || !isCurrent(state)) return;
  state.el.innerHTML = `
    <div class="cab-main-inner">
      <button class="cab-btn cab-btn--cold" data-action="home" type="button">Volver a Comportamiento</button>
      <header style="margin:var(--lite-space-y-lg) 0">
        <p class="cab-summary-eyebrow">Una indicación de trabajo</p>
        <h1 class="cab-title">${esc(section.title)}</h1>
        <p class="cab-subtitle">${state.sectionMeta?.managed
    ? 'Este bloque se mantiene automáticamente. Podés leerlo, pero no cambiarlo desde acá.'
    : 'Editá sólo este bloque. Antes de aplicar nada, vas a ver una explicación clara de lo que cambiaría.'}</p>
      </header>
      <div class="cab-composer">
        <textarea class="cab-composer-field" data-ref="editor" rows="18" spellcheck="true" ${state.sectionMeta?.managed ? 'readonly aria-readonly="true"' : ''}></textarea>
        <div class="cab-composer-actions">
          <span class="cab-conversation-meta">El resto de tus indicaciones no se toca.</span>
          ${state.sectionMeta?.managed ? '' : '<button class="cab-btn cab-btn--hot cab-composer-send" data-action="review" type="button">Revisar antes de guardar</button>'}
        </div>
      </div>
    </div>`;
  state.el.querySelector('[data-ref="editor"]').value = state.draft ?? section.text;
}

function changeGroup(title, items, kind) {
  const values = asList(items);
  if (!values.length) return '';
  const palette = kind === 'removed'
    ? 'background:var(--lite-diff-del-bg);color:var(--lite-diff-del-ink)'
    : 'background:var(--lite-diff-add-bg);color:var(--lite-diff-add-ink)';
  return `
    <section class="cab-panel" style="padding:18px 20px;${palette}">
      <h3 style="margin:0 0 10px;font-size:var(--cwc-fs-lg)">${esc(title)}</h3>
      <ul style="margin:0;padding-left:22px;line-height:1.6">${values.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
    </section>`;
}

function literalChangeGroup(title, text, kind) {
  if (!text) return '';
  const palette = kind === 'removed'
    ? 'background:var(--lite-diff-del-bg);color:var(--lite-diff-del-ink)'
    : 'background:var(--lite-diff-add-bg);color:var(--lite-diff-add-ink)';
  return `
    <section class="cab-panel" style="padding:18px 20px;${palette}">
      <h3 style="margin:0 0 10px;font-size:var(--cwc-fs-lg)">${esc(title)}</h3>
      <div style="white-space:pre-wrap;line-height:1.6">${esc(text)}</div>
    </section>`;
}

function renderReview(state, { analysis = null, error = '' } = {}) {
  state.screen = 'review';
  if (!isCurrent(state)) return;
  const local = changedLines(state.section.text, state.draft);
  const removed = analysis ? asList(analysis.removed) : [];
  const added = analysis ? asList(analysis.added) : [];
  const modified = analysis ? asList(analysis.modified) : [];
  const hasAiChanges = removed.length || added.length || modified.length;
  const riskLabels = { ok: 'No se ven pérdidas importantes', atencion: 'Conviene mirar con atención', critico: 'Este cambio puede borrar algo importante' };
  const explanation = analysis?.summary || analysis?.riskWhy || (error
    ? 'La explicación automática no estuvo disponible. Igual podés revisar abajo el texto que dejaría de estar y el que quedaría en su lugar.'
    : 'Comparando tu indicación anterior con la nueva…');

  state.el.innerHTML = `
    <div class="cab-main-inner">
      <button class="cab-btn cab-btn--cold" data-action="back-to-editor" type="button">Seguir editando</button>
      <header style="margin:var(--lite-space-y-lg) 0">
        <p class="cab-summary-eyebrow">Antes de aplicar el cambio</p>
        <h1 class="cab-title">Esto es lo que va a cambiar</h1>
        <p class="cab-subtitle">${esc(explanation)}</p>
      </header>
      ${analysis?.risk ? `<div class="cab-status-chip ${analysis.risk === 'ok' ? 'cab-status-chip--resting' : 'cab-status-chip--waiting'}" style="margin-bottom:var(--lite-space-y)">${esc(riskLabels[analysis.risk] || analysis.risk)}</div>` : ''}
      ${analysis?.summary && analysis?.riskWhy ? `<p class="cab-subtitle" style="margin:0 0 var(--lite-space-y)">${esc(analysis.riskWhy)}</p>` : ''}
      <div style="display:grid;gap:14px">
        ${analysis
    ? `${changeGroup('Lo que dejará de decir', removed, 'removed')}
           ${changeGroup('Lo que empezará a decir', added, 'added')}
           ${changeGroup('Lo que cambia de sentido', modified, 'added')}
           ${!hasAiChanges ? emptyMessage('No se detectaron cambios de contenido.') : ''}`
    : `${literalChangeGroup('Texto que dejará de estar', local.removed, 'removed')}
           ${literalChangeGroup('Texto que quedará en su lugar', local.added, 'added')}`}
      </div>
      <div class="cab-composer-actions" style="margin-top:var(--lite-space-y-lg)">
        <button class="cab-btn cab-btn--cold" data-action="back-to-editor" type="button">Quiero corregir algo</button>
        <button class="cab-btn cab-btn--hot cab-composer-send" data-action="confirm-save" type="button">Sí, aplicar este cambio</button>
      </div>
    </div>`;
}

function renderReviewLoading(state) {
  state.screen = 'review-loading';
  state.el.innerHTML = `
    <div class="cab-main-inner">
      <button class="cab-btn cab-btn--cold" data-action="back-to-editor" type="button">Seguir editando</button>
      <div style="margin-top:var(--lite-space-y-lg)">
        ${emptyMessage('La IA está leyendo el antes y el después para explicarte el cambio…')}
      </div>
    </div>`;
}

async function loadOverview(state) {
  const [sectionsResult, identityResult] = await Promise.allSettled([
    state.ctx.api.get(`${API_BASE}/global/sections`),
    state.ctx.api.get(`${API_BASE}/identity`),
  ]);
  if (!isCurrent(state)) return;
  if (sectionsResult.status === 'fulfilled') {
    state.sectionsData = sectionsResult.value;
    state.sectionsError = '';
  } else {
    state.sectionsError = sectionsResult.reason?.message || 'No pude leer tus indicaciones.';
  }
  if (identityResult.status === 'fulfilled') {
    state.identityData = identityResult.value;
    state.identityError = '';
  } else {
    state.identityError = identityResult.reason?.message || 'No pude leer tu identidad.';
  }
}

async function openSection(state, index) {
  const meta = asList(state.sectionsData?.sections).find((section) => String(section.i) === String(index));
  if (!meta) return;
  state.screen = 'section-loading';
  renderLoadingSection(state);
  try {
    const section = await state.ctx.api.get(`${API_BASE}/global/section/${encodeURIComponent(meta.i)}`);
    if (!isCurrent(state)) return;
    state.section = section;
    state.sectionMeta = meta;
    state.draft = section.text;
    renderEditor(state);
  } catch (error) {
    if (!isCurrent(state)) return;
    state.ctx.toast(error.message || 'No pude abrir esta indicación.');
    renderHome(state);
  }
}

async function beginReview(state) {
  const editor = state.el.querySelector('[data-ref="editor"]');
  if (!editor || !state.section) return;
  state.draft = editor.value;
  if (state.draft === state.section.text) {
    state.ctx.toast('No hay cambios para revisar.');
    return;
  }
  renderReviewLoading(state);
  try {
    let job = await state.ctx.api.post(
      `${API_BASE}/global/section/${encodeURIComponent(state.section.i)}/analyze`,
      { content: state.draft, hash: state.section.hash },
    );
    let misses = 0;
    while (job.status === 'running' && isCurrent(state) && state.screen === 'review-loading') {
      await waitForPoll(state);
      if (!isCurrent(state) || state.screen !== 'review-loading') return;
      try {
        job = await state.ctx.api.get(
          `${API_BASE}/global/section/${encodeURIComponent(state.section.i)}/analyze/${encodeURIComponent(job.id)}`,
        );
        misses = 0;
      } catch (error) {
        misses += 1;
        if (misses >= 5) throw error;
      }
    }
    if (!isCurrent(state) || state.screen !== 'review-loading') return;
    if (job.status !== 'done' || !job.analysis) throw new Error(job.error || 'La revisión automática no terminó.');
    state.reviewAnalysis = job.analysis;
    renderReview(state, { analysis: job.analysis });
  } catch (error) {
    if (!isCurrent(state) || state.screen !== 'review-loading') return;
    state.reviewAnalysis = null;
    renderReview(state, { error: error.message || 'No se pudo generar la explicación.' });
  }
}

async function confirmSave(state, button) {
  if (!state.section) return;
  button.disabled = true;
  button.textContent = 'Aplicando…';
  try {
    await state.ctx.api.post(
      `${API_BASE}/global/section/${encodeURIComponent(state.section.i)}`,
      { content: state.draft, hash: state.section.hash },
    );
    if (!isCurrent(state)) return;
    state.ctx.toast('Listo. La IA va a usar esta indicación en las próximas conversaciones.');
    state.section = null;
    state.sectionMeta = null;
    state.draft = '';
    state.sectionsData = null;
    state.identityData = null;
    renderHome(state);
    await loadOverview(state);
    if (isCurrent(state) && state.screen === 'home') renderHome(state);
  } catch (error) {
    if (!isCurrent(state)) return;
    state.ctx.toast(error.message || 'No pude aplicar el cambio. Nada fue guardado.');
    button.disabled = false;
    button.textContent = 'Sí, aplicar este cambio';
  }
}

async function openPreferencesChat(state, button) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const data = await state.ctx.api.post('/api/chat/preferencias');
    const chat = data?.chat;
    if (!chat?.id) throw new Error('El servidor no devolvió la conversación creada.');
    location.hash = '#/conversaciones/' + encodeURIComponent(chat.id);
  } catch (error) {
    state.ctx.toast(error?.message || 'No pude abrir la conversación.');
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function handleClick(state, event) {
  const button = event.target.closest('[data-action]');
  if (!button || !state.el.contains(button)) return;
  const action = button.dataset.action;
  if (action === 'refresh') {
    button.disabled = true;
    await loadOverview(state);
    if (isCurrent(state)) renderHome(state);
  } else if (action === 'preferences-chat') {
    await openPreferencesChat(state, button);
  } else if (action === 'home') {
    renderHome(state);
  } else if (action === 'open-section') {
    await openSection(state, button.dataset.index);
  } else if (action === 'review') {
    await beginReview(state);
  } else if (action === 'back-to-editor') {
    renderEditor(state);
  } else if (action === 'confirm-save') {
    await confirmSave(state, button);
  }
}

export default {
  name: 'como-trabajo',

  async mount(el, ctx) {
    this.unmount();
    const state = {
      alive: true,
      el,
      ctx,
      screen: 'home',
      sectionsData: null,
      identityData: null,
      sectionsError: '',
      identityError: '',
      section: null,
      sectionMeta: null,
      draft: '',
      reviewAnalysis: null,
      pollTimer: null,
      pollResolve: null,
      clickHandler: null,
    };
    current = state;
    state.clickHandler = (event) => { handleClick(state, event); };
    el.addEventListener('click', state.clickHandler);
    renderHome(state);
    await loadOverview(state);
    if (isCurrent(state) && state.screen === 'home') renderHome(state);
  },

  unmount() {
    if (!current) return;
    current.alive = false;
    if (current.pollTimer) clearTimeout(current.pollTimer);
    current.pollResolve?.();
    if (current.clickHandler) current.el.removeEventListener('click', current.clickHandler);
    current = null;
  },
};
