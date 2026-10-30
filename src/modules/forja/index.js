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
  getArenaSnapshot, getMeSnapshot, saveGithubProfile,
} from './store.js';

const VALIDATION_WINDOW_MS = 60 * 1000;
const VALIDATION_MAX_PER_WINDOW = 8;
const AUTOMATIC_REFRESH_COOLDOWN_MS = 30 * 1000;
const validationBuckets = new Map();
const automaticRefreshByOwner = new Map();

function ownerOf(req) {
  return principalOf(req)?.username || hostUser();
}

function configuredPlayer(owner) {
  return playerForUsername(owner, resolvePlayers({ warnDuplicateClaims: false }));
}

function sameLogin(left, right) {
  return typeof left === 'string' && left.toLowerCase() === String(right || '').toLowerCase();
}

function publicMeSnapshot(snapshot) {
  const result = { ...snapshot };
  delete result.prs;
  return result;
}

function refreshingSnapshotState({
  owner, player, snapshot, enqueue = refreshOwner, now = Date.now(),
}) {
  if (!snapshot || sameLogin(snapshot.login, player.login)) return null;
  const previous = automaticRefreshByOwner.get(owner);
  if (!Number.isFinite(previous) || now - previous >= AUTOMATIC_REFRESH_COOLDOWN_MS) {
    automaticRefreshByOwner.set(owner, now);
    void enqueue(owner, { rateLimitMs: 0 });
  }
  return {
    configured: true,
    refreshing: true,
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

function handlerErrorStatus(error) {
  if (error?.badRequest) return 400;
  const marked = Number(error?.statusCode ?? error?.status);
  return Number.isInteger(marked) && marked >= 400 && marked < 500 ? marked : 500;
}

function respondHandlerError(res, operation, error) {
  const status = handlerErrorStatus(error);
  console.warn(`[forja] ${operation}:`, error?.message || error);
  return res.status(status).json({
    error: status === 500
      ? 'La Forja no pudo completar la operación.'
      : String(error?.message || error),
  });
}

export default {
  name: 'forja',

  init() { startRefresher(); },

  registerHttp(router) {
    const r = express.Router();

    r.get('/me', async (req, res) => {
      try {
        const owner = ownerOf(req);
        const player = configuredPlayer(owner);
        if (!player) {
          const status = githubLoginStatusForUsername(owner);
          return res.json({
            configured: false,
            hint: status.configured && !status.valid ? 'identity.github.invalid' : 'identity.github',
            invalidLogin: status.configured && !status.valid,
          });
        }
        let snapshot = getMeSnapshot(owner);
        const refreshing = refreshingSnapshotState({
          owner,
          player,
          snapshot,
        });
        if (refreshing) return res.json(refreshing);
        if (!snapshot) snapshot = (await refreshOwner(owner, { rateLimitMs: 0 })).snapshot;
        if (!snapshot) return res.status(503).json({
          configured: true,
          stale: true,
          error: 'La Forja todavía no tiene un snapshot.',
        });
        return res.json(publicMeSnapshot(snapshot));
      } catch (error) {
        return respondHandlerError(res, 'no se pudo cargar la ficha', error);
      }
    });

    r.post('/validate-login', async (req, res) => {
      try {
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
        let profile;
        try {
          profile = await githubUserExists(login);
        } catch (error) {
          console.warn(`[forja] no se pudo validar el login de ${owner}:`, error?.message || error);
          return res.status(503).json({ ok: false, error: 'GitHub no respondió. Intentá de nuevo en un momento.' });
        }
        if (profile?._stale === true) {
          return res.status(503).json({ ok: false, error: 'GitHub no respondió. Intentá de nuevo en un momento.' });
        }
        if (profile.exists) {
          try {
            saveGithubProfile(owner, { login: profile.canonicalLogin, name: profile.name });
          } catch (error) {
            console.warn(`[forja] no se pudo guardar el perfil GitHub de ${owner}:`, error?.message || error);
            return res.status(500).json({ ok: false, error: 'No se pudo guardar el perfil de GitHub.' });
          }
        }
        return res.json({
          ok: true,
          exists: Boolean(profile.exists),
          canonicalLogin: profile.canonicalLogin || null,
          name: profile.name || '',
        });
      } catch (error) {
        return respondHandlerError(res, 'no se pudo procesar la validación de GitHub', error);
      }
    });

    r.get('/arena', (req, res) => {
      try {
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
      } catch (error) {
        return respondHandlerError(res, 'no se pudo cargar la arena', error);
      }
    });

    r.post('/refresh', async (req, res) => {
      try {
        const owner = ownerOf(req);
        const player = configuredPlayer(owner);
        if (!player) return res.json({ configured: false, hint: 'identity.github' });
        const refreshing = refreshingSnapshotState({
          owner,
          player,
          snapshot: getMeSnapshot(owner),
        });
        if (refreshing) return res.json({ ok: true, ...refreshing });
        const result = await refreshOwner(owner);
        if (!result.snapshot) return res.status(503).json({ ok: false, error: result.error || 'No se pudo refrescar La Forja.' });
        return res.json({ ok: true, ignored: result.ignored, snapshot: result.snapshot });
      } catch (error) {
        return respondHandlerError(res, 'no se pudo refrescar la ficha', error);
      }
    });

    router.use('/forja', r);
  },
};
