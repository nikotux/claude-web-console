// modules/system/sponsorship-panel.js — panel personal para prestar la
// credencial de Claude a usuarios patrocinados. La adopción la decide cada
// sponsor desde su propia sesión; no es una acción administrativa.
import { icon } from '../../ui/icons.js';
import { openModal } from '../../ui/dialog.js';
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
    const tokenStatus = mine.tokenReady ? `
      <p class="ev-hint">${t('system.sponsorship.tokenReady', '🔑 Tu token de patrocinio está listo.')}</p>` : `
      <div class="hlp-note hlp-note--warn">
        ${t('system.sponsorship.tokenWarning', 'El token de patrocinio es una credencial dedicada y revocable que permite trabajar a quienes adoptes, sin prestarles tus credenciales personales. Generala desde acá antes de adoptar a alguien.')}
        <div class="mcp-acts">
          <button type="button" class="btn btn--sm" data-action="gen-token">
            ${icon('plus', { size: 13 })}
            <span>${t('system.sponsorship.generateToken', 'Generar mi token de patrocinio')}</span>
          </button>
        </div>
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
      ${tokenStatus}
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

  function openTokenWizard() {
    const modal = openModal({
      title: t('system.sponsorship.tokenWizardTitle', 'Generar token de patrocinio'),
      width: 560,
    });
    let timer = null;
    let closed = false;
    let terminal = false;
    let status = 'starting';
    let polling = false;
    let sendingCode = false;
    let idleTicks = 0;

    modal.body.innerHTML = `
      <div class="mcp-oauth">
        <div class="hlp-note hlp-note--warn">${t('system.sponsorship.tokenCostWarning', 'Este token consume de TU suscripción de Claude: quien patrocines gasta con tu cuenta.')}</div>
        <p class="ev-hint" data-ref="token-status"></p>
        <div data-ref="token-auth" hidden>
          <p class="ev-hint">${t('system.sponsorship.tokenAuthorizeStep', 'Abrí este enlace y autorizá el acceso con tu cuenta de Claude:')}</p>
          <a class="mcp-oauth-link" data-ref="token-url" target="_blank" rel="noopener noreferrer">
            ${icon('externalLink', { size: 13 })}
            <span data-ref="token-url-text"></span>
          </a>
          <p class="ev-hint">${t('system.sponsorship.tokenCodeStep', 'Pegá el código que muestra la pantalla de autorización.')}</p>
          <input type="text" class="dlg-input" data-ref="token-code" autocomplete="off" placeholder="${esc(t('system.sponsorship.tokenCodePlaceholder', 'Código de autorización'))}">
          <button type="button" class="btn btn--sm" data-ref="token-send">
            ${icon('check', { size: 12 })}
            <span>${t('system.sponsorship.sendCode', 'Enviar código')}</span>
          </button>
        </div>
        <p class="ev-hint" data-ref="token-note" hidden></p>
        <p class="ev-msg ev-msg--err" data-ref="token-error" hidden></p>
        <p class="ev-msg ev-msg--ok" data-ref="token-success" hidden>${t('system.sponsorship.tokenDone', 'Tu token de patrocinio está listo.')}</p>
        <div class="mcp-acts">
          <button type="button" class="btn btn--sm" data-ref="token-retry" hidden>${icon('refresh', { size: 12 })}<span>${t('system.sponsorship.retry', 'Reintentar')}</span></button>
          <button type="button" class="btn-ghost btn--sm" data-ref="token-cancel">${t('system.sponsorship.cancel', 'Cancelar')}</button>
          <button type="button" class="btn btn--sm" data-ref="token-close" hidden>${t('system.sponsorship.close', 'Cerrar')}</button>
        </div>
      </div>`;

    const statusLine = modal.body.querySelector('[data-ref="token-status"]');
    const auth = modal.body.querySelector('[data-ref="token-auth"]');
    const authUrl = modal.body.querySelector('[data-ref="token-url"]');
    const authUrlText = modal.body.querySelector('[data-ref="token-url-text"]');
    const codeInput = modal.body.querySelector('[data-ref="token-code"]');
    const sendButton = modal.body.querySelector('[data-ref="token-send"]');
    const noteLine = modal.body.querySelector('[data-ref="token-note"]');
    const errorLine = modal.body.querySelector('[data-ref="token-error"]');
    const successLine = modal.body.querySelector('[data-ref="token-success"]');
    const retryButton = modal.body.querySelector('[data-ref="token-retry"]');
    const cancelButton = modal.body.querySelector('[data-ref="token-cancel"]');
    const closeButton = modal.body.querySelector('[data-ref="token-close"]');

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const cancelJob = () => fetch('/api/sponsorship/token/cancel', { method: 'POST' }).catch(() => {});
    const observer = new MutationObserver(() => {
      if (modal.body.isConnected) return;
      closed = true;
      stop();
      observer.disconnect();
      if (!terminal) void cancelJob();
      if (status === 'done') void load();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    function setUrl(url) {
      if (!url) return;
      authUrl.href = url;
      authUrlText.textContent = url;
    }

    function render(job = {}) {
      const nextStatus = job.ready && job.status !== 'error' ? 'done' : job.status;
      status = nextStatus;
      if (nextStatus && nextStatus !== 'idle') idleTicks = 0;
      if (job.url) setUrl(job.url);
      noteLine.hidden = !job.note;
      noteLine.textContent = job.note
        ? t('system.sponsorship.tokenNote', 'Diagnóstico: {note}', { note: job.note })
        : '';
      errorLine.hidden = true;
      successLine.hidden = true;
      retryButton.hidden = true;
      closeButton.hidden = true;
      cancelButton.hidden = false;

      if (nextStatus === 'starting') {
        terminal = false;
        auth.hidden = true;
        statusLine.hidden = false;
        statusLine.textContent = t('system.sponsorship.tokenStarting', 'Abriendo el flujo de autorización…');
        sendButton.disabled = false;
        codeInput.disabled = false;
      } else if (nextStatus === 'awaiting-code') {
        terminal = false;
        auth.hidden = false;
        statusLine.hidden = false;
        statusLine.textContent = t('system.sponsorship.tokenAwaitingCode', 'Autorizá el acceso y pegá el código para continuar.');
        sendButton.disabled = sendingCode;
        codeInput.disabled = sendingCode;
      } else if (nextStatus === 'exchanging') {
        terminal = false;
        auth.hidden = false;
        statusLine.hidden = false;
        statusLine.textContent = t('system.sponsorship.tokenExchanging', 'Canjeando el código…');
        sendButton.disabled = true;
        codeInput.disabled = true;
      } else if (nextStatus === 'done') {
        terminal = true;
        sendingCode = false;
        stop();
        auth.hidden = true;
        statusLine.hidden = true;
        successLine.hidden = false;
        cancelButton.hidden = true;
        closeButton.hidden = false;
      } else if ((!nextStatus || nextStatus === 'idle') && idleTicks < 10) {
        // El runner desacoplado puede no haber escrito todavía su primer estado.
        idleTicks += 1;
        terminal = false;
        auth.hidden = true;
        statusLine.hidden = false;
        statusLine.textContent = t('system.sponsorship.tokenStarting', 'Abriendo el flujo de autorización…');
        sendButton.disabled = false;
        codeInput.disabled = false;
        return;
      } else {
        terminal = true;
        sendingCode = false;
        stop();
        auth.hidden = true;
        statusLine.hidden = true;
        errorLine.hidden = false;
        errorLine.textContent = t(
          'system.sponsorship.tokenError',
          'No se pudo generar el token: {error}',
          { error: job.error || t('system.sponsorship.tokenIdle', 'No hay un flujo de autorización activo.') },
        );
        retryButton.hidden = false;
        cancelButton.hidden = true;
        closeButton.hidden = false;
      }
    }

    async function pollOnce() {
      if (closed || polling) return;
      polling = true;
      try {
        const job = await requestJson('/api/sponsorship/token/status');
        if (!closed) render(job);
      } catch {
        // Una falla transitoria de red no interrumpe el asistente ni su polling.
      } finally {
        polling = false;
      }
    }

    async function startToken() {
      stop();
      terminal = false;
      sendingCode = false;
      idleTicks = 0;
      render({ status: 'starting' });
      try {
        const job = await requestJson('/api/sponsorship/token/start', { method: 'POST' });
        if (closed) return;
        timer = setInterval(pollOnce, 1500);
        render(job);
        await pollOnce();
      } catch (error) {
        if (!closed) render({ status: 'error', error: error?.message || String(error) });
      }
    }

    async function submitCode() {
      const code = codeInput.value.trim();
      if (!code || sendButton.disabled || sendingCode) return;
      sendingCode = true;
      sendButton.disabled = true;
      codeInput.disabled = true;
      noteLine.hidden = false;
      noteLine.textContent = t('system.sponsorship.tokenSendingCode', 'Enviando código…');
      try {
        await requestJson('/api/sponsorship/token/code', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        sendingCode = false;
        noteLine.textContent = t('system.sponsorship.tokenCodeSent', 'Código enviado. Esperando confirmación…');
        await pollOnce();
      } catch (error) {
        sendingCode = false;
        noteLine.textContent = t('system.sponsorship.tokenCodeError', 'No se pudo enviar el código: {error}', { error: error?.message || String(error) });
        sendButton.disabled = false;
        codeInput.disabled = false;
      }
    }

    sendButton.addEventListener('click', submitCode);
    codeInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void submitCode();
    });
    retryButton.addEventListener('click', startToken);
    cancelButton.addEventListener('click', () => modal.close());
    closeButton.addEventListener('click', () => modal.close());

    void startToken();
  }

  async function runAction(button) {
    const action = button.dataset.action;
    if (action === 'gen-token') {
      openTokenWizard();
      return;
    }
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
