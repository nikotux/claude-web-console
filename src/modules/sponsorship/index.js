// modules/sponsorship/index.js — adopción self-service de perfiles patrocinados.
//
// HTTP (autenticado):
//   GET  /api/sponsorship/candidates -> perfiles que esperan sponsor
//   GET  /api/sponsorship/mine       -> capacidad, token y patrocinados propios
//   POST /api/sponsorship/adopt      -> adopta { username }
//   POST /api/sponsorship/release    -> suelta { username }
//   POST /api/sponsorship/token/start  -> inicia setup-token propio
//   GET  /api/sponsorship/token/status -> consulta el estado sin exponer secretos
//   POST /api/sponsorship/token/code   -> entrega { code } al runner propio
//   POST /api/sponsorship/token/cancel -> cancela el setup-token propio
//   POST /api/sponsorship/admin/assign   -> admin asigna { username, sponsor? }
//   POST /api/sponsorship/admin/release  -> admin suelta { username }
//   GET  /api/sponsorship/admin/overview -> admin lista estado y sponsors aptos
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { isAdmin, principalOf } from '../../core/auth.js';
import { sponsorTokenReady } from '../../core/sponsorship.js';
import {
  listUsers,
  setAwaitingSponsor,
  setUserSponsor,
  sponsorshipState,
} from '../../core/users.js';
import { withLocalUsage } from '../tokens/index.js';

const DEFAULT_WARN_USD = 10;
const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'sponsor-token-jobs');
const jobFile = (u) => path.join(JOBS_DIR, `${u}.json`);
const codeFile = (u) => path.join(JOBS_DIR, `${u}.code`);
const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'bin', 'cwc-sponsor-token-runner.js',
);

function readJob(username) {
  try { return JSON.parse(fs.readFileSync(jobFile(username), 'utf8')); }
  catch { return { status: 'idle' }; }
}

function jobAlive(job) {
  if (['done', 'error'].includes(job?.status)) return false;
  const pid = Number(job?.pid);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

    r.post('/token/start', (req, res) => {
      try {
        const username = principalUsername(req, res);
        if (!username) return;
        const job = readJob(username);
        if (jobAlive(job)) return res.json({ ...job, alreadyRunning: true });

        try { fs.unlinkSync(codeFile(username)); } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
        try { fs.unlinkSync(jobFile(username)); } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
        const child = spawn(process.execPath, [RUNNER, '--user', username], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        res.json({ status: 'starting' });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudo iniciar la generación del token.' });
      }
    });

    r.get('/token/status', (req, res) => {
      try {
        const username = principalUsername(req, res);
        if (!username) return;
        const job = readJob(username);
        res.json({
          status: job.status,
          url: job.url || null,
          note: job.note || null,
          error: job.error || null,
          ready: sponsorTokenReady(username),
        });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudo consultar la generación del token.' });
      }
    });

    r.post('/token/code', (req, res) => {
      try {
        const username = principalUsername(req, res);
        if (!username) return;
        const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
        if (!code) return res.status(400).json({ error: 'code debe ser un string no vacío.' });
        fs.mkdirSync(JOBS_DIR, { recursive: true });
        fs.writeFileSync(codeFile(username), code, { mode: 0o600 });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudo guardar el código.' });
      }
    });

    r.post('/token/cancel', (req, res) => {
      try {
        const username = principalUsername(req, res);
        if (!username) return;
        const job = readJob(username);
        if (jobAlive(job)) {
          try { process.kill(Number(job.pid), 'SIGTERM'); } catch { /* ya terminó */ }
        }
        try { fs.unlinkSync(codeFile(username)); } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
        fs.mkdirSync(JOBS_DIR, { recursive: true });
        fs.writeFileSync(
          jobFile(username),
          JSON.stringify({ status: 'error', error: 'cancelado', user: username, ts: Date.now() }),
          { mode: 0o600 },
        );
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudo cancelar la generación del token.' });
      }
    });

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

    r.post('/admin/assign', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });

      const target = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      if (!target) return res.status(400).json({ error: 'username debe ser un string no vacío.' });

      const requestedSponsor = req.body?.sponsor;
      let sponsor;
      if (requestedSponsor === undefined) {
        const principal = principalOf(req);
        sponsor = typeof principal?.username === 'string' ? principal.username.trim() : '';
        if (!sponsor) {
          return res.status(400).json({
            error: 'El token maestro no identifica un usuario; indicá sponsor explícitamente.',
          });
        }
      } else {
        sponsor = typeof requestedSponsor === 'string' ? requestedSponsor.trim() : '';
        if (!sponsor) return res.status(400).json({ error: 'sponsor debe ser un string no vacío.' });
      }

      // La autoridad es del admin que ejecuta la acción; el sponsor designado
      // no necesita ser admin, pero sí tener listo su setup-token propio.
      if (!sponsorTokenReady(sponsor)) {
        return res.status(400).json({
          error: `El sponsor ${sponsor} no tiene listo su token propio de patrocinio.`,
        });
      }

      try {
        setUserSponsor(target, sponsor);
        const user = listUsers().find((item) => item.username === target);
        res.json({
          ok: true,
          username: user.username,
          tier: user.tier,
          sponsorshipState: user.sponsorshipState,
          sponsor: user.sponsor,
        });
      } catch (err) {
        res.status(err.badRequest ? 400 : 500).json({ error: err.message });
      }
    });

    r.post('/admin/release', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });

      const target = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      if (!target) return res.status(400).json({ error: 'username debe ser un string no vacío.' });

      try {
        // Un usuario sponsored sin sponsor queda awaiting-sponsor y NO arranca:
        // ese fail-closed es el comportamiento correcto, no un estado roto.
        setAwaitingSponsor(target);
        const user = listUsers().find((item) => item.username === target);
        res.json({
          ok: true,
          username: user.username,
          tier: user.tier,
          sponsorshipState: user.sponsorshipState,
          sponsor: user.sponsor,
        });
      } catch (err) {
        res.status(err.badRequest ? 400 : 500).json({ error: err.message });
      }
    });

    r.get('/admin/overview', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });

      try {
        // El panel recibe la aptitud ya resuelta para no ofrecer sponsors que
        // fallarían después por falta de token propio o por estar patrocinados.
        const users = listUsers().map((user) => ({
          username: user.username,
          tier: user.tier,
          sponsorshipState: user.sponsorshipState,
          sponsor: user.sponsor,
          canSponsor: user.sponsorshipState === 'none' && sponsorTokenReady(user.username),
        }));
        res.json({ users });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudo consultar el estado de patrocinio.' });
      }
    });

    router.use('/sponsorship', r);
  },
};
