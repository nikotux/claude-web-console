import { t } from '../../ui/i18n.js';
import {
  formatSeason, levelCode, levelName, node, percent, staleLabel,
} from './view.js';

function podiumPlayer(player, rank, arena) {
  const card = node('article', `fj-podium-player fj-podium-player--${rank}${player.isMe ? ' fj-podium-player--me' : ''}`);
  const mvp = arena.mvp && arena.mvp.displayName === player.displayName && arena.mvp.initials === player.initials;
  if (mvp) card.appendChild(node('span', 'fj-mvp', t('forja.arena.mvp', 'MVP del día · +{count}', { count: arena.mvp.count })));
  const avatar = node('div', 'fj-arena-avatar', player.initials || '—');
  avatar.appendChild(node('span', 'fj-arena-level', levelCode(player.level)));
  if (player.isMe) avatar.appendChild(node('span', 'fj-you', t('forja.arena.you', 'Tú')));
  card.append(
    avatar,
    node('strong', 'fj-player-name', player.displayName || t('forja.arena.unknownPlayer', 'Jugador')),
    node('span', 'fj-player-title', levelName(player.level)),
    node('b', 'fj-season-score', t('forja.arena.rings', '{count} anillos', { count: player.seasonCount || 0 })),
    node('span', 'fj-total-score', t('forja.arena.totalRings', '{count} anillos totales', { count: player.total || 0 })),
    node('span', 'fj-mini-stats', t('forja.arena.playerStats', 'Racha {streak} · Hoy +{today}', { streak: player.currentStreak || 0, today: player.todayCount || 0 })),
  );
  const gap = (arena.gaps || []).find((item) => item.toRank === rank);
  if (gap) card.appendChild(node('span', 'fj-gap', rank === 2
    ? t('forja.arena.behindThrone', '{count} detrás del trono', { count: gap.value })
    : t('forja.arena.behindPrevious', '{count} detrás del puesto anterior', { count: gap.value })));
  card.appendChild(node('div', 'fj-pedestal', rank));
  return card;
}

function renderPodium(arena) {
  const section = node('section', 'fj-arena-stage');
  const eye = node('div', 'fj-eye');
  eye.setAttribute('aria-hidden', 'true');
  eye.append(node('span'), node('i'));
  section.appendChild(eye);
  const grid = node('div', 'fj-podium-grid');
  const byRank = new Map((arena.players || []).map((player) => [Number(player.rank), player]));
  const podiumSize = Math.min(3, byRank.size);
  if (podiumSize) grid.classList.add(`fj-podium-grid--${podiumSize}`);
  for (const rank of [2, 1, 3]) {
    const player = byRank.get(rank);
    if (player) grid.appendChild(podiumPlayer(player, rank, arena));
  }
  if (!grid.children.length) grid.appendChild(node('p', 'fj-empty', t('forja.arena.empty', 'La arena todavía espera a sus primeros jugadores.')));
  section.appendChild(grid);
  return section;
}

function characterPanel(me, privateData) {
  const panel = node('article', 'fj-game-panel');
  const head = node('div', 'fj-game-head');
  head.append(node('h2', '', t('forja.arena.characterTitle', 'Tu personaje')), node('span', '', t('forja.arena.activePlayer', 'Jugador activo')));
  panel.appendChild(head);
  if (!me) {
    panel.appendChild(node('p', 'fj-empty', t('forja.arena.notRanked', 'Tu personaje todavía no aparece en esta temporada.')));
    return panel;
  }
  const main = node('div', 'fj-character-main');
  const avatar = node('div', 'fj-character-avatar', me.initials || '—');
  const copy = node('div');
  copy.append(
    node('strong', 'fj-character-level', `${levelCode(me.level)} · ${levelName(me.level)}`),
    node('span', 'fj-character-handle', me.displayName || privateData.displayName || ''),
  );
  const progress = privateData.level?.nextLevelProgress || { cur: privateData.total || 0, max: privateData.total || 1, remaining: 0 };
  copy.appendChild(node('p', '', t('forja.arena.levelProgress', '{cur}/{max} anillos hacia el próximo nivel', { cur: progress.cur, max: progress.max })));
  const label = node('div', 'fj-bar-label');
  label.append(node('span', '', t('forja.arena.forgeFire', 'Fuego de la Forja')), node('span', '', `${Math.round(percent(progress.cur, progress.max))}%`));
  const track = node('div', 'fj-arena-xp');
  const fill = node('i');
  fill.style.width = `${percent(progress.cur, progress.max)}%`;
  track.appendChild(fill);
  copy.append(label, track);
  main.append(avatar, copy);
  panel.appendChild(main);
  const stats = node('div', 'fj-stats-grid');
  const unlocked = (privateData.medals || []).filter((medal) => medal.unlocked).length;
  const values = [
    [t('forja.arena.stat.streak', 'Racha'), t('forja.arena.stat.days', '{count} días', { count: me.currentStreak || 0 })],
    [t('forja.arena.stat.today', 'Hoy'), `+${me.todayCount || 0}`],
    [t('forja.arena.stat.medals', 'Trofeos'), `${unlocked}/${(privateData.medals || []).length}`],
    [t('forja.arena.stat.rank', 'Puesto'), `#${me.rank || '—'}`],
  ];
  values.forEach(([labelText, value]) => {
    const item = node('div');
    item.append(node('span', '', labelText), node('strong', '', value));
    stats.appendChild(item);
  });
  panel.appendChild(stats);
  return panel;
}

