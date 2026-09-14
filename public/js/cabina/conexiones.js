import { icon } from '../ui/icons.js';

const PROVIDER_COPY = {
  microsoft: {
    name: 'Microsoft 365',
    can: 'El agente puede leer y enviar correo, organizar tu calendario y tus tareas, consultar contactos, trabajar con archivos y sitios, y leer las conversaciones de Teams necesarias para ayudarte.',
    cannot: 'No recibe tu contraseña ni puede cambiar la seguridad de tu cuenta, administrar usuarios o entrar a productos fuera de Microsoft 365.',
  },
  zoho: {
    name: 'Zoho',
    can: 'El agente puede trabajar con tickets y contactos de Desk, consultar y actualizar la información de CRM, y revisar proyectos y tareas.',
    cannot: 'No recibe tu contraseña ni puede administrar usuarios, pagos o la configuración general de tu organización.',
  },
  freshservice: {
    name: 'Freshservice',
    can: 'El agente puede ayudarte con tickets y con la información de soporte que tu cuenta de Freshservice ya puede ver y gestionar.',
    cannot: 'No recibe tu contraseña ni obtiene más permisos que los que ya tiene tu usuario de Freshservice.',
  },
};

const POLL_MS = 3000;

let disposeCurrent = () => {};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function accountLabel(provider) {
  if (provider.id === 'freshservice') {
    const identity = provider.name || provider.email || provider.account;
    if (identity && provider.email && identity !== provider.email) {
      return `${identity} · ${provider.email}`;
    }
    return identity || provider.domain || 'Cuenta verificada';
  }
  return provider.account || 'Cuenta verificada';
}

function initialPhase(provider) {
  if (provider.connected) return { name: 'connected' };
  const error = provider.error || provider.lastAttempt?.error;
  if (error) return { name: 'error', error };
  return {
    name: 'idle',
    interrupted: provider.lastAttempt?.status === 'pending',
  };
}

