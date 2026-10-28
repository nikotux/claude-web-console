import {
  githubUserExists, listCommitsBetween, listMergedPrsByAuthor, listProductionDeploys,
} from '../comms/pr-read-shared.js';
import {
  computeForja, deskNumbers, FORJA_TIMEZONE, monthKey, normalizePr, playerIdFor,
} from './compute.js';
import {
  ATTRIBUTED_BOT_AUTHOR, playerForBranch, playerForUsername, resolvePlayers,
} from './players.js';
import {
  getBotPrs, getFestejos, getMeSnapshot, loadFromDisk, saveArenaSnapshot, saveBotPrs,
  saveFestejos, saveGithubProfile, saveMeSnapshot,
  snapshotAgeMs,
} from './store.js';

const REFRESH_MS = Number(process.env.FORJA_REFRESH_MS) || 3 * 60 * 1000;
const MANUAL_RATE_LIMIT_MS = 60 * 1000;
const FULL_FETCH_LIMIT = 1000;
const INCREMENTAL_FETCH_LIMIT = 50;
const FETCH_CONCURRENCY = 3;
const FESTEJOS_MAX_PENDING = 10;
const DEPLOY_HISTORY_LIMIT = 20;
const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

let timer = null;
let queueTail = Promise.resolve();
let fullCycle = null;
const ownerCycles = new Map();
let fetchMergedPrsByAuthor = listMergedPrsByAuthor;
let fetchProductionDeploys = listProductionDeploys;
let fetchCommitsBetween = listCommitsBetween;
let fetchGithubProfile = githubUserExists;

function sameLogin(left, right) {
  return typeof left === 'string' && left.toLowerCase() === String(right || '').toLowerCase();
}

function storedState(player) {
  const snapshot = getMeSnapshot(player.username);
  const loginMatches = sameLogin(snapshot?.login, player.login);
  const storedPrs = Array.isArray(snapshot?.prs) ? snapshot.prs : [];
  const prs = loginMatches ? storedPrs : [];
  const hasAuthorHistory = prs.some((pr) => pr?.attributedFrom !== ATTRIBUTED_BOT_AUTHOR);
  return { snapshot, loginMatches, storedPrs, prs, hasAuthorHistory };
}

async function fetchAuthor(author, limit) {
  const prs = await fetchMergedPrsByAuthor(author, { limit });
  return { prs, stale: prs._stale === true };
}

function compactBotPr(raw) {
  const number = Number(raw?.number);
  const mergedAt = typeof raw?.mergedAt === 'string' ? raw.mergedAt : null;
  if (!Number.isSafeInteger(number) || !mergedAt || Number.isNaN(Date.parse(mergedAt))) return null;
  return {
    number,
    title: String(raw?.title || ''),
    mergedAt,
    createdAt: typeof raw?.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
      ? raw.createdAt : mergedAt,
    additions: Math.max(0, Number(raw?.additions) || 0),
    deletions: Math.max(0, Number(raw?.deletions) || 0),
    headRefName: String(raw?.headRefName || ''),
    url: typeof raw?.url === 'string' ? raw.url : null,
    mergeCommitOid: typeof raw?.mergeCommitOid === 'string'
      ? raw.mergeCommitOid
      : (typeof raw?.mergeCommit?.oid === 'string' ? raw.mergeCommit.oid : null),
    headRefOid: typeof raw?.headRefOid === 'string' ? raw.headRefOid : null,
  };
}

function unionBotPrs(previous, fetched) {
  const merged = new Map();
  for (const raw of [...previous, ...fetched]) {
    const pr = compactBotPr(raw);
    if (pr) merged.set(pr.number, pr);
  }
  return [...merged.values()];
}

function mergePlayerPrs(player, previous, direct, botPrs, players) {
  const merged = new Map();
  const add = (raw, source) => {
    const normalized = normalizePr(raw, player, source);
    if (normalized) merged.set(normalized.number, normalized);
  };

  for (const pr of previous) add(pr, pr?.attributedFrom || 'author');
  if (direct.ok) direct.value.prs.forEach((pr) => add(pr, 'author'));
  for (const pr of botPrs) {
    if (playerForBranch(pr.headRefName, players)?.username === player.username) {
      add(pr, ATTRIBUTED_BOT_AUTHOR);
    }
  }
  return [...merged.values()];
}

