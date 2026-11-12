import { t } from '../../ui/i18n.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function plainLiveText(value) {
  return String(value ?? '').replace(/`/g, '').replace(/\*\*/g, '').replace(/__/g, '');
}

function stamp(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatLiveDuration(ms) {
  const minutes = Math.max(0, Math.floor(Number(ms) / 60_000));
  if (minutes < 1) return t('chat.live.duration.lessMinute', 'menos de 1 min');
  if (minutes < 60) return t('chat.live.duration.minutes', '{n} min', { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = String(minutes % 60).padStart(2, '0');
  return t('chat.live.duration.hours', '{h} h {m} min', { h: hours, m: rest });
}

function progressBar(done, total, indeterminate = false) {
  const width = total > 0 ? Math.max(0, Math.min(100, done / total * 100)) : 0;
  return `<div class="live-progress${indeterminate ? ' is-indeterminate' : ''}" role="progressbar"${total > 0 ? ` aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"` : ''}><span style="width:${width}%"></span></div>`;
}

function durationLine(startedAt, finishedAt, clock) {
  const start = stamp(startedAt);
  if (!start) return '';
  return formatLiveDuration(Math.max(0, (stamp(finishedAt) || clock) - start));
}

function githubChecksUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return '#';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/checks`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return '#'; }
}

function dismissButton(kind, key) {
  return `<button type="button" class="live-dismiss" data-live-dismiss="${escapeHtml(kind)}:${escapeHtml(key)}" aria-label="${escapeHtml(t('chat.live.dismiss', 'Ocultar'))}" title="${escapeHtml(t('chat.live.dismiss', 'Ocultar'))}">×</button>`;
}

