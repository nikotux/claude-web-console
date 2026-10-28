import express from 'express';
import { principalOf } from '../../core/auth.js';
import { hostUser } from '../../core/user-space.js';
import { githubUserExists } from '../comms/pr-read-shared.js';
import { playerIdFor } from './compute.js';
import {
  GITHUB_LOGIN_RE, githubLoginStatusForUsername, playerForUsername, resolvePlayers,
} from './players.js';
import { refreshOwner, startRefresher } from './refresher.js';
import {
  getArenaSnapshot, getFestejos, getMeSnapshot, markFestejosSeen, pendingFestejos,
  saveGithubProfile,
} from './store.js';

const VALIDATION_WINDOW_MS = 60 * 1000;
const VALIDATION_MAX_PER_WINDOW = 8;
const validationBuckets = new Map();

function ownerOf(req) {
  return principalOf(req)?.username || hostUser();
}

function configuredPlayer(owner) {
  return playerForUsername(owner, resolvePlayers({ warnDuplicateClaims: false }));
}

function sameLogin(left, right) {
  return typeof left === 'string' && left.toLowerCase() === String(right || '').toLowerCase();
}

function refreshingSnapshotState({ owner, player, snapshot, pending, enqueue = refreshOwner }) {
  if (!snapshot || sameLogin(snapshot.login, player.login)) return null;
  void enqueue(owner, { rateLimitMs: 0 });
  return {
    configured: true,
    refreshing: true,
    pendingFestejos: pending,
  };
}

export function __refreshingSnapshotStateForTests(options) {
  return refreshingSnapshotState(options);
}

function consumeValidation(owner, now = Date.now()) {
  const previous = validationBuckets.get(owner);
  const bucket = !previous || now - previous.since >= VALIDATION_WINDOW_MS
    ? { since: now, count: 0 }
    : previous;
  bucket.count += 1;
  validationBuckets.set(owner, bucket);
  return bucket.count <= VALIDATION_MAX_PER_WINDOW;
}

export default {
  name: 'forja',

  init() { startRefresher(); },

  registerHttp(router) {
    const r = express.Router();

    r.get('/me', async (req, res) => {
      const owner = ownerOf(req);
      const player = configuredPlayer(owner);
      if (!player) {
        const status = githubLoginStatusForUsername(owner);
        return res.json({
          configured: false,
          hint: status.configured && !status.valid ? 'identity.github.invalid' : 'identity.github',
          invalidLogin: status.configured && !status.valid,
          pendingFestejos: 0,
        });
      }
      let snapshot = getMeSnapshot(owner);
      const refreshing = refreshingSnapshotState({
        owner,
        player,
        snapshot,
        pending: pendingFestejos(owner),
      });
      if (refreshing) return res.json(refreshing);
      if (!snapshot) snapshot = (await refreshOwner(owner, { rateLimitMs: 0 })).snapshot;
      if (!snapshot) return res.status(503).json({
        configured: true,
        stale: true,
        pendingFestejos: pendingFestejos(owner),
        error: 'La Forja todavía no tiene un snapshot.',
      });
      return res.json({ ...snapshot, pendingFestejos: pendingFestejos(owner) });
    });

    r.get('/festejos', (req, res) => {
      const owner = ownerOf(req);
      return res.json({ pending: getFestejos(owner)?.pending || [] });
    });

    r.post('/festejos/visto', (req, res) => {
      const owner = ownerOf(req);
      const numbers = req.body?.numbers ?? [];
      const ids = req.body?.ids ?? [];
      const validNumbers = Array.isArray(numbers)
        && numbers.every((number) => Number.isSafeInteger(number) && number > 0);
      const validIds = Array.isArray(ids)
        && ids.every((id) => typeof id === 'string' && /^(?:merge:\d+|deploy:[0-9a-f]{40})$/i.test(id));
      if (!validNumbers || !validIds || (!numbers.length && !ids.length)) {
        return res.status(400).json({ error: 'ids o numbers debe identificar al menos un festejo válido.' });
      }
      const state = markFestejosSeen(owner, { ids, numbers });
      return res.json({ ok: true, pending: state.pending, pendingFestejos: state.pending.length });
    });

    r.post('/validate-login', async (req, res) => {
      const owner = ownerOf(req);
      if (!consumeValidation(owner)) {
        return res.status(429).json({ ok: false, error: 'Demasiados intentos. Esperá un minuto y probá de nuevo.' });
      }
      const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
      if (!GITHUB_LOGIN_RE.test(login)) {
        return res.status(400).json({
          ok: false,
          exists: false,
          error: 'Es tu @usuario de GitHub, no tu nombre. Ej: rarboledaAtMordor',
        });
      }
      try {
        const profile = await githubUserExists(login);
        if (profile.exists) saveGithubProfile(owner, { login: profile.canonicalLogin, name: profile.name });
        return res.json({
          ok: true,
          exists: Boolean(profile.exists),
          canonicalLogin: profile.canonicalLogin || null,
          name: profile.name || '',
        });
      } catch (error) {
        console.warn(`[forja] no se pudo validar el login de ${owner}:`, error?.message || error);
        return res.status(503).json({ ok: false, error: 'GitHub no respondió. Intentá de nuevo en un momento.' });
      }
    });

    r.get('/arena', (req, res) => {
      const owner = ownerOf(req);
      const arena = getArenaSnapshot();
      if (!arena) return res.status(503).json({ error: 'La arena todavía no tiene un snapshot.' });
      const ownSnapshot = configuredPlayer(owner) ? getMeSnapshot(owner) : null;
      return res.json({
        generatedAt: arena.generatedAt,
        dataAsOf: arena.dataAsOf || null,
        stale: Boolean(arena.stale),
        season: arena.season,
        gaps: arena.gaps,
        mvp: arena.mvp,
        missions: ownSnapshot?.mission || null,
        players: (arena.players || []).map((player) => ({
          ...player,
          isMe: player.playerId === playerIdFor(owner),
        })),
      });
    });

    r.post('/refresh', async (req, res) => {
      const owner = ownerOf(req);
      const player = configuredPlayer(owner);
      if (!player) return res.json({ configured: false, hint: 'identity.github' });
      const refreshing = refreshingSnapshotState({
        owner,
        player,
        snapshot: getMeSnapshot(owner),
        pending: pendingFestejos(owner),
      });
      if (refreshing) return res.json({ ok: true, ...refreshing });
      const result = await refreshOwner(owner);
      if (!result.snapshot) return res.status(503).json({ ok: false, error: result.error || 'No se pudo refrescar La Forja.' });
      return res.json({ ok: true, ignored: result.ignored, snapshot: result.snapshot });
    });

    router.use('/forja', r);
  },
};
