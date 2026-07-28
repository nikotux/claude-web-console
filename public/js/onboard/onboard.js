(function () {
  'use strict';

  const API = '/api/onboard/public';
  const root = document.getElementById('onboard-root');
  const state = {
    step: 'token',
    token: '',
    username: '',
    admin: false,
    lang: 'es',
    account: '',
    codex: '',
    infisical: '',
    url: '',
    credsNote: '',
    accountUrl: '',
    codexUrl: '',
    codexCode: '',
    infisicalUrl: '',
    pending: [],
    checklist: null,
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
    if (['creds', 'account', 'codex', 'infisical'].includes(state.step) && step !== state.step) clearPoll();
    state.step = step;
    state.error = '';
    loading = '';
    exchanging = false;
    currentJobKey = '';
    if (step === 'done' && !state.finishSent) {
      state.finishSent = true;
      apiJson('/finish', { method: 'POST', body: { token: state.token } }).catch(() => {});
    }
    render();
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
    } else {
      setStep('done');
    }
  }

  function startNextPending() {
    startNamedStep(state.pending[0]);
  }

  function advanceCompleted(step) {
    if (state.checklist) {
      state.checklist[step] = true;
      state.pending = state.pending.filter(function (item) {
        return item !== step;
      });
      startNextPending();
      return;
    }

    if (step === 'claude') startNamedStep('account');
    else if (step === 'account') startNamedStep('codex');
    else if (step === 'codex') startNamedStep('infisical');
    else startNamedStep('done');
  }

  function advanceSkipped(step) {
    if (state.checklist) {
      state.pending = state.pending.filter(function (item) {
        return item !== step;
      });
      startNextPending();
      return;
    }

    if (step === 'account') startNamedStep('codex');
    else if (step === 'codex') startNamedStep('infisical');
    else startNamedStep('done');
  }

  function setError(message) {
    state.error = message || 'Ocurrió un error.';
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

  function header(title, hint, activeStep) {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'ob-head';
    head.appendChild(textEl('h1', 'ob-title', title));
    if (hint) head.appendChild(textEl('p', 'ob-hint', hint));
    frag.appendChild(head);

    const steps = document.createElement('div');
    steps.className = 'ob-steps';
    steps.style.gridTemplateColumns = 'repeat(7, 1fr)';
    steps.setAttribute('aria-label', 'Progreso del onboarding');
    for (let i = 1; i <= 7; i += 1) {
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
      const msg = data.error || data.reason || 'Error de servidor.';
      throw new Error(msg);
    }

    return data;
  }

  async function validateToken() {
    const tokenInput = document.getElementById('ob-token');
    const token = tokenInput ? tokenInput.value.trim() : '';
    if (!token) {
      setError('Ingresá el token de invitación.');
      return;
    }

    loading = 'token';
    state.error = '';
    render();

    try {
      const data = await apiJson('/validate', { method: 'POST', body: { token } });
      state.token = token;
      state.admin = Boolean(data.admin);

      if (data.resume === true) {
        state.username = data.lockedTo || '';
        state.pending = Array.isArray(data.pending) ? data.pending.slice() : [];
        state.checklist = {
          claude: Boolean(data.hasToken),
          account: Boolean(data.hasClaudeAccount),
          codex: Boolean(data.hasCodex),
          infisical: Boolean(data.hasInfisical),
        };
        state.codex = data.hasCodex ? 'connected' : '';
        state.infisical = data.hasInfisical ? 'connected' : '';
        if (state.pending.length) setStep('pending');
        else setStep('done');
        return;
      }

      if (data.valid === true) {
        setStep('register');
      } else {
        setError('Invitación ' + (data.reason || 'inválida'));
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
      setError('Ingresá un nombre de usuario.');
      return;
    }
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== repeat) {
      setError('Las contraseñas no coinciden.');
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
      if (!data.ok) throw new Error(data.error || 'No se pudo crear la cuenta.');
      state.username = username;
      setStep('creds');
      startCreds();
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
      state.error = 'Pegá el código de autorización.';
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
    btn.textContent = exchanging ? 'Confirmando…' : 'Confirmar código';
  }

  function renderToken() {
    root.replaceChildren();
    root.appendChild(header('Bienvenido/a', 'Usá tu invitación para configurar el acceso.', 1));

    const form = document.createElement('form');
    form.className = 'ob-form';
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      validateToken();
    });

    const token = input('ob-token', 'text', 'Token de invitación', 'one-time-code');
    token.autofocus = true;
    form.appendChild(field('Token de invitación', token));

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn';
    submit.disabled = loading === 'token';
    submit.textContent = loading === 'token' ? 'Continuando…' : 'Continuar';
    actions.appendChild(submit);
    form.appendChild(actions);

    const err = message();
    if (err) form.appendChild(err);
    root.appendChild(form);
    token.focus();
  }

  function renderPending() {
    const stepNumbers = { claude: 3, account: 4, codex: 5, infisical: 6 };
    const activeStep = stepNumbers[state.pending[0]] || 2;
    const items = [
      ['claude', 'Cuenta de Claude'],
      ['account', 'Claude · tu consumo (opcional)'],
      ['codex', 'Codex (opcional)'],
      ['infisical', 'Infisical (acceso a Tolkien)'],
    ];

    root.replaceChildren();
    root.appendChild(header(
      'Te falta completar tu configuración',
      'Entraste como ' + state.username + '. Estos son los pasos que quedaron pendientes.',
      activeStep
    ));

    const form = document.createElement('div');
    form.className = 'ob-form';
    const list = document.createElement('ul');
    list.className = 'ob-list';
    items.forEach(function (item) {
      const complete = state.checklist && state.checklist[item[0]];
      list.appendChild(textEl('li', '', (complete ? '✅ ' : '⬜ ') + item[1]));
    });
    form.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button('Continuar', 'btn', startNextPending));
    form.appendChild(actions);
    root.appendChild(form);
  }

  function renderRegister() {
    root.replaceChildren();
    root.appendChild(header('Creá tu usuario', 'Elegí las credenciales para entrar a la consola.', 2));

    const form = document.createElement('form');
    form.className = 'ob-form';
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      registerUser();
    });

    if (state.admin) {
      form.appendChild(textEl('p', 'ob-note', 'Esta cuenta será administrador.'));
    }

    const username = input('ob-username', 'text', 'Usuario', 'username');
    const password = input('ob-password', 'password', 'Contraseña', 'new-password');
    const repeat = input('ob-password-repeat', 'password', 'Repetir contraseña', 'new-password');
    const lang = document.createElement('select');
    lang.id = 'ob-lang';
    lang.className = 'dlg-input';
    const spanish = document.createElement('option');
    spanish.value = 'es';
    spanish.textContent = 'Español';
    const english = document.createElement('option');
    english.value = 'en';
    english.textContent = 'English';
    lang.appendChild(spanish);
    lang.appendChild(english);
    lang.value = state.lang;
    form.appendChild(field('Usuario', username));
    form.appendChild(field('Contraseña', password));
    form.appendChild(field('Repetir contraseña', repeat));
    form.appendChild(field('Idioma de la consola', lang));

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button('← volver', 'btn-ghost', function () {
      setStep('token');
    }));
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn';
    submit.disabled = loading === 'register';
    submit.textContent = loading === 'register' ? 'Creando…' : 'Crear cuenta';
    actions.appendChild(submit);
    form.appendChild(actions);

    const err = message();
    if (err) form.appendChild(err);
    root.appendChild(form);
    username.focus();
  }

  function renderCredsBase() {
    root.replaceChildren();
    root.appendChild(header('Conectá tu cuenta de Claude', 'Autorizá Claude para terminar la configuración.', 3));
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
    first.appendChild(textEl('span', '', 'Abrí este enlace y autorizá con tu cuenta de Claude:'));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.url;
    first.appendChild(link);
    const copy = button('Copiar enlace', 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.url);
        copy.textContent = 'Copiado';
      } catch (err) {
        copy.textContent = 'No se pudo copiar';
      }
      window.setTimeout(function () {
        copy.textContent = 'Copiar enlace';
      }, 1800);
    });
    first.appendChild(copy);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl('span', '', 'Copiá el código que te da y pegalo acá:'));
    if (state.credsNote) {
      second.appendChild(textEl('p', 'ob-error', state.credsNote));
    }
    const row = document.createElement('div');
    row.className = 'ob-code-row';
    const code = input('ob-code', 'text', 'Código de autorización', 'one-time-code');
    const confirm = button('Confirmar código', 'btn', sendCode);
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
      state.error = error || 'No se pudo conectar la cuenta de Claude.';
      renderCredsBase();
      root.appendChild(textEl('p', 'ob-error', state.error));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button('Reintentar', 'btn', startCreds));
      root.appendChild(actions);
      return;
    }

    if (stale) {
      clearPoll();
      currentJobKey = jobKey;
      renderCredsBase();
      root.appendChild(textEl('p', 'ob-error', 'Parece que se interrumpió.'));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button('Reintentar', 'btn', startCreds));
      root.appendChild(actions);
      return;
    }

    if (jobKey === currentJobKey && status === 'awaiting-code') return;
    currentJobKey = jobKey;

    if (status === 'exchanging') {
      renderSpinner('Verificando el código…');
      return;
    }

    if (status === 'awaiting-code' && url) {
      state.url = url;
      renderAwaitingCode();
      return;
    }

    renderSpinner('Preparando…');
  }

  function renderAccountBase() {
    root.replaceChildren();
    root.appendChild(header(
      'Claude · tu consumo (opcional)',
      'Conectá tu cuenta para ver el uso real de tu plan.',
      4
    ));
    root.appendChild(textEl('p', 'ob-note', 'Esto habilita los porcentajes reales de tu sesión de 5 horas y de tu semana.'));
    root.appendChild(textEl('p', 'ob-note', 'Sin este paso, el panel Uso solo mostrará tus tokens consumidos. No es requisito para empezar a trabajar: podés conectarlo más tarde desde el bloque Claude · tu consumo.'));
  }

  function appendAccountSkip() {
    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button('Omitir por ahora', 'btn-ghost', function () {
      state.account = 'skipped';
      advanceSkipped('account');
    }));
    root.appendChild(actions);
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
    renderAccountSpinner('Preparando…');

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
      state.error = 'Pegá el código de autorización.';
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
      ? 'Verificando…'
      : (waiting ? 'Confirmar código' : 'Esperando al servidor…');
  }

  function renderAccountAuthorization(status) {
    renderAccountBase();

    const list = document.createElement('ol');
    list.className = 'ob-list';

    const first = document.createElement('li');
    first.appendChild(textEl('span', '', 'La página no se abre sola porque el CLI corre en un servidor sin entorno gráfico. Abrí este enlace y autorizá con tu cuenta de Claude:'));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.accountUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.accountUrl;
    first.appendChild(link);
    const copy = button('Copiar enlace', 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.accountUrl);
        copy.textContent = 'Copiado';
      } catch (err) {
        copy.textContent = 'No se pudo copiar';
      }
      window.setTimeout(function () {
        copy.textContent = 'Copiar enlace';
      }, 1800);
    });
    first.appendChild(copy);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl('span', '', 'Copiá el código que te da Claude y pegalo acá:'));
    const row = document.createElement('div');
    row.className = 'ob-code-row';
    const code = input('ob-account-code', 'text', 'Código de autorización', 'one-time-code');
    const confirm = button('Confirmar código', 'btn', sendAccountCode);
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
      root.appendChild(textEl('p', 'ob-error', error || 'No se pudo conectar la cuenta de Claude.'));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button('Reintentar', 'btn', startAccount));
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
    renderAccountSpinner(status === 'verifying' ? 'Verificando el código…' : 'Preparando…');
  }

  function renderCodexBase() {
    root.replaceChildren();
    root.appendChild(header('Conectar Codex (opcional)', 'Autorizá Codex para usar el modo Tándem.', 5));
    root.appendChild(textEl('p', 'ob-note', 'Codex es el ejecutor del modo Tándem (Claude razona, Codex escribe el código). Sin Codex tus chats usan AutoTux; podés conectarlo más tarde desde ⚙ Sistema → Conexiones.'));
  }

  function appendCodexSkip() {
    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button('Omitir por ahora', 'btn-ghost', function () {
      state.codex = 'skipped';
      advanceSkipped('codex');
    }));
    root.appendChild(actions);
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
    renderCodexSpinner('Preparando…');

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
    first.appendChild(textEl('span', '', 'Abrí este enlace:'));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.codexUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.codexUrl;
    first.appendChild(link);
    const copyLink = button('Copiar enlace', 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.codexUrl);
        copyLink.textContent = 'Copiado';
      } catch (err) {
        copyLink.textContent = 'No se pudo copiar';
      }
      window.setTimeout(function () {
        copyLink.textContent = 'Copiar enlace';
      }, 1800);
    });
    first.appendChild(copyLink);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl('span', '', 'Código de autorización:'));
    second.appendChild(textEl('p', 'ob-title', state.codexCode));
    const copyCode = button('Copiar código', 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.codexCode);
        copyCode.textContent = 'Copiado';
      } catch (err) {
        copyCode.textContent = 'No se pudo copiar';
      }
      window.setTimeout(function () {
        copyCode.textContent = 'Copiar código';
      }, 1800);
    });
    second.appendChild(copyCode);
    list.appendChild(second);
    root.appendChild(list);
    root.appendChild(textEl('p', 'ob-note', 'Abrí el enlace, pegá este código y autorizá con tu cuenta de ChatGPT. El código vence en 15 minutos.'));
    root.appendChild(textEl('p', 'ob-note', 'Esta pantalla avanza sola cuando termines.'));
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
      root.appendChild(textEl('p', 'ob-error', error || 'Parece que se interrumpió.'));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button('Reintentar', 'btn', startCodex));
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

    renderCodexSpinner('Preparando…');
  }

  function renderInfisicalBase() {
    root.replaceChildren();
    root.appendChild(header('Conectá Infisical', 'Es lo que le da acceso a las herramientas de Tolkien.', 6));
    root.appendChild(textEl('p', 'ob-note', 'Infisical guarda los secretos del proyecto. Sin esta conexión, el MCP de Tolkien queda sin credenciales y las herramientas de Desk/Teams no funcionan. Podés conectarlo más tarde desde ⚙ Sistema → MCPs.'));
  }

  function appendInfisicalSkip() {
    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button('Omitir por ahora', 'btn-ghost', function () {
      state.infisical = 'skipped';
      advanceSkipped('infisical');
    }));
    root.appendChild(actions);
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
    renderInfisicalSpinner('Preparando…');

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
      state.error = 'Pegá el token de Infisical.';
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
    btn.textContent = exchanging ? 'Confirmando…' : 'Confirmar token';
  }

  function renderInfisicalAwaitingToken() {
    renderInfisicalBase();

    const list = document.createElement('ol');
    list.className = 'ob-list';

    const first = document.createElement('li');
    first.appendChild(textEl('span', '', 'Abrí este enlace e iniciá sesión en Infisical:'));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.infisicalUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.infisicalUrl;
    first.appendChild(link);
    const copy = button('Copiar enlace', 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.infisicalUrl);
        copy.textContent = 'Copiado';
      } catch (err) {
        copy.textContent = 'No se pudo copiar';
      }
      window.setTimeout(function () {
        copy.textContent = 'Copiar enlace';
      }, 1800);
    });
    first.appendChild(copy);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl('span', '', 'Copiá el token que te muestra Infisical y pegalo acá:'));
    const row = document.createElement('div');
    row.className = 'ob-code-row';
    const token = input('ob-infisical-token', 'text', 'Token de Infisical', 'one-time-code');
    const confirm = button('Confirmar token', 'btn', sendInfisicalToken);
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
      root.appendChild(textEl('p', 'ob-error', error || 'Parece que se interrumpió.'));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button('Reintentar', 'btn', startInfisical));
      root.appendChild(actions);
      appendInfisicalSkip();
      return;
    }

    if (jobKey === currentJobKey && url) return;
    currentJobKey = jobKey;

    if (status === 'exchanging') {
      renderInfisicalSpinner('Verificando el token…');
      return;
    }

    if (url) {
      exchanging = false;
      state.infisicalUrl = url;
      renderInfisicalAwaitingToken();
      return;
    }

    renderInfisicalSpinner('Preparando…');
  }

  function renderDone() {
    root.replaceChildren();
    root.appendChild(header('✅ ¡Listo!', 'Tu cuenta quedó configurada.', 7));
    const list = document.createElement('ul');
    list.className = 'ob-list';
    const accountConnected = state.account === 'connected' || (state.checklist && state.checklist.account);
    const codexConnected = state.codex === 'connected' || (state.checklist && state.checklist.codex);
    const infisicalConnected = state.infisical === 'connected' || (state.checklist && state.checklist.infisical);
    list.appendChild(textEl('li', '', '✅ Cuenta creada (' + state.username + ')'));
    list.appendChild(textEl('li', '', '✅ Claude listo para trabajar (setup-token)'));
    list.appendChild(textEl('li', '', accountConnected
      ? '✅ Claude · tu consumo conectado'
      : '⏭ Claude · tu consumo omitido — lo podés conectar después'));
    list.appendChild(textEl('li', '', codexConnected
      ? '✅ Codex conectado'
      : '⏭ Codex omitido — lo podés conectar después'));
    list.appendChild(textEl('li', '', infisicalConnected
      ? '✅ Infisical conectado'
      : '⏭ Infisical omitido — lo podés conectar después'));
    list.appendChild(textEl('li', '', '✅ Idioma: ' + (state.lang === 'en' ? 'English' : 'Español')));
    root.appendChild(list);
    root.appendChild(textEl('p', 'ob-note', 'Cuando entres, en ⚙ Sistema → Conexiones podés conectar Microsoft y Zoho.'));
    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button('Ir a iniciar sesión', 'btn', function () {
      window.location.href = '/login';
    }));
    root.appendChild(actions);
  }

  function render() {
    if (!root) return;
    if (state.step === 'token') renderToken();
    else if (state.step === 'pending') renderPending();
    else if (state.step === 'register') renderRegister();
    else if (state.step === 'creds') renderSpinner('Preparando…');
    else if (state.step === 'account') renderAccountSpinner('Preparando…');
    else if (state.step === 'codex') renderCodexSpinner('Preparando…');
    else if (state.step === 'infisical') renderInfisicalSpinner('Preparando…');
    else renderDone();
  }

  render();
}());
