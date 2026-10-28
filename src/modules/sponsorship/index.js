// modules/sponsorship/index.js — adopción self-service de perfiles patrocinados.
//
// HTTP (autenticado):
//   GET  /api/sponsorship/candidates -> perfiles que esperan sponsor si puede patrocinar
//   GET  /api/sponsorship/mine       -> capacidad, token y patrocinados propios
//   POST /api/sponsorship/adopt      -> adopta { username } con token propio listo
//   POST /api/sponsorship/release    -> suelta { username }
//   POST /api/sponsorship/token/start  -> inicia setup-token propio
//   GET  /api/sponsorship/token/status -> consulta el estado sin exponer secretos
//   POST /api/sponsorship/token/code   -> entrega { code } al runner propio que lo espera
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
import { sanitizeUserId, userDataDir } from '../../core/user-space.js';
import {
  listUsers,
  setAwaitingSponsor,
  setUserSponsor,
  sponsorshipState,
} from '../../core/users.js';
import { withLocalUsage } from '../tokens/index.js';

const DEFAULT_WARN_USD = 10;
const LEGACY_JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'sponsor-token-jobs');
const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'bin', 'cwc-sponsor-token-runner.js',
);

function safeUser(username) {
  const user = sanitizeUserId(username);
  if (user === '.' || user === '..') throw new Error('Usuario inválido.');
  return user;
}

function jobsDirFor(username) {
  return path.join(userDataDir(safeUser(username)), 'sponsor-token-jobs');
}

function contained(dir, file) {
  const rel = path.relative(dir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Ruta fuera del directorio de jobs.');
  }
  return file;
}

function jobPaths(dir, username) {
  const user = safeUser(username);
  return {
    job: contained(dir, path.join(dir, `${user}.json`)),
    code: contained(dir, path.join(dir, `${user}.code`)),
    cancel: contained(dir, path.join(dir, `${user}.cancel`)),
  };
}

function readJobFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { status: 'idle' }; }
}

function locateJob(username) {
  const user = safeUser(username);
  const dir = jobsDirFor(user);
  const { job } = jobPaths(dir, user);
  if (fs.existsSync(job)) return { dir, job: readJobFile(job) };

  const legacyJob = jobPaths(LEGACY_JOBS_DIR, user).job;
  if (fs.existsSync(legacyJob)) {
    return { dir: LEGACY_JOBS_DIR, job: readJobFile(legacyJob) };
  }
  return { dir, job: { status: 'idle' } };
}

function jobAlive(job) {
  if (['done', 'error'].includes(job?.status)) return false;
  if (!job?.pid && job?.status === 'starting') {
    const age = Date.now() - Number(job?.ts);
    return Number.isFinite(age) && age >= 0 && age < 15000;
  }
  const pid = Number(job?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return cmdline.includes('cwc-sponsor-token-runner');
  } catch {
    return false;
  }
}

function publicJob(job) {
  return {
    status: job?.status || null,
    url: job?.url || null,
    note: job?.note || null,
    error: job?.error || null,
  };
}

