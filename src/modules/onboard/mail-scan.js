// modules/onboard/mail-scan.js — retrato conversacional a partir del correo.
// Se monta únicamente post-auth: conectar Microsoft ya expresa el consentimiento
// y habilita el barrido automático. El usuario siempre sale de la sesión; nunca
// se admite elegir a otra persona por body o query, ni siquiera siendo admin.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { principalOf } from '../../core/auth.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { connectionStatus } from '../../core/connections-store.js';
import {
  fetchMailBodies,
  fetchMailSample,
  mailScopeAvailable,
  selectRepresentative,
  summarizeMailSample,
} from '../../core/microsoft-mail-client.js';
import { userDataDir } from '../../core/user-space.js';

export const mailScanRouter = express.Router();

const STATE_FILE = 'onboard-mail-scan.json';
const STATE_VERSION = 1;
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BODY_STATE_FILE = 'onboard-mail-bodies.json';
const BODY_STATE_VERSION = 1;
// El contenido solo acompaña el alta: tres días alcanzan para retomarla sin
// conservar cuerpos completos durante el mes que sí necesita el retrato.
const BODY_STATE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const REPRESENTATIVE_BODY_LIMIT = 80;
const scanInflight = new Map();

function sessionUser(req, res) {
  const principal = principalOf(req);
  if (principal?.type === 'user' && principal.username) return principal.username;
  res.status(400).json({ error: 'Esta ruta requiere una sesión de usuario.' });
  return null;
}

// La ruta se resuelve por operación desde el dueño del dato (console:BUG-2185).
function statePath(user) {
  return path.join(userDataDir(user), STATE_FILE);
}

function bodyStatePath(user) {
  return path.join(userDataDir(user), BODY_STATE_FILE);
}

function unlinkBestEffort(file) {
  try { fs.unlinkSync(file); } catch { /* ausencia o fallo de poda: se reintentará */ }
}

function readLastResult(user) {
  const file = statePath(user);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') unlinkBestEffort(file);
    return null;
  }

  const expiresAt = Date.parse(state?.expiresAt);
  if (state?.version !== STATE_VERSION || !state?.result || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    unlinkBestEffort(file);
    return null;
  }
  return publicResult(state.result);
}

function writeLastResult(user, result) {
  const savedAt = new Date();
  writeJsonAtomic(statePath(user), {
    version: STATE_VERSION,
    savedAt: savedAt.toISOString(),
    expiresAt: new Date(savedAt.getTime() + STATE_TTL_MS).toISOString(),
    result,
  }, { mode: 0o600, space: 2 });
}

function pruneBodyState(user) {
  const file = bodyStatePath(user);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') unlinkBestEffort(file);
    return;
  }

  const expiresAt = Date.parse(state?.expiresAt);
  if (state?.version !== BODY_STATE_VERSION || !Array.isArray(state?.messages)
      || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    unlinkBestEffort(file);
  }
}

function writeMailBodies(user, messages) {
  const savedAt = new Date();
  writeJsonAtomic(bodyStatePath(user), {
    version: BODY_STATE_VERSION,
    savedAt: savedAt.toISOString(),
    expiresAt: new Date(savedAt.getTime() + BODY_STATE_TTL_MS).toISOString(),
    messages,
  }, { mode: 0o600, space: 2 });
}

function redactEmails(value) {
  return String(value || '')
    .replace(/[^\s<>@]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)/gu, '[correo @$1]')
    .trim();
}

function publicDomain(value) {
  const domain = String(value || '').trim().toLowerCase();
  return domain && !domain.includes('@') ? domain.slice(0, 253) : null;
}

function publicRange(range) {
  if (!range || typeof range !== 'object') return null;
  return {
    from: typeof range.from === 'string' ? range.from : null,
    to: typeof range.to === 'string' ? range.to : null,
  };
}

