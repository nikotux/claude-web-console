import { listMergedPrsByAuthor } from '../comms/pr-read-shared.js';
import { computeForja, normalizePr } from './compute.js';
import {
  ATTRIBUTED_BOT_AUTHOR, playerForBranch, playerForUsername, resolvePlayers,
} from './players.js';
import {
  getBotPrs, getMeSnapshot, loadFromDisk, saveArenaSnapshot, saveBotPrs, saveMeSnapshot,
  snapshotAgeMs,
} from './store.js';

const REFRESH_MS = Number(process.env.FORJA_REFRESH_MS) || 3 * 60 * 1000;
const MANUAL_RATE_LIMIT_MS = 60 * 1000;
const FULL_FETCH_LIMIT = 1000;
const INCREMENTAL_FETCH_LIMIT = 50;
const FETCH_CONCURRENCY = 3;

let timer = null;
let queueTail = Promise.resolve();
let fullCycle = null;
const ownerCycles = new Map();
let fetchMergedPrsByAuthor = listMergedPrsByAuthor;

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

async function runCycle({ onlyOwner = null } = {}) {
  const players = resolvePlayers();
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
