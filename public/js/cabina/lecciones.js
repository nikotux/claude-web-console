// Cabina lite — mejora continua. Presenta patrones aprendidos para que la
// persona decida si conservarlos, sin exponer herramientas de administración.

import { icon } from '../ui/icons.js';
import { t } from '../ui/i18n.js';

const API_BASE = '/api/retro';

const CATEGORY = {
  regla: { icon: '⛔', label: t('cabina.lecciones.ruleCategory', 'Regla') },
  convencion: { icon: '📏', label: t('cabina.lecciones.conventionCategory', 'Convención') },
  metodologia: { icon: '🧭', label: t('cabina.lecciones.methodologyCategory', 'Metodología') },
  procedimiento: { icon: '📋', label: t('cabina.lecciones.procedureCategory', 'Procedimiento') },
  herramienta: { icon: '🔧', label: t('cabina.lecciones.toolCategory', 'Herramienta') },
  nota: { icon: '📝', label: t('cabina.lecciones.noteCategory', 'Nota') },
};

const STATUS = {
  propuesta: { label: t('cabina.lecciones.pendingStatus', 'Por decidir'), chip: 'cab-status-chip--waiting' },
  aprobada: { label: t('cabina.lecciones.approvedStatus', 'Aprobada'), chip: 'cab-status-chip--working' },
  promovida: { label: t('cabina.lecciones.incorporatedStatus', 'Ya incorporada'), chip: 'cab-status-chip--working' },
  descartada: { label: t('cabina.lecciones.dismissedStatus', 'Descartada'), chip: 'cab-status-chip--resting' },
};

const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[char]));

const lessonsOnly = (lessons) => (Array.isArray(lessons) ? lessons : [])
  .filter((lesson) => lesson.category !== 'feedback-cliente');

function partsOf(body) {
  const text = String(body || '').trim();
  const marker = '**Lección:**';
  const at = text.indexOf(marker);
  if (at < 0) return { observation: '', lesson: text };
  return {
    observation: text.slice(0, at).replace(/^\*\*Observación:\*\*\s*/, '').trim(),
    lesson: text.slice(at + marker.length).trim(),
  };
}

function recurrenceTone(value) {
  const count = Math.max(1, Number(value) || 1);
  if (count >= 5) return {
    row: 'cab-conversation-row--working',
    chip: 'cab-status-chip--working',
    label: t('cabina.lecciones.repeated', 'Se repitió {count} veces', { count }),
  };
  if (count > 1) return {
    row: 'cab-conversation-row--waiting',
    chip: 'cab-status-chip--waiting',
    label: t('cabina.lecciones.repeated', 'Se repitió {count} veces', { count }),
  };
  return { row: 'cab-conversation-row--resting', chip: 'cab-status-chip--resting', label: t('cabina.lecciones.appearedOnce', 'Apareció una vez') };
}

let current = null;

function isCurrent(state) {
  return current === state && state.alive;
}

function visibleCounts(lessons) {
  const counts = { propuesta: 0, aprobada: 0, promovida: 0, descartada: 0, total: lessons.length };
  for (const lesson of lessons) counts[lesson.status] = (counts[lesson.status] || 0) + 1;
  return counts;
}

