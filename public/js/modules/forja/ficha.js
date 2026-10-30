import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { icon } from '../../ui/icons.js';
import { levelCode, levelName, node, percent, staleLabel } from './view.js';

const REFRESHING_POLL_BASE_MS = 5_000;
const REFRESHING_POLL_CAP_MS = 60_000;
const REFRESHING_POLL_MAX_ATTEMPTS = 10;
let refreshingPoller = null;

function refreshingPollDelay(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= REFRESHING_POLL_MAX_ATTEMPTS) return null;
  return Math.min(REFRESHING_POLL_CAP_MS, REFRESHING_POLL_BASE_MS * (2 ** attempt));
}

export function __refreshingPollDelayForTests(attempt) {
  return refreshingPollDelay(attempt);
}

function clearRefreshingTimer(poller) {
  if (poller?.timer) clearTimeout(poller.timer);
  if (poller) poller.timer = null;
}

function stopRefreshingPoller(el = null) {
  if (!refreshingPoller || (el && refreshingPoller.el !== el)) return;
  clearRefreshingTimer(refreshingPoller);
  document.removeEventListener('visibilitychange', refreshingPoller.onVisibilityChange);
  refreshingPoller = null;
}

function scheduleRefreshingPoll(poller, delay = refreshingPollDelay(poller.attempts)) {
  clearRefreshingTimer(poller);
  if (delay === null || document.hidden || refreshingPoller !== poller) {
    poller.remainingMs = delay;
    return;
  }
  poller.remainingMs = delay;
  poller.startedAt = Date.now();
  poller.timer = setTimeout(() => {
    poller.timer = null;
    poller.remainingMs = null;
    if (refreshingPoller !== poller) return;
    if (!poller.el.isConnected) {
      stopRefreshingPoller(poller.el);
      return;
    }
    poller.attempts += 1;
    poller.actions.onRetry();
  }, delay);
}

function ensureRefreshingPoller(el, actions) {
  if (refreshingPoller?.el !== el) {
    stopRefreshingPoller();
    const poller = {
      el,
      actions,
      attempts: 0,
      timer: null,
      remainingMs: null,
      startedAt: 0,
      onVisibilityChange: null,
    };
    poller.onVisibilityChange = () => {
      if (refreshingPoller !== poller) return;
      if (document.hidden) {
        if (!poller.timer) return;
        poller.remainingMs = Math.max(0, poller.remainingMs - (Date.now() - poller.startedAt));
        clearRefreshingTimer(poller);
        return;
      }
      if (!poller.timer) scheduleRefreshingPoll(poller, poller.remainingMs);
    };
    document.addEventListener('visibilitychange', poller.onVisibilityChange);
    refreshingPoller = poller;
    scheduleRefreshingPoll(poller);
  } else {
    refreshingPoller.actions = actions;
    if (!refreshingPoller.timer && refreshingPoller.remainingMs === null) {
      scheduleRefreshingPoll(refreshingPoller);
    }
  }
  return refreshingPoller;
}

function restartRefreshingPoller(el, actions) {
  if (refreshingPoller?.el === el) {
    refreshingPoller.attempts = 0;
    refreshingPoller.remainingMs = null;
    refreshingPoller.actions = actions;
    scheduleRefreshingPoll(refreshingPoller);
  }
  actions.onRetry();
}

function throneTooltip(data) {
  if (data?.refreshingTerminal) return t('forja.refreshing.terminal', 'No pudimos forjar tu ficha todavía. Reintentá.');
  if (data?.refreshing) return t('forja.refreshing.tooltip', 'Estamos forjando tu ficha con el nuevo usuario de GitHub');
  if (data?.configured === false) return t('forja.collapsed.tooltip.unconfigured', 'Forjá tu ficha y entrá a la arena');
  const throne = data?.mission?.throne || {};
  if (throne.id === 'defend-throne' && throne.targetDisplayName) {
    return t('forja.collapsed.tooltip.leader', 'El Ojo te observa… 👑 Seguís en el trono — {name} a {gap}', {
      name: throne.targetDisplayName, gap: throne.gap || 0,
    });
  }
  if (throne.id === 'defend-throne') return t('forja.collapsed.tooltip.alone', 'El Ojo te observa… 👑 Seguís en el trono — sin retadores');
  if (throne.id === 'reach-throne') {
    return t('forja.collapsed.tooltip.challenger', 'El Ojo te observa… ⚔️ Estás a {gap} del trono', { gap: throne.gap || 0 });
  }
  return t('forja.collapsed.tooltip.configured', 'El Ojo te observa… tu ficha arde en la arena');
}

