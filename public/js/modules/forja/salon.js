import { t } from '../../ui/i18n.js';
import {
  formatDate, iconNode, medalText, node, percent, safeExternalUrl, staleLabel,
} from './view.js';

function heading(title, aside = '') {
  const head = node('div', 'fj-section-head');
  head.appendChild(node('h2', 'fj-section-title', title));
  if (aside) head.appendChild(node('span', 'fj-section-aside', aside));
  return head;
}

function impactCard(label, value, unit, detail) {
  const card = node('article', 'fj-impact-card');
  card.append(node('span', 'fj-impact-label', label));
  const total = node('strong', 'fj-impact-value', value);
  total.appendChild(node('small', '', unit));
  card.append(total, node('p', '', detail));
  return card;
}

function renderHero(data, icon) {
  const hero = node('section', 'fj-salon-hero');
  const scene = node('div', 'fj-forge-scene');
  const copy = node('div', 'fj-forge-copy');
  copy.append(
    node('h2', '', t('forja.salon.forgeTitle', 'La Forja')),
    node('p', '', t('forja.salon.forgeCopy', 'Cada anillo guarda una mejora que dejaste en Tolkien.')),
  );
  const anvil = document.createElement('img');
  anvil.src = '/img/forja/forja.svg';
  anvil.alt = t('forja.salon.anvilAlt', 'Un martillo forja un anillo brillante sobre un yunque');
  anvil.className = 'fj-anvil';
  const sparks = node('span', 'fj-sparks');
  sparks.setAttribute('aria-hidden', 'true');
  scene.append(copy, anvil, sparks);

  const vault = node('div', 'fj-progress-vault');
  const progress = data.level?.milestoneProgress || { cur: data.total || 0, max: 100, remaining: 0 };
  const ring = node('div', 'fj-ring-progress');
  ring.style.setProperty('--fj-progress', `${percent(progress.cur, progress.max)}%`);
  ring.setAttribute('role', 'progressbar');
  ring.setAttribute('aria-valuenow', String(progress.cur));
  ring.setAttribute('aria-valuemax', String(progress.max));
  ring.append(
    node('strong', '', data.total || 0),
    node('span', '', t('forja.salon.forgedRings', 'anillos forjados')),
  );
  const nextMilestone = node('small', 'fj-ring-next', progress.remaining
    ? t('forja.salon.toMilestone', '{count} para el próximo hito', { count: progress.remaining })
    : t('forja.salon.maxMilestone', 'Leyenda máxima'));
  vault.append(iconNode(icon, 'flame', 18), ring, nextMilestone);
  hero.append(scene, vault);
  return hero;
}

function renderImpact(data) {
  const section = node('section', 'fj-section');
  section.appendChild(heading(t('forja.salon.impactTitle', 'Tu impacto')));
  const grid = node('div', 'fj-impact-grid');
  const impact = data.impact || data;
  grid.append(
    impactCard(t('forja.salon.impact.desk.label', 'Desk'), impact.deskTickets || 0, t('forja.salon.impact.desk.unit', 'tickets resueltos'), t('forja.salon.impact.desk.detail', 'personas que tuvieron una respuesta')),
    impactCard(t('forja.salon.impact.plan.label', 'Plan'), impact.tasks || 0, t('forja.salon.impact.plan.unit', 'tareas entregadas'), t('forja.salon.impact.plan.detail', 'tareas que ayudaron a mover el plan')),
    impactCard(t('forja.salon.impact.journey.label', 'Tu recorrido'), impact.daysForging || 0, t('forja.salon.impact.journey.unit', 'días forjando'), data.firstMerge?.date ? t('forja.salon.impact.journey.since', 'desde el {date}', { date: formatDate(data.firstMerge.date, { long: true }) }) : t('forja.salon.impact.journey.empty', 'todavía sin anillos')),
    impactCard(t('forja.salon.impact.tolkien.label', 'Tolkien'), impact.total || data.total || 0, t('forja.salon.impact.tolkien.unit', 'mejoras'), t('forja.salon.impact.tolkien.detail', 'cambios que ya son parte del producto')),
  );
  section.appendChild(grid);
  return section;
}

function renderChronicle(data, icon) {
  const section = node('section', 'fj-section');
  section.appendChild(heading(t('forja.salon.chronicleTitle', 'Tu crónica')));
  const path = node('div', 'fj-chronicle');
  for (const item of data.chronicle || []) {
    const milestone = node('article', `fj-milestone${item.achieved ? '' : ' fj-milestone--future'}`);
    const rune = node('span', 'fj-rune');
    rune.setAttribute('aria-hidden', 'true');
    rune.appendChild(iconNode(icon, item.achieved ? 'flame' : 'sparkle', 17));
    milestone.appendChild(rune);
    if (item.achieved) {
      milestone.append(
        node('span', 'fj-milestone-date', formatDate(item.date)),
        node('strong', '', item.milestone === 1
          ? t('forja.salon.firstRing', 'Primer anillo')
          : t('forja.salon.ringNumber', 'Anillo nº {count}', { count: item.milestone })),
        node('span', 'fj-milestone-pr', `#${item.number}`),
        node('p', '', item.title || ''),
      );
    } else {
      milestone.append(
        node('span', 'fj-milestone-date', t('forja.salon.nextMilestone', 'Próximo hito')),
        node('strong', '', t('forja.salon.ringNumber', 'Anillo nº {count}', { count: item.milestone })),
        node('span', 'fj-milestone-pr', t('forja.salon.remaining', 'faltan {count}', { count: item.remaining })),
        node('p', '', item.label || ''),
      );
    }
    path.appendChild(milestone);
  }
  if (!path.children.length) path.appendChild(node('p', 'fj-empty', t('forja.salon.emptyChronicle', 'Tu primer hito aparecerá con el próximo merge.')));
  section.appendChild(path);
  return section;
}

