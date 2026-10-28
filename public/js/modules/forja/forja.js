import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { renderArena } from './arena.js';
import { createFestejoController } from './festejo.js';
import { renderFicha } from './ficha.js';
import { renderSalon } from './salon.js';
import { node } from './view.js';

const POLL_MS = 60_000;
const OPEN_KEY = 'cwc.forja.open';
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const mountCleanups = new WeakMap();
let modalSequence = 0;

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t('forja.error.request', 'La Forja no respondió.'));
  return data;
}

function readOpen() {
  try { return localStorage.getItem(OPEN_KEY) === '1'; }
  catch { return false; }
}

function loadingPanel(label) {
  const loading = node('div', 'cwc-loading fj-modal-loading');
  loading.append(node('span', 'cwc-spinner'), document.createTextNode(label));
  return loading;
}

function errorPanel(error, retry) {
  const box = node('div', 'fj-modal-error');
  box.append(node('strong', '', t('forja.error.title', 'La fragua se enfrió')), node('p', '', error?.message || t('forja.error.request', 'La Forja no respondió.')));
  const button = node('button', 'btn-ghost', t('forja.error.retry', 'Reintentar'));
  button.type = 'button';
  button.addEventListener('click', retry);
  box.appendChild(button);
  return box;
}

function addModalHelp(modal) {
  const holder = document.createElement('span');
  holder.innerHTML = helpBtn('forja');
  modal.card.querySelector('.dlg-head')?.appendChild(holder.firstElementChild);
}

function openForgeModal(ctx, me, mountEl) {
  let arena = null;
  let arenaPromise = null;
  const opener = document.activeElement;
  const modal = ctx.dialog.openModal({
    title: t('forja.modal.title', 'La Forja'),
    width: 'min(1180px, 96vw)',
    onClose: () => {
      const focusTarget = opener?.isConnected ? opener : mountEl.querySelector('[data-ref="forja-cta"]');
      focusTarget?.focus();
    },
  });
  modal.card.classList.add('fj-modal');
  addModalHelp(modal);

  const tabs = node('div', 'fj-tabs');
  tabs.setAttribute('role', 'tablist');
  const salonButton = node('button', 'fj-tab fj-tab--active', t('forja.tabs.salon', 'Mi salón'));
  const arenaButton = node('button', 'fj-tab', t('forja.tabs.arena', 'Arena'));
  salonButton.type = 'button';
  arenaButton.type = 'button';
  salonButton.setAttribute('role', 'tab');
  arenaButton.setAttribute('role', 'tab');
  const modalId = ++modalSequence;
  salonButton.id = `fj-tab-salon-${modalId}`;
  arenaButton.id = `fj-tab-arena-${modalId}`;
  salonButton.setAttribute('aria-controls', `fj-tab-panel-${modalId}`);
  arenaButton.setAttribute('aria-controls', `fj-tab-panel-${modalId}`);
  salonButton.setAttribute('aria-selected', 'true');
  arenaButton.setAttribute('aria-selected', 'false');
  salonButton.tabIndex = 0;
  arenaButton.tabIndex = -1;
  const panel = node('div', 'fj-tab-panel');
  panel.id = `fj-tab-panel-${modalId}`;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', salonButton.id);
  tabs.append(salonButton, arenaButton);
  modal.body.append(tabs, panel);

  const activate = (name) => {
    const isSalon = name === 'salon';
    salonButton.classList.toggle('fj-tab--active', isSalon);
    arenaButton.classList.toggle('fj-tab--active', !isSalon);
    salonButton.setAttribute('aria-selected', String(isSalon));
    arenaButton.setAttribute('aria-selected', String(!isSalon));
    salonButton.tabIndex = isSalon ? 0 : -1;
    arenaButton.tabIndex = isSalon ? -1 : 0;
    panel.setAttribute('aria-labelledby', isSalon ? salonButton.id : arenaButton.id);
    if (isSalon) {
      renderSalon(panel, me, ctx);
      return;
    }
    if (arena) {
      renderArena(panel, arena, me, ctx);
      return;
    }
    panel.textContent = '';
    panel.appendChild(loadingPanel(t('forja.arena.loading', 'Abriendo la arena…')));
    if (!arenaPromise) arenaPromise = api('/api/forja/arena');
    arenaPromise.then((data) => {
      arena = data;
      if (arenaButton.getAttribute('aria-selected') === 'true') renderArena(panel, arena, me, ctx);
    }).catch((error) => {
      arenaPromise = null;
      if (arenaButton.getAttribute('aria-selected') !== 'true') return;
      panel.textContent = '';
      panel.appendChild(errorPanel(error, () => activate('arena')));
    });
  };

  salonButton.addEventListener('click', () => activate('salon'));
  arenaButton.addEventListener('click', () => activate('arena'));
  tabs.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabButtons = [salonButton, arenaButton];
    const current = tabButtons.indexOf(document.activeElement);
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabButtons.length - 1;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabButtons.length) % tabButtons.length;
    else next = (current + 1) % tabButtons.length;
    const target = tabButtons[next];
    activate(target === salonButton ? 'salon' : 'arena');
    target.focus();
  });
  activate('salon');
  salonButton.focus();
}