function collapsedVisual(data) {
  if (!data) {
    return {
      visual: node('span', 'cwc-spinner fj-collapsed-loading'),
      mode: 'loading',
      chip: t('forja.collapsed.loading', 'Calentando…'),
    };
  }
  if (data?.refreshingTerminal) {
    return {
      visual: node('span', 'fj-collapsed-lock', '!'),
      mode: 'refreshing-terminal',
      chip: t('forja.refreshing.terminalShort', 'No pudimos forjarla'),
    };
  }
  if (data?.refreshing) {
    return {
      visual: node('span', 'cwc-spinner fj-collapsed-loading'),
      mode: 'refreshing',
      chip: t('forja.refreshing.short', 'Forjando tu ficha…'),
    };
  }
  if (data?.configured === false) {
    const visual = node('span', 'fj-collapsed-lock');
    const image = document.createElement('img');
    image.src = '/img/forja/candado.svg';
    image.alt = '';
    visual.appendChild(image);
    return { visual, mode: 'invite', chip: t('forja.collapsed.waiting', 'Tu ficha te espera') };
  }
  const visual = node('span', 'fj-collapsed-forge');
  const anvil = document.createElement('img');
  anvil.src = '/img/forja/yunque-mini.svg';
  anvil.alt = '';
  visual.append(anvil, node('i', 'fj-collapsed-hammer'), node('i', 'fj-collapsed-sparks'));
  return {
    visual,
    mode: 'hammer',
    chip: `${levelCode(data?.level)} · ${Number(data?.season?.count ?? data?.seasonCount) || 0}🔥`,
  };
}

function header(el, state, actions, panelId) {
  const open = Boolean(state.open);
  const data = state.data;
  const collapsed = collapsedVisual(data);
  const tooltipText = throneTooltip(data);
  const tooltipId = 'fj-sidebar-tooltip';
  const head = node('header', `sec-head fj-head${open ? ' fj-head--open' : ''}`);
  const toggle = node('button', `fj-head-main fj-head--toggle${open ? '' : ` fj-collapsed-row fj-collapsed-row--${collapsed.mode}`}`);
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-controls', panelId);
  toggle.setAttribute('aria-describedby', tooltipId);
  toggle.setAttribute('aria-label', open
    ? t('forja.toggle.close', 'Ocultar La Forja')
    : t('forja.toggle.open', 'Mostrar La Forja'));
  const chevron = node('span', 'btn-ghost btn--sm btn--icon fj-toggle');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = icon(open ? 'chevronDown' : 'chevronRight', { size: 13 });
  const brand = node('span', 'sec-title fj-head-title');
  const ember = node('span', 'fj-head-ember');
  ember.setAttribute('aria-hidden', 'true');
  brand.append(ember, document.createTextNode(t('forja.title', 'La Forja')));
  toggle.append(chevron, brand);
  if (!open) {
    collapsed.visual.setAttribute('aria-hidden', 'true');
    const chip = node('span', 'fj-collapsed-chip', collapsed.chip);
    toggle.append(collapsed.visual, chip);
  }
  const help = node('span');
  help.innerHTML = helpBtn('forja');
  const tooltip = node('span', 'fj-head-tooltip', tooltipText);
  tooltip.id = tooltipId;
  tooltip.setAttribute('role', 'tooltip');
  head.append(toggle, help.firstElementChild, tooltip);
  toggle.addEventListener('click', () => actions.onToggle(!open));
  el.appendChild(head);
  return tooltipText;
}

function renderLoading(el) {
  const box = node('div', 'cwc-loading fj-loading');
  box.append(node('span', 'cwc-spinner'), document.createTextNode(t('forja.loading', 'Calentando la fragua…')));
  el.appendChild(box);
}

function renderConfigured(el, data, onOpen) {
  const card = node('div', 'fj-ficha');
  const player = node('div', 'fj-ficha-player');
  const emblemWrap = node('div', 'fj-emblem-wrap');
  const emblem = document.createElement('img');
  emblem.className = 'fj-emblem';
  emblem.src = '/img/forja/yunque.svg';
  emblem.alt = t('forja.emblemAlt', 'Yunque y martillo con un anillo al rojo vivo');
  emblemWrap.append(emblem, node('span', 'fj-level-tag', levelCode(data.level)));

  const copy = node('div', 'fj-ficha-copy');
  copy.append(
    node('div', 'fj-kicker', t('forja.ficha.active', 'Personaje activo')),
    node('div', 'fj-character-name', levelName(data.level)),
  );
  const chips = node('div', 'fj-ficha-chips');
  const unlocked = (data.medals || []).filter((medal) => medal.unlocked).length;
  chips.append(
    node('span', 'fj-chip', t('forja.ficha.rank', 'Corona #{rank}', { rank: data.rank || '—' })),
    node('span', 'fj-chip', t('forja.ficha.medals', '{unlocked}/{total} trofeos', { unlocked, total: (data.medals || []).length })),
    node('span', 'fj-chip', t('forja.ficha.season', '{count} temporada', { count: data.season?.count ?? data.seasonCount ?? 0 })),
  );
  copy.appendChild(chips);
  player.append(emblemWrap, copy);

  const progress = data.level?.nextLevelProgress || { cur: data.total || 0, max: data.total || 1 };
  const xp = node('div', 'fj-xp-block');
  const xpLabel = node('div', 'fj-xp-label');
  xpLabel.append(node('span', '', t('forja.ficha.xp', 'XP')), node('strong', '', `${progress.cur}/${progress.max}`));
  const track = node('div', 'fj-xp');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuenow', String(progress.cur));
  track.setAttribute('aria-valuemax', String(progress.max));
  const totalFill = percent(progress.cur, progress.max) / 10;
  for (let index = 0; index < 10; index += 1) {
    const segment = node('i');
    segment.style.setProperty('--fj-fill', `${Math.max(0, Math.min(1, totalFill - index)) * 100}%`);
    track.appendChild(segment);
  }
  xp.append(xpLabel, track);

  const enter = node('button', 'btn fj-enter', t('forja.ficha.enter', 'Entrar a la Forja'));
  enter.type = 'button';
  enter.setAttribute('aria-label', t('forja.ficha.openAria', 'Abrir La Forja'));
  enter.addEventListener('click', onOpen);
  card.append(player, xp, enter);
  if (data.stale) card.appendChild(node('div', 'fj-stale', staleLabel(data)));
  el.appendChild(card);
}