function unlinkIfExists(file) {
  try { fs.unlinkSync(file); } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
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
      let reservedJobFile = null;
      let reservedUser = null;
      try {
        const username = principalUsername(req, res);
        if (!username) return;
        let user;
        try { user = safeUser(username); } catch {
          return res.status(400).json({ error: 'Usuario inválido.' });
        }
        const current = locateJob(user).job;
        if (jobAlive(current)) {
          return res.json({ ...publicJob(current), alreadyRunning: true });
        }

        const dir = jobsDirFor(user);
        const paths = jobPaths(dir, user);
        const legacyPaths = jobPaths(LEGACY_JOBS_DIR, user);
        unlinkIfExists(paths.code);
        unlinkIfExists(paths.job);
        unlinkIfExists(paths.cancel);
        unlinkIfExists(legacyPaths.code);
        unlinkIfExists(legacyPaths.cancel);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

        let fd;
        try {
          fd = fs.openSync(paths.job, 'wx', 0o600);
          reservedJobFile = paths.job;
          reservedUser = user;
          fs.writeFileSync(fd, JSON.stringify({ status: 'starting', user, ts: Date.now() }));
        } catch (err) {
          if (err?.code === 'EEXIST') {
            return res.json({ status: 'starting', alreadyRunning: true });
          }
          throw err;
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }

        const child = spawn(process.execPath, [RUNNER, '--user', user], {
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', (err) => {
          try {
            const job = readJobFile(paths.job);
            if (job.pid && job.pid !== child.pid) return;
            fs.writeFileSync(
              paths.job,
              JSON.stringify({
                status: 'error',
                error: 'No se pudo lanzar el runner: ' + err.message,
                user,
                ts: Date.now(),
              }),
              { mode: 0o600 },
            );
          } catch { /* el error de spawn nunca puede tumbar el server */ }
        });
        child.unref();

        const state = child.pid
          ? { status: 'starting', user, pid: child.pid, ts: Date.now() }
          : { status: 'error', error: 'No se pudo lanzar el runner.', user, ts: Date.now() };
        fs.writeFileSync(paths.job, JSON.stringify(state), { mode: 0o600 });
        res.json({ status: 'starting' });
      } catch (err) {
        if (reservedJobFile) {
          try {
            fs.writeFileSync(
              reservedJobFile,
              JSON.stringify({
                status: 'error',
                error: err.message || 'No se pudo iniciar la generación del token.',
                user: reservedUser,
                ts: Date.now(),
              }),
              { mode: 0o600 },
            );
          } catch { /* best-effort después de reservar */ }
        }
        res.status(500).json({ error: err.message || 'No se pudo iniciar la generación del token.' });
      }
    });

    r.get('/token/status', (req, res) => {
      try {
        const username = principalUsername(req, res);
        if (!username) return;
        let user;
        try { user = safeUser(username); } catch {
          return res.status(400).json({ error: 'Usuario inválido.' });
        }
        const { job } = locateJob(user);
        res.json({
          status: job.status,
          url: job.url || null,
          note: job.note || null,
          error: job.error || null,
          ready: sponsorTokenReady(user),
        });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudo consultar la generación del token.' });
      }
    });

    r.post('/token/code', (req, res) => {
      try {
        const username = principalUsername(req, res);
        if (!username) return;
        let user;
        try { user = safeUser(username); } catch {
          return res.status(400).json({ error: 'Usuario inválido.' });
        }
        const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
        if (!code) return res.status(400).json({ error: 'code debe ser un string no vacío.' });
        if (code.length > 512) {
          return res.status(400).json({ error: 'code demasiado largo (máx. 512).' });
        }
        const { dir, job } = locateJob(user);
        if (!jobAlive(job) || !['awaiting-code', 'exchanging'].includes(job.status)) {
          return res.status(409).json({
            error: 'No hay un flujo de autorización esperando un código.',
          });
        }
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(jobPaths(dir, user).code, code, { mode: 0o600 });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudo guardar el código.' });
      }
    });

    r.post('/token/cancel', (req, res) => {
      try {
        const username = principalUsername(req, res);
        if (!username) return;
        let user;
        try { user = safeUser(username); } catch {
          return res.status(400).json({ error: 'Usuario inválido.' });
        }
        const { dir, job } = locateJob(user);
        const paths = jobPaths(dir, user);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(paths.cancel, String(Date.now()), { mode: 0o600 });
        if (jobAlive(job) && job.pid) {
          try { process.kill(Number(job.pid), 'SIGTERM'); } catch { /* ya terminó */ }
        }
        unlinkIfExists(paths.code);
        fs.writeFileSync(
          paths.job,
          JSON.stringify({ status: 'error', error: 'cancelado', user, ts: Date.now() }),
          { mode: 0o600 },
        );
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message || 'No se pudo cancelar la generación del token.' });
      }
    });

    r.get('/candidates', (req, res) => {
      const principal = principalUsername(req, res);
      if (!principal) return;
      try {
        if (sponsorshipState(principal) !== 'none' || !sponsorTokenReady(principal)) {
          return res.json({ candidates: [] });
        }
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
        if (!sponsorTokenReady(principal)) {
          return res.status(400).json({
            error: 'Primero generá tu token propio de patrocinio para poder adoptar.',
          });
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
        if (target === sponsor) {
          return res.status(400).json({ error: 'Un usuario no puede patrocinarse a sí mismo.' });
        }
        if (sponsorshipState(sponsor) !== 'none') {
          return res.status(400).json({
            error: 'Un usuario patrocinado no puede patrocinar a otro usuario.',
          });
        }
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