async function settledFetch(author, limit) {
  try { return { ok: true, value: await fetchAuthor(author, limit) }; }
  catch (error) { return { ok: false, error }; }
}

async function runFetchPool(tasks, concurrency = FETCH_CONCURRENCY) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  };
  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export function __nextDataAsOfForTests(previous, direct, bot, attemptedAt) {
  return direct.ok && !direct.value.stale && bot.ok && !bot.value.stale
    ? attemptedAt
    : previous;
}

export function __runFetchPoolForTests(tasks) {
  return runFetchPool(tasks);
}

function throneFor(player, arena) {
  const ranked = [...(arena?.players || [])].sort((a, b) => a.rank - b.rank);
  const mine = ranked.find((item) => item.playerId === player.playerId);
  const leader = ranked[0] || null;
  if (!mine || !leader) return { status: 'unknown', gap: 0 };
  if (mine.rank === 1) {
    const rival = ranked[1] || null;
    return rival
      ? { status: 'leader', rivalDisplayName: rival.displayName, gap: Math.max(0, mine.seasonCount - rival.seasonCount) }
      : { status: 'leader-alone', gap: 0 };
  }
  return {
    status: 'challenger',
    leaderDisplayName: leader.displayName,
    gap: Math.max(0, leader.seasonCount - mine.seasonCount),
  };
}

function ringOfMonth(pr, prs) {
  const key = monthKey(new Date(pr.mergedAt), FORJA_TIMEZONE);
  return prs.filter((candidate) => (
    monthKey(new Date(candidate.mergedAt), FORJA_TIMEZONE) === key
      && (new Date(candidate.mergedAt) < new Date(pr.mergedAt)
        || (candidate.mergedAt === pr.mergedAt && candidate.number <= pr.number))
  )).length;
}

function buildFestejo(player, pr, prs, arena) {
  const month = monthKey(new Date(pr.mergedAt), FORJA_TIMEZONE);
  const monthNumber = Number(month.slice(5));
  return {
    id: `merge:${pr.number}`,
    kind: 'merge',
    number: pr.number,
    title: pr.title,
    url: pr.url,
    deskTicket: deskNumbers(pr.title)[0] || null,
    durationMin: Math.max(0, Math.round((new Date(pr.mergedAt) - new Date(pr.createdAt)) / 60000)),
    additions: pr.additions,
    deletions: pr.deletions,
    ringOfMonth: ringOfMonth(pr, prs),
    monthLabel: MONTHS[monthNumber - 1] || '',
    throne: throneFor({ ...player, playerId: playerIdFor(player.username) }, arena),
    mergedAt: pr.mergedAt,
    celebrationName: player.celebrationName || null,
  };
}

function nextMergeFestejoState(state, player, prs, arena, now) {
  const numbers = prs.map((pr) => pr.number);
  if (!state || !sameLogin(state.login, player.login)) {
    return {
      login: player.login,
      initializedAt: now,
      celebrated: numbers,
      deployed: numbers,
      deployCelebrated: [],
      lastDeployProcessed: null,
      pending: [],
    };
  }

  const celebrated = new Set(state.celebrated);
  const unseen = prs.filter((pr) => !celebrated.has(pr.number));
  for (const pr of unseen) celebrated.add(pr.number);
  return {
    ...state,
    celebrated: [...celebrated],
    // Un festejos.json anterior a producción se siembra con todo lo actual:
    // nunca convierte el historial de merges en una avalancha retroactiva.
    deployed: state.deployed === null ? numbers : state.deployed,
    pending: [
      ...state.pending,
      ...unseen.map((pr) => buildFestejo(player, pr, prs, arena)),
    ].slice(-FESTEJOS_MAX_PENDING),
  };
}

function recordMergeFestejos(player, prs, arena, now) {
  saveFestejos(player.username, nextMergeFestejoState(
    getFestejos(player.username), player, prs, arena, now,
  ));
}

export function __nextMergeFestejoStateForTests(state, player, prs, arena, now) {
  return nextMergeFestejoState(state, player, prs, arena, now);
}