function pageHeader(state) {
  const lessons = lessonsOnly(state.data?.lessons);
  const counts = visibleCounts(lessons);
  return `
    <header class="cab-page-header">
      <div>
        <h1 class="cab-title">${t('cabina.lecciones.title', 'Lecciones')}</h1>
        <p class="cab-subtitle">${t('cabina.lecciones.subtitle', 'Mirá lo que aprendí de vos esta semana. Vos decidís qué vale la pena conservar.')}</p>
      </div>
      <button class="cab-btn cab-btn--cold" data-action="refresh" type="button">${t('cabina.lecciones.refresh', 'Actualizar')}</button>
      <button class="cab-help-btn" type="button" data-cabina-help title="${t('cabina.lecciones.screenHelp', 'Cómo se usa esta pantalla')}" aria-label="${t('cabina.lecciones.screenHelp', 'Cómo se usa esta pantalla')}">${icon('help', { size: 16 })}</button>
    </header>
    <div class="cab-summary-grid" style="margin-top:0;margin-bottom:var(--lite-space-y-lg)">
      <div class="cab-summary-card">
        <span class="cab-summary-eyebrow">${t('cabina.lecciones.awaitingDecision', 'Esperan tu decisión')}</span>
        <span class="cab-summary-title">${counts.propuesta}</span>
        <span class="cab-summary-meta">${t('cabina.lecciones.newPatterns', 'Patrones nuevos para revisar')}</span>
      </div>
      <div class="cab-summary-card">
        <span class="cab-summary-eyebrow">${t('cabina.lecciones.reviewed', 'Ya revisadas')}</span>
        <span class="cab-summary-title">${counts.aprobada + counts.promovida + counts.descartada}</span>
        <span class="cab-summary-meta">${t('cabina.lecciones.reviewedCounts', '{approved} aprobadas · {dismissed} descartadas', {
          approved: counts.aprobada + counts.promovida,
          dismissed: counts.descartada,
        })}</span>
      </div>
    </div>`;
}

function lessonRow(lesson) {
  const category = CATEGORY[lesson.category] || CATEGORY.nota;
  const recurrence = recurrenceTone(lesson.recurrence);
  const status = STATUS[lesson.status] || STATUS.propuesta;
  return `
    <button class="cab-conversation-row ${recurrence.row}" data-action="open-lesson" data-id="${esc(lesson.id)}" type="button">
      <span class="cab-conversation-copy">
        <span class="cab-summary-eyebrow">${category.icon} ${esc(category.label)} · ${esc(status.label)}</span>
        <span class="cab-conversation-title" style="${Number(lesson.recurrence) >= 5 ? 'font-weight:700' : ''}">${esc(lesson.title)}</span>
        <span class="cab-conversation-meta">${esc(t('cabina.lecciones.confidence', 'Confianza {confidence}', {
          confidence: lesson.confidence || t('cabina.lecciones.mediumConfidence', 'media'),
        }))}</span>
      </span>
      <span class="cab-status-chip ${recurrence.chip}">${esc(recurrence.label)}</span>
    </button>`;
}

function group(state, title, statuses) {
  const items = lessonsOnly(state.data?.lessons)
    .filter((lesson) => statuses.includes(lesson.status))
    .sort((a, b) => (Number(b.recurrence) || 1) - (Number(a.recurrence) || 1));
  if (!items.length) return '';
  return `
    <section style="margin-bottom:var(--lite-space-y-lg)">
      <div class="cab-section-divider"><span>${esc(title)}</span><span class="cab-section-divider-line"></span><span class="cab-conversation-meta">${items.length}</span></div>
      <div class="cab-conversation-list">${items.map(lessonRow).join('')}</div>
    </section>`;
}

function renderList(state) {
  state.screen = 'list';
  if (!isCurrent(state)) return;
  if (state.error) {
    state.el.innerHTML = `
      <div class="cab-main-inner">
        ${pageHeader(state)}
        <div class="cab-panel" style="padding:var(--lite-space-y-lg);text-align:center">
          <p class="cab-subtitle" style="margin-inline:auto">${esc(state.error)}</p>
          <button class="cab-btn cab-btn--cold" data-action="refresh" type="button">${t('cabina.lecciones.retry', 'Reintentar')}</button>
        </div>
      </div>`;
    return;
  }
  if (!state.data) {
    state.el.innerHTML = `
      <div class="cab-main-inner">
        ${pageHeader(state)}
        <div class="cab-panel" style="padding:var(--lite-space-y-lg);text-align:center">${t('cabina.lecciones.loading', 'Cargando lecciones…')}</div>
      </div>`;
    return;
  }
  const lessons = lessonsOnly(state.data.lessons);
  state.el.innerHTML = `
    <div class="cab-main-inner">
      ${pageHeader(state)}
      ${lessons.length ? `
        ${group(state, t('cabina.lecciones.pendingGroup', 'Por decidir'), ['propuesta'])}
        ${group(state, t('cabina.lecciones.approvedGroup', 'Aprobadas'), ['aprobada', 'promovida'])}
        ${group(state, t('cabina.lecciones.dismissedGroup', 'Descartadas'), ['descartada'])}` : `
        <div class="cab-panel" style="padding:var(--lite-space-y-lg);text-align:center">
          <h2 class="cab-summary-title">${t('cabina.lecciones.empty', 'Todavía no hay lecciones')}</h2>
          <p class="cab-subtitle" style="margin-inline:auto">${t('cabina.lecciones.emptyHint', 'Cuando un patrón aparezca en tus conversaciones, lo vas a poder revisar acá.')}</p>
        </div>`}
    </div>`;
}

