import { listMergedPrsByAuthor } from '../comms/pr-read-shared.js';
import { computeForja, normalizePr } from './compute.js';
import {
  ATTRIBUTED_BOT_AUTHOR, playerForBranch, playerForUsername, resolvePlayers,
} from './players.js';
import {
  getMeSnapshot, loadFromDisk, saveArenaSnapshot, saveMeSnapshot, snapshotAgeMs,
} from './store.js';

const REFRESH_MS = Number(process.env.FORJA_REFRESH_MS) || 3 * 60 * 1000;
const MANUAL_RATE_LIMIT_MS = 60 * 1000;

let timer = null;
let refreshing = null;
const refreshingOwners = new Map();

function previousPrs(owner) {
  return Array.isArray(getMeSnapshot(owner)?.prs) ? getMeSnapshot(owner).prs : [];
}

async function fetchAuthor(author) {
  const prs = await listMergedPrsByAuthor(author);
  return { prs, stale: prs._stale === true };
}

function mergePlayerPrs(player, direct, bot, players) {
  const merged = new Map();
  const add = (raw, source) => {
    const normalized = normalizePr(raw, player, source);
    if (normalized && !merged.has(normalized.number)) merged.set(normalized.number, normalized);
  };

  if (direct.ok) direct.value.prs.forEach((pr) => add(pr, 'author'));
  else previousPrs(player.username).filter((pr) => pr.attributedFrom === 'author').forEach((pr) => add(pr, 'author'));

  if (bot.ok) {
    for (const pr of bot.value.prs) {
      if (playerForBranch(pr.headRefName, players)?.username === player.username) add(pr, ATTRIBUTED_BOT_AUTHOR);
    }
  } else {
    previousPrs(player.username)
      .filter((pr) => pr.attributedFrom === ATTRIBUTED_BOT_AUTHOR)
      .forEach((pr) => add(pr, ATTRIBUTED_BOT_AUTHOR));
  }
  return [...merged.values()];
}

async function settledFetch(author) {
  try { return { ok: true, value: await fetchAuthor(author) }; }
  catch (error) { return { ok: false, error }; }
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
  const [bot, ...directResults] = await Promise.all([
    settledFetch(ATTRIBUTED_BOT_AUTHOR),
    ...requested.map((player) => settledFetch(player.login)),
  ]);
  const directByOwner = new Map(requested.map((player, index) => [player.username, directResults[index]]));
  const prsByUsername = new Map();
  const staleByUsername = new Map();
  const errorByUsername = new Map();

  for (const player of players) {
    const direct = directByOwner.get(player.username);
    if (!direct) {
      prsByUsername.set(player.username, previousPrs(player.username));
      staleByUsername.set(player.username, Boolean(getMeSnapshot(player.username)?.stale));
      continue;
    }
    prsByUsername.set(player.username, mergePlayerPrs(player, direct, bot, players));
    const stale = !direct.ok || direct.value.stale || !bot.ok || bot.value.stale;
    staleByUsername.set(player.username, stale);
    const error = !direct.ok ? direct.error : (!bot.ok ? bot.error : null);
    if (error) errorByUsername.set(player.username, error?.message || error);
  }

  const computed = computeForja(players, prsByUsername, { staleByUsername, errorByUsername });
  for (const player of players) saveMeSnapshot(player.username, computed.snapshots.get(player.username));
  saveArenaSnapshot(computed.arena);
  return target ? computed.snapshots.get(target.username) : computed;
}

export function refreshNow() {
  if (refreshing) return refreshing;
  refreshing = runCycle()
    .catch((error) => {
      console.error('[forja] no se pudo refrescar:', error?.message || error);
      return null;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export function refreshOwner(owner, { rateLimitMs = MANUAL_RATE_LIMIT_MS } = {}) {
  if (snapshotAgeMs(owner) < rateLimitMs) {
    return Promise.resolve({ ignored: true, snapshot: getMeSnapshot(owner) });
  }
  if (refreshing) {
    return refreshing.then(() => ({ ignored: true, snapshot: getMeSnapshot(owner) }));
  }
  if (refreshingOwners.has(owner)) return refreshingOwners.get(owner);
  const promise = runCycle({ onlyOwner: owner })
    .then((snapshot) => ({ ignored: false, snapshot }))
    .catch((error) => {
      console.error(`[forja] no se pudo refrescar ${owner}:`, error?.message || error);
      return { ignored: false, snapshot: getMeSnapshot(owner), error: String(error?.message || error).slice(0, 300) };
    })
    .finally(() => { refreshingOwners.delete(owner); });
  refreshingOwners.set(owner, promise);
  return promise;
}

export function startRefresher() {
  if (timer) return;
  const players = resolvePlayers();
  loadFromDisk(players.map((player) => player.username));
  void refreshNow();
  timer = setInterval(refreshNow, REFRESH_MS);
  timer.unref?.();
  console.log(`[forja] refresher activo cada ${Math.round(REFRESH_MS / 1000)}s`);
}