function buildDeployFestejo(player, prs, deploy) {
  const completedAt = deploy.completedAt || new Date().toISOString();
  const items = prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    mergedAt: pr.mergedAt,
    durationMin: Math.max(0, Math.round((new Date(completedAt) - new Date(pr.mergedAt)) / 60000)),
  }));
  return {
    id: `deploy:${deploy.deployedSha}`,
    kind: 'deploy',
    deploySha: deploy.deployedSha,
    completedAt,
    celebrationName: player.celebrationName || null,
    numbers: items.map((item) => item.number),
    prs: items,
  };
}

async function detectDeployFestejos({
  players,
  prsByUsername,
  statesByUsername,
  deploys,
  commitsBetween = fetchCommitsBetween,
}) {
  const orderedDeploys = Array.isArray(deploys) ? deploys : [];
  const nextStates = new Map();
  const work = [];
  const neededDeployIndexes = new Set();
  const newestDeploy = orderedDeploys[0];
  if (!newestDeploy) return { states: nextStates, compareCalls: 0 };

  for (const player of players) {
    const state = statesByUsername.get(player.username);
    if (!state || state.deployed === null) continue;
    const prs = [...(prsByUsername.get(player.username) || [])];
    const cursor = typeof state.lastDeployProcessed === 'string' ? state.lastDeployProcessed : '';
    const cursorIndex = cursor
      ? orderedDeploys.findIndex((deploy) => deploy.deployedSha === cursor)
      : -1;
    if (!cursor || cursorIndex === -1) {
      nextStates.set(player.username, {
        ...state,
        deployed: [...new Set(prs.map((pr) => pr.number).filter(Number.isSafeInteger))],
        lastDeployProcessed: newestDeploy.deployedSha,
      });
      continue;
    }
    const deployIndexes = [];
    for (let index = cursorIndex - 1; index >= 0; index -= 1) {
      deployIndexes.push(index);
      neededDeployIndexes.add(index);
    }
    if (deployIndexes.length) work.push({ player, state, prs, deployIndexes });
  }

  // Se resuelven todos los deltas antes de construir estados. Si un compare
  // falla, la promesa rechaza y ningún cursor de jugador avanza.
  const commitsByDeployIndex = new Map();
  const chronologicalIndexes = [...neededDeployIndexes].sort((a, b) => b - a);
  for (const index of chronologicalIndexes) {
    const deploy = orderedDeploys[index];
    const previousDeploy = orderedDeploys[index + 1];
    if (!previousDeploy) throw new Error(`Falta el deploy previo a ${deploy.deployedSha}`);
    const commits = await commitsBetween(previousDeploy.deployedSha, deploy.deployedSha);
    commitsByDeployIndex.set(index, new Set(Array.isArray(commits) ? commits : []));
  }

  for (const { player, state, prs, deployIndexes } of work) {
    const deployed = new Set(state.deployed);
    const celebratedDeploys = new Set(state.deployCelebrated || []);
    const pending = [...state.pending];
    let lastDeployProcessed = state.lastDeployProcessed;
    for (const index of deployIndexes) {
      const deploy = orderedDeploys[index];
      const included = new Set([...(commitsByDeployIndex.get(index) || [])]
        .map((sha) => String(sha).toLowerCase()));
      const landed = prs.filter((pr) => {
        if (deployed.has(pr.number)) return false;
        return (typeof pr.mergeCommitOid === 'string' && included.has(pr.mergeCommitOid.toLowerCase()))
          || (typeof pr.headRefOid === 'string' && included.has(pr.headRefOid.toLowerCase()));
      });
      for (const pr of landed) deployed.add(pr.number);
      if (landed.length && !celebratedDeploys.has(deploy.deployedSha)) {
        pending.push(buildDeployFestejo(player, landed, deploy));
      }
      celebratedDeploys.add(deploy.deployedSha);
      lastDeployProcessed = deploy.deployedSha;
    }
    nextStates.set(player.username, {
      ...state,
      deployed: [...deployed],
      deployCelebrated: [...celebratedDeploys],
      lastDeployProcessed,
      pending: pending.slice(-FESTEJOS_MAX_PENDING),
    });
  }
  return { states: nextStates, compareCalls: commitsByDeployIndex.size };
}

export async function __detectDeployFestejosForTests(options) {
  return detectDeployFestejos(options);
}