async function openConfiguration(ctx, onSaved) {
  const modal = ctx.dialog.openModal({ title: t('forja.configure.modalTitle', 'Forjá tu ficha'), width: 440 });
  modal.card.classList.add('fj-config-modal');
  modal.body.appendChild(loadingPanel(t('forja.configure.loading', 'Leyendo tu identidad…')));
  let identity;
  try {
    const data = await api('/api/projects/me/identity');
    identity = data.identity || {};
  } catch (error) {
    modal.body.textContent = '';
    modal.body.appendChild(errorPanel(error, () => { modal.close(); void openConfiguration(ctx, onSaved); }));
    return;
  }

  modal.body.textContent = '';
  const form = node('form', 'fj-config-form');
  form.appendChild(node('p', 'dlg-msg', t('forja.configure.explanation', 'Escribí tu login de GitHub. Conservaremos el resto de tu identidad tal como está.')));
  const label = node('label', 'fj-config-label');
  label.appendChild(node('span', '', t('forja.configure.githubLabel', 'Login de GitHub')));
  const input = node('input', 'dlg-input');
  input.type = 'text';
  input.name = 'github';
  input.required = true;
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.placeholder = t('forja.configure.githubPlaceholder', 'tu-usuario');
  input.value = identity.github || '';
  label.appendChild(input);
  const feedback = node('p', 'fj-config-feedback');
  feedback.hidden = true;
  const actions = node('div', 'dlg-actions');
  const cancel = node('button', 'btn-ghost', t('forja.configure.cancel', 'Cancelar'));
  cancel.type = 'button';
  const save = node('button', 'btn', t('forja.configure.save', 'Guardar y forjar'));
  save.type = 'submit';
  actions.append(cancel, save);
  form.append(label, feedback, actions);
  modal.body.appendChild(form);
  cancel.addEventListener('click', modal.close);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const github = input.value.trim();
    feedback.classList.remove('fj-config-feedback--error');
    if (!GITHUB_LOGIN_RE.test(github)) {
      feedback.textContent = t('forja.configure.invalidFormat', 'Es tu @usuario de GitHub, no tu nombre. Ej: rarboledaAtMordor');
      feedback.classList.add('fj-config-feedback--error');
      feedback.hidden = false;
      input.focus();
      return;
    }
    input.disabled = true;
    save.disabled = true;
    cancel.disabled = true;
    feedback.textContent = t('forja.configure.saving', 'Guardando identidad y encendiendo la fragua…');
    feedback.hidden = false;
    try {
      const validation = await api('/api/forja/validate-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: github }),
      });
      if (!validation.exists || !validation.canonicalLogin) {
        throw new Error(t('forja.configure.notFound', 'No encontramos ese @usuario en GitHub. Revisalo e intentá de nuevo.'));
      }
      const freshData = await api('/api/projects/me/identity');
      const nextIdentity = { ...(freshData.identity || {}), github: validation.canonicalLogin };
      await api('/api/projects/me/identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: nextIdentity }),
      });
      await api('/api/forja/refresh', { method: 'POST' });
      modal.close();
      await onSaved();
    } catch (error) {
      feedback.textContent = error?.message || t('forja.configure.saveError', 'No pudimos forjar tu ficha.');
      feedback.classList.add('fj-config-feedback--error');
      input.disabled = false;
      save.disabled = false;
      cancel.disabled = false;
    }
  });
  input.focus();
  input.select();
}

export default {
  name: 'forja',

  mount(el, ctx) {
    mountCleanups.get(el)?.();
    const state = {
      loading: true,
      data: null,
      error: null,
      open: readOpen(),
      pendingNoticed: false,
    };
    let lastLoadedAt = 0;
    let inFlight = null;
    let active = true;

    let festejos = null;
    const render = () => {
      if (!active) return;
      renderFicha(el, state, {
        onOpen: () => { if (state.data?.configured) openForgeModal(ctx, state.data, el); },
        onConfigure: () => { void openConfiguration(ctx, () => load()); },
        onRetry: () => { void load(); },
        onToggle: (open) => {
          state.open = open;
          if (open) state.pendingNoticed = true;
          try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* localStorage puede estar bloqueado. */ }
          render();
        },
      });
      el.querySelector('.fj-enter')?.setAttribute('data-ref', 'forja-cta');
    };
    festejos = createFestejoController({
      api,
      onOpen: () => { if (state.data?.configured) openForgeModal(ctx, state.data, el); },
      onPendingChange: (count) => {
        if (!active || !state.data?.configured) return;
        const previous = Number(state.data.pendingFestejos) || 0;
        state.data = { ...state.data, pendingFestejos: count };
        if (count <= 0) state.pendingNoticed = true;
        else if (count > previous && !state.open) state.pendingNoticed = false;
        render();
      },
    });

    const load = ({ silent = false } = {}) => {
      if (inFlight) return inFlight;
      if (!silent) {
        state.loading = !state.data;
        state.error = null;
        render();
      }
      inFlight = api('/api/forja/me')
        .then((data) => {
          state.data = data;
          state.error = null;
          state.loading = false;
          lastLoadedAt = Date.now();
          render();
          if (active) festejos.sync(data.pendingFestejos, data.celebrationName);
          return data;
        })
        .catch((error) => {
          state.loading = false;
          if (!state.data) state.error = error;
          render();
          return null;
        })
        .finally(() => { inFlight = null; });
      return inFlight;
    };

    render();
    void load();
    const interval = setInterval(() => { if (!document.hidden) void load({ silent: true }); }, POLL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden && Date.now() - lastLoadedAt >= POLL_MS) void load({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    mountCleanups.set(el, () => {
      active = false;
      festejos.destroy();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  },
};
