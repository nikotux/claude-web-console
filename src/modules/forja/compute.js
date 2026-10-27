// Cálculo puro de La Forja. No lee disco, red ni configuración del proceso.
export const FORJA_TIMEZONE = 'America/Bogota';
export const CHRONICLE_MILESTONES = [1, 10, 25, 50, 75, 100, 150, 200, 300, 500, 1000];
export const LEVELS = [
  { id: 'nv1', number: 1, code: 'NV1', title: 'Orco de la mina', min: 0, max: 24 },
  { id: 'nv2', number: 2, code: 'NV2', title: 'Uruk-hai', min: 25, max: 49 },
  { id: 'nv3', number: 3, code: 'NV3', title: 'Capitán de Minas Morgul', min: 50, max: 99 },
  { id: 'nv4', number: 4, code: 'NV4', title: 'Nazgûl', min: 100, max: 249 },
  { id: 'nv5', number: 5, code: 'NV5', title: 'Boca de Sauron', min: 250, max: 499 },
  { id: 'nv6', number: 6, code: 'NV6', title: 'Señor de Barad-dûr', min: 500, max: 999 },
  { id: 'nv7', number: 7, code: 'NV7', title: 'El Ojo que Todo lo Ve', min: 1000, max: null },
];

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function zonedParts(date, timeZone = FORJA_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((out, part) => {
    if (part.type !== 'literal') out[part.type] = part.value;
    return out;
  }, {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

export function dateKey(date, timeZone = FORJA_TIMEZONE) {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function monthKey(date, timeZone = FORJA_TIMEZONE) {
  const { year, month } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function utcDayFromKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addCalendarDays(key, amount) {
  const value = utcDayFromKey(key);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function isBusinessDay(key) {
  const weekday = utcDayFromKey(key).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function previousBusinessDay(key) {
  let cursor = addCalendarDays(key, -1);
  while (!isBusinessDay(cursor)) cursor = addCalendarDays(cursor, -1);
  return cursor;
}

function nextBusinessDay(key) {
  let cursor = addCalendarDays(key, 1);
  while (!isBusinessDay(cursor)) cursor = addCalendarDays(cursor, 1);
  return cursor;
}

function shortDate(key) {
  const [year, month, day] = key.split('-').map(Number);
  return `${day} ${MONTHS[month - 1].slice(0, 3)} ${year}`;
}

export function normalizePr(pr, player, attributedFrom = 'author') {
  const number = Number(pr?.number);
  const mergedAt = typeof pr?.mergedAt === 'string' ? pr.mergedAt : null;
  if (!Number.isSafeInteger(number) || !mergedAt || Number.isNaN(Date.parse(mergedAt))) return null;
  return {
    number,
    title: String(pr?.title || ''),
    mergedAt,
    createdAt: typeof pr?.createdAt === 'string' && !Number.isNaN(Date.parse(pr.createdAt)) ? pr.createdAt : mergedAt,
    additions: Math.max(0, Number(pr?.additions) || 0),
    deletions: Math.max(0, Number(pr?.deletions) || 0),
    headRefName: String(pr?.headRefName || ''),
    url: typeof pr?.url === 'string' ? pr.url : null,
    playerLogin: player.login,
    attributedFrom,
  };
}

export function levelFor(total) {
  const count = Math.max(0, Number(total) || 0);
  const base = LEVELS.find((level) => level.max === null || count <= level.max) || LEVELS.at(-1);
  const next = LEVELS[base.number] || null;
  return {
    ...base,
    isMax: !next,
    nextLevelProgress: next
      ? { cur: Math.max(0, count - base.min), max: next.min - base.min, target: next.min, levelId: next.id, label: next.title }
      : { cur: count, max: count, target: count, levelId: null, label: 'MAX' },
    milestoneProgress: {
      id: count < 100 ? 'centenario' : (next?.id || 'max'),
      cur: count,
      max: count < 100 ? 100 : (next?.min ?? count),
      remaining: Math.max(0, (count < 100 ? 100 : (next?.min ?? count)) - count),
      label: count < 100 ? 'El Anillo Centenario' : (next?.title || 'MAX'),
    },
  };
}

function countsBy(prs, keyer) {
  const counts = new Map();
  for (const pr of prs) {
    const key = keyer(pr);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function bestBusinessStreak(prs, timeZone) {
  const days = [...new Set(prs.map((pr) => dateKey(new Date(pr.mergedAt), timeZone)).filter(isBusinessDay))].sort();
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of days) {
    run = previous && nextBusinessDay(previous) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  return best;
}

function currentBusinessStreak(prs, timeZone, today) {
  const days = new Set(prs.map((pr) => dateKey(new Date(pr.mergedAt), timeZone)));
  let cursor = isBusinessDay(today) ? today : previousBusinessDay(today);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = previousBusinessDay(cursor);
  }
  return streak;
}

export function deskNumbers(title) {
  return [...String(title).matchAll(/Desk\s*#?(\d+)/gi)].map((match) => Number(match[1]));
}

export function taskNumbers(title) {
  return [...String(title).matchAll(/TASK-(\d+)/g)].map((match) => Number(match[1]));
}

function formatDecimal(value) {
  return new Intl.NumberFormat('es-AR', {
    maximumFractionDigits: 1, minimumFractionDigits: value % 1 ? 1 : 0,
  }).format(value);
}

export function computeMedals(prs, { timeZone, currentMonthKey, rank, monthLabel }) {
  const dayCounts = countsBy(prs, (pr) => dateKey(new Date(pr.mergedAt), timeZone));
  const monthCounts = countsBy(prs, (pr) => monthKey(new Date(pr.mergedAt), timeZone));
  const fast = [...prs].map((pr) => ({
    pr, minutes: Math.max(0, (new Date(pr.mergedAt) - new Date(pr.createdAt)) / 60000),
  })).sort((a, b) => a.minutes - b.minutes)[0];
  const eruptionDays = [...dayCounts].filter(([, count]) => count >= 10).sort(([a], [b]) => a.localeCompare(b));
  const biggest = [...prs].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))[0];
  const bestMonth = [...monthCounts].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0] || [currentMonthKey, 0];
  const smallMonthCounts = countsBy(prs.filter((pr) => pr.additions + pr.deletions < 50), (pr) => monthKey(new Date(pr.mergedAt), timeZone));
  const bestSmallMonth = [...smallMonthCounts].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0] || [currentMonthKey, 0];
  const bestDay = Math.max(0, ...dayCounts.values());
  const bestStreak = bestBusinessStreak(prs, timeZone);
  const specs = [
    { id: 'alas-nazgul', name: 'Alas del Nazgûl', desc: 'PR mergeado en menos de 10 minutos', icon: '🦇', unlocked: Boolean(fast && fast.minutes < 10), detail: fast ? `#${fast.pr.number} · ${formatDecimal(fast.minutes)} min` : 'Todavía sin anillos', progress: { cur: fast ? Math.max(0, Math.min(10, 10 - fast.minutes)) : 0, max: 10 } },
    { id: 'erupcion', name: 'Erupción de Orodruin', desc: '10 o más PRs mergeados en un día', icon: '🌋', unlocked: eruptionDays.length > 0, detail: eruptionDays.length ? `×${eruptionDays.length} · ${eruptionDays.map(([day]) => shortDate(day)).join(', ')}` : `${bestDay}/10 en el mejor día`, progress: { cur: Math.min(bestDay, 10), max: 10 } },
    { id: 'troll', name: 'Troll de las cavernas', desc: 'PR con 2.000 o más líneas cambiadas', icon: '🧌', unlocked: Boolean(biggest && biggest.additions + biggest.deletions >= 2000), detail: biggest ? `#${biggest.number} (+${biggest.additions}/−${biggest.deletions})` : '0/2.000 líneas', progress: { cur: Math.min(biggest ? biggest.additions + biggest.deletions : 0, 2000), max: 2000 } },
    { id: 'legion', name: 'Legión de Mordor', desc: '50 PRs mergeados en un mes', icon: '⚔️', unlocked: bestMonth[1] >= 50, detail: `${bestMonth[1]} en ${MONTHS[Number(bestMonth[0].slice(5)) - 1]} de ${bestMonth[0].slice(0, 4)}`, progress: { cur: Math.min(bestMonth[1], 50), max: 50 } },
    { id: 'trono', name: 'Trono de obsidiana', desc: 'Líder de la temporada actual', icon: '👑', unlocked: rank === 1, detail: rank === 1 ? `#1 en ${monthLabel} (por ahora)` : `Puesto #${rank} en ${monthLabel}`, progress: { cur: rank === 1 ? 1 : 0, max: 1 } },
    { id: 'centenario', name: 'El Anillo Centenario', desc: '100 PRs mergeados en total', icon: '💍', unlocked: prs.length >= 100, detail: `${prs.length}/100 anillos`, progress: { cur: Math.min(prs.length, 100), max: 100 } },
    { id: 'vigilia', name: 'Vigilia del Ojo', desc: '10 días hábiles seguidos con merge', icon: '👁️', unlocked: bestStreak >= 10, detail: `${bestStreak}/10 días hábiles`, progress: { cur: Math.min(bestStreak, 10), max: 10 } },
    { id: 'daga', name: 'Daga de Morgul', desc: '10 PRs de menos de 50 líneas en un mes', icon: '🗡️', unlocked: bestSmallMonth[1] >= 10, detail: `${bestSmallMonth[1]} en ${MONTHS[Number(bestSmallMonth[0].slice(5)) - 1]} de ${bestSmallMonth[0].slice(0, 4)}`, progress: { cur: Math.min(bestSmallMonth[1], 10), max: 10 } },
  ];
  return specs.sort((a, b) => Number(b.unlocked) - Number(a.unlocked)
    || (b.progress.cur / b.progress.max) - (a.progress.cur / a.progress.max));
}

function daysForging(firstKey, today) {
  return Math.max(0, Math.round((utcDayFromKey(today) - utcDayFromKey(firstKey)) / 86400000));
}

function daysLeftInMonth(parts) {
  return Math.max(0, new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate() - parts.day);
}

function playerBase(player, prs, currentMonthKey, today, timeZone) {
  const seasonPrs = prs.filter((pr) => monthKey(new Date(pr.mergedAt), timeZone) === currentMonthKey);
  return {
    ...player,
    total: prs.length,
    level: levelFor(prs.length),
    seasonCount: seasonPrs.length,
    todayCount: prs.filter((pr) => dateKey(new Date(pr.mergedAt), timeZone) === today).length,
    currentStreak: currentBusinessStreak(prs, timeZone, today),
    prs,
  };
}

function buildMe(player, context) {
  const { timeZone, currentMonthKey, monthLabel, today, generatedAt, stale, error } = context;
  const first = player.prs[0] || null;
  const deskTickets = new Set(player.prs.flatMap((pr) => deskNumbers(pr.title))).size;
  const tasks = new Set(player.prs.flatMap((pr) => taskNumbers(pr.title))).size;
  const days = first ? daysForging(dateKey(new Date(first.mergedAt), timeZone), today) : 0;
  const recent = [...player.prs].reverse().slice(0, 4).map((pr) => ({
    number: pr.number, title: pr.title, additions: pr.additions, deletions: pr.deletions,
    minutesOpen: Math.max(0, Math.round((new Date(pr.mergedAt) - new Date(pr.createdAt)) / 60000)),
    desk: deskNumbers(pr.title)[0] || null, mergedAt: pr.mergedAt, url: pr.url,
  }));
  const chronicle = CHRONICLE_MILESTONES.filter((value) => value <= player.prs.length).map((value) => {
    const pr = player.prs[value - 1];
    return { milestone: value, achieved: true, date: dateKey(new Date(pr.mergedAt), timeZone), number: pr.number, title: pr.title };
  });
  const pending = CHRONICLE_MILESTONES.find((value) => value > player.prs.length);
  if (pending) chronicle.push({ milestone: pending, achieved: false, remaining: pending - player.prs.length, label: pending === 100 ? 'El Anillo Centenario' : `Anillo nº ${pending}` });
  return {
    configured: true,
    generatedAt,
    stale: Boolean(stale),
    ...(error ? { lastError: String(error).slice(0, 300) } : {}),
    timezone: timeZone,
    today,
    username: player.username,
    login: player.login,
    displayName: player.displayName,
    initials: player.initials,
    total: player.total,
    impact: { deskTickets, tasks, daysForging: days, total: player.total },
    deskTickets,
    tasks,
    daysForging: days,
    firstMerge: first ? { date: dateKey(new Date(first.mergedAt), timeZone), number: first.number, title: first.title } : null,
    season: { key: currentMonthKey, count: player.seasonCount },
    seasonCount: player.seasonCount,
    recent,
    level: player.level,
    chronicle,
    medals: computeMedals(player.prs, { timeZone, currentMonthKey, rank: player.rank, monthLabel }),
    rank: player.rank,
    currentStreak: player.currentStreak,
    todayCount: player.todayCount,
    prs: player.prs,
  };
}

export function computeForja(players, prsByUsername, {
  now = new Date(),
  timeZone = FORJA_TIMEZONE,
  staleByUsername = new Map(),
  errorByUsername = new Map(),
} = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  const generatedAt = instant.toISOString();
  const today = dateKey(instant, timeZone);
  const parts = zonedParts(instant, timeZone);
  const currentMonthKey = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
  const monthLabel = MONTHS[parts.month - 1];
  const ranked = players.map((player) => {
    const prs = [...(prsByUsername.get(player.username) || [])]
      .filter((pr) => pr?.mergedAt && !Number.isNaN(Date.parse(pr.mergedAt)))
      .sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt) || a.number - b.number);
    return playerBase(player, prs, currentMonthKey, today, timeZone);
  }).sort((a, b) => b.seasonCount - a.seasonCount || b.total - a.total
    || a.displayName.localeCompare(b.displayName, 'es'))
    .map((player, index) => ({ ...player, rank: index + 1 }));

  const snapshots = new Map(ranked.map((player) => [player.username, buildMe(player, {
    timeZone, currentMonthKey, monthLabel, today, generatedAt,
    stale: staleByUsername.get(player.username), error: errorByUsername.get(player.username),
  })]));
  const publicPlayers = ranked.map((player) => ({
    displayName: player.displayName,
    initials: player.initials,
    seasonCount: player.seasonCount,
    total: player.total,
    level: { id: player.level.id, number: player.level.number },
    currentStreak: player.currentStreak,
    todayCount: player.todayCount,
    rank: player.rank,
  }));
  const gaps = publicPlayers.slice(0, 2).map((player, index) => {
    const next = publicPlayers[index + 1];
    return next ? { fromRank: player.rank, toRank: next.rank, value: Math.max(0, player.seasonCount - next.seasonCount) } : null;
  }).filter(Boolean);
  const mvp = [...publicPlayers].sort((a, b) => b.todayCount - a.todayCount || a.rank - b.rank)[0];
  const missionsByOwner = Object.fromEntries(ranked.map((player) => {
    const leader = ranked[0];
    const runnerUp = ranked[1];
    const target = player.rank === 1 ? runnerUp : leader;
    const progress = player.level.milestoneProgress;
    return [player.username, {
      throne: {
        id: player.rank === 1 ? 'defend-throne' : 'reach-throne',
        targetDisplayName: target?.displayName || null,
        targetRank: target?.rank || null,
        gap: target ? Math.abs(player.seasonCount - target.seasonCount) : 0,
      },
      boss: { id: 'next-milestone', cur: player.total, max: progress.max, remaining: progress.remaining },
    }];
  }));
  for (const [owner, mission] of Object.entries(missionsByOwner)) {
    snapshots.set(owner, { ...snapshots.get(owner), mission });
  }
  const arena = {
    generatedAt,
    stale: ranked.some((player) => Boolean(staleByUsername.get(player.username))),
    season: {
      key: currentMonthKey,
      month: monthLabel,
      year: parts.year,
      label: `${monthLabel[0].toUpperCase()}${monthLabel.slice(1)} ${parts.year}`,
      daysLeft: daysLeftInMonth(parts),
    },
    players: publicPlayers,
    gaps,
    mvp: mvp && mvp.todayCount > 0
      ? { displayName: mvp.displayName, initials: mvp.initials, count: mvp.todayCount }
      : null,
  };
  return { snapshots, arena };
}