function missionCard(title, copy, tone, progress = null) {
  const card = node('article', `fj-mission fj-mission--${tone}`);
  card.append(node('strong', '', title), node('p', '', copy));
  if (progress) {
    const track = node('div', 'fj-mission-track');
    const fill = node('i');
    fill.style.width = `${percent(progress.cur, progress.max)}%`;
    track.appendChild(fill);
    card.appendChild(track);
  }
  return card;
}

function missionsPanel(arena) {
  const missions = arena.missions || {};
  const panel = node('article', 'fj-game-panel');
  const head = node('div', 'fj-game-head');
  head.append(node('h2', '', t('forja.arena.missionsTitle', 'Misiones')), node('span', '', t('forja.arena.activeMissions', 'Activas')));
  panel.appendChild(head);
  const list = node('div', 'fj-missions');
  if (missions.throne) {
    const defend = missions.throne.id === 'defend-throne';
    const hasRival = Boolean(missions.throne.targetDisplayName || missions.throne.targetRank);
    const gap = Number(missions.throne.gap) || 0;
    let title;
    if (!hasRival) {
      title = t('forja.arena.mission.noChallengers', 'Defendé el trono: todavía no hay retadores');
    } else if (gap === 0) {
      title = t('forja.arena.mission.tiedThrone', 'Empate en el trono');
    } else {
      title = defend
        ? t('forja.arena.mission.defend', 'Defendé el trono: {name} está a {gap}', { name: missions.throne.targetDisplayName || t('forja.arena.rival', 'tu rival'), gap })
        : t('forja.arena.mission.reach', 'Alcanzá el trono: {name} está a {gap}', { name: missions.throne.targetDisplayName || t('forja.arena.rival', 'tu rival'), gap });
    }
    list.appendChild(missionCard(title, defend ? t('forja.arena.mission.defendCopy', 'Que nadie arrebate el sitial de obsidiana.') : t('forja.arena.mission.reachCopy', 'Cada merge acorta la distancia.'), 'throne'));
  }
  if (arena.mvp) {
    list.appendChild(missionCard(
      t('forja.arena.mission.mvp', '{name} sumó +{count} hoy', { name: arena.mvp.displayName || t('forja.arena.rival', 'Un rival'), count: arena.mvp.count || 0 }),
      t('forja.arena.mission.mvpCopy', 'Las minas retumban con cada merge.'),
      'surge',
    ));
  }
  if (missions.boss) {
    list.appendChild(missionCard(
      t('forja.arena.mission.boss', 'Misión de jefe: próximo hito'),
      t('forja.arena.mission.bossCopy', '{cur}/{max} totales · faltan {remaining}.', { cur: missions.boss.cur || 0, max: missions.boss.max || 0, remaining: missions.boss.remaining || 0 }),
      'boss', missions.boss,
    ));
  }
  if (!list.children.length) list.appendChild(node('p', 'fj-empty', t('forja.arena.noMissions', 'Las próximas misiones se están templando.')));
  panel.appendChild(list);
  return panel;
}

function levelsLegend(currentLevel) {
  const section = node('section', 'fj-levels');
  section.appendChild(node('h2', '', t('forja.arena.levelsTitle', 'Jerarquía de Mordor · anillos históricos')));
  const grid = node('div');
  const ranges = [[0, 24], [25, 49], [50, 99], [100, 249], [250, 499], [500, 999], [1000, null]];
  ranges.forEach(([min, max], index) => {
    const level = { id: `nv${index + 1}`, number: index + 1 };
    const card = node('article', currentLevel?.id === level.id ? 'fj-level-current' : '');
    card.append(
      node('strong', '', `${levelCode(level)}${currentLevel?.id === level.id ? ` · ${t('forja.arena.you', 'Tú')}` : ''}`),
      node('span', '', levelName(level)),
      node('small', '', max === null ? `${min}+` : `${min}–${max}`),
    );
    grid.appendChild(card);
  });
  section.appendChild(grid);
  return section;
}

export function renderArena(root, arena, privateData) {
  root.textContent = '';
  const panel = node('div', 'fj-arena');
  const banner = node('header', 'fj-season-banner');
  const copy = node('div');
  copy.append(
    node('span', 'fj-season-eyebrow', t('forja.arena.season', 'Temporada {season} · termina en {days} días', { season: formatSeason(arena.season), days: arena.season?.daysLeft ?? '—' })),
    node('h1', '', t('forja.arena.title', 'La Forja del Monte del Destino')),
    node('p', '', t('forja.arena.subtitle', 'Donde cada merge alimenta el fuego de Orodruin.')),
  );
  const rule = node('span', 'fj-season-rule', t('forja.arena.rule', '1 PR mergeado = 1 anillo forjado'));
  banner.append(copy, rule);
  panel.append(banner, node('div', 'fj-arena-heading', t('forja.arena.podiumTitle', 'Los tres de la Tierra Oscura')), renderPodium(arena));
  const below = node('section', 'fj-below-grid');
  const me = (arena.players || []).find((player) => player.isMe);
  below.append(characterPanel(me, privateData), missionsPanel(arena));
  panel.append(below, levelsLegend(privateData.level));
  if (arena.stale) panel.appendChild(node('p', 'fj-panel-stale', staleLabel(arena)));
  panel.appendChild(node('footer', 'fj-footer', t('forja.arena.footer', 'Las brasas cuentan cuando el PR llega a merge.')));
  root.appendChild(panel);
}