function medalCard(medal, icon) {
  const card = node('article', `fj-medal${medal.unlocked ? '' : ' fj-medal--locked'}`);
  const head = node('div', 'fj-medal-head');
  const medalIcon = iconNode(icon, {
    'alas-nazgul': 'ghost',
    erupcion: 'flame',
    troll: 'trophy',
    legion: 'swords',
    trono: 'trophy',
    centenario: 'flame',
    vigilia: 'eye',
    daga: 'swords',
  }[medal.id] || 'trophy', 20);
  medalIcon.classList.add('fj-medal-icon');
  head.append(
    medalIcon,
    node('strong', 'fj-medal-name', medalText(medal, 'name')),
  );
  if (!medal.unlocked) head.appendChild(iconNode(icon, 'lock', 13));
  head.appendChild(node('span', 'fj-medal-state', medal.unlocked ? t('forja.salon.forged', 'Forjada') : t('forja.salon.toForge', 'Por forjar')));
  const description = node('p', 'fj-medal-copy', medalText(medal, 'desc'));
  description.appendChild(node('span', 'fj-medal-detail', medal.detail || ''));
  card.append(head, description);
  if (!medal.unlocked) {
    const progress = node('div', 'fj-ash-progress');
    const track = node('span');
    const fill = node('i');
    const value = percent(medal.progress?.cur, medal.progress?.max);
    fill.style.width = `${value}%`;
    track.appendChild(fill);
    progress.append(track, node('b', '', `${Math.round(value)}%`));
    card.appendChild(progress);
  }
  return card;
}

function medalGroup(label, medals, icon) {
  const group = node('div', 'fj-medal-group');
  group.appendChild(node('h3', 'fj-medal-group-title', `${label} · ${medals.length}`));
  const grid = node('div', 'fj-medal-grid');
  medals.forEach((medal) => grid.appendChild(medalCard(medal, icon)));
  group.appendChild(grid);
  return group;
}

function renderTrophies(data, icon) {
  const section = node('section', 'fj-section');
  section.appendChild(heading(t('forja.salon.trophiesTitle', 'Vitrina de trofeos'), t('forja.salon.trophiesAside', 'Hitos de tu recorrido')));
  const medals = Array.isArray(data.medals) ? data.medals : [];
  const unlocked = medals.filter((medal) => medal.unlocked);
  const locked = medals.filter((medal) => !medal.unlocked);
  if (unlocked.length) section.appendChild(medalGroup(t('forja.salon.unlockedGroup', 'Forjadas'), unlocked, icon));
  if (locked.length) section.appendChild(medalGroup(t('forja.salon.lockedGroup', 'Por forjar'), locked, icon));
  if (!medals.length) section.appendChild(node('p', 'fj-empty', t('forja.salon.emptyTrophies', 'Los trofeos aparecerán a medida que avance tu historia.')));
  return section;
}

function recentCard(pr, index) {
  const card = node('article', `fj-recent${index === 0 ? ' fj-recent--newest' : ''}`);
  card.appendChild(node('span', 'fj-recent-number', `#${pr.number}`));
  const copy = node('div', 'fj-recent-copy');
  const href = safeExternalUrl(pr.url);
  const title = href ? node('a', '', pr.title || '') : node('strong', '', pr.title || '');
  if (href) {
    title.href = href;
    title.target = '_blank';
    title.rel = 'noopener';
  }
  const meta = node('p');
  meta.append(
    node('span', 'fj-plus', `+${Number(pr.additions) || 0}`),
    document.createTextNode(' / '),
    node('span', 'fj-minus', `−${Number(pr.deletions) || 0}`),
    document.createTextNode(` · ${t('forja.salon.minutes', '{count} min', { count: Number(pr.minutesOpen) || 0 })}`),
  );
  copy.append(title, meta);
  card.append(copy, node('span', 'fj-merged', t('forja.salon.merged', 'Mergeado')));
  return card;
}

function renderRecent(data) {
  const section = node('section', 'fj-section');
  section.appendChild(heading(t('forja.salon.recentTitle', 'Anillos recién forjados'), t('forja.salon.recentAside', 'Más nuevos primero')));
  const list = node('div', 'fj-recent-list');
  (data.recent || []).forEach((pr, index) => list.appendChild(recentCard(pr, index)));
  if (!list.children.length) list.appendChild(node('p', 'fj-empty', t('forja.salon.emptyRecent', 'Todavía no hay anillos recientes.')));
  section.appendChild(list);
  return section;
}

export function renderSalon(root, data, { icon }) {
  root.textContent = '';
  const panel = node('div', 'fj-salon');
  const intro = node('header', 'fj-intro');
  const title = node('div');
  title.append(node('h1', '', t('forja.salon.title', 'Tu Forja')), node('p', '', t('forja.salon.subtitle', 'Tu recorrido personal en las entrañas de Orodruin')));
  const privacy = node('span', 'fj-privacy');
  privacy.append(iconNode(icon, 'lock', 13), document.createTextNode(t('forja.salon.private', 'Solo vos ves esto')));
  intro.append(title, privacy);
  panel.append(intro, renderHero(data, icon), renderImpact(data), renderChronicle(data, icon), renderTrophies(data, icon), renderRecent(data));
  if (data.stale) panel.appendChild(node('p', 'fj-panel-stale', staleLabel(data.dataAsOf ?? data.generatedAt)));
  panel.appendChild(node('footer', 'fj-footer', t('forja.salon.footer', '1 PR mergeado = 1 anillo forjado · tu recorrido es privado')));
  root.appendChild(panel);
}
