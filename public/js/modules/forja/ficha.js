import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { icon } from '../../ui/icons.js';
import { levelCode, levelName, node, percent, staleLabel } from './view.js';

function throneTooltip(data) {
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
  const pending = Math.max(0, Number(data?.pendingFestejos) || 0);
  if (data?.configured === false) {
    const visual = node('span', 'fj-collapsed-lock');
    const image = document.createElement('img');
    image.src = '/img/forja/candado.svg';
    image.alt = '';
    visual.appendChild(image);
    return { visual, mode: 'invite', chip: t('forja.collapsed.waiting', 'Tu ficha te espera') };
  }
  if (pending) {
    return {
      visual: node('span', 'fj-collapsed-ring'),
      mode: 'pending',
      chip: t('forja.collapsed.pending', '+{count} {label}', {
        count: pending,
        label: pending === 1 ? t('forja.collapsed.ring.one', 'anillo') : t('forja.collapsed.ring.many', 'anillos'),
      }),
    };
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

function header(el, state, actions) {
  const open = Boolean(state.open);
  const data = state.data;
  const collapsed = collapsedVisual(data);
  const head = node('header', `sec-head fj-head fj-head--toggle${open ? ' fj-head--open' : ` fj-collapsed-row fj-collapsed-row--${collapsed.mode}`}`);
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', String(open));
  head.title = throneTooltip(data);
  const toggle = node('button', 'btn-ghost btn--sm btn--icon fj-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', open
    ? t('forja.toggle.close', 'Ocultar La Forja')
    : t('forja.toggle.open', 'Mostrar La Forja'));
  toggle.innerHTML = icon(open ? 'chevronDown' : 'chevronRight', { size: 13 });
  const brand = node('span', 'sec-title fj-head-title');
  const ember = node('span', 'fj-head-ember');
  ember.setAttribute('aria-hidden', 'true');
  brand.append(ember, document.createTextNode(t('forja.title', 'La Forja')));
  head.append(toggle, brand);
  if (!open) {
    collapsed.visual.setAttribute('aria-hidden', 'true');
    const chip = node('span', `fj-collapsed-chip${collapsed.mode === 'pending' ? ' fj-collapsed-chip--pending' : ''}`, collapsed.chip);
    head.append(collapsed.visual, chip);
    if (collapsed.mode === 'pending' && !state.pendingNoticed) head.classList.add('fj-collapsed-row--alert');
  }
  const help = node('span');
  help.innerHTML = helpBtn('forja');
  head.appendChild(help.firstElementChild);
  const toggleOpen = () => actions.onToggle(!open);
  head.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-help]')) return;
    toggleOpen();
  });
  head.addEventListener('keydown', (event) => {
    if (event.target !== head || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    toggleOpen();
  });
  el.appendChild(head);
}

function renderLoading(el) {
  const box = node('div', 'cwc-loading fj-loading');
  box.append(node('span', 'cwc-spinner'), document.createTextNode(t('forja.loading', 'Calentando la fragua…')));
  el.appendChild(box);
}

function renderConfigured(el, data, onOpen) {
  const card = node('div', 'fj-ficha');
  const pending = Math.max(0, Number(data.pendingFestejos) || 0);
  if (pending) {
    const badge = node('span', 'fj-chip fj-festejo-badge', `+${pending}`);
    badge.setAttribute('aria-label', t('forja.festejo.pendingBadge', '{count} festejos pendientes', { count: pending }));
    card.appendChild(badge);
  }

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
  el.textContent = '';
  header(el, state, actions);
  if (!state.open) return;
  if (state.loading) renderLoading(el);
  else if (state.error) renderError(el, state.error, actions.onRetry);
  else if (state.data?.configured === false) renderUnconfigured(el, state.data, actions.onConfigure);
  else renderConfigured(el, state.data || {}, actions.onOpen);
}