function formatRemaining(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function statusView(provider, phase) {
  if (provider.connected || phase.name === 'connected') {
    return { label: 'Conectada', modifier: 'working' };
  }
  if (phase.name === 'error') return { label: 'Con error', modifier: 'waiting' };
  if (phase.name === 'starting') return { label: 'Conectando · iniciando', modifier: 'working' };
  if (phase.name === 'awaiting-code') return { label: 'Conectando · falta tu autorización', modifier: 'working' };
  if (phase.name === 'exchanging') return { label: 'Conectando · verificando', modifier: 'working' };
  return { label: 'Sin conectar', modifier: 'resting' };
}

function button(ctx, { action, provider, label, hot = false, disabled = false, icon: iconName = '' }) {
  const iconHtml = iconName ? icon(iconName) : '';
  return `<button class="cab-btn cab-btn--${hot ? 'hot' : 'cold'}" type="button" data-action="${esc(action)}" data-provider="${esc(provider)}"${disabled ? ' disabled' : ''}>${iconHtml}<span>${esc(label)}</span></button>`;
}

function connectedDetail(provider, ctx) {
  const date = provider.connectedAt
    ? `<span> · desde ${esc(ctx.fmtDate(provider.connectedAt))}</span>`
    : '';
  return `
    <p class="cab-summary-meta">
      ${icon('check')}
      <span>${esc(accountLabel(provider))}${date}</span>
    </p>`;
}

function microsoftFlow(provider, phase, ctx) {
  if (phase.name === 'starting') {
    return `
      <p class="cab-subtitle" role="status">Estamos preparando una autorización segura con Microsoft…</p>
      <div class="cab-composer-actions">
        ${button(ctx, { action: 'cancel', provider: provider.id, label: 'Cancelar' })}
      </div>`;
  }

  if (!['awaiting-code', 'exchanging'].includes(phase.name)) return '';
  const url = safeExternalUrl(phase.verificationUri);
  const countdown = phase.deadline
    ? `<span class="cab-status-chip cab-status-chip--waiting" data-countdown="microsoft">Vence en ${formatRemaining(phase.deadline - Date.now())}</span>`
    : '';
  const checking = phase.name === 'exchanging'
    ? '<p class="cab-subtitle" role="status">Estamos comprobando la autorización. Podés dejar esta pantalla abierta.</p>'
    : '<p class="cab-subtitle" role="status">Microsoft te pedirá este código. Cuando autorices, la conexión se confirmará sola.</p>';

  return `
    ${checking}
    <div class="cab-composer">
      <p class="cab-summary-eyebrow">Tu código de un solo uso</p>
      <output class="cab-title" aria-label="Código de Microsoft">${esc(phase.userCode)}</output>
      <div class="cab-composer-actions">
        ${button(ctx, { action: 'copy-code', provider: provider.id, label: 'Copiar código', icon: 'clipboard' })}
        ${url ? `<a class="cab-btn cab-btn--hot" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-action="open-microsoft" data-provider="microsoft">${icon('externalLink')}<span>Abrir Microsoft</span></a>` : ''}
        ${countdown}
      </div>
    </div>
    <ol class="cab-subtitle">
      <li>Abrí Microsoft con el botón.</li>
      <li>Escribí el código grande y aceptá.</li>
      <li>Volvé acá; la consola terminará automáticamente.</li>
    </ol>
    <div class="cab-composer-actions">
      ${button(ctx, { action: 'cancel', provider: provider.id, label: 'Cancelar' })}
    </div>`;
}

function zohoFlow(provider, phase, ctx) {
  if (phase.name === 'starting') {
    return `
      <p class="cab-subtitle" role="status">Estamos preparando la autorización con Zoho…</p>
      <div class="cab-composer-actions">${button(ctx, { action: 'cancel', provider: provider.id, label: 'Cancelar' })}</div>`;
  }
  if (phase.name === 'exchanging') {
    return `
      <p class="cab-subtitle" role="status">Zoho está verificando el código y terminando la conexión…</p>
      <div class="cab-composer-actions">${button(ctx, { action: 'cancel', provider: provider.id, label: 'Cancelar' })}</div>`;
  }
  if (phase.name !== 'awaiting-code') return '';

  const url = safeExternalUrl(phase.authUrl);
  return `
    <p class="cab-subtitle" role="status">Autorizá la cuenta en Zoho y pegá acá el código de un solo uso que te entregue.</p>
    <ol class="cab-subtitle">
      <li>${url ? `<a class="cab-btn cab-btn--hot" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${icon('externalLink')}<span>Abrir Zoho</span></a>` : 'Abrí la consola de Zoho.'}</li>
      <li>Al crear la autorización, usá los permisos preparados para esta conexión. ${button(ctx, { action: 'copy-permissions', provider: provider.id, label: 'Copiar permisos necesarios', icon: 'clipboard' })}</li>
      <li>Copiá el código que te muestre Zoho y pegalo abajo enseguida: dura pocos minutos y se usa una sola vez.</li>
    </ol>
    <form class="cab-composer" data-form="zoho" data-provider="zoho">
      <label class="cab-summary-eyebrow" for="cab-zoho-code">Código entregado por Zoho</label>
      <input class="cab-composer-field" id="cab-zoho-code" name="code" type="password" autocomplete="off" required placeholder="Pegalo acá">
      <div class="cab-composer-actions">
        ${button(ctx, { action: 'submit-zoho', provider: provider.id, label: 'Terminar conexión', hot: true, icon: 'check' })}
        ${button(ctx, { action: 'cancel', provider: provider.id, label: 'Cancelar' })}
      </div>
    </form>`;
}

function freshserviceForm(provider, ctx) {
  return `
    <form class="cab-composer" data-form="freshservice" data-provider="freshservice">
      <label class="cab-summary-eyebrow" for="cab-fresh-domain">Dirección de tu cuenta</label>
      <input class="cab-composer-field" id="cab-fresh-domain" name="domain" type="text" inputmode="url" autocomplete="url" required placeholder="tuempresa.freshservice.com">
      <label class="cab-summary-eyebrow" for="cab-fresh-key">Clave de API</label>
      <input class="cab-composer-field" id="cab-fresh-key" name="apiKey" type="password" autocomplete="new-password" required placeholder="Pegala acá">
      <p class="cab-summary-meta">La clave se envía directamente para verificar la cuenta. Nunca se vuelve a mostrar en esta pantalla.</p>
      <div class="cab-composer-actions">
        ${button(ctx, { action: 'submit-freshservice', provider: provider.id, label: 'Verificar y conectar', hot: true, icon: 'check' })}
      </div>
    </form>`;
}

function actionArea(provider, phase, ctx, allConnected) {
  if (allConnected) return '';
  if (provider.connected || phase.name === 'connected') {
    return `<div class="cab-composer-actions">${button(ctx, { action: 'disconnect', provider: provider.id, label: 'Desconectar' })}</div>`;
  }
  if (phase.name === 'error') {
    return `
      <p class="cab-subtitle" role="alert">${esc(phase.error || 'No se pudo completar la conexión.')}</p>
      <div class="cab-composer-actions">
        ${button(ctx, { action: 'retry', provider: provider.id, label: 'Intentar de nuevo', hot: true, icon: 'refresh', disabled: provider.configured === false })}
        ${phase.jobId ? button(ctx, { action: 'cancel', provider: provider.id, label: 'Cancelar intento' }) : ''}
      </div>`;
  }
  if (provider.configured === false) {
    return '<p class="cab-subtitle" role="status">Un administrador todavía tiene que habilitar esta conexión. No necesitás cargar ninguna configuración técnica.</p>';
  }
  if (provider.id === 'microsoft') {
    const flow = microsoftFlow(provider, phase, ctx);
    if (flow) return flow;
  }
  if (provider.id === 'zoho') {
    const flow = zohoFlow(provider, phase, ctx);
    if (flow) return flow;
  }
  if (provider.id === 'freshservice') {
    if (phase.name === 'exchanging') {
      return '<p class="cab-subtitle" role="status">Estamos verificando la cuenta con Freshservice…</p>';
    }
    return freshserviceForm(provider, ctx);
  }
  return `
    ${phase.interrupted ? '<p class="cab-subtitle">Había una conexión anterior sin terminar. Al empezar de nuevo recibirás una autorización nueva.</p>' : ''}
    <div class="cab-composer-actions">
      ${button(ctx, { action: 'connect', provider: provider.id, label: 'Conectar cuenta', hot: true })}
    </div>`;
}

function providerCard(provider, phase, ctx, allConnected) {
  const copy = PROVIDER_COPY[provider.id] || {
    name: provider.label || provider.id,
    can: 'El agente puede usar esta cuenta para ayudarte cuando se lo pidas.',
    cannot: 'No recibe tu contraseña.',
  };
  const status = statusView(provider, phase);
  return `
    <article class="cab-summary-card" data-provider-card="${esc(provider.id)}">
      <div class="cab-page-header">
        <div>
          <p class="cab-summary-eyebrow">Conexión</p>
          <h2 class="cab-summary-title">${esc(copy.name)}</h2>
        </div>
        <span class="cab-status-chip cab-status-chip--${status.modifier}">${esc(status.label)}</span>
      </div>
      <p class="cab-subtitle"><strong>Qué podrá hacer:</strong> ${esc(copy.can)}</p>
      <p class="cab-subtitle"><strong>Qué no:</strong> ${esc(copy.cannot)}</p>
      ${(provider.connected || phase.name === 'connected') ? connectedDetail(provider, ctx) : ''}
      ${actionArea(provider, phase, ctx, allConnected)}
    </article>`;
}

function loadingMarkup() {
  return `
    <header class="cab-page-header">
      <div>
        <h1 class="cab-title">Conexiones</h1>
        <p class="cab-subtitle" role="status">Estamos revisando qué cuentas ya están listas…</p>
      </div>
    </header>`;
}

function pageMarkup(providers, phases, ctx, loadError = '') {
  if (loadError) {
    return `
      <header class="cab-page-header">
        <div>
          <h1 class="cab-title">Conexiones</h1>
          <p class="cab-subtitle">Acá conectás las cuentas con las que el agente puede ayudarte.</p>
        </div>
      </header>
      <section class="cab-summary-card" role="alert">
        <h2 class="cab-summary-title">No pudimos revisar tus conexiones</h2>
        <p class="cab-subtitle">${esc(loadError)}</p>
        <div class="cab-composer-actions">${button(ctx, { action: 'reload', provider: '', label: 'Volver a intentar', hot: true, icon: 'refresh' })}</div>
      </section>`;
  }

  const allConnected = providers.length > 0 && providers.every((provider) => provider.connected);
  const ready = allConnected
    ? `<section class="cab-summary-card" role="status">
        <p class="cab-summary-eyebrow">Todo listo</p>
        <h2 class="cab-summary-title">Todas tus cuentas ya están conectadas</h2>
        <p class="cab-subtitle">No tenés que hacer nada. Las conexiones ya estaban preparadas cuando entraste.</p>
      </section>`
    : '';
  return `
    <header class="cab-page-header">
      <div>
        <h1 class="cab-title">Conexiones</h1>
        <p class="cab-subtitle">Elegí qué cuentas puede usar el agente para ayudarte. Siempre vas a ver qué acceso obtiene antes de conectar.</p>
      </div>
      <button class="cab-help-btn" type="button" data-cabina-help title="Cómo se usa esta pantalla" aria-label="Cómo se usa esta pantalla">${icon('help', { size: 16 })}</button>
    </header>
    ${ready}
    <div class="cab-section-divider"><span>Tus cuentas</span><span class="cab-section-divider-line"></span></div>
    <section class="cab-conversation-list" aria-label="Cuentas disponibles">
      ${providers.map((provider) => providerCard(provider, phases.get(provider.id) || initialPhase(provider), ctx, allConnected)).join('')}
    </section>`;
}

async function copyText(value, ctx, successMessage) {
  try {
    await navigator.clipboard.writeText(String(value || ''));
    ctx.toast(successMessage);
  } catch {
    ctx.toast('No pudimos copiarlo automáticamente. Seleccionalo y copialo a mano.');
  }
}

export default {
  name: 'conexiones',

  async mount(el, ctx) {
    disposeCurrent();
    let alive = true;
    let providers = [];
    const phases = new Map();
    const pollTimers = new Map();
    let countdownTimer = null;

    const stopPoll = (providerId) => {
      const timer = pollTimers.get(providerId);
      if (timer) clearTimeout(timer);
      pollTimers.delete(providerId);
    };

    const stopAllTimers = () => {
      for (const timer of pollTimers.values()) clearTimeout(timer);
      pollTimers.clear();
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = null;
    };

    const render = (loadError = '') => {
      if (!alive) return;
      el.innerHTML = pageMarkup(providers, phases, ctx, loadError);
    };

    const updateCountdown = () => {
      if (!alive) return;
      const phase = phases.get('microsoft');
      if (!phase?.deadline || !['awaiting-code', 'exchanging'].includes(phase.name)) return;
      const remaining = phase.deadline - Date.now();
      const output = el.querySelector('[data-countdown="microsoft"]');
      if (output) output.textContent = `Vence en ${formatRemaining(remaining)}`;
      if (remaining > 0) return;
      stopPoll('microsoft');
      phases.set('microsoft', {
        name: 'error',
        error: 'El código venció antes de completar la autorización. Iniciá de nuevo para recibir otro.',
      });
      ctx.api.post('/api/connections/microsoft/cancel', {}).catch(() => {});
      render();
    };

    const load = async () => {
      try {
        const data = await ctx.api.get('/api/connections');
        if (!alive) return;
        if (!Array.isArray(data?.providers)) throw new Error('La respuesta no contiene la lista de conexiones.');
        providers = data.providers.filter((provider) => PROVIDER_COPY[provider.id]);
        for (const provider of providers) {
          const active = phases.get(provider.id);
          if (provider.connected) phases.set(provider.id, { name: 'connected' });
          else if (!active || ['idle', 'connected'].includes(active.name)) phases.set(provider.id, initialPhase(provider));
        }
        render();
      } catch (error) {
        if (alive) render(error.message || String(error));
      }
    };

    const poll = async (providerId) => {
      if (!alive) return;
      const phase = phases.get(providerId);
      if (!phase?.jobId) return;
      try {
        const result = await ctx.api.get(`/api/connections/${encodeURIComponent(providerId)}/status?jobId=${encodeURIComponent(phase.jobId)}`);
        if (!alive) return;
        if (result.status === 'connected') {
          stopPoll(providerId);
          phases.set(providerId, { name: 'connected' });
          const provider = providers.find((item) => item.id === providerId);
          if (provider) {
            provider.connected = true;
            provider.account = result.account || provider.account;
            provider.connectedAt = provider.connectedAt || new Date().toISOString();
          }
          ctx.toast(`${PROVIDER_COPY[providerId]?.name || providerId} quedó conectado.`);
          await load();
          return;
        }
        if (result.status === 'error') {
          stopPoll(providerId);
          phases.set(providerId, { name: 'error', error: result.error || 'No se pudo completar la conexión.', jobId: phase.jobId });
          render();
          return;
        }
        phase.pollFailures = 0;
      } catch (error) {
        if (!alive) return;
        phase.pollFailures = (phase.pollFailures || 0) + 1;
        if (phase.pollFailures >= 3) {
          stopPoll(providerId);
          phases.set(providerId, { name: 'error', error: error.message || String(error), jobId: phase.jobId });
          render();
          return;
        }
      }
      if (alive && phases.get(providerId)?.jobId) {
        pollTimers.set(providerId, setTimeout(() => poll(providerId), POLL_MS));
      }
    };

    const startOAuth = async (providerId) => {
      stopPoll(providerId);
      phases.set(providerId, { name: 'starting' });
      render();
      try {
        const result = await ctx.api.post(`/api/connections/${encodeURIComponent(providerId)}/connect`, {});
        if (!alive) return;
        if (!result?.jobId) throw new Error('No recibimos una autorización válida.');
        if (providerId === 'microsoft' && result.mode === 'device') {
          phases.set(providerId, {
            name: 'awaiting-code',
            jobId: result.jobId,
            userCode: result.userCode,
            verificationUri: result.verificationUri,
            deadline: Number.isFinite(result.expiresIn) ? Date.now() + result.expiresIn * 1000 : null,
          });
        } else if (providerId === 'zoho' && result.mode === 'paste') {
          phases.set(providerId, {
            name: 'awaiting-code',
            jobId: result.jobId,
            authUrl: result.authUrl,
            scopes: result.scopes || '',
          });
        } else {
          throw new Error('El proveedor devolvió un modo de conexión desconocido.');
        }
        render();
        pollTimers.set(providerId, setTimeout(() => poll(providerId), POLL_MS));
      } catch (error) {
        if (!alive) return;
        phases.set(providerId, { name: 'error', error: error.message || String(error) });
        render();
      }
    };

    const cancel = async (providerId) => {
      stopPoll(providerId);
      try {
        await ctx.api.post(`/api/connections/${encodeURIComponent(providerId)}/cancel`, {});
        if (!alive) return;
        phases.set(providerId, { name: 'idle' });
        render();
        ctx.toast('Se canceló el intento de conexión.');
      } catch (error) {
        if (!alive) return;
        phases.set(providerId, { name: 'error', error: error.message || String(error) });
        render();
      }
    };

    const disconnect = async (providerId) => {
      const name = PROVIDER_COPY[providerId]?.name || providerId;
      if (!window.confirm(`¿Querés desconectar ${name}? El agente dejará de poder usar esa cuenta.`)) return;
      try {
        await ctx.api.post(`/api/connections/${encodeURIComponent(providerId)}/disconnect`, {});
        if (!alive) return;
        const provider = providers.find((item) => item.id === providerId);
        if (provider) provider.connected = false;
        phases.set(providerId, { name: 'idle' });
        ctx.toast(`${name} quedó desconectado.`);
        await load();
      } catch (error) {
        if (!alive) return;
        phases.set(providerId, { name: 'error', error: error.message || String(error) });
        render();
      }
    };

    const submitZoho = async (form) => {
      const phase = phases.get('zoho');
      const value = new FormData(form).get('code')?.toString().trim();
      if (!value || !phase?.jobId) return;
      phases.set('zoho', { ...phase, name: 'exchanging' });
      render();
      try {
        await ctx.api.post('/api/connections/zoho/code', { jobId: phase.jobId, value });
        if (!alive) return;
        stopPoll('zoho');
        phases.set('zoho', { name: 'connected' });
        ctx.toast('Zoho quedó conectado.');
        await load();
      } catch (error) {
        if (!alive) return;
        stopPoll('zoho');
        phases.set('zoho', { name: 'error', error: error.message || String(error), jobId: phase.jobId });
        render();
      }
    };

    const submitFreshservice = async (form) => {
      const values = new FormData(form);
      const domain = values.get('domain')?.toString().trim();
      const apiKey = values.get('apiKey')?.toString().trim();
      if (!domain || !apiKey) return;
      phases.set('freshservice', { name: 'exchanging' });
      render();
      try {
        await ctx.api.post('/api/connections/freshservice/connect', { domain, apiKey });
        if (!alive) return;
        phases.set('freshservice', { name: 'connected' });
        ctx.toast('Freshservice quedó conectado.');
        await load();
      } catch (error) {
        if (!alive) return;
        phases.set('freshservice', { name: 'error', error: error.message || String(error) });
        render();
      }
    };

    const onClick = async (event) => {
      const control = event.target.closest('[data-action]');
      if (!control || !el.contains(control)) return;
      const action = control.dataset.action;
      const providerId = control.dataset.provider;

      if (action === 'open-microsoft') {
        const phase = phases.get('microsoft');
        if (phase?.name === 'awaiting-code') {
          phases.set('microsoft', { ...phase, name: 'exchanging' });
          setTimeout(render, 0);
        }
        return;
      }

      event.preventDefault();
      if (action === 'reload') return load();
      if (action === 'connect') return startOAuth(providerId);
      if (action === 'retry') {
        if (providerId === 'freshservice') {
          phases.set(providerId, { name: 'idle' });
          render();
          return;
        }
        try {
          await ctx.api.post(`/api/connections/${encodeURIComponent(providerId)}/cancel`, {});
        } catch {
          // El intento anterior puede haberse limpiado solo; igual se puede reintentar.
        }
        return startOAuth(providerId);
      }
      if (action === 'cancel') return cancel(providerId);
      if (action === 'disconnect') return disconnect(providerId);
      if (action === 'copy-code') {
        return copyText(phases.get(providerId)?.userCode, ctx, 'Código copiado.');
      }
      if (action === 'copy-permissions') {
        return copyText(phases.get(providerId)?.scopes, ctx, 'Permisos necesarios copiados.');
      }
      if (action === 'submit-zoho') return submitZoho(control.closest('form'));
      if (action === 'submit-freshservice') return submitFreshservice(control.closest('form'));
    };

    const onSubmit = (event) => {
      const form = event.target.closest('[data-form]');
      if (!form || !el.contains(form)) return;
      event.preventDefault();
      if (form.dataset.form === 'zoho') submitZoho(form);
      if (form.dataset.form === 'freshservice') submitFreshservice(form);
    };

    el.addEventListener('click', onClick);
    el.addEventListener('submit', onSubmit);
    el.innerHTML = loadingMarkup();
    countdownTimer = setInterval(updateCountdown, 1000);

    disposeCurrent = () => {
      if (!alive) return;
      alive = false;
      stopAllTimers();
      el.removeEventListener('click', onClick);
      el.removeEventListener('submit', onSubmit);
    };

    await load();
  },

  unmount() {
    disposeCurrent();
    disposeCurrent = () => {};
  },
};