export function renderCodexCard(job, {
  now = Date.now(), typical = null, expanded = false, minimized = false,
} = {}) {
  if (!job || typeof job !== 'object') return '';
  const clock = stamp(now) || Date.now();
  const id = String(job.id || '');
  const progress = job.progress && typeof job.progress === 'object' ? job.progress : {};
  const steps = Array.isArray(progress.steps) ? progress.steps : [];
  const done = steps.filter((step) => step?.done === true).length;
  const total = steps.length;
  const files = Math.max(0, Number(progress.counts?.files) || 0);
  const actions = Math.max(0, Number(progress.counts?.actions) || 0);
  const started = stamp(job.startedAt);
  const elapsedMs = started ? Math.max(0, clock - started) : 0;
  const duration = durationLine(job.startedAt, job.finishedAt, clock);
  const problem = job.isError === true || ['error', 'killed', 'orphaned'].includes(job.status);
  const running = job.status === 'pending' || job.status === 'running';

  if (!running && problem) {
    return `<article class="live-card live-card--error" data-live-card="codex:${escapeHtml(id)}"><span>${escapeHtml(t('chat.live.codex.problem', '❌ Codex tuvo un problema · Claude lo revisa'))}</span>${dismissButton('codex', id)}</article>`;
  }
  if (!running) {
    const parts = [t('chat.live.codex.finished', '✅ Codex terminó')];
    if (total) parts.push(t('chat.live.codex.finishedSteps', '{done} de {total} pasos', { done, total }));
    if (duration) parts.push(t('chat.live.codex.took', 'tardó {time}', { time: duration }));
    if (files) parts.push(files === 1
      ? t('chat.live.codex.changedFilesSingular', 'cambió {n} archivo', { n: files })
      : t('chat.live.codex.changedFiles', 'cambió {n} archivos', { n: files }));
    return `<article class="live-card live-card--ok" data-live-card="codex:${escapeHtml(id)}">${escapeHtml(parts.join(' · '))}</article>`;
  }

  const currentIndex = steps.findIndex((step) => step?.done !== true);
  const current = currentIndex >= 0 ? steps[currentIndex] : null;
  const currentNumber = total ? Math.min(total, done + 1) : 0;
  const currentText = total
    ? plainLiveText(current?.text)
    : t('chat.live.codex.noSteps', 'Trabajando (este encargo no trae lista de pasos)');
  const stepText = total
    ? t('chat.live.codex.step', 'Va en el paso {n} de {total} — {text}', { n: currentNumber, total, text: currentText })
    : currentText;
  const typicalText = typical?.medianMs > 0
    ? t('chat.live.codex.typical', ' · la mayoría de los encargos termina en unos {time}', { time: formatLiveDuration(typical.medianMs) })
    : '';
  const staleMs = clock - stamp(job.heartbeatAt);
  const warningTexts = [
    typical?.p90Ms > 0 && elapsedMs > typical.p90Ms ? t('chat.live.codex.slow', '⚠️ Está tardando más que casi todos los anteriores') : '',
    stamp(job.heartbeatAt) && staleMs > 90_000
      ? t('chat.live.codex.stale', '⚠️ No da señales hace {time}', { time: formatLiveDuration(staleMs) }) : '',
  ].filter(Boolean);
  const warnings = warningTexts.map((text) => `<div class="live-warning">${escapeHtml(text)}</div>`).join('');
  const lastMessageText = progress.lastMessage ? plainLiveText(progress.lastMessage) : '';
  const nowText = progress.now?.label ? plainLiveText(progress.now.label) : '';
  const lastMessage = lastMessageText
    ? `<div class="live-detail">${escapeHtml(t('chat.live.codex.lastMessage', '💬 Lo último que contó: «{text}»', { text: lastMessageText }))}</div>` : '';
  const happening = nowText
    ? `<div class="live-detail">${escapeHtml(t('chat.live.codex.now', '▶ En este momento: {text}', { text: nowText }))}</div>` : '';
  const chipItems = [
    files ? {
      full: files === 1
        ? t('chat.live.codex.filesChipSingular', '📝 Cambió {n} archivo', { n: files })
        : t('chat.live.codex.filesChip', '📝 Cambió {n} archivos', { n: files }),
      mini: files === 1
        ? t('chat.live.codex.miniFilesChipSingular', '📝 {n} archivo', { n: files })
        : t('chat.live.codex.miniFilesChip', '📝 {n} archivos', { n: files }),
    } : null,
    actions ? {
      full: actions === 1
        ? t('chat.live.codex.actionsChipSingular', '🔁 Hizo {n} acción', { n: actions })
        : t('chat.live.codex.actionsChip', '🔁 Hizo {n} acciones', { n: actions }),
      mini: actions === 1
        ? t('chat.live.codex.miniActionsChipSingular', '🔁 {n} acción', { n: actions })
        : t('chat.live.codex.miniActionsChip', '🔁 {n} acciones', { n: actions }),
    } : null,
  ].filter(Boolean);
  const chips = chipItems.map((item) => `<span class="live-chip">${escapeHtml(item.full)}</span>`).join('');

  if (minimized) {
    const miniTypical = typical?.medianMs > 0
      ? t('chat.live.codex.miniTypical', ' de ~{time}', { time: formatLiveDuration(typical.medianMs) })
      : '';
    const miniDuration = duration || formatLiveDuration(0);
    const miniNowText = nowText || lastMessageText;
    const miniChips = chipItems.map((item) => `<span class="live-mini-chip">${escapeHtml(item.mini)}</span>`).join('');
    const miniWarnings = warningTexts.map((text) => `<span class="live-mini-warn">${escapeHtml(text)}</span>`).join('');
    const miniSub = [
      miniNowText ? `<span class="live-mini-now">▶ ${escapeHtml(miniNowText)}</span>` : '',
      miniChips,
      miniWarnings,
    ].join('');
    const pct = total ? Math.max(0, Math.min(100, done / total * 100)) : 0;
    return `<article class="live-card live-card--running live-card--mini${warningTexts.length ? ' live-card--warn' : ''}" data-live-card="codex:${escapeHtml(id)}">
      <div class="live-mini-row"><span class="live-pulse" aria-hidden="true"></span><strong>${escapeHtml(t('chat.live.codex.miniTitle', '⚙️ Codex'))}</strong>${total ? `<span class="live-mini-badge">${currentNumber}/${total}</span>` : ''}<span class="live-mini-step">${escapeHtml(currentText)}</span><span class="live-mini-time" data-live-elapsed="codex-mini" data-start="${stamp(job.startedAt)}" data-typical="${Number(typical?.medianMs) || 0}">${escapeHtml(t('chat.live.codex.miniElapsed', '⏱ {time}', { time: miniDuration }) + miniTypical)}</span><button type="button" class="live-restore" data-live-restore="${escapeHtml(id)}" title="${escapeHtml(t('chat.live.codex.restore', 'Restaurar'))}" aria-label="${escapeHtml(t('chat.live.codex.restore', 'Restaurar'))}">⤢</button></div>
      ${miniSub ? `<div class="live-mini-row live-mini-sub">${miniSub}</div>` : ''}
      <div class="live-mini-bar${total ? '' : ' is-indeterminate'}"><span style="width:${pct}%"></span></div>
    </article>`;
  }

  const checklist = steps.map((step, index) => {
    const state = step?.done === true ? 'done' : index === currentIndex ? 'current' : 'pending';
    const mark = state === 'done' ? '✅' : state === 'current' ? '🔄' : '⚪';
    return `<li class="is-${state}">${mark} <span>${escapeHtml(plainLiveText(step?.text))}</span></li>`;
  }).join('');
  const recent = (Array.isArray(progress.recent) ? [...progress.recent].reverse() : []).map((item) => (
    `<li>${item?.ok === false ? '✖' : '✔'} <span>${escapeHtml(plainLiveText(item?.label))}</span></li>`
  )).join('');
  const details = total || recent
    ? `<div class="live-expanded"${expanded ? '' : ' hidden'}>${total ? `<ul class="live-checklist">${checklist}</ul>` : ''}${recent ? `<h4>${escapeHtml(t('chat.live.codex.recent', 'Últimas acciones'))}</h4><ul class="live-recent">${recent}</ul>` : ''}</div>` : '';

  return `<article class="live-card live-card--running" data-live-card="codex:${escapeHtml(id)}">
    <div class="live-card-head"><span class="live-pulse" aria-hidden="true"></span><div><strong>${escapeHtml(t('chat.live.codex.working', '⚙️ Codex está trabajando'))}</strong>${job.label ? `<small>${escapeHtml(job.label)}</small>` : ''}</div><button type="button" class="live-minimize" data-live-minimize="${escapeHtml(id)}" title="${escapeHtml(t('chat.live.codex.minimize', 'Minimizar'))}" aria-label="${escapeHtml(t('chat.live.codex.minimize', 'Minimizar'))}">—</button></div>
    ${progressBar(done, total, !total)}<div class="live-step">${escapeHtml(stepText)}</div>
    ${duration ? `<div class="live-time" data-live-elapsed="codex" data-start="${stamp(job.startedAt)}" data-typical="${Number(typical?.medianMs) || 0}">${escapeHtml(t('chat.live.codex.elapsed', '⏱ Lleva {time}', { time: duration }) + typicalText)}</div>` : ''}${warnings}${lastMessage}${happening}
    ${chips ? `<div class="live-chips">${chips}</div>` : ''}
    ${details ? `<button type="button" class="live-toggle" data-live-toggle="${escapeHtml(id)}">${escapeHtml(expanded ? t('chat.live.codex.hideSteps', 'Ocultar los pasos ▴') : t('chat.live.codex.showSteps', 'Ver los pasos ▾'))}</button>${details}` : ''}
  </article>`;
}