function lessonDate(state, lesson) {
  const stamp = lesson.updatedAt || lesson.createdAt;
  if (!stamp) return '';
  try { return state.ctx.fmtDate(stamp); } catch { return ''; }
}

function renderDetail(state) {
  state.screen = 'detail';
  const lesson = state.lesson;
  if (!lesson || !isCurrent(state)) return;
  const category = CATEGORY[lesson.category] || CATEGORY.nota;
  const status = STATUS[lesson.status] || STATUS.propuesta;
  const recurrence = recurrenceTone(lesson.recurrence);
  const parts = partsOf(lesson.body);
  const date = lessonDate(state, lesson);
  state.el.innerHTML = `
    <div class="cab-main-inner">
      <button class="cab-btn cab-btn--cold" data-action="back" type="button">${t('cabina.lecciones.back', 'Volver a Lecciones')}</button>
      <header style="margin:var(--lite-space-y-lg) 0">
        <p class="cab-summary-eyebrow">${category.icon} ${esc(category.label)}</p>
        <h1 class="cab-title">${esc(lesson.title)}</h1>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <span class="cab-status-chip ${status.chip}">${esc(status.label)}</span>
          <span class="cab-status-chip ${recurrence.chip}">${esc(recurrence.label)}</span>
          <span class="cab-status-chip cab-status-chip--resting">${esc(t('cabina.lecciones.confidence', 'Confianza {confidence}', {
            confidence: lesson.confidence || t('cabina.lecciones.mediumConfidence', 'media'),
          }))}</span>
        </div>
      </header>
      <div style="display:grid;gap:14px">
        <section class="cab-summary-card">
          <span class="cab-summary-eyebrow">${t('cabina.lecciones.observation', 'Lo que observé')}</span>
          <div class="cab-message-bubble" style="padding:0;white-space:pre-wrap">${esc(parts.observation || t('cabina.lecciones.noObservation', 'No quedó registrada una observación concreta.'))}</div>
        </section>
        <section class="cab-panel" style="padding:22px;border-left:3px solid var(--cwc-accent)">
          <span class="cab-summary-eyebrow">${t('cabina.lecciones.generalLesson', 'La lección general')}</span>
          <div class="cab-message-bubble" style="padding:0;white-space:pre-wrap;font-weight:600">${esc(parts.lesson || t('cabina.lecciones.noGeneralRule', 'No quedó registrada una regla general.'))}</div>
        </section>
      </div>
      <p class="cab-conversation-meta" style="margin:14px 0 0">${date ? esc(t('cabina.lecciones.updatedAt', 'Actualizada {date} · ', { date })) : ''}${esc(lesson.id || '')}</p>
      ${lesson.status === 'propuesta' ? `
        <div class="cab-composer-actions" style="margin-top:var(--lite-space-y-lg)" data-ref="decision-actions">
          <button class="cab-btn cab-btn--cold" data-action="ask-dismiss" type="button">${t('cabina.lecciones.declineLesson', 'No, descartarla')}</button>
          <button class="cab-btn cab-btn--hot cab-composer-send" data-action="approve" type="button">${t('cabina.lecciones.keepLesson', 'Sí, conservar esta lección')}</button>
        </div>` : ''}
    </div>`;
}

