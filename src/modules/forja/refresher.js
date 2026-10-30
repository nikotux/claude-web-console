import {
  getLatestMergedActivity, githubUserExists, listMergedPrsByAuthor,
} from '../comms/pr-read-shared.js';
import {
  computeForja, normalizePr,
} from './compute.js';
import {
  ATTRIBUTED_BOT_AUTHOR, playerForBranch, playerForUsername, resolvePlayers,
} from './players.js';
import {
  getBotPrs, getMeSnapshot, loadFromDisk, saveArenaSnapshot, saveBotPrs,
  saveGithubProfile, saveMeSnapshot, snapshotAgeMs,
} from './store.js';

const REFRESH_MS = Number(process.env.FORJA_REFRESH_MS) || 3 * 60 * 1000;
const MANUAL_RATE_LIMIT_MS = 60 * 1000;
const FULL_FETCH_LIMIT = 1000;
const INCREMENTAL_FETCH_LIMIT = 50;
const FETCH_CONCURRENCY = 3;
const STALE_PROFILE_RETRY_MS = 15 * 60 * 1000;

let timer = null;
let queueTail = Promise.resolve();
let fullCycle = null;
const ownerCycles = new Map();
const profileRetryAfterByOwner = new Map();
let fetchMergedPrsByAuthor = listMergedPrsByAuthor;
let fetchLatestMergedActivity = getLatestMergedActivity;
let fetchGithubProfile = githubUserExists;
let lastMergedActivity = null;

function sameLogin(left, right) {
  return typeof left === 'string' && left.toLowerCase() === String(right || '').toLowerCase();
}

function sameMergedActivity(left, right) {
  return left?.number === right?.number && left?.updatedAt === right?.updatedAt;
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

function nextDataAsOf(previous, direct, bot, attemptedAt) {
  return direct.ok && !direct.value.stale && bot.ok && !bot.value.stale
    ? attemptedAt
    : previous;
}

export const __nextDataAsOfForTests = nextDataAsOf;

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
  const canSkipAuthorFetch = !onlyOwner && lastMergedActivity !== null
    && previousBotPrs.length > 0
    && requested.every((player) => {
      const state = states.get(player.username);
      return state?.hasAuthorHistory && state.loginMatches;
    });
  let probedActivity = null;
  let activityProbeSucceeded = false;
  if (!onlyOwner) {
    try {
      probedActivity = await fetchLatestMergedActivity();
      activityProbeSucceeded = true;
    } catch { /* el sondeo es una optimización: ante error se consulta completo */ }
  }
  const skippedAuthorFetch = canSkipAuthorFetch
    && activityProbeSucceeded
    && sameMergedActivity(probedActivity, lastMergedActivity);
  let bot;
  let directResults;
  if (skippedAuthorFetch) {
    bot = { ok: true, value: { prs: [], stale: false } };
    directResults = requested.map(() => ({ ok: true, value: { prs: [], stale: false } }));
  } else {
    [bot, ...directResults] = await runFetchPool([
      () => settledFetch(ATTRIBUTED_BOT_AUTHOR, botLimit),
      ...requested.map((player) => () => settledFetch(
        player.login,
        states.get(player.username).hasAuthorHistory ? INCREMENTAL_FETCH_LIMIT : FULL_FETCH_LIMIT,
      )),
    ]);
    // Un ciclo manual no cubre a todos los jugadores, así que no puede avanzar la marca.
    if (!onlyOwner && activityProbeSucceeded && bot.ok && !bot.value.stale
      && directResults.every((direct) => direct.ok && !direct.value.stale)) {
      lastMergedActivity = probedActivity;
    }
  }
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
    const dataAsOf = nextDataAsOf(previousDataAsOf, direct, bot, attemptedAt);
    if (dataAsOf) dataAsOfByUsername.set(player.username, dataAsOf);
    lastAttemptAtByUsername.set(player.username, attemptedAt);
  }

  const computed = computeForja(players, prsByUsername, {
    staleByUsername, errorByUsername, fetchedAtByUsername, dataAsOfByUsername,
    lastAttemptAtByUsername,
  });
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

export function __setSupplementalReadersForTests({ profile, activity } = {}) {
  fetchGithubProfile = typeof profile === 'function' ? profile : githubUserExists;
  fetchLatestMergedActivity = typeof activity === 'function' ? activity : getLatestMergedActivity;
}

export function __resetForjaMemosForTests() {
  lastMergedActivity = null;
}
