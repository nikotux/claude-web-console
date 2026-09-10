// modules/system/sponsorship-panel.js — panel personal para prestar la
// credencial de Claude a usuarios patrocinados. La adopción la decide cada
// sponsor desde su propia sesión; no es una acción administrativa.
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));

function formatUsd(value) {
  if (value == null || value === '') return t('system.sponsorship.noData', 'sin datos');
  const amount = Number(value);
  if (!Number.isFinite(amount)) return t('system.sponsorship.noData', 'sin datos');
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function sponsoredRows(items, busyKey) {
  return items.map((person) => {
    const username = String(person?.username ?? '');
    const key = `release:${username}`;
    return `
      <div class="hr-finding hr-finding--low">
        <div class="hr-f-head">
          <span class="hr-sev hr-sev--low">${icon('check', { size: 12 })}</span>
          <span class="hr-f-area">${esc(username)}</span>
          <span class="hr-f-mod">${esc(t(
            'system.sponsorship.usageLine',
            'Hoy: {today} · umbral: {threshold}',
            { today: formatUsd(person?.todayUsd), threshold: formatUsd(person?.thresholdUsd) },
          ))}</span>
          <button type="button" class="btn-ghost btn--sm btn--danger" data-action="release" data-username="${esc(username)}"${busyKey === key ? ' disabled' : ''}>
            ${icon('minus', { size: 13 })}
            <span>${busyKey === key
              ? t('system.sponsorship.releasing', 'Soltando…')
              : t('system.sponsorship.release', 'Soltar')}</span>
          </button>
        </div>
      </div>`;
  }).join('');
}

function candidateRows(items, busyKey) {
  return items.map((person) => {
    const username = String(person?.username ?? '');
    const key = `adopt:${username}`;
    return `
      <div class="hr-finding hr-finding--low">
        <div class="hr-f-head">
          <span class="hr-sev hr-sev--low">${icon('clock', { size: 12 })}</span>
          <span class="hr-f-area">${esc(username)}</span>
          <button type="button" class="btn btn--sm" data-action="adopt" data-username="${esc(username)}"${busyKey === key ? ' disabled' : ''}>
            ${icon('plus', { size: 13 })}
            <span>${busyKey === key
              ? t('system.sponsorship.adopting', 'Adoptando…')
              : t('system.sponsorship.adopt', 'Adoptar')}</span>
          </button>
        </div>
      </div>`;
  }).join('');
}

export function mountSponsorshipPanel(container, ctx) {
  let mine = null;
  let candidates = [];
  let busyKey = '';
  let feedback = null;

  container.innerHTML = `
    <div class="hp-opt">
      <details class="hp-opt-card" data-ref="panel">
        <summary class="hp-opt-head">
          ${icon('checklist', { size: 15 })}
          <strong>${t('system.sponsorship.title', 'Patrocinio')}</strong>
          <span class="hp-opt-snippet" data-ref="summary">${t('system.sponsorship.loading', 'cargando…')}</span>
          ${helpBtn('sys-sponsorship')}
        </summary>
        <div class="hp-opt-body" data-ref="body">
          <p class="ev-hint">${t('system.sponsorship.loading', 'cargando…')}</p>
        </div>
      </details>
    </div>`;

  const summary = container.querySelector('[data-ref="summary"]');
  const body = container.querySelector('[data-ref="body"]');

  function summaryText() {
    if (!mine) return t('system.sponsorship.loading', 'cargando…');
    if (!mine.canSponsor) {
      return t('system.sponsorship.cannotSponsorSummary', 'Un usuario patrocinado no puede patrocinar a otra persona');
    }
    const counts = t(
      'system.sponsorship.counts',
      '{sponsored} patrocinados · {candidates} esperando',
      { sponsored: mine.sponsored.length, candidates: candidates.length },
    );
    return mine.tokenReady
      ? counts
      : t('system.sponsorship.tokenPendingSummary', 'Token pendiente · {counts}', { counts });
  }

  function feedbackHtml() {
    if (!feedback?.text) return '';
    const kind = feedback.kind === 'ok' ? ' ev-msg--ok' : ' ev-msg--err';
    return `<p class="ev-msg${kind}">${esc(feedback.text)}</p>`;
  }

  function paint() {
    if (!mine) return;
    summary.textContent = summaryText();

    if (!mine.canSponsor) {
      body.innerHTML = `
        <p class="ev-hint">${t('system.sponsorship.cannotSponsor', 'Tu cuenta ya trabaja con la llave de otra persona, por eso no puede prestar una llave a su vez.')}</p>
        ${feedbackHtml()}`;
      return;
    }

    const sponsored = mine.sponsored;
    const tokenWarning = mine.tokenReady ? '' : `
      <div class="hlp-note hlp-note--warn">
        ${t('system.sponsorship.tokenWarning', 'Todavía no generaste tu token de patrocinio. Ejecutá claude setup-token: hasta entonces, la persona que adoptes no va a poder trabajar.')}
      </div>`;
    const empty = !sponsored.length && !candidates.length ? `
      <p class="ev-hint">${t('system.sponsorship.empty', 'Acá podés prestar tu llave de Claude a una persona patrocinada. Por ahora no patrocinás a nadie y tampoco hay personas esperando adopción.')}</p>` : '';
    const sponsoredSection = sponsored.length ? `
      <details class="hp-opt-group">
        <summary>${icon('check', { size: 13 })} ${t('system.sponsorship.sponsoredTitle', 'A quién le presto mi llave')} · ${sponsored.length}</summary>
        <div class="hr-findings">${sponsoredRows(sponsored, busyKey)}</div>
      </details>` : '';
    const candidatesSection = candidates.length ? `
      <details class="hp-opt-group">
        <summary>${icon('clock', { size: 13 })} ${t('system.sponsorship.candidatesTitle', 'Esperando que alguien los adopte')} · ${candidates.length}</summary>
        <div class="hr-findings">${candidateRows(candidates, busyKey)}</div>
      </details>` : '';

    body.innerHTML = `
      <p class="ev-hint">${t('system.sponsorship.intro', 'Vos decidís a quién le prestás tu llave de Claude y podés dejar de hacerlo cuando quieras.')}</p>
      ${tokenWarning}
      ${empty}
      ${sponsoredSection}
      ${candidatesSection}
      ${feedbackHtml()}`;

    body.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => runAction(button));
    });
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || t('system.sponsorship.requestError', 'No se pudo completar la operación.'));
    }
    return data;
  }

  async function load() {
    try {
      const [mineData, candidateData] = await Promise.all([
        requestJson('/api/sponsorship/mine'),
        requestJson('/api/sponsorship/candidates'),
      ]);
      mine = {
        canSponsor: !!mineData.canSponsor,
        tokenReady: !!mineData.tokenReady,
        sponsored: Array.isArray(mineData.sponsored) ? mineData.sponsored : [],
      };
      candidates = Array.isArray(candidateData.candidates) ? candidateData.candidates : [];
      paint();
    } catch (error) {
      summary.textContent = t('system.sponsorship.loadErrorSummary', 'No se pudo cargar');
      body.innerHTML = `<p class="ev-msg ev-msg--err">${esc(error?.message || t('system.sponsorship.loadError', 'No se pudo cargar el patrocinio.'))}</p>`;
    }
  }

  async function runAction(button) {
    const action = button.dataset.action;
    const username = button.dataset.username || '';
    const adopting = action === 'adopt';
    const ok = await ctx.dialog.confirmDialog({
      title: adopting
        ? t('system.sponsorship.adoptConfirmTitle', 'Adoptar a {username}', { username })
        : t('system.sponsorship.releaseConfirmTitle', 'Soltar a {username}', { username }),
      message: adopting
        ? t('system.sponsorship.adoptConfirmMessage', 'A partir de este momento, el consumo de {username} lo pagás vos con tu llave de Claude. ¿Querés adoptarlo?', { username })
        : t('system.sponsorship.releaseConfirmMessage', '{username} va a dejar de poder trabajar hasta que otra persona lo adopte. ¿Querés soltarlo?', { username }),
      confirmLabel: adopting
        ? t('system.sponsorship.adoptConfirm', 'Sí, adoptar')
        : t('system.sponsorship.releaseConfirm', 'Sí, soltar'),
      danger: !adopting,
    });
    if (!ok) return;

    busyKey = `${action}:${username}`;
    feedback = null;
    paint();
    try {
      await requestJson(`/api/sponsorship/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      feedback = {
        kind: 'ok',
        text: adopting
          ? t('system.sponsorship.adopted', 'Ahora patrocinás a {username}.', { username })
          : t('system.sponsorship.released', 'Dejaste de patrocinar a {username}.', { username }),
      };
    } catch (error) {
      feedback = {
        kind: 'err',
        text: error?.message || t('system.sponsorship.requestError', 'No se pudo completar la operación.'),
      };
    } finally {
      busyKey = '';
      await load();
    }
  }

  void load();
}
