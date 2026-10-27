import express from 'express';
import { principalOf } from '../../core/auth.js';
import { hostUser } from '../../core/user-space.js';
import { playerIdFor } from './compute.js';
import { playerForUsername, resolvePlayers } from './players.js';
import { refreshOwner, startRefresher } from './refresher.js';
import {
  getArenaSnapshot, getFestejos, getMeSnapshot, markFestejosSeen, pendingFestejos,
} from './store.js';

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
      if (!configuredPlayer(owner)) return res.json({ configured: false, hint: 'identity.github', pendingFestejos: 0 });
      let snapshot = getMeSnapshot(owner);
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
      const numbers = req.body?.numbers;
      if (!Array.isArray(numbers) || !numbers.every((number) => Number.isSafeInteger(number) && number > 0)) {
        return res.status(400).json({ error: 'numbers debe ser un array de enteros positivos.' });
      }
      const state = markFestejosSeen(owner, numbers);
      return res.json({ ok: true, pending: state.pending, pendingFestejos: state.pending.length });
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
      if (!configuredPlayer(owner)) return res.json({ configured: false, hint: 'identity.github' });
      const result = await refreshOwner(owner);
      if (!result.snapshot) return res.status(503).json({ ok: false, error: result.error || 'No se pudo refrescar La Forja.' });
      return res.json({ ok: true, ignored: result.ignored, snapshot: result.snapshot });
    });

    router.use('/forja', r);
  },
};