async function runCycle({ onlyOwner = null } = {}) {
  let players = resolvePlayers();
  const missingProfiles = players.filter((player) => player.needsGithubName);
  if (missingProfiles.length) {
    const profiles = await runFetchPool(missingProfiles.map((player) => async () => {
      try { return { player, profile: await fetchGithubProfile(player.login) }; }
      catch { return null; }
    }));
    for (const result of profiles) {
      if (result?.profile?.exists) {
        saveGithubProfile(result.player.username, {
          login: result.profile.canonicalLogin || result.player.login,
          name: result.profile.name || '',
        });
      }
    }
    players = resolvePlayers();
  }
  loadFromDisk(players.map((player) => player.username));
  const target = onlyOwner ? playerForUsername(onlyOwner, players) : null;
  if (onlyOwner && !target) return null;
  if (!players.length) {
    const computed = computeForja([], new Map());
    saveArenaSnapshot(computed.arena);
    return computed;
  }

  const requested = target ? [target] : players;
  const states = new Map(requested.map((player) => [player.username, storedState(player)]));
  const snapshotBotPrs = players.flatMap((player) => {
    const prs = getMeSnapshot(player.username)?.prs;
    return Array.isArray(prs)
      ? prs.filter((pr) => pr?.attributedFrom === ATTRIBUTED_BOT_AUTHOR)
      : [];
  });
  const previousBotPrs = unionBotPrs(getBotPrs(), snapshotBotPrs);
  const botLimit = previousBotPrs.length ? INCREMENTAL_FETCH_LIMIT : FULL_FETCH_LIMIT;
  const attemptedAt = new Date().toISOString();
  const [bot, ...directResults] = await runFetchPool([
    () => settledFetch(ATTRIBUTED_BOT_AUTHOR, botLimit),
    ...requested.map((player) => () => settledFetch(
      player.login,
      states.get(player.username).hasAuthorHistory ? INCREMENTAL_FETCH_LIMIT : FULL_FETCH_LIMIT,
    )),
  ]);
  const directByOwner = new Map(requested.map((player, index) => [player.username, directResults[index]]));
  const botPrs = bot.ok ? unionBotPrs(previousBotPrs, bot.value.prs) : previousBotPrs;
  saveBotPrs(botPrs);

  const prsByUsername = new Map();
  const staleByUsername = new Map();
  const errorByUsername = new Map();
  const fetchedAtByUsername = new Map();
  const dataAsOfByUsername = new Map();
  const lastAttemptAtByUsername = new Map();

  for (const player of players) {
    const direct = directByOwner.get(player.username);
    const state = direct ? states.get(player.username) : storedState(player);
    if (!direct) {
      prsByUsername.set(player.username, state.storedPrs);
      staleByUsername.set(player.username, Boolean(state.snapshot?.stale));
      if (state.snapshot?.lastError) errorByUsername.set(player.username, state.snapshot.lastError);
      if (state.snapshot?.fetchedAt) fetchedAtByUsername.set(player.username, state.snapshot.fetchedAt);
      if (state.snapshot?.dataAsOf) dataAsOfByUsername.set(player.username, state.snapshot.dataAsOf);
      if (state.snapshot?.lastAttemptAt) lastAttemptAtByUsername.set(player.username, state.snapshot.lastAttemptAt);
      continue;
    }

    prsByUsername.set(player.username, mergePlayerPrs(player, state.prs, direct, botPrs, players));
    const stale = !direct.ok || direct.value.stale || !bot.ok || bot.value.stale;
    staleByUsername.set(player.username, stale);
    const error = !direct.ok ? direct.error : (!bot.ok ? bot.error : null);
    if (error) errorByUsername.set(player.username, error?.message || error);
    const previousFetchedAt = state.loginMatches ? state.snapshot?.fetchedAt : null;
    const nextFetchedAt = direct.ok && !direct.value.stale ? attemptedAt : previousFetchedAt;
    if (nextFetchedAt) fetchedAtByUsername.set(player.username, nextFetchedAt);
    const previousDataAsOf = state.loginMatches ? state.snapshot?.dataAsOf : null;
    const nextDataAsOf = __nextDataAsOfForTests(previousDataAsOf, direct, bot, attemptedAt);
    if (nextDataAsOf) dataAsOfByUsername.set(player.username, nextDataAsOf);
    lastAttemptAtByUsername.set(player.username, attemptedAt);
  }

  const computed = computeForja(players, prsByUsername, {
    staleByUsername, errorByUsername, fetchedAtByUsername, dataAsOfByUsername,
    lastAttemptAtByUsername,
  });
  for (const player of requested) {
    const direct = directByOwner.get(player.username);
    if (!direct?.ok || direct.value.stale || !bot.ok || bot.value.stale) continue;
    const prs = computed.snapshots.get(player.username)?.prs || [];
    recordMergeFestejos(player, prs, computed.arena, attemptedAt);
  }

  // Producción es un segundo paso del mismo ciclo serializado. Solo corre con
  // las lecturas directa+bot frescas y con un listado de deploys también fresco.
  const freshPlayers = requested.filter((player) => {
    const direct = directByOwner.get(player.username);
    return direct?.ok && !direct.value.stale && bot.ok && !bot.value.stale;
  });
  if (freshPlayers.length) {
    try {
      const deploys = await fetchProductionDeploys({ limit: DEPLOY_HISTORY_LIMIT });
      if (deploys[0] && deploys._stale !== true) {
        const statesByUsername = new Map(freshPlayers.map((player) => [player.username, getFestejos(player.username)]));
        const deployStep = await detectDeployFestejos({
          players: freshPlayers,
          prsByUsername,
          statesByUsername,
          deploys,
        });
        for (const [owner, state] of deployStep.states) saveFestejos(owner, state);
      }
    } catch (error) {
      console.warn('[forja] no se pudieron leer los deploys de producción:', error?.message || error);
    }
  }
  for (const player of players) {
    const snapshot = computed.snapshots.get(player.username);
    const previousLogin = directByOwner.has(player.username) ? null : getMeSnapshot(player.username)?.login;
    saveMeSnapshot(player.username, previousLogin ? { ...snapshot, login: previousLogin } : snapshot);
  }
  saveArenaSnapshot(computed.arena);
  return target ? computed.snapshots.get(target.username) : computed;
}