// Allowlist explícita: aun si el cliente agrega campos en el futuro, esta
// frontera HTTP no puede empezar a filtrar direcciones ni mensajes crudos.
function publicPortrait(portrait) {
  return {
    totalMessages: Number(portrait?.totalMessages) || 0,
    period: publicRange(portrait?.period),
    internalDomain: publicDomain(portrait?.internalDomain),
    volumeByMonth: Array.isArray(portrait?.volumeByMonth)
      ? portrait.volumeByMonth.map((item) => ({
        month: String(item?.month || '').slice(0, 7),
        received: Number(item?.received) || 0,
        sent: Number(item?.sent) || 0,
        total: Number(item?.total) || 0,
      }))
      : [],
    topInterlocutors: Array.isArray(portrait?.topInterlocutors)
      ? portrait.topInterlocutors.map((item) => ({
        name: item?.name ? redactEmails(item.name).slice(0, 120) : null,
        domain: publicDomain(item?.domain),
        received: Number(item?.received) || 0,
        sent: Number(item?.sent) || 0,
        messages: Number(item?.messages) || 0,
      }))
      : [],
    recurrentSubjects: Array.isArray(portrait?.recurrentSubjects)
      ? portrait.recurrentSubjects.map((item) => ({
        subject: redactEmails(item?.subject).slice(0, 120),
        count: Number(item?.count) || 0,
      }))
      : [],
    topExternalDomains: Array.isArray(portrait?.topExternalDomains)
      ? portrait.topExternalDomains.map((item) => ({
        domain: publicDomain(item?.domain),
        messages: Number(item?.messages) || 0,
      }))
      : [],
  };
}

function publicSampling(sampling) {
  if (!sampling || typeof sampling !== 'object') return null;
  return {
    months: Number(sampling.months) || 0,
    strategy: String(sampling.strategy || '').slice(0, 80),
    buckets: Array.isArray(sampling.buckets)
      ? sampling.buckets.map((bucket) => ({
        from: typeof bucket?.from === 'string' ? bucket.from : null,
        to: typeof bucket?.to === 'string' ? bucket.to : null,
        received: Number(bucket?.received) || 0,
        sent: Number(bucket?.sent) || 0,
      }))
      : [],
  };
}

function publicResult(result) {
  return {
    portrait: publicPortrait(result?.portrait),
    count: Number(result?.count) || 0,
    range: publicRange(result?.range),
    sampling: publicSampling(result?.sampling),
  };
}

function actionableFailure(result) {
  const reason = ['missing-scope', 'unauthorized', 'rate-limited', 'network', 'unknown'].includes(result?.reason)
    ? result.reason
    : 'unknown';

  if (reason === 'missing-scope') {
    return {
      reason,
      message: 'Falta el permiso de correo Mail.Read. Cuando la consola lo habilite, reconectá Microsoft desde ⚙ Sistema → Conexiones para otorgarlo.',
    };
  }
  if (reason === 'unauthorized') {
    return {
      reason,
      message: 'Microsoft no está conectado o la autorización venció. Conectá Microsoft desde ⚙ Sistema → Conexiones.',
    };
  }
  if (reason === 'rate-limited') {
    const seconds = Number.isFinite(result?.retryAfterSeconds) ? Math.max(0, Math.ceil(result.retryAfterSeconds)) : null;
    return {
      reason,
      message: seconds === null
        ? 'Microsoft limitó temporalmente las consultas. Reintentá dentro de unos minutos.'
        : `Microsoft limitó temporalmente las consultas. Reintentá en ${seconds} segundos.`,
      ...(seconds === null ? {} : { retryAfterSeconds: seconds }),
    };
  }
  if (reason === 'network') {
    return { reason, message: 'No se pudo consultar Microsoft en este momento. Revisá la conexión y reintentá.' };
  }
  return { reason, message: 'No se pudo generar el retrato del correo. Reintentá más tarde.' };
}

