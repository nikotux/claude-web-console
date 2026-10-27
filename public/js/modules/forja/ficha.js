import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { levelCode, levelName, node, percent, staleLabel } from './view.js';

function header(el) {
  const head = node('header', 'sec-head fj-head');
  const brand = node('span', 'sec-title fj-head-title');
  const ember = node('span', 'fj-head-ember');
  ember.setAttribute('aria-hidden', 'true');
  brand.append(ember, document.createTextNode(t('forja.title', 'La Forja')));
  head.appendChild(brand);
  const help = node('span');
  help.innerHTML = helpBtn('forja');
  head.appendChild(help.firstElementChild);
  el.appendChild(head);
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
  if (data.stale) card.appendChild(node('div', 'fj-stale', staleLabel(data.generatedAt)));
  el.appendChild(card);
}

function renderUnconfigured(el, onConfigure) {
  const card = node('div', 'fj-ficha fj-ficha--empty');
  const emblem = document.createElement('img');
  emblem.className = 'fj-emblem fj-emblem--empty';
  emblem.src = '/img/forja/yunque.svg';
  emblem.alt = '';
  const copy = node('div', 'fj-empty-copy');
  copy.append(
    node('strong', '', t('forja.configure.title', 'Forjá tu ficha')),
    node('span', '', t('forja.configure.hint', 'Vinculá tu usuario de GitHub y convertí tus merges en historia.')),
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
  header(el);
  if (state.loading) renderLoading(el);
  else if (state.error) renderError(el, state.error, actions.onRetry);
  else if (state.data?.configured === false) renderUnconfigured(el, actions.onConfigure);
  else renderConfigured(el, state.data || {}, actions.onOpen);
}