function renderDismissQuestion(state) {
  const actions = state.el.querySelector('[data-ref="decision-actions"]');
  if (!actions) return;
  actions.innerHTML = `
    <span class="cab-conversation-meta">${t('cabina.lecciones.dismissConfirm', '¿Seguro? Quedará en Descartadas.')}</span>
    <button class="cab-btn cab-btn--cold" data-action="cancel-dismiss" type="button">${t('cabina.lecciones.cancel', 'Cancelar')}</button>
    <button class="cab-btn cab-btn--hot" data-action="dismiss" type="button">${t('cabina.lecciones.confirmDismiss', 'Sí, descartarla')}</button>`;
}

async function loadLessons(state) {
  try {
    state.data = await state.ctx.api.get(API_BASE);
    state.error = '';
  } catch (error) {
    state.error = error.message || t('cabina.lecciones.loadError', 'No pude leer las lecciones.');
  }
}

async function openLesson(state, id) {
  state.screen = 'detail-loading';
  state.el.innerHTML = `
    <div class="cab-main-inner">
      <button class="cab-btn cab-btn--cold" data-action="back" type="button">${t('cabina.lecciones.back', 'Volver a Lecciones')}</button>
      <div class="cab-panel" style="margin-top:var(--lite-space-y-lg);padding:var(--lite-space-y-lg);text-align:center">${t('cabina.lecciones.opening', 'Abriendo la lección…')}</div>
    </div>`;
  try {
    const data = await state.ctx.api.get(`${API_BASE}/${encodeURIComponent(id)}`);
    if (!isCurrent(state)) return;
    state.lesson = data.lesson;
    renderDetail(state);
  } catch (error) {
    if (!isCurrent(state)) return;
    state.ctx.toast(error.message || t('cabina.lecciones.openError', 'No pude abrir la lección.'));
    renderList(state);
  }
}

async function decide(state, action, button) {
  if (!state.lesson || state.lesson.status !== 'propuesta') return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = action === 'approve'
    ? t('cabina.lecciones.savingApproval', 'Conservando…')
    : t('cabina.lecciones.savingDismissal', 'Descartando…');
  try {
    const result = await state.ctx.api.post(
      `${API_BASE}/${encodeURIComponent(state.lesson.id)}/${action}`,
      {},
    );
    if (!isCurrent(state)) return;
    state.lesson = result.lesson;
    const index = state.data?.lessons?.findIndex((lesson) => lesson.id === result.lesson.id) ?? -1;
    if (index >= 0) state.data.lessons[index] = result.lesson;
    state.ctx.toast(action === 'approve'
      ? t('cabina.lecciones.approvedToast', 'Lección aprobada.')
      : t('cabina.lecciones.dismissedToast', 'Lección descartada.'));
    renderDetail(state);
  } catch (error) {
    if (!isCurrent(state)) return;
    state.ctx.toast(error.message || t('cabina.lecciones.saveDecisionError', 'No pude guardar tu decisión.'));
    button.disabled = false;
    button.textContent = original;
  }
}

async function handleClick(state, event) {
  const button = event.target.closest('[data-action]');
  if (!button || !state.el.contains(button)) return;
  const action = button.dataset.action;
  if (action === 'refresh') {
    button.disabled = true;
    await loadLessons(state);
    if (isCurrent(state)) renderList(state);
  } else if (action === 'open-lesson') {
    await openLesson(state, button.dataset.id);
  } else if (action === 'back') {
    renderList(state);
  } else if (action === 'approve' || action === 'dismiss') {
    await decide(state, action, button);
  } else if (action === 'ask-dismiss') {
    renderDismissQuestion(state);
  } else if (action === 'cancel-dismiss') {
    renderDetail(state);
  }
}

export default {
  name: 'lecciones',

  async mount(el, ctx) {
    this.unmount();
    const state = {
      alive: true,
      el,
      ctx,
      data: null,
      error: '',
      lesson: null,
      screen: 'list',
      clickHandler: null,
    };
    current = state;
    state.clickHandler = (event) => { handleClick(state, event); };
    el.addEventListener('click', state.clickHandler);
    renderList(state);
    await loadLessons(state);
    if (isCurrent(state) && state.screen === 'list') renderList(state);
  },

  unmount() {
    if (!current) return;
    current.alive = false;
    if (current.clickHandler) current.el.removeEventListener('click', current.clickHandler);
    current = null;
  },
};
