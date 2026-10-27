import express from 'express';
import { principalOf } from '../../core/auth.js';
import { hostUser } from '../../core/user-space.js';
import { playerIdFor } from './compute.js';
import { playerForUsername, resolvePlayers } from './players.js';
import { refreshOwner, startRefresher } from './refresher.js';
import { getArenaSnapshot, getMeSnapshot } from './store.js';

function ownerOf(req) {
  return principalOf(req)?.username || hostUser();
}

function configuredPlayer(owner) {
  return playerForUsername(owner, resolvePlayers({ warnDuplicateClaims: false }));
}

export default {
  name: 'forja',

  init() { startRefresher(); },

  registerHttp(router) {
    const r = express.Router();

    r.get('/me', async (req, res) => {
      const owner = ownerOf(req);
      if (!configuredPlayer(owner)) return res.json({ configured: false, hint: 'identity.github' });
      let snapshot = getMeSnapshot(owner);
      if (!snapshot) snapshot = (await refreshOwner(owner, { rateLimitMs: 0 })).snapshot;
      if (!snapshot) return res.status(503).json({ configured: true, stale: true, error: 'La Forja todavía no tiene un snapshot.' });
      return res.json(snapshot);
    });

    r.get('/arena', (req, res) => {
      const owner = ownerOf(req);
      const arena = getArenaSnapshot();
      if (!arena) return res.status(503).json({ error: 'La arena todavía no tiene un snapshot.' });
      const ownSnapshot = configuredPlayer(owner) ? getMeSnapshot(owner) : null;
      return res.json({
        generatedAt: arena.generatedAt,
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
      if (!configuredPlayer(owner)) return res.json({ configured: false, hint: 'identity.github' });
      const result = await refreshOwner(owner);
      if (!result.snapshot) return res.status(503).json({ ok: false, error: result.error || 'No se pudo refrescar La Forja.' });
      return res.json({ ok: true, ignored: result.ignored, snapshot: result.snapshot });
    });

    router.use('/forja', r);
  },
};