function enqueueCycle(task) {
  const promise = queueTail.then(task, task);
  queueTail = promise.catch(() => null);
  return promise;
}

export function refreshNow() {
  if (fullCycle) return fullCycle;
  const promise = enqueueCycle(() => runCycle())
    .catch((error) => {
      console.error('[forja] no se pudo refrescar:', error?.message || error);
      return null;
    });
  fullCycle = promise;
  void promise.finally(() => {
    if (fullCycle === promise) fullCycle = null;
  });
  return promise;
}

export function refreshOwner(owner, { rateLimitMs = MANUAL_RATE_LIMIT_MS } = {}) {
  if (fullCycle) {
    return fullCycle.then(() => ({ ignored: true, snapshot: getMeSnapshot(owner) }));
  }
  if (snapshotAgeMs(owner) < rateLimitMs) {
    return Promise.resolve({ ignored: true, snapshot: getMeSnapshot(owner) });
  }
  if (ownerCycles.has(owner)) return ownerCycles.get(owner);
  const promise = enqueueCycle(() => runCycle({ onlyOwner: owner }))
    .then((snapshot) => ({ ignored: false, snapshot }))
    .catch((error) => {
      console.error(`[forja] no se pudo refrescar ${owner}:`, error?.message || error);
      return { ignored: false, snapshot: getMeSnapshot(owner), error: String(error?.message || error).slice(0, 300) };
    });
  ownerCycles.set(owner, promise);
  void promise.finally(() => {
    if (ownerCycles.get(owner) === promise) ownerCycles.delete(owner);
  });
  return promise;
}

export function startRefresher() {
  if (timer) return;
  void refreshNow();
  timer = setInterval(refreshNow, REFRESH_MS);
  timer.unref?.();
  console.log(`[forja] refresher activo cada ${Math.round(REFRESH_MS / 1000)}s`);
}

export function __setFetchForTests(fn) {
  fetchMergedPrsByAuthor = typeof fn === 'function' ? fn : listMergedPrsByAuthor;
}

export function __setProductionReadersForTests({ deploys, commits, profile } = {}) {
  fetchProductionDeploys = typeof deploys === 'function' ? deploys : listProductionDeploys;
  fetchCommitsBetween = typeof commits === 'function' ? commits : listCommitsBetween;
  fetchGithubProfile = typeof profile === 'function' ? profile : githubUserExists;
}
