import {
  getCurrentProductionSha, githubUserExists, listCommitsBetween, listMergedPrsByAuthor,
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
const STALE_PROFILE_RETRY_MS = 15 * 60 * 1000;
const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

let timer = null;
let queueTail = Promise.resolve();
let fullCycle = null;
const ownerCycles = new Map();
const profileRetryAfterByOwner = new Map();
let fetchMergedPrsByAuthor = listMergedPrsByAuthor;
let fetchCurrentProduction = getCurrentProductionSha;
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

async function fetchAuthor(author, limit, { fresh = false } = {}) {
  const prs = await fetchMergedPrsByAuthor(author, { limit, fresh });
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

async function settledFetch(author, limit, options) {
  try { return { ok: true, value: await fetchAuthor(author, limit, options) }; }
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

function githubProfileResultAction(profile, now = Date.now()) {
  if (profile?._stale === true) {
    return { save: false, retryAt: now + STALE_PROFILE_RETRY_MS };
  }
  return { save: Boolean(profile?.exists), retryAt: null };
}

export function __githubProfileResultActionForTests(profile, now) {
  return githubProfileResultAction(profile, now);
}

function githubProfileRetryDue(player, now) {
  const retry = profileRetryAfterByOwner.get(player.username);
  return !retry || !sameLogin(retry.login, player.login) || now >= retry.at;
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
      prodSha: null,
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

function buildDeployFestejo(player, prs, production) {
  const completedAt = production.completedAt || new Date().toISOString();
  const items = prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    mergedAt: pr.mergedAt,
    durationMin: Math.max(0, Math.round((new Date(completedAt) - new Date(pr.mergedAt)) / 60000)),
  }));
  return {
    id: `deploy:${production.sha}`,
    kind: 'deploy',
    deploySha: production.sha,
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
  production,
  commitsBetween = fetchCommitsBetween,
}) {
  const nextStates = new Map();
  const work = [];
  const currentSha = typeof production?.sha === 'string' ? production.sha : '';
  if (!currentSha) return { states: nextStates, compareCalls: 0 };

  for (const player of players) {
    const state = statesByUsername.get(player.username);
    if (!state) continue;
    const prs = [...(prsByUsername.get(player.username) || [])];
    const previousSha = typeof state.prodSha === 'string' ? state.prodSha : '';
    if (!previousSha) {
      nextStates.set(player.username, {
        ...state,
        deployed: [...new Set(prs.map((pr) => pr.number).filter(Number.isSafeInteger))],
        prodSha: currentSha,
      });
      continue;
    }
    if (previousSha !== currentSha) work.push({ player, state, prs, previousSha });
  }

  // Todos los jugadores normalmente comparten el mismo par. Se resuelven los
  // compares antes de construir estados: cualquier fallo deja todo sin mutar.
  const commitsByPair = new Map();
  for (const { previousSha } of work) {
    const pair = `${previousSha}:${currentSha}`;
    if (commitsByPair.has(pair)) continue;
    const commits = await commitsBetween(previousSha, currentSha);
    commitsByPair.set(pair, new Set((Array.isArray(commits) ? commits : [])
      .map((sha) => String(sha).toLowerCase())));
  }

  for (const { player, state, prs, previousSha } of work) {
    const deployed = new Set(Array.isArray(state.deployed) ? state.deployed : []);
    const included = commitsByPair.get(`${previousSha}:${currentSha}`) || new Set();
    const landed = prs.filter((pr) => {
      if (deployed.has(pr.number)) return false;
      return (typeof pr.mergeCommitOid === 'string' && included.has(pr.mergeCommitOid.toLowerCase()))
        || (typeof pr.headRefOid === 'string' && included.has(pr.headRefOid.toLowerCase()));
    });
    for (const pr of landed) deployed.add(pr.number);
    const pending = [...state.pending];
    if (landed.length) pending.push(buildDeployFestejo(player, landed, production));
    nextStates.set(player.username, {
      ...state,
      deployed: [...deployed],
      prodSha: currentSha,
      pending: pending.slice(-FESTEJOS_MAX_PENDING),
    });
  }
  return { states: nextStates, compareCalls: commitsByPair.size };
}

export async function __detectDeployFestejosForTests(options) {
  return detectDeployFestejos(options);
}

async function refreshDeployPrs({
  players,
  allPlayers,
  prsByUsername,
  statesByUsername,
  storedByUsername,
  previousBotPrs,
  botLimit,
  production,
}) {
  const currentSha = typeof production?.sha === 'string' ? production.sha : '';
  const changedPlayers = players.filter((player) => {
    const state = statesByUsername.get(player.username);
    const previousSha = typeof state?.prodSha === 'string' ? state.prodSha : '';
    return Boolean(state && currentSha && previousSha !== currentSha);
  });
  if (!changedPlayers.length) return { players, botPrs: null, refreshedOwners: [], failedOwners: [] };

  const [bot, ...directResults] = await runFetchPool([
    () => settledFetch(ATTRIBUTED_BOT_AUTHOR, botLimit, { fresh: true }),
    ...changedPlayers.map((player) => () => settledFetch(
      player.login,
      storedByUsername.get(player.username)?.hasAuthorHistory ? INCREMENTAL_FETCH_LIMIT : FULL_FETCH_LIMIT,
      { fresh: true },
    )),
  ]);
  const botReady = bot.ok && !bot.value.stale;
  const refreshedBotPrs = botReady ? unionBotPrs(previousBotPrs, bot.value.prs) : previousBotPrs;
  const ready = new Set();
  const failedOwners = [];
  changedPlayers.forEach((player, index) => {
    const direct = directResults[index];
    if (!botReady || !direct?.ok || direct.value.stale) {
      failedOwners.push(player.username);
      return;
    }
    ready.add(player.username);
    prsByUsername.set(player.username, mergePlayerPrs(
      player,
      prsByUsername.get(player.username) || [],
      direct,
      refreshedBotPrs,
      allPlayers,
    ));
  });
  const changedOwners = new Set(changedPlayers.map((player) => player.username));
  return {
    players: players.filter((player) => !changedOwners.has(player.username) || ready.has(player.username)),
    botPrs: ready.size ? refreshedBotPrs : null,
    refreshedOwners: [...ready],
    failedOwners,
  };
}

export async function __refreshDeployPrsForTests(options) {
  return refreshDeployPrs(options);
}

async function runCycle({ onlyOwner = null } = {}) {
  let players = resolvePlayers();
  const profileNow = Date.now();
  const missingProfiles = players.filter((player) => (
    player.needsGithubName && githubProfileRetryDue(player, profileNow)
  ));
  if (missingProfiles.length) {
    const profiles = await runFetchPool(missingProfiles.map((player) => async () => {
      try { return { player, profile: await fetchGithubProfile(player.login) }; }
      catch { return null; }
    }));
    for (const result of profiles) {
      if (!result) continue;
      const action = githubProfileResultAction(result.profile);
      if (action.retryAt) {
        profileRetryAfterByOwner.set(result.player.username, {
          login: result.player.login,
          at: action.retryAt,
        });
        continue;
      }
      profileRetryAfterByOwner.delete(result.player.username);
      if (action.save) {
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
  // las lecturas directa+bot frescas y con el estado de producción también fresco.
  const freshPlayers = requested.filter((player) => {
    const direct = directByOwner.get(player.username);
    return direct?.ok && !direct.value.stale && bot.ok && !bot.value.stale;
  });
  if (freshPlayers.length) {
    try {
      const production = await fetchCurrentProduction();
      if (production && production._stale !== true) {
        const statesByUsername = new Map(freshPlayers.map((player) => [player.username, getFestejos(player.username)]));
        const refreshed = await refreshDeployPrs({
          players: freshPlayers,
          allPlayers: players,
          prsByUsername,
          statesByUsername,
          storedByUsername: states,
          previousBotPrs: botPrs,
          botLimit,
          production,
        });
        if (refreshed.botPrs) saveBotPrs(refreshed.botPrs);
        const deployStep = await detectDeployFestejos({
          players: refreshed.players,
          prsByUsername,
          statesByUsername,
          production,
        });
        for (const [owner, state] of deployStep.states) saveFestejos(owner, state);
      }
    } catch (error) {
      console.warn('[forja] no se pudo leer el estado de producción:', error?.message || error);
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
  if (ownerCycles.has(owner)) return ownerCycles.get(owner);
  if (fullCycle && rateLimitMs > 0) {
    return fullCycle.then(() => ({ ignored: true, snapshot: getMeSnapshot(owner) }));
  }
  if (snapshotAgeMs(owner) < rateLimitMs) {
    return Promise.resolve({ ignored: true, snapshot: getMeSnapshot(owner) });
  }
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

export function __setProductionReadersForTests({ production, commits, profile } = {}) {
  fetchCurrentProduction = typeof production === 'function' ? production : getCurrentProductionSha;
  fetchCommitsBetween = typeof commits === 'function' ? commits : listCommitsBetween;
  fetchGithubProfile = typeof profile === 'function' ? profile : githubUserExists;
}