function failureStatus(reason) {
  if (reason === 'rate-limited') return 429;
  if (reason === 'missing-scope') return 403;
  if (reason === 'unauthorized') return 409;
  if (reason === 'network') return 503;
  return 502;
}

mailScanRouter.get('/mail-scan/status', async (req, res) => {
  const user = sessionUser(req, res);
  if (!user) return;
  try {
    readLastResult(user); // poda oportunista del snapshot sensible vencido
    pruneBodyState(user); // el contenido privado tiene un TTL independiente y más corto

    if (!connectionStatus(user, 'microsoft').connected) {
      const failure = actionableFailure({ reason: 'unauthorized' });
      return res.json({ connected: false, scopeAvailable: false, ...failure });
    }
  } catch {
    const failure = actionableFailure({ reason: 'unknown' });
    return res.status(500).json({ connected: false, scopeAvailable: false, ...failure });
  }

  try {
    const status = await mailScopeAvailable(user);
    if (status.ok && status.available) {
      return res.json({
        connected: true,
        scopeAvailable: true,
        reason: null,
        message: 'Microsoft está conectado y el permiso de correo está disponible.',
      });
    }
    const failure = actionableFailure(status);
    return res.json({
      connected: failure.reason !== 'unauthorized',
      scopeAvailable: false,
      reason: failure.reason,
      message: failure.message,
    });
  } catch {
    const failure = actionableFailure({ reason: 'unknown' });
    return res.status(500).json({ connected: true, scopeAvailable: false, ...failure });
  }
});

async function runMailScan(user) {
  let sample;
  try {
    sample = await fetchMailSample(user);
  } catch {
    const failure = actionableFailure({ reason: 'unknown' });
    return { status: 500, body: { ok: false, ...failure } };
  }
  if (!sample.ok) {
    const failure = actionableFailure(sample);
    return { status: failureStatus(failure.reason), body: { ok: false, ...failure } };
  }

  const representative = selectRepresentative(sample.messages, REPRESENTATIVE_BODY_LIMIT);
  let bodies;
  try {
    bodies = await fetchMailBodies(user, representative);
  } catch {
    const failure = actionableFailure({ reason: 'unknown' });
    return { status: 500, body: { ok: false, ...failure } };
  }
  if (!bodies.ok) {
    const failure = actionableFailure(bodies);
    return { status: failureStatus(failure.reason), body: { ok: false, ...failure } };
  }

  const result = publicResult({
    portrait: summarizeMailSample(sample),
    count: Number(sample.count) || 0,
    range: publicRange(sample.range),
    sampling: publicSampling(sample.sampling),
  });

  try {
    // El contenido viaja del servidor al modelo, jamás del servidor al navegador.
    // publicResult sigue siendo la única frontera de la respuesta HTTP.
    writeMailBodies(user, bodies.messages);
    writeLastResult(user, result);
  } catch {
    return {
      status: 500,
      body: {
        ok: false,
        reason: 'unknown',
        message: 'El retrato se generó, pero no se pudo guardar de forma segura. Reintentá más tarde.',
      },
    };
  }
  return { status: 200, body: result };
}

mailScanRouter.post('/mail-scan', async (req, res) => {
  const user = sessionUser(req, res);
  if (!user) return;

  try {
    let promise = scanInflight.get(user);
    if (!promise) {
      promise = runMailScan(user).finally(() => {
        if (scanInflight.get(user) === promise) scanInflight.delete(user);
      });
      scanInflight.set(user, promise);
    }
    const { status, body } = await promise;
    return res.status(status).json(body);
  } catch {
    return res.status(500).json({
      ok: false,
      ...actionableFailure({ reason: 'unknown' }),
    });
  }
});

mailScanRouter.get('/mail-scan/last', (req, res) => {
  const user = sessionUser(req, res);
  if (!user) return;
  pruneBodyState(user);
  return res.json(readLastResult(user));
});
