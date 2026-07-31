(async function () {
  'use strict';

  const { applyI18n, initI18n, t } = await import('/js/ui/i18n.js');
  // Antes del login no hay una preferencia de usuario disponible: manda
  // ?lang= de la URL; después, un navegador en inglés; y español por defecto.
  const langParam = new URLSearchParams(window.location.search).get('lang');
  const initialLang = langParam
    ? (langParam.toLowerCase().startsWith('en') ? 'en' : 'es')
    : ((navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'es');
  await initI18n(initialLang);
  document.documentElement.lang = initialLang;
  applyI18n(document);
  const API = '/api/onboard/public';
  const root = document.getElementById('onboard-root');
  const state = {
    step: 'token',
    token: '',
    username: '',
    admin: false,
    lang: initialLang,
    account: '',
    codex: '',
    infisical: '',
    github: '',
    url: '',
    credsNote: '',
    accountUrl: '',
    codexUrl: '',
    codexCode: '',
    infisicalUrl: '',
    githubUrl: '',
    githubCode: '',
    pending: [],
    capabilities: [],
    checklist: null,
    provision: null,
    provisionPolling: false,
    provisionRetrying: false,
    provisionError: '',
    smoke: [],
    smokeRunning: false,
    smokeError: '',
    finishSent: false,
    error: '',
  };

  let loading = '';
  let exchanging = false;
  let pollId = null;
  let pollFails = 0;
  let currentJobKey = '';

  function clearPoll() {
    if (pollId) {
      clearInterval(pollId);
      pollId = null;
    }
    pollFails = 0;
  }

  function setStep(step) {
    if (['creds', 'account', 'codex', 'infisical', 'github'].includes(state.step) && step !== state.step) clearPoll();
    state.step = step;
    state.error = '';
    loading = '';
    exchanging = false;
    currentJobKey = '';
    if (step === 'done' && !state.finishSent) {
      state.finishSent = true;
      apiJson('/finish', { method: 'POST', body: { token: state.token } }).catch(() => {});
    }
    if (step === 'done' && !state.provisionPolling) {
      state.provisionPolling = true;
      pollProvision(0);
    }
    render();
  }

  // El alta responde antes de completar el espacio del inquilino. Pendientes y
  // cierre consultan el estado real, y un fallo se puede reintentar sin crear
  // otra cuenta.
  function pollProvision(tries) {
    if (!state.token) return;
    apiJson('/provision-status?token=' + encodeURIComponent(state.token), {})
      .then(function (data) {
        state.provision = data;
        state.provisionError = '';
        if (state.step === 'pending' || state.step === 'done') render();
        if (data.status === 'pending' && tries < 20) {
          setTimeout(function () { pollProvision(tries + 1); }, 3000);
        }
      })
      .catch(function () { /* el checklist no bloquea el cierre del wizard */ });
  }

  function capabilityMeta(id) {
    return state.capabilities.find(function (item) { return item.id === id; }) || null;
  }

  function capabilityRequired(id) {
    return capabilityMeta(id)?.required === true;
  }

  function applyValidation(data) {
    state.pending = Array.isArray(data.pending) ? data.pending.slice() : [];
    state.capabilities = Array.isArray(data.capabilities) ? data.capabilities.slice() : [];
    state.checklist = Object.fromEntries(state.capabilities.map(function (item) {
      return [item.id, item.complete === true];
    }));
    state.codex = data.hasCodex ? 'connected' : '';
    state.infisical = data.hasInfisical ? 'connected' : '';
    state.github = data.hasGithub ? 'connected' : '';
  }

  function startNamedStep(step) {
    if (step === 'claude') {
      setStep('creds');
      startCreds();
    } else if (step === 'account') {
      setStep('account');
      startAccount();
    } else if (step === 'codex') {
      setStep('codex');
      startCodex();
    } else if (step === 'infisical') {
      setStep('infisical');
      startInfisical();
    } else if (step === 'github') {
      setStep('github');
      startGithub();
    } else {
      setStep('smoke');
      runSmokeChecks();
    }
  }

  function startNextPending() {
    startNamedStep(state.pending[0]);
  }

  function advanceCompleted(step) {
    if (state.checklist) state.checklist[step] = true;
    state.pending = state.pending.filter(function (item) {
      return item !== step;
    });
    startNextPending();
  }

  function advanceSkipped(step) {
    state.pending = state.pending.filter(function (item) {
      return item !== step;
    });
    startNextPending();
  }

  function appendSkip(step, onSkip) {
    if (capabilityRequired(step)) return;
    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button(
      t('onboard.action.skip', 'Omitir por ahora'),
      'btn-ghost',
      onSkip
    ));
    root.appendChild(actions);
  }

  function setError(message) {
    state.error = message || t('onboard.error.generic', 'Ocurrió un error.');
    loading = '';
    render();
  }

  function textEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    return el;
  }

  function button(text, className, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className || 'btn';
    el.textContent = text;
    el.addEventListener('click', onClick);
    return el;
  }

  function field(label, input) {
    const wrap = document.createElement('label');
    wrap.className = 'ob-field';
    wrap.appendChild(textEl('span', 'ob-label', label));
    wrap.appendChild(input);
    return wrap;
  }

  function input(id, type, placeholder, autocomplete) {
    const el = document.createElement('input');
    el.id = id;
    el.type = type;
    el.placeholder = placeholder;
    el.autocomplete = autocomplete || 'off';
    if (type === 'text') {
      el.autocapitalize = 'off';
      el.autocorrect = 'off';
      el.spellcheck = false;
    }
    return el;
  }

  function progressKey() {
    if (state.step === 'pending') return state.pending[0] || 'done';
    if (state.step === 'creds') return 'claude';
    return state.step;
  }

  function progressOrder() {
    return ['token', 'register'].concat(
      state.capabilities.map(function (item) { return item.id; }),
      ['smoke', 'done']
    );
  }

  function header(title, hint) {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'ob-head';
    head.appendChild(textEl('h1', 'ob-title', title));
    if (hint) head.appendChild(textEl('p', 'ob-hint', hint));
    frag.appendChild(head);

    const steps = document.createElement('div');
    steps.className = 'ob-steps';
    const order = progressOrder();
    const activeStep = Math.max(1, order.indexOf(progressKey()) + 1);
    steps.style.gridTemplateColumns = `repeat(${order.length}, 1fr)`;
    steps.setAttribute('aria-label', t('onboard.progress.label', 'Progreso del onboarding'));
    for (let i = 1; i <= order.length; i += 1) {
      const step = document.createElement('span');
      step.className = i <= activeStep ? 'ob-step is-active' : 'ob-step';
      steps.appendChild(step);
    }
    frag.appendChild(steps);
    return frag;
  }

  function message() {
    if (!state.error) return null;
    return textEl('p', 'ob-error', state.error);
  }

  async function apiJson(path, options) {
    const res = await fetch(API + path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    });

    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      data = {};
    }

    if (!res.ok) {
      const msg = data.error || data.reason || t('onboard.error.server', 'Error de servidor.');
      throw new Error(msg);
    }

    return data;
  }

  async function validateToken() {
    const tokenInput = document.getElementById('ob-token');
    const token = tokenInput ? tokenInput.value.trim() : '';
    if (!token) {
      setError(t('onboard.token.required', 'Ingresá el token de invitación.'));
      return;
    }

    loading = 'token';
    state.error = '';
    render();

    try {
      const data = await apiJson('/validate', { method: 'POST', body: { token } });
      state.token = token;
      state.admin = Boolean(data.admin);
      applyValidation(data);

      if (data.resume === true) {
        state.username = data.lockedTo || '';
        if (state.pending.length) {
          setStep('pending');
          pollProvision(0);
        } else {
          setStep('smoke');
          runSmokeChecks();
        }
        return;
      }

      if (data.valid === true) {
        setStep('register');
      } else {
        setError(t('onboard.token.invalid', 'Invitación {reason}', {
          reason: data.reason || t('onboard.token.invalidReason', 'inválida'),
        }));
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function registerUser() {
    const usernameEl = document.getElementById('ob-username');
    const passwordEl = document.getElementById('ob-password');
    const repeatEl = document.getElementById('ob-password-repeat');
    const langEl = document.getElementById('ob-lang');
    const username = usernameEl ? usernameEl.value.trim() : '';
    const password = passwordEl ? passwordEl.value : '';
    const repeat = repeatEl ? repeatEl.value : '';
    const lang = langEl && langEl.value === 'en' ? 'en' : 'es';

    if (!username) {
      setError(t('onboard.register.usernameRequired', 'Ingresá un nombre de usuario.'));
      return;
    }
    if (password.length < 8) {
      setError(t('onboard.register.passwordLength', 'La contraseña debe tener al menos 8 caracteres.'));
      return;
    }
    if (password !== repeat) {
      setError(t('onboard.register.passwordMismatch', 'Las contraseñas no coinciden.'));
      return;
    }

    loading = 'register';
    state.lang = lang;
    state.error = '';
    render();

    try {
      const data = await apiJson('/register', {
        method: 'POST',
        body: { token: state.token, username, password, lang },
      });
      if (!data.ok) throw new Error(data.error || t('onboard.register.createError', 'No se pudo crear la cuenta.'));
      state.username = username;
      const validation = await apiJson('/validate', {
        method: 'POST',
        body: { token: state.token },
      });
      applyValidation(validation);
      pollProvision(0);
      startNextPending();
    } catch (err) {
      setError(err.message);
    }
  }

  async function startCreds() {
    clearPoll();
    state.url = '';
    state.credsNote = '';
    state.error = '';
    currentJobKey = '';
    renderCredsStatus({ status: 'starting' });

    try {
      await apiJson('/creds-start', { method: 'POST', body: { token: state.token } });
      pollCreds();
      pollId = setInterval(pollCreds, 1500);
    } catch (err) {
      clearPoll();
      renderCredsStatus({ status: 'error', error: err.message });
    }
  }

  async function pollCreds() {
    try {
      const data = await apiJson('/creds-status?token=' + encodeURIComponent(state.token), { method: 'GET' });
      pollFails = 0;
      renderCredsStatus(data || {});
    } catch (err) {
      pollFails += 1;
      if (pollFails < 5) return;
      clearPoll();
      renderCredsStatus({ status: 'error', error: err.message });
    }
  }

  async function sendCode() {
    const codeEl = document.getElementById('ob-code');
    const code = codeEl ? codeEl.value.trim() : '';
    if (!code) {
      state.error = t('onboard.claude.codeRequired', 'Pegá el código de autorización.');
      renderCredsStatus({ status: 'awaiting-code', url: state.url });
      return;
    }

    exchanging = true;
    state.error = '';
    updateCodeButton();

    try {
      await apiJson('/creds-code', { method: 'POST', body: { token: state.token, code } });
      renderCredsStatus({ status: 'exchanging' });
    } catch (err) {
      exchanging = false;
      state.error = err.message;
      renderCredsStatus({ status: 'awaiting-code', url: state.url });
    }
  }

  function updateCodeButton() {
    const btn = document.getElementById('ob-code-btn');
    if (!btn) return;
    btn.disabled = exchanging;
    btn.textContent = exchanging
      ? t('onboard.action.confirming', 'Confirmando…')
      : t('onboard.action.confirmCode', 'Confirmar código');
  }

  function renderToken() {
    root.replaceChildren();
    root.appendChild(header(
      t('onboard.token.title', 'Bienvenido/a'),
      t('onboard.token.hint', 'Usá tu invitación para configurar el acceso.')
    ));

    const form = document.createElement('form');
    form.className = 'ob-form';
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      validateToken();
    });

    const tokenLabel = t('onboard.token.label', 'Token de invitación');
    const token = input('ob-token', 'text', tokenLabel, 'one-time-code');
    token.autofocus = true;
    form.appendChild(field(tokenLabel, token));

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn';
    submit.disabled = loading === 'token';
    submit.textContent = loading === 'token'
      ? t('onboard.action.continuing', 'Continuando…')
      : t('onboard.action.continue', 'Continuar');
    actions.appendChild(submit);
    form.appendChild(actions);

    const err = message();
    if (err) form.appendChild(err);
    root.appendChild(form);
    token.focus();
  }

  const PROVISION_LABELS = {
    pad: ['Pad', 'Preparando Pad…'],
    workspace: ['Workspace', 'Preparando el workspace…'],
    skills: ['Skills', 'Instalando skills…'],
    'tolkien-mcp': ['MCP de Tolkien', 'Configurando el MCP de Tolkien…'],
  };

  function provisionText(name, step) {
    const labels = PROVISION_LABELS[name] || [name, `Preparando ${name}…`];
    const label = t(`onboard.provision.${name}.label`, labels[0]);
    if (!step || step.status === 'pending') {
      return '⏳ ' + t(`onboard.provision.${name}.pending`, labels[1]);
    }
    if (step.status === 'ok') {
      return '✅ ' + t('onboard.provision.ready', '{step}: listo.', { step: label });
    }
    return '⚠️ ' + t('onboard.provision.failed', '{step}: falló.', { step: label })
      + (step.error ? ' (' + step.error + ')' : '');
  }

  async function retryProvision() {
    state.provisionRetrying = true;
    state.provisionError = '';
    render();
    try {
      state.provision = await apiJson('/provision-retry', {
        method: 'POST',
        body: { token: state.token },
      });
      state.provisionRetrying = false;
      render();
      pollProvision(0);
    } catch (error) {
      state.provisionRetrying = false;
      state.provisionError = error.message;
      render();
    }
  }

  function appendProvisionState(container) {
    const block = document.createElement('div');
    block.className = 'ob-provision';
    block.appendChild(textEl(
      'p',
      'ob-label',
      t('onboard.provision.title', 'Preparación de tu espacio')
    ));
    const list = document.createElement('ul');
    list.className = 'ob-list';
    const steps = state.provision?.steps || {};
    Object.keys(PROVISION_LABELS).forEach(function (name) {
      list.appendChild(textEl('li', '', provisionText(name, steps[name])));
    });
    block.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    const retry = button(
      state.provisionRetrying
        ? t('onboard.provision.retrying', 'Reintentando…')
        : t('onboard.action.retry', 'Reintentar'),
      'btn-ghost',
      retryProvision
    );
    retry.disabled = state.provisionRetrying
      || !state.provision
      || (state.provision.status === 'pending' && state.provision.stale !== true);
    actions.appendChild(retry);
    block.appendChild(actions);
    if (state.provisionError) {
      block.appendChild(textEl('p', 'ob-error', state.provisionError));
    }
    container.appendChild(block);
  }

  function renderPending() {
    root.replaceChildren();
    root.appendChild(header(
      t('onboard.pending.title', 'Te falta completar tu configuración'),
      t('onboard.pending.hint', 'Entraste como {user}. Estos son los pasos que quedaron pendientes.', {
        user: state.username,
      })
    ));

    const form = document.createElement('div');
    form.className = 'ob-form';
    const list = document.createElement('ul');
    list.className = 'ob-list';
    state.capabilities.forEach(function (item) {
      const complete = state.checklist && state.checklist[item.id];
      const optional = item.required ? '' : t('onboard.pending.optional', ' (opcional)');
      const label = t(`onboard.capability.${item.id}`, item.labelEs || item.id);
      list.appendChild(textEl('li', '', (complete ? '✅ ' : '⬜ ') + label + optional));
    });
    form.appendChild(list);
    appendProvisionState(form);

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button(t('onboard.pending.continue', 'Continuar'), 'btn', startNextPending));
    form.appendChild(actions);
    root.appendChild(form);
  }

  function renderRegister() {
    root.replaceChildren();
    root.appendChild(header(
      t('onboard.register.title', 'Creá tu usuario'),
      t('onboard.register.hint', 'Elegí las credenciales para entrar a la consola.')
    ));

    const form = document.createElement('form');
    form.className = 'ob-form';
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      registerUser();
    });

    if (state.admin) {
      form.appendChild(textEl(
        'p',
        'ob-note',
        t('onboard.register.adminNote', 'Esta cuenta será administrador.')
      ));
    }

    const usernameLabel = t('onboard.register.username', 'Usuario');
    const passwordLabel = t('onboard.register.password', 'Contraseña');
    const repeatLabel = t('onboard.register.repeatPassword', 'Repetir contraseña');
    const username = input('ob-username', 'text', usernameLabel, 'username');
    const password = input('ob-password', 'password', passwordLabel, 'new-password');
    const repeat = input('ob-password-repeat', 'password', repeatLabel, 'new-password');
    const lang = document.createElement('select');
    lang.id = 'ob-lang';
    lang.className = 'dlg-input';
    const spanish = document.createElement('option');
    spanish.value = 'es';
    spanish.textContent = t('onboard.language.spanish', 'Español');
    const english = document.createElement('option');
    english.value = 'en';
    english.textContent = t('onboard.language.english', 'English');
    lang.appendChild(spanish);
    lang.appendChild(english);
    lang.value = state.lang;
    form.appendChild(field(usernameLabel, username));
    form.appendChild(field(passwordLabel, password));
    form.appendChild(field(repeatLabel, repeat));
    form.appendChild(field(t('onboard.register.language', 'Idioma de la consola'), lang));

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button(t('onboard.action.back', '← volver'), 'btn-ghost', function () {
      setStep('token');
    }));
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn';
    submit.disabled = loading === 'register';
    submit.textContent = loading === 'register'
      ? t('onboard.register.creating', 'Creando…')
      : t('onboard.register.create', 'Crear cuenta');
    actions.appendChild(submit);
    form.appendChild(actions);

    const err = message();
    if (err) form.appendChild(err);
    root.appendChild(form);
    username.focus();
  }

  function renderCredsBase() {
    root.replaceChildren();
    root.appendChild(header(
      t('onboard.claude.title', 'Conectá tu cuenta de Claude'),
      t('onboard.claude.hint', 'Autorizá Claude para terminar la configuración.')
    ));
  }

  function renderSpinner(text) {
    renderCredsBase();
    const line = document.createElement('div');
    line.className = 'ob-spinner-line';
    line.appendChild(document.createElement('span')).className = 'ob-spinner';
    line.appendChild(textEl('span', '', text));
    root.appendChild(line);
  }

  function renderAwaitingCode() {
    renderCredsBase();

    const list = document.createElement('ol');
    list.className = 'ob-list';

    const first = document.createElement('li');
    first.appendChild(textEl(
      'span',
      '',
      t('onboard.claude.open', 'Abrí este enlace y autorizá con tu cuenta de Claude:')
    ));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.url;
    first.appendChild(link);
    const copy = button(t('onboard.action.copyLink', 'Copiar enlace'), 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.url);
        copy.textContent = t('onboard.action.copied', 'Copiado');
      } catch (err) {
        copy.textContent = t('onboard.action.copyFailed', 'No se pudo copiar');
      }
      window.setTimeout(function () {
        copy.textContent = t('onboard.action.copyLink', 'Copiar enlace');
      }, 1800);
    });
    first.appendChild(copy);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl(
      'span',
      '',
      t('onboard.claude.pasteCode', 'Copiá el código que te da y pegalo acá:')
    ));
    if (state.credsNote) {
      second.appendChild(textEl('p', 'ob-error', state.credsNote));
    }
    const row = document.createElement('div');
    row.className = 'ob-code-row';
    const code = input(
      'ob-code',
      'text',
      t('onboard.claude.codePlaceholder', 'Código de autorización'),
      'one-time-code'
    );
    const confirm = button(t('onboard.action.confirmCode', 'Confirmar código'), 'btn', sendCode);
    confirm.id = 'ob-code-btn';
    row.appendChild(code);
    row.appendChild(confirm);
    second.appendChild(row);
    list.appendChild(second);

    root.appendChild(list);
    const err = message();
    if (err) root.appendChild(err);
    updateCodeButton();
  }

  function renderCredsStatus(job) {
    if (state.step !== 'creds') return;

    const status = job.status || (job.done ? 'done' : 'starting');
    const url = job.url || state.url || '';
    const stale = job.stale === true;
    const error = job.error || '';
    const jobKey = [status, url, stale ? 'stale' : '', error, job.note || '', state.error].join('|');

    if (status === 'awaiting-code') {
      exchanging = false;
      state.credsNote = job.note || '';
    }

    if (status === 'done' || job.done) {
      clearPoll();
      advanceCompleted('claude');
      return;
    }

    if (status === 'error') {
      clearPoll();
      currentJobKey = jobKey;
      state.error = error || t('onboard.claude.connectError', 'No se pudo conectar la cuenta de Claude.');
      renderCredsBase();
      root.appendChild(textEl('p', 'ob-error', state.error));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button(t('onboard.action.retry', 'Reintentar'), 'btn', startCreds));
      root.appendChild(actions);
      return;
    }

    if (stale) {
      clearPoll();
      currentJobKey = jobKey;
      renderCredsBase();
      root.appendChild(textEl(
        'p',
        'ob-error',
        t('onboard.error.interrupted', 'Parece que se interrumpió.')
      ));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button(t('onboard.action.retry', 'Reintentar'), 'btn', startCreds));
      root.appendChild(actions);
      return;
    }

    if (jobKey === currentJobKey && status === 'awaiting-code') return;
    currentJobKey = jobKey;

    if (status === 'exchanging') {
      renderSpinner(t('onboard.claude.verifyingCode', 'Verificando el código…'));
      return;
    }

    if (status === 'awaiting-code' && url) {
      state.url = url;
      renderAwaitingCode();
      return;
    }

    renderSpinner(t('onboard.action.preparing', 'Preparando…'));
  }

  function renderAccountBase() {
    root.replaceChildren();
    root.appendChild(header(
      t('onboard.account.title', 'Claude · tu consumo (opcional)'),
      t('onboard.account.hint', 'Conectá tu cuenta para ver el uso real de tu plan.')
    ));
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.account.usageNote', 'Esto habilita los porcentajes reales de tu sesión de 5 horas y de tu semana.')
    ));
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.account.optionalNote', 'Sin este paso, el panel Uso solo mostrará tus tokens consumidos. No es requisito para empezar a trabajar: podés conectarlo más tarde desde el bloque Claude · tu consumo.')
    ));
  }

  function appendAccountSkip() {
    appendSkip('account', function () {
      state.account = 'skipped';
      advanceSkipped('account');
    });
  }

  function renderAccountSpinner(text) {
    renderAccountBase();
    const line = document.createElement('div');
    line.className = 'ob-spinner-line';
    line.appendChild(document.createElement('span')).className = 'ob-spinner';
    line.appendChild(textEl('span', '', text));
    root.appendChild(line);
    appendAccountSkip();
  }

  async function startAccount() {
    clearPoll();
    state.accountUrl = '';
    state.error = '';
    currentJobKey = '';
    renderAccountSpinner(t('onboard.action.preparing', 'Preparando…'));

    try {
      const data = await apiJson('/claude-account-start', {
        method: 'POST',
        body: { token: state.token },
      });
      if (state.step !== 'account') return;
      if (data.connected === true) {
        state.account = 'connected';
        advanceCompleted('account');
        return;
      }
      pollId = setInterval(pollAccount, 1500);
      pollAccount();
    } catch (err) {
      clearPoll();
      renderAccountStatus({ status: 'error', error: err.message });
    }
  }

  async function pollAccount() {
    try {
      const data = await apiJson(
        '/claude-account-status?token=' + encodeURIComponent(state.token),
        { method: 'GET' }
      );
      pollFails = 0;
      renderAccountStatus(data || {});
    } catch (err) {
      pollFails += 1;
      if (pollFails < 5) return;
      clearPoll();
      renderAccountStatus({ status: 'error', error: err.message });
    }
  }

  async function sendAccountCode() {
    const codeEl = document.getElementById('ob-account-code');
    const code = codeEl ? codeEl.value.trim() : '';
    if (!code) {
      state.error = t('onboard.claude.codeRequired', 'Pegá el código de autorización.');
      renderAccountStatus({ status: 'waiting-code', url: state.accountUrl });
      return;
    }

    exchanging = true;
    state.error = '';
    updateAccountCodeButton('verifying');

    try {
      await apiJson('/claude-account-code', {
        method: 'POST',
        body: { token: state.token, code },
      });
      renderAccountStatus({ status: 'verifying', url: state.accountUrl });
    } catch (err) {
      exchanging = false;
      state.error = err.message;
      renderAccountStatus({ status: 'waiting-code', url: state.accountUrl });
    }
  }

  function updateAccountCodeButton(status) {
    const btn = document.getElementById('ob-account-code-btn');
    if (!btn) return;
    const waiting = status === 'waiting-code';
    btn.disabled = exchanging || !waiting;
    btn.textContent = exchanging || status === 'verifying'
      ? t('onboard.action.verifying', 'Verificando…')
      : (waiting
        ? t('onboard.action.confirmCode', 'Confirmar código')
        : t('onboard.action.waitingServer', 'Esperando al servidor…'));
  }

  function renderAccountAuthorization(status) {
    renderAccountBase();

    const list = document.createElement('ol');
    list.className = 'ob-list';

    const first = document.createElement('li');
    first.appendChild(textEl(
      'span',
      '',
      t('onboard.account.open', 'La página no se abre sola porque el CLI corre en un servidor sin entorno gráfico. Abrí este enlace y autorizá con tu cuenta de Claude:')
    ));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.accountUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.accountUrl;
    first.appendChild(link);
    const copy = button(t('onboard.action.copyLink', 'Copiar enlace'), 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.accountUrl);
        copy.textContent = t('onboard.action.copied', 'Copiado');
      } catch (err) {
        copy.textContent = t('onboard.action.copyFailed', 'No se pudo copiar');
      }
      window.setTimeout(function () {
        copy.textContent = t('onboard.action.copyLink', 'Copiar enlace');
      }, 1800);
    });
    first.appendChild(copy);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl(
      'span',
      '',
      t('onboard.account.pasteCode', 'Copiá el código que te da Claude y pegalo acá:')
    ));
    const row = document.createElement('div');
    row.className = 'ob-code-row';
    const code = input(
      'ob-account-code',
      'text',
      t('onboard.claude.codePlaceholder', 'Código de autorización'),
      'one-time-code'
    );
    const confirm = button(t('onboard.action.confirmCode', 'Confirmar código'), 'btn', sendAccountCode);
    confirm.id = 'ob-account-code-btn';
    row.appendChild(code);
    row.appendChild(confirm);
    second.appendChild(row);
    list.appendChild(second);

    root.appendChild(list);
    const err = message();
    if (err) root.appendChild(err);
    updateAccountCodeButton(status);
    appendAccountSkip();
  }

  function renderAccountStatus(job) {
    if (state.step !== 'account') return;

    const status = job.status || 'starting';
    const url = job.url || state.accountUrl || '';
    const error = job.error || '';
    const jobKey = [status, url, error, state.error].join('|');

    if (status === 'ok') {
      clearPoll();
      state.account = 'connected';
      advanceCompleted('account');
      return;
    }

    if (status === 'error') {
      clearPoll();
      currentJobKey = jobKey;
      renderAccountBase();
      root.appendChild(textEl(
        'p',
        'ob-error',
        error || t('onboard.claude.connectError', 'No se pudo conectar la cuenta de Claude.')
      ));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button(t('onboard.action.retry', 'Reintentar'), 'btn', startAccount));
      root.appendChild(actions);
      appendAccountSkip();
      return;
    }

    if (jobKey === currentJobKey && url) return;
    currentJobKey = jobKey;

    if (url) {
      state.accountUrl = url;
      exchanging = status === 'verifying';
      renderAccountAuthorization(status);
      return;
    }

    exchanging = status === 'verifying';
    renderAccountSpinner(status === 'verifying'
      ? t('onboard.claude.verifyingCode', 'Verificando el código…')
      : t('onboard.action.preparing', 'Preparando…'));
  }

  function renderCodexBase() {
    root.replaceChildren();
    root.appendChild(header(
      t('onboard.codex.title', 'Conectá Codex'),
      t('onboard.codex.hint', 'Autorizá Codex para usar el modo Tándem.')
    ));
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.codex.note', 'Codex es obligatorio: ejecuta el código del modo Tándem con la cuenta aislada de tu usuario.')
    ));
  }

  function appendCodexSkip() {
    appendSkip('codex', function () {
      state.codex = 'skipped';
      advanceSkipped('codex');
    });
  }

  function renderCodexSpinner(text) {
    renderCodexBase();
    const line = document.createElement('div');
    line.className = 'ob-spinner-line';
    line.appendChild(document.createElement('span')).className = 'ob-spinner';
    line.appendChild(textEl('span', '', text));
    root.appendChild(line);
    appendCodexSkip();
  }

  async function startCodex() {
    clearPoll();
    state.codexUrl = '';
    state.codexCode = '';
    state.error = '';
    currentJobKey = '';
    renderCodexSpinner(t('onboard.action.preparing', 'Preparando…'));

    try {
      const data = await apiJson('/codex-start', { method: 'POST', body: { token: state.token } });
      if (state.step !== 'codex') return;
      if (data.connected === true) {
        state.codex = 'connected';
        advanceCompleted('codex');
        return;
      }
      pollId = setInterval(pollCodex, 3000);
      pollCodex();
    } catch (err) {
      clearPoll();
      renderCodexStatus({ status: 'error', error: err.message });
    }
  }

  async function pollCodex() {
    try {
      const data = await apiJson('/codex-status?token=' + encodeURIComponent(state.token), { method: 'GET' });
      pollFails = 0;
      renderCodexStatus(data || {});
    } catch (err) {
      pollFails += 1;
      if (pollFails < 5) return;
      clearPoll();
      renderCodexStatus({ status: 'error', error: err.message });
    }
  }

  function renderCodexAwaitingAuth() {
    renderCodexBase();

    const list = document.createElement('ol');
    list.className = 'ob-list';

    const first = document.createElement('li');
    first.appendChild(textEl('span', '', t('onboard.codex.open', 'Abrí este enlace:')));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.codexUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.codexUrl;
    first.appendChild(link);
    const copyLink = button(t('onboard.action.copyLink', 'Copiar enlace'), 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.codexUrl);
        copyLink.textContent = t('onboard.action.copied', 'Copiado');
      } catch (err) {
        copyLink.textContent = t('onboard.action.copyFailed', 'No se pudo copiar');
      }
      window.setTimeout(function () {
        copyLink.textContent = t('onboard.action.copyLink', 'Copiar enlace');
      }, 1800);
    });
    first.appendChild(copyLink);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl(
      'span',
      '',
      t('onboard.codex.code', 'Código de autorización:')
    ));
    second.appendChild(textEl('p', 'ob-title', state.codexCode));
    const copyCode = button(t('onboard.action.copyCode', 'Copiar código'), 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.codexCode);
        copyCode.textContent = t('onboard.action.copied', 'Copiado');
      } catch (err) {
        copyCode.textContent = t('onboard.action.copyFailed', 'No se pudo copiar');
      }
      window.setTimeout(function () {
        copyCode.textContent = t('onboard.action.copyCode', 'Copiar código');
      }, 1800);
    });
    second.appendChild(copyCode);
    list.appendChild(second);
    root.appendChild(list);
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.codex.authorize', 'Abrí el enlace, pegá este código y autorizá con tu cuenta de ChatGPT. El código vence en 15 minutos.')
    ));
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.codex.autoAdvance', 'Esta pantalla avanza sola cuando termines.')
    ));
    appendCodexSkip();
  }

  function renderCodexStatus(job) {
    if (state.step !== 'codex') return;

    const status = job.status || (job.done ? 'done' : 'starting');
    const url = job.url || state.codexUrl || '';
    const code = job.code || state.codexCode || '';
    const stale = job.stale === true;
    const error = job.error || '';
    const jobKey = [status, url, code, stale ? 'stale' : '', error].join('|');

    if (job.connected === true || job.done === true || status === 'done') {
      clearPoll();
      state.codex = 'connected';
      advanceCompleted('codex');
      return;
    }

    if (status === 'error' || stale) {
      clearPoll();
      currentJobKey = jobKey;
      renderCodexBase();
      root.appendChild(textEl(
        'p',
        'ob-error',
        error || t('onboard.error.interrupted', 'Parece que se interrumpió.')
      ));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button(t('onboard.action.retry', 'Reintentar'), 'btn', startCodex));
      root.appendChild(actions);
      appendCodexSkip();
      return;
    }

    if (jobKey === currentJobKey && status === 'awaiting-auth') return;
    currentJobKey = jobKey;

    if (status === 'awaiting-auth' && url && code) {
      state.codexUrl = url;
      state.codexCode = code;
      renderCodexAwaitingAuth();
      return;
    }

    renderCodexSpinner(t('onboard.action.preparing', 'Preparando…'));
  }

  function renderInfisicalBase() {
    root.replaceChildren();
    root.appendChild(header(
      t('onboard.infisical.title', 'Conectá Infisical'),
      t('onboard.infisical.hint', 'Es lo que le da acceso a las herramientas de Tolkien.')
    ));
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.infisical.note', 'Infisical es obligatorio: guarda los secretos que necesitan el MCP de Tolkien y sus herramientas.')
    ));
  }

  function appendInfisicalSkip() {
    appendSkip('infisical', function () {
      state.infisical = 'skipped';
      advanceSkipped('infisical');
    });
  }

  function renderInfisicalSpinner(text) {
    renderInfisicalBase();
    const line = document.createElement('div');
    line.className = 'ob-spinner-line';
    line.appendChild(document.createElement('span')).className = 'ob-spinner';
    line.appendChild(textEl('span', '', text));
    root.appendChild(line);
    appendInfisicalSkip();
  }

  async function startInfisical() {
    clearPoll();
    state.infisicalUrl = '';
    state.error = '';
    currentJobKey = '';
    renderInfisicalSpinner(t('onboard.action.preparing', 'Preparando…'));

    try {
      const data = await apiJson('/infisical-start', { method: 'POST', body: { token: state.token } });
      if (state.step !== 'infisical') return;
      if (data.connected === true || data.hasInfisical === true || data.status === 'done') {
        state.infisical = 'connected';
        advanceCompleted('infisical');
        return;
      }
      pollId = setInterval(pollInfisical, 3000);
      pollInfisical();
    } catch (err) {
      clearPoll();
      renderInfisicalStatus({ status: 'error', error: err.message });
    }
  }

  async function pollInfisical() {
    try {
      const data = await apiJson('/infisical-status?token=' + encodeURIComponent(state.token), { method: 'GET' });
      pollFails = 0;
      renderInfisicalStatus(data || {});
    } catch (err) {
      pollFails += 1;
      if (pollFails < 5) return;
      clearPoll();
      renderInfisicalStatus({ status: 'error', error: err.message });
    }
  }

  async function sendInfisicalToken() {
    const tokenEl = document.getElementById('ob-infisical-token');
    const value = tokenEl ? tokenEl.value.trim() : '';
    if (!value) {
      state.error = t('onboard.infisical.tokenRequired', 'Pegá el token de Infisical.');
      renderInfisicalStatus({ status: 'awaiting-token', url: state.infisicalUrl });
      return;
    }

    exchanging = true;
    state.error = '';
    updateInfisicalTokenButton();

    try {
      await apiJson('/infisical-token', {
        method: 'POST',
        body: { token: state.token, value },
      });
      renderInfisicalStatus({ status: 'exchanging', url: state.infisicalUrl });
    } catch (err) {
      exchanging = false;
      state.error = err.message;
      renderInfisicalStatus({ status: 'awaiting-token', url: state.infisicalUrl });
    }
  }

  function updateInfisicalTokenButton() {
    const btn = document.getElementById('ob-infisical-token-btn');
    if (!btn) return;
    btn.disabled = exchanging;
    btn.textContent = exchanging
      ? t('onboard.action.confirming', 'Confirmando…')
      : t('onboard.infisical.confirmToken', 'Confirmar token');
  }

  function renderInfisicalAwaitingToken() {
    renderInfisicalBase();

    const list = document.createElement('ol');
    list.className = 'ob-list';

    const first = document.createElement('li');
    first.appendChild(textEl(
      'span',
      '',
      t('onboard.infisical.open', 'Abrí este enlace e iniciá sesión en Infisical:')
    ));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.infisicalUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.infisicalUrl;
    first.appendChild(link);
    const copy = button(t('onboard.action.copyLink', 'Copiar enlace'), 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.infisicalUrl);
        copy.textContent = t('onboard.action.copied', 'Copiado');
      } catch (err) {
        copy.textContent = t('onboard.action.copyFailed', 'No se pudo copiar');
      }
      window.setTimeout(function () {
        copy.textContent = t('onboard.action.copyLink', 'Copiar enlace');
      }, 1800);
    });
    first.appendChild(copy);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl(
      'span',
      '',
      t('onboard.infisical.pasteToken', 'Copiá el token que te muestra Infisical y pegalo acá:')
    ));
    const row = document.createElement('div');
    row.className = 'ob-code-row';
    const token = input(
      'ob-infisical-token',
      'text',
      t('onboard.infisical.tokenPlaceholder', 'Token de Infisical'),
      'one-time-code'
    );
    const confirm = button(t('onboard.infisical.confirmToken', 'Confirmar token'), 'btn', sendInfisicalToken);
    confirm.id = 'ob-infisical-token-btn';
    row.appendChild(token);
    row.appendChild(confirm);
    second.appendChild(row);
    list.appendChild(second);

    root.appendChild(list);
    const err = message();
    if (err) root.appendChild(err);
    updateInfisicalTokenButton();
    appendInfisicalSkip();
  }

  function renderInfisicalStatus(job) {
    if (state.step !== 'infisical') return;

    const status = job.status || (job.done ? 'done' : 'starting');
    const url = job.url || state.infisicalUrl || '';
    const stale = job.stale === true;
    const error = job.error || '';
    const jobKey = [status, url, stale ? 'stale' : '', error, state.error].join('|');

    if (job.hasInfisical === true || job.done === true || status === 'done') {
      clearPoll();
      state.infisical = 'connected';
      advanceCompleted('infisical');
      return;
    }

    if (status === 'error' || stale) {
      clearPoll();
      currentJobKey = jobKey;
      renderInfisicalBase();
      root.appendChild(textEl(
        'p',
        'ob-error',
        error || t('onboard.error.interrupted', 'Parece que se interrumpió.')
      ));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button(t('onboard.action.retry', 'Reintentar'), 'btn', startInfisical));
      root.appendChild(actions);
      appendInfisicalSkip();
      return;
    }

    if (jobKey === currentJobKey && url) return;
    currentJobKey = jobKey;

    if (status === 'exchanging') {
      renderInfisicalSpinner(t('onboard.infisical.verifyingToken', 'Verificando el token…'));
      return;
    }

    if (url) {
      exchanging = false;
      state.infisicalUrl = url;
      renderInfisicalAwaitingToken();
      return;
    }

    renderInfisicalSpinner(t('onboard.action.preparing', 'Preparando…'));
  }

  function renderGithubBase() {
    root.replaceChildren();
    root.appendChild(header(
      t('onboard.github.title', 'Conectá GitHub'),
      t('onboard.github.hint', 'Autorizá el CLI para trabajar con tus repositorios por HTTPS.')
    ));
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.github.note', 'GitHub es obligatorio. La sesión y la configuración Git quedan en el HOME aislado de tu usuario.')
    ));
  }

  function renderGithubSpinner(text) {
    renderGithubBase();
    const line = document.createElement('div');
    line.className = 'ob-spinner-line';
    line.appendChild(document.createElement('span')).className = 'ob-spinner';
    line.appendChild(textEl('span', '', text));
    root.appendChild(line);
  }

  async function startGithub() {
    clearPoll();
    state.githubUrl = '';
    state.githubCode = '';
    state.error = '';
    currentJobKey = '';
    renderGithubSpinner(t('onboard.github.preparing', 'Preparando…'));

    try {
      const data = await apiJson('/github-start', {
        method: 'POST',
        body: { token: state.token },
      });
      if (state.step !== 'github') return;
      if (data.connected === true) {
        state.github = 'connected';
        advanceCompleted('github');
        return;
      }
      pollId = setInterval(pollGithub, 3000);
      pollGithub();
    } catch (err) {
      clearPoll();
      renderGithubStatus({ status: 'error', error: err.message });
    }
  }

  async function pollGithub() {
    try {
      const data = await apiJson(
        '/github-status?token=' + encodeURIComponent(state.token),
        { method: 'GET' }
      );
      pollFails = 0;
      renderGithubStatus(data || {});
    } catch (err) {
      pollFails += 1;
      if (pollFails < 5) return;
      clearPoll();
      renderGithubStatus({ status: 'error', error: err.message });
    }
  }

  function renderGithubAwaitingAuth() {
    renderGithubBase();
    const list = document.createElement('ol');
    list.className = 'ob-list';

    const first = document.createElement('li');
    first.appendChild(textEl('span', '', t('onboard.github.open', 'Abrí este enlace:')));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.githubUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.githubUrl;
    first.appendChild(link);
    const copyLink = button(
      t('onboard.action.copyLink', 'Copiar enlace'),
      'btn-ghost ob-copy',
      async function () {
        try {
          await navigator.clipboard.writeText(state.githubUrl);
          copyLink.textContent = t('onboard.action.copied', 'Copiado');
        } catch (err) {
          copyLink.textContent = t('onboard.action.copyFailed', 'No se pudo copiar');
        }
        window.setTimeout(function () {
          copyLink.textContent = t('onboard.action.copyLink', 'Copiar enlace');
        }, 1800);
      }
    );
    first.appendChild(copyLink);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl(
      'span',
      '',
      t('onboard.github.code', 'Código de un solo uso:')
    ));
    second.appendChild(textEl('p', 'ob-title', state.githubCode));
    const copyCode = button(
      t('onboard.action.copyCode', 'Copiar código'),
      'btn-ghost ob-copy',
      async function () {
        try {
          await navigator.clipboard.writeText(state.githubCode);
          copyCode.textContent = t('onboard.action.copied', 'Copiado');
        } catch (err) {
          copyCode.textContent = t('onboard.action.copyFailed', 'No se pudo copiar');
        }
        window.setTimeout(function () {
          copyCode.textContent = t('onboard.action.copyCode', 'Copiar código');
        }, 1800);
      }
    );
    second.appendChild(copyCode);
    list.appendChild(second);
    root.appendChild(list);
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.github.authorize', 'Pegá el código en GitHub y aprobá el acceso. Esta pantalla avanza sola al terminar.')
    ));
  }

  function renderGithubStatus(job) {
    if (state.step !== 'github') return;
    const status = job.status || (job.done ? 'done' : 'starting');
    const url = job.url || state.githubUrl || '';
    const code = job.code || state.githubCode || '';
    const stale = job.stale === true;
    const error = job.error || '';
    const jobKey = [status, url, code, stale ? 'stale' : '', error].join('|');

    if (job.connected === true || job.done === true || status === 'done') {
      clearPoll();
      state.github = 'connected';
      advanceCompleted('github');
      return;
    }

    if (status === 'error' || stale) {
      clearPoll();
      currentJobKey = jobKey;
      renderGithubBase();
      root.appendChild(textEl(
        'p',
        'ob-error',
        error || t('onboard.github.interrupted', 'Parece que el login de GitHub se interrumpió.')
      ));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button(
        t('onboard.action.retry', 'Reintentar'),
        'btn',
        startGithub
      ));
      root.appendChild(actions);
      return;
    }

    if (jobKey === currentJobKey && status === 'awaiting-auth') return;
    currentJobKey = jobKey;

    if (status === 'awaiting-auth' && url && code) {
      state.githubUrl = url;
      state.githubCode = code;
      renderGithubAwaitingAuth();
      return;
    }

    renderGithubSpinner(status === 'setup-git'
      ? t('onboard.github.setupGit', 'Configurando Git para HTTPS…')
      : t('onboard.github.preparing', 'Preparando…'));
  }

  const SMOKE_CHECKS = [
    ['chat', 'Chat con Claude'],
    ['terminal', 'Terminal'],
    ['mcp', 'MCP de Tolkien'],
    ['pad', 'Workspace de Pad'],
    ['tolkien', 'Compilación de Tolkien'],
  ];

  function pendingSmokeChecks() {
    return SMOKE_CHECKS.map(function (item) {
      return {
        id: item[0],
        labelEs: item[1],
        status: 'pending',
        detail: t('onboard.smoke.pending', 'Verificando…'),
        fixHint: null,
      };
    });
  }

  async function runSmokeChecks(retryId) {
    state.smokeRunning = true;
    state.smokeError = '';
    if (!state.smoke.length) {
      state.smoke = pendingSmokeChecks();
    } else if (retryId) {
      state.smoke = state.smoke.map(function (check) {
        return check.id === retryId
          ? { ...check, status: 'pending', detail: t('onboard.smoke.pending', 'Verificando…') }
          : check;
      });
    }
    render();
    try {
      const checks = await apiJson('/smoke', {
        method: 'POST',
        body: { token: state.token },
      });
      if (!Array.isArray(checks) || checks.length !== SMOKE_CHECKS.length) {
        throw new Error(t('onboard.smoke.invalidResponse', 'El servidor devolvió una verificación incompleta.'));
      }
      state.smoke = checks;
    } catch (error) {
      state.smokeError = error.message;
    } finally {
      state.smokeRunning = false;
      render();
    }
  }

  function smokeIcon(status) {
    if (status === 'ok') return '✅';
    if (status === 'fail') return '❌';
    if (status === 'skip') return '⏭';
    return '⏳';
  }

  function renderSmoke() {
    root.replaceChildren();
    const failed = state.smoke.some(function (check) { return check.status === 'fail'; });
    const skipped = state.smoke.some(function (check) { return check.status === 'skip'; });
    const allOk = state.smoke.length === SMOKE_CHECKS.length
      && state.smoke.every(function (check) { return check.status === 'ok'; });
    root.appendChild(header(
      allOk
        ? t('onboard.smoke.readyTitle', '✅ Todo funciona')
        : t('onboard.smoke.title', 'Verificamos tu acceso'),
      allOk
        ? t('onboard.smoke.readyHint', 'Las cinco pruebas reales terminaron bien.')
        : t('onboard.smoke.hint', 'Probamos cada puerta antes de dar por terminada la configuración.')
    ));
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.smoke.chatCost', 'La prueba de chat valida la credencial sin generar una respuesta: no consume tokens.')
    ));

    const list = document.createElement('ul');
    list.className = 'ob-list';
    state.smoke.forEach(function (check) {
      const item = document.createElement('li');
      item.appendChild(textEl(
        'span',
        '',
        `${smokeIcon(check.status)} ${t(`onboard.smoke.${check.id}.label`, check.labelEs || check.id)}`
      ));
      if (check.detail) item.appendChild(textEl('p', 'ob-note', check.detail));
      if (check.status === 'fail' && check.fixHint) {
        item.appendChild(textEl('p', 'ob-error', check.fixHint));
        const retry = button(
          t('onboard.smoke.retryOne', 'Reintentar esta prueba'),
          'btn-ghost',
          function () { runSmokeChecks(check.id); }
        );
        retry.disabled = state.smokeRunning;
        item.appendChild(retry);
      }
      list.appendChild(item);
    });
    root.appendChild(list);

    if (state.smokeError) {
      root.appendChild(textEl('p', 'ob-error', state.smokeError));
    } else if (failed) {
      root.appendChild(textEl(
        'p',
        'ob-error',
        t('onboard.smoke.failedHint', 'Hay funciones que todavía no van a funcionar. Podés corregirlas ahora o continuar igual.')
      ));
    } else if (skipped && !state.smokeRunning) {
      root.appendChild(textEl(
        'p',
        'ob-note',
        t('onboard.smoke.skippedHint', 'Alguna preparación todavía no terminó. Podés reintentar o continuar igual.')
      ));
    }

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    if (state.smokeError) {
      const retryAll = button(
        t('onboard.smoke.retryAll', 'Reintentar verificación'),
        'btn-ghost',
        function () { runSmokeChecks(); }
      );
      retryAll.disabled = state.smokeRunning;
      actions.appendChild(retryAll);
    }
    if (!state.smokeRunning && state.smoke.length) {
      actions.appendChild(button(
        allOk
          ? t('onboard.smoke.finish', 'Terminar')
          : t('onboard.smoke.continueAnyway', 'Continuar igual'),
        allOk ? 'btn' : 'btn-ghost',
        function () { setStep('done'); }
      ));
    }
    root.appendChild(actions);
  }

  function renderDone() {
    root.replaceChildren();
    const provFailed = !!(state.provision && state.provision.status === 'failed');
    root.appendChild(provFailed
      ? header(
        t('onboard.done.partialTitle', '⚠️ Casi listo'),
        t('onboard.done.partialHint', 'Tu cuenta quedó creada, pero algo de tu espacio no se pudo preparar.')
      )
      : header(
        t('onboard.done.title', '✅ ¡Listo!'),
        t('onboard.done.hint', 'Tu cuenta quedó configurada.')
      ));
    const list = document.createElement('ul');
    list.className = 'ob-list';
    list.appendChild(textEl(
      'li',
      '',
      '✅ ' + t('onboard.done.accountCreated', 'Cuenta creada ({user})', { user: state.username })
    ));
    state.capabilities.forEach(function (item) {
      const connected = state[item.id] === 'connected'
        || (state.checklist && state.checklist[item.id]);
      const label = t(`onboard.capability.${item.id}`, item.labelEs || item.id);
      let text;
      if (connected) {
        text = '✅ ' + t('onboard.done.connected', '{step}: conectado.', { step: label });
      } else if (item.required) {
        text = '⚠️ ' + t('onboard.done.requiredMissing', '{step}: falta completar.', {
          step: label,
        });
      } else {
        text = '⏭ ' + t('onboard.done.skipped', '{step}: omitido; podés conectarlo después.', {
          step: label,
        });
      }
      list.appendChild(textEl('li', '', text));
    });
    list.appendChild(textEl(
      'li',
      '',
      '✅ ' + t('onboard.done.language', 'Idioma: {lang}', {
        lang: state.lang === 'en' ? 'English' : 'Español',
      })
    ));
    root.appendChild(list);
    appendProvisionState(root);
    root.appendChild(textEl(
      'p',
      'ob-note',
      t('onboard.done.connections', 'Cuando entres, en ⚙ Sistema → Conexiones podés conectar Microsoft y Zoho.')
    ));
    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button(t('onboard.done.login', 'Ir a iniciar sesión'), 'btn', function () {
      window.location.href = '/login';
    }));
    root.appendChild(actions);
  }

  function render() {
    if (!root) return;
    if (state.step === 'token') renderToken();
    else if (state.step === 'pending') renderPending();
    else if (state.step === 'register') renderRegister();
    else if (state.step === 'creds') renderSpinner(t('onboard.action.preparing', 'Preparando…'));
    else if (state.step === 'account') renderAccountSpinner(t('onboard.action.preparing', 'Preparando…'));
    else if (state.step === 'codex') renderCodexSpinner(t('onboard.action.preparing', 'Preparando…'));
    else if (state.step === 'infisical') renderInfisicalSpinner(t('onboard.action.preparing', 'Preparando…'));
    else if (state.step === 'github') renderGithubSpinner(t('onboard.github.preparing', 'Preparando…'));
    else if (state.step === 'smoke') renderSmoke();
    else renderDone();
  }

  render();
}());
