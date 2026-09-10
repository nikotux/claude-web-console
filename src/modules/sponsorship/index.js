// modules/sponsorship/index.js — adopción self-service de perfiles patrocinados.
//
// HTTP (autenticado, nunca admin-only):
//   GET  /api/sponsorship/candidates -> perfiles que esperan sponsor
//   GET  /api/sponsorship/mine       -> capacidad, token y patrocinados propios
//   POST /api/sponsorship/adopt      -> adopta { username }
//   POST /api/sponsorship/release    -> suelta { username }
import express from 'express';
import { principalOf } from '../../core/auth.js';
import { sponsorTokenReady } from '../../core/sponsorship.js';
import {
  listUsers,
  setAwaitingSponsor,
  setUserSponsor,
  sponsorshipState,
} from '../../core/users.js';
import { withLocalUsage } from '../tokens/index.js';

const DEFAULT_WARN_USD = 10;

function warnThresholdUsd() {
  const raw = process.env.CWC_SPONSORED_USAGE_WARN_USD;
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_WARN_USD;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_WARN_USD;
}

function principalUsername(req, res) {
  const principal = principalOf(req);
  if (!principal) {
    res.status(401).json({ error: 'No autorizado.' });
    return null;
  }
  if (typeof principal.username !== 'string' || !principal.username) {
    res.status(400).json({ error: 'El token maestro no tiene un perfil de usuario que pueda patrocinar.' });
    return null;
  }
  return principal.username;
}

// withLocalUsage() es la puerta exportada al summary con TTL y deduplicación
// concurrente de tokens. Un fallo queda aislado en este usuario.
async function usageFor(username, thresholdUsd) {
  try {
    const result = await withLocalUsage({ unavailable: true }, username);
    const todayUsd = result?.localUsage?.todayCost;
    if (typeof todayUsd !== 'number' || !Number.isFinite(todayUsd)) {
      throw new Error('consumo diario no disponible');
    }
    return { username, todayUsd, thresholdUsd };
  } catch {
    return { username, todayUsd: null, thresholdUsd };
  }
}

export default {
  name: 'sponsorship',

  init(ctx) { // eslint-disable-line no-unused-vars -- interfaz estándar
    return Promise.resolve();
  },

  registerHttp(router, ctx) { // eslint-disable-line no-unused-vars -- interfaz estándar
    const r = express.Router();

    r.get('/candidates', (req, res) => {
      if (!principalUsername(req, res)) return;
      try {
        const candidates = listUsers()
          .filter((user) => user.sponsorshipState === 'awaiting-sponsor')
          .map((user) => ({ username: user.username }));
        res.json({ candidates });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudieron listar los candidatos.' });
      }
    });

    r.get('/mine', async (req, res) => {
      const principal = principalUsername(req, res);
      if (!principal) return;
      try {
        const thresholdUsd = warnThresholdUsd();
        const ownUsers = listUsers().filter((user) => user.sponsor === principal);
        const sponsored = await Promise.all(
          ownUsers.map((user) => usageFor(user.username, thresholdUsd)),
        );
        res.json({
          canSponsor: sponsorshipState(principal) === 'none',
          tokenReady: sponsorTokenReady(principal),
          sponsored,
        });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudo consultar el patrocinio.' });
      }
    });

    r.post('/adopt', (req, res) => {
      const principal = principalUsername(req, res);
      if (!principal) return;
      const target = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      if (!target) return res.status(400).json({ error: 'username debe ser un string no vacío.' });

      try {
        const user = listUsers().find((item) => item.username === target);
        if (!user) return res.status(400).json({ error: 'El usuario a adoptar no existe.' });
        if (user.sponsorshipState !== 'awaiting-sponsor') {
          return res.status(400).json({ error: 'Ese usuario no está esperando sponsor y no puede ser adoptado.' });
        }
        if (target === principal) {
          return res.status(400).json({ error: 'No puedes patrocinarte a ti mismo.' });
        }
        if (sponsorshipState(principal) !== 'none') {
          return res.status(400).json({ error: 'Un usuario patrocinado no puede patrocinar a otro usuario.' });
        }

        setUserSponsor(target, principal);
        res.json({ ok: true, username: target });
      } catch (err) {
        res.status(err.badRequest ? 400 : 500).json({ error: err.message });
      }
    });

    r.post('/release', (req, res) => {
      const principal = principalUsername(req, res);
      if (!principal) return;
      const target = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      if (!target) return res.status(400).json({ error: 'username debe ser un string no vacío.' });

      try {
        const user = listUsers().find((item) => item.username === target);
        if (!user || user.sponsor !== principal) {
          return res.status(403).json({ error: 'No puedes soltar el patrocinio de ese usuario.' });
        }
        setAwaitingSponsor(target);
        res.json({ ok: true, username: target, sponsorshipState: 'awaiting-sponsor' });
      } catch (err) {
        res.status(err.badRequest ? 400 : 500).json({ error: err.message });
      }
    });

    router.use('/sponsorship', r);
  },
};