export function renderCiCard(ci, { now = Date.now() } = {}) {
  if (!ci || typeof ci !== 'object') return '';
  const clock = stamp(now) || Date.now();
  const number = Number(ci.number) || 0;
  const total = Math.max(0, Number(ci.total) || 0);
  const done = Math.max(0, Number(ci.done) || 0);
  const failed = Math.max(0, Number(ci.failed) || 0);
  const failedNames = (Array.isArray(ci.failedNames) ? ci.failedNames : []).join(', ');
  const runningNames = (Array.isArray(ci.running) ? ci.running : []).join(', ');
  const duration = durationLine(ci.startedAt, ci.finishedAt, clock);
  const url = githubChecksUrl(ci.url);
  const link = `<a class="live-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(t('chat.live.ci.github', 'Ver en GitHub ↗'))}</a>`;
  const key = `${number}:${String(ci.sha || '')}`;
  if (ci.state === 'passed') {
    const took = duration ? t('chat.live.ci.took', ' · tardaron {time}', { time: duration }) : '';
    return `<article class="live-card live-card--ok" data-live-card="ci:${escapeHtml(key)}">${escapeHtml(t('chat.live.ci.passed', '✅ Pasaron todas las revisiones del PR #{number} ({total} de {total})', { number, total }) + took)}</article>`;
  }
  if (ci.state === 'failed') {
    const text = failed === 1
      ? t('chat.live.ci.failedSingular', '❌ Falló {n} revisión del PR #{number}: {names}', { n: failed, number, names: failedNames })
      : t('chat.live.ci.failed', '❌ Fallaron {n} revisiones del PR #{number}: {names}', { n: failed, number, names: failedNames });
    return `<article class="live-card live-card--error" data-live-card="ci:${escapeHtml(key)}"><span>${escapeHtml(text)} · ${link}</span>${dismissButton('ci', key)}</article>`;
  }
  const failedText = !failed ? '' : failed === 1
    ? t('chat.live.ci.oneFailed', ' · {n} falló: {names}', { n: failed, names: failedNames })
    : t('chat.live.ci.manyFailed', ' · {n} fallaron: {names}', { n: failed, names: failedNames });
  const readyText = total === 1
    ? t('chat.live.ci.readySingular', '{done} de {total} lista', { done, total })
    : t('chat.live.ci.ready', '{done} de {total} listas', { done, total });
  return `<article class="live-card live-card--running" data-live-card="ci:${escapeHtml(key)}">
    <div class="live-card-head"><div><strong>${escapeHtml(t('chat.live.ci.running', '🧪 Revisiones automáticas del PR #{number}', { number }))}</strong>${ci.title ? `<small>${escapeHtml(ci.title)}</small>` : ''}</div></div>
    ${progressBar(done, total)}<div class="live-step">${escapeHtml(readyText + failedText)}</div>
    ${runningNames ? `<div class="live-detail">${escapeHtml(t('chat.live.ci.now', '▶ Corriendo: {names}', { names: runningNames }))}</div>` : ''}
    ${duration ? `<div class="live-time" data-live-elapsed="ci" data-start="${stamp(ci.startedAt)}">${escapeHtml(t('chat.live.ci.elapsed', '⏱ Lleva {time}', { time: duration }))}</div>` : ''}${link}
  </article>`;
}