function renderUnconfigured(el, data, onConfigure) {
  const card = node('div', 'fj-ficha fj-ficha--empty');
  const emblem = document.createElement('img');
  emblem.className = 'fj-emblem fj-emblem--empty';
  emblem.src = '/img/forja/yunque.svg';
  emblem.alt = '';
  const copy = node('div', 'fj-empty-copy');
  copy.append(
    node('strong', '', t('forja.configure.title', 'Forjá tu ficha')),
    node('span', '', data?.invalidLogin
      ? t('forja.configure.invalidExisting', 'Tu usuario de GitHub no es válido, corregilo.')
      : t('forja.configure.hint', 'Vinculá tu usuario de GitHub y convertí tus merges en historia.')),
  );
  const button = node('button', 'btn fj-enter', t('forja.configure.action', 'Forjar mi ficha'));
  button.type = 'button';
  button.addEventListener('click', onConfigure);
  card.append(emblem, copy, button);
  el.appendChild(card);
}

function renderRefreshing(el) {
  const box = node('div', 'cwc-loading fj-loading');
  box.append(
    node('span', 'cwc-spinner'),
    document.createTextNode(t('forja.refreshing.title', 'Forjando tu ficha…')),
  );
  box.appendChild(node('span', '', t(
    'forja.refreshing.detail',
    'Estamos trayendo tu historia con el nuevo usuario de GitHub.',
  )));
  el.appendChild(box);
}

function renderRefreshingTerminal(el, onRetry) {
  const box = node('div', 'fj-error');
  box.appendChild(node('span', '', t(
    'forja.refreshing.terminal',
    'No pudimos forjar tu ficha todavía. Reintentá.',
  )));
  const retry = node('button', 'btn-ghost btn--sm', t('forja.refreshing.retry', 'Reintentar'));
  retry.type = 'button';
  retry.addEventListener('click', onRetry);
  box.appendChild(retry);
  el.appendChild(box);
}

function renderError(el, error, onRetry) {
  const box = node('div', 'fj-error');
  box.append(
    node('strong', '', t('forja.error.title', 'La fragua se enfrió')),
    node('span', '', error?.message || t('forja.error.load', 'No pudimos cargar tu ficha.')),
  );
  const retry = node('button', 'btn-ghost btn--sm', t('forja.error.retry', 'Reintentar'));
  retry.type = 'button';
  retry.addEventListener('click', onRetry);
  box.appendChild(retry);
  el.appendChild(box);
}

export function renderFicha(el, state, actions) {
  const poller = state.data?.refreshing ? ensureRefreshingPoller(el, actions) : null;
  if (!state.data?.refreshing) stopRefreshingPoller(el);
  const refreshingTerminal = Boolean(
    poller && poller.attempts >= REFRESHING_POLL_MAX_ATTEMPTS,
  );
  const renderState = refreshingTerminal
    ? { ...state, data: { ...state.data, refreshingTerminal: true } }
    : state;
  el.textContent = '';
  const panelId = 'fj-sidebar-panel';
  const context = header(el, renderState, actions, panelId);
  const panel = node('div', 'fj-sidebar-panel');
  panel.id = panelId;
  panel.hidden = !renderState.open;
  el.appendChild(panel);
  if (!renderState.open) return;
  panel.appendChild(node('p', 'fj-expanded-context', context));
  if (renderState.loading) renderLoading(panel);
  else if (renderState.error) renderError(panel, renderState.error, actions.onRetry);
  else if (refreshingTerminal) {
    renderRefreshingTerminal(panel, () => restartRefreshingPoller(el, actions));
  }
  else if (renderState.data?.refreshing) {
    renderRefreshing(panel);
  }
  else if (renderState.data?.configured === false) renderUnconfigured(panel, renderState.data, actions.onConfigure);
  else renderConfigured(panel, renderState.data || {}, actions.onOpen);
}
