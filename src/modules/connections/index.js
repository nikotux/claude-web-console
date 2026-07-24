// modules/connections/index.js — endpoints OAuth para conectores externos.
//
// Este módulo existe para exponer una capa HTTP chica sobre el store y los
// proveedores ya implementados: la configuración OAuth de la app es global y
// admin-only, mientras que los tokens quedan siempre por usuario. Por eso el
// deviceCode de Microsoft vive solo en memoria durante el polling y ningún
// endpoint devuelve ni loguea tokens, secrets o códigos internos.
import express from 'express';
import { principalOf, isAdmin } from '../../core/auth.js';
import { config } from '../../core/config.js';
import { hostUser } from '../../core/user-space.js';
import {
  PROVIDERS,
  isProvider,
  readAppConfig,
  writeAppConfig,
  appConfigured,
  readConnection,
  writeConnection,
  getAccessToken,
  deleteConnection,
  cancelAttempts,
  connectionStatus,
  lastAttempt,
  newJobId,
  readJob,
  writeJob,
  JOB_ID_RE,
} from '../../core/connections-store.js';
import {
  MS_SCOPES,
  startDeviceFlow,
  pollDeviceToken,
  getMe as getMicrosoftMe,
} from '../../core/connections-microsoft.js';
import {
  ZOHO_SCOPES,
  authUrl,
  exchangeCode,
  getOrg,
  getMe as getZohoMe,
} from '../../core/connections-zoho.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function userOf(req) {
  const p = principalOf(req);
  // El token maestro no representa a una persona concreta; para mantener la
  // retrocompatibilidad de los datos locales cae al usuario host.
  return p?.username || hostUser();
}

function reqProvider(req, res) {
  const provider = req.params.provider;
  if (!isProvider(provider)) {
    res.status(400).json({ error: 'Proveedor desconocido.' });
    return null;
  }
  return provider;
}

function labelOf(provider) {
  return PROVIDERS.find((p) => p.id === provider)?.label || provider;
}

function scopesForResponse(username, provider, requestedScopes) {
  const conn = readConnection(username, provider);
  const requested = Array.isArray(requestedScopes) ? requestedScopes : [];
  const grantedScopes = Array.isArray(conn?.scopes) ? conn.scopes : [];
  const hasStoredScopes = grantedScopes.length > 0;
  const connected = !!conn && !conn.error;
  const grantedSet = new Set(grantedScopes.map((s) => String(s).toLowerCase()));
  const missingScopes = connected && hasStoredScopes
    ? requested.filter((s) => !grantedSet.has(String(s).toLowerCase()))
    : [];
  return { grantedScopes, missingScopes };
}

function patchJob(username, jobId, fields) {
  try {
    const job = readJob(username, jobId);
    if (!job) return;
    writeJob(username, jobId, { ...job, ...fields });
  } catch {
    // El polling no debe tumbar el proceso por una carrera de archivos.
  }
}

async function pollMicrosoft(username, jobId, { clientId, tenantId, deviceCode, interval, expiresIn }) {
  let waitMs = Math.max(interval, 5) * 1000;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(waitMs);

    let job;
    try {
      job = readJob(username, jobId);
    } catch {
      return;
    }
    if (!job || job.status !== 'pending') return;

    let result;
    try {
      result = await pollDeviceToken({ clientId, tenantId, deviceCode });
    } catch (e) {
      patchJob(username, jobId, { status: 'error', error: e.message });
      return;
    }

    if (result.status === 'slow_down') {
      waitMs += 5000;
      continue;
    }
    if (result.status === 'pending') continue;
    if (result.status === 'ok') {
      try {
        const account = await getMicrosoftMe(result.tokens.access_token);
        writeConnection(username, 'microsoft', {
          provider: 'microsoft',
          account,
          accessToken: result.tokens.access_token,
          refreshToken: result.tokens.refresh_token || null,
          expiresAt: Date.now() + (Number(result.tokens.expires_in) || 3600) * 1000,
          scopes: MS_SCOPES,
          connectedAt: new Date().toISOString(),
          error: null,
        });
        patchJob(username, jobId, { status: 'connected', account, error: null });
      } catch (e) {
        patchJob(username, jobId, { status: 'error', error: e.message });
      }
      return;
    }
  }

  patchJob(username, jobId, {
    status: 'error',
    error: 'El código expiró antes de que se completara la autorización.',
  });
}

function asyncHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

function appConfigResponse() {
  const cfg = readAppConfig();
  return {
    microsoft: {
      clientId: cfg.microsoft.clientId,
      tenantId: cfg.microsoft.tenantId,
    },
    zoho: {
      clientId: cfg.zoho.clientId,
      dc: cfg.zoho.dc,
      hasSecret: !!cfg.zoho.clientSecret,
    },
  };
}

// Auto-reparación: las conexiones creadas antes del fix de identidad quedaron
// sin account/agentId. Como el refresh token ya está guardado, se resuelve sin
// re-hacer OAuth (el grant code de Zoho es de un solo uso). Best-effort: nunca
// rompe la consulta de estado.
async function healZohoIdentity(username) {
  try {
    const conn = readConnection(username, 'zoho');
    if (!conn || !conn.refreshToken || conn.agentId) return;
    const token = await getAccessToken(username, 'zoho');
    if (!token) return;
    const { dc } = readAppConfig().zoho;
    const me = await getZohoMe(token, dc, conn.orgId, config.instance?.identity?.email);
    if (!me) return;
    writeConnection(username, 'zoho', {
      ...conn,
      account: me.email || conn.account || null,
      agentId: me.id || null,
      agentName: me.name || null,
    });
  } catch {
    // Si falla, la tarjeta simplemente sigue sin nombre; no se rompe nada.
  }
}

export default {
  name: 'connections',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', asyncHandler(async (req, res) => {
      const username = userOf(req);
      await healZohoIdentity(username);
      res.json({
        providers: PROVIDERS.map((p) => {
          const { grantedScopes, missingScopes } = scopesForResponse(username, p.id, p.scopes);
          return {
            id: p.id,
            label: p.label,
            scopes: p.scopes,
            grantedScopes,
            missingScopes,
            configured: appConfigured(p.id),
            ...connectionStatus(username, p.id),
            lastAttempt: lastAttempt(username, p.id),
          };
        }),
        isAdmin: isAdmin(req),
      });
    }));

    r.get('/app', asyncHandler((req, res) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ error: 'Solo un administrador puede ver la configuración de la app OAuth.' });
      }
      res.json(appConfigResponse());
    }));

    r.post('/app', asyncHandler((req, res) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ error: 'Solo un administrador puede ver la configuración de la app OAuth.' });
      }

      const body = req.body || {};
      const { provider } = body;
      if (!isProvider(provider)) return res.status(400).json({ error: 'Proveedor desconocido.' });

      const keys = provider === 'microsoft' ? ['clientId', 'tenantId'] : ['clientId', 'clientSecret', 'dc'];
      const patch = {};
      for (const key of keys) {
        if (Object.hasOwn(body, key)) patch[key] = body[key];
      }

      try {
        writeAppConfig({ [provider]: patch });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
      res.json({ ok: true });
    }));

    r.post('/:provider/connect', asyncHandler(async (req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      if (!appConfigured(provider)) {
        const needSecret = provider === 'zoho' ? ' y el Client Secret' : '';
        return res.status(409).json({
          error: `La app OAuth de ${labelOf(provider)} todavía no está configurada. Un administrador debe cargar el Client ID${needSecret}.`,
        });
      }

      const username = userOf(req);
      const cfg = readAppConfig();
      const jobId = newJobId();

      if (provider === 'microsoft') {
        const { clientId, tenantId } = cfg.microsoft;
        let flow;
        try {
          flow = await startDeviceFlow({ clientId, tenantId });
        } catch (e) {
          return res.status(502).json({ error: e.message });
        }

        writeJob(username, jobId, {
          provider: 'microsoft',
          status: 'pending',
          mode: 'device',
          createdAt: Date.now(),
          expiresAt: Date.now() + flow.expiresIn * 1000,
          error: null,
        });
        pollMicrosoft(username, jobId, {
          clientId,
          tenantId,
          deviceCode: flow.deviceCode,
          interval: flow.interval,
          expiresIn: flow.expiresIn,
        }).catch(() => {});

        return res.json({
          mode: 'device',
          jobId,
          userCode: flow.userCode,
          verificationUri: flow.verificationUri,
          expiresIn: flow.expiresIn,
        });
      }

      const { clientId, dc } = cfg.zoho;
      writeJob(username, jobId, {
        provider: 'zoho',
        status: 'pending',
        mode: 'paste',
        createdAt: Date.now(),
        error: null,
      });
      res.json({
        mode: 'paste',
        jobId,
        authUrl: authUrl({ clientId, dc }),
        scopes: ZOHO_SCOPES.join(','),
      });
    }));

    r.post('/:provider/code', asyncHandler(async (req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      const username = userOf(req);
      const jobId = req.body?.jobId;
      if (!JOB_ID_RE.test(jobId || '')) return res.status(400).json({ error: 'jobId inválido.' });

      const job = readJob(username, jobId);
      if (!job || job.provider !== provider) return res.status(404).json({ error: 'Job inexistente.' });
      if (provider === 'microsoft') {
        return res.status(400).json({ error: 'Microsoft se conecta con el código del dispositivo, no hace falta pegar nada.' });
      }

      const value = String(req.body?.value || '').trim();
      if (!value) return res.status(400).json({ error: 'Pegá el grant code de Zoho.' });

      const { clientId, clientSecret, dc } = readAppConfig().zoho;
      let tokens;
      try {
        tokens = await exchangeCode({ clientId, clientSecret, code: value, dc });
      } catch (e) {
        patchJob(username, jobId, { status: 'error', error: e.message });
        return res.status(502).json({ error: e.message });
      }

      // getOrg/getZohoMe pueden fallar (timeout, rate limit) DESPUÉS de consumir
      // el grant code (un solo uso): NO perder los tokens ya obtenidos. La
      // identidad se completa luego con healZohoIdentity. Simétrico con el flujo
      // de Microsoft (pollMicrosoft), que persiste aunque getMicrosoftMe falle.
      let org = null;
      let me = null;
      try {
        org = await getOrg(tokens.access_token, dc);
        me = await getZohoMe(tokens.access_token, dc, org?.id, config.instance?.identity?.email);
      } catch (e) {
        console.error('[connections] identidad Zoho falló tras el exchange; se persiste sin nombre:', e?.message);
      }
      const account = me?.email || null;
      writeConnection(username, 'zoho', {
        provider: 'zoho',
        account,
        orgId: org?.id || null,
        orgName: org?.name || null,
        agentId: me?.id || null,
        agentName: me?.name || null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        scopes: ZOHO_SCOPES,
        connectedAt: new Date().toISOString(),
        error: null,
      });
      patchJob(username, jobId, { status: 'connected', account, error: null });
      res.json({ ok: true });
    }));

    r.get('/:provider/status', asyncHandler((req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      const username = userOf(req);
      const jobId = req.query.jobId;
      const job = readJob(username, jobId);
      if (!job) return res.status(404).json({ error: 'Job inexistente.' });
      // Auto-sanado tras reinicio: pollMicrosoft vive en memoria del proceso; si
      // el server se reinició mientras el usuario esperaba la aprobación del
      // device code, el loop murió y el job quedaría 'pending' para siempre. Si
      // ya venció, lo marcamos 'error' en la lectura para no dejar colgado al front.
      if (job.status === 'pending' && job.expiresAt && Date.now() > job.expiresAt) {
        patchJob(username, jobId, { status: 'error', error: 'El código expiró antes de completar la autorización.' });
        job.status = 'error';
        job.error = 'El código expiró antes de completar la autorización.';
      }
      res.json({
        status: job.status,
        ...(job.account ? { account: job.account } : {}),
        ...(job.error ? { error: job.error } : {}),
      });
    }));

    r.post('/:provider/disconnect', asyncHandler((req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      // Esto solo borra el token local del usuario; la revocación remota se
      // gestiona desde el panel del proveedor.
      deleteConnection(userOf(req), provider);
      res.json({ ok: true });
    }));

    r.post('/:provider/cancel', asyncHandler((req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      const removed = cancelAttempts(userOf(req), provider);
      res.json({ ok: true, removed });
    }));

    router.use('/connections', r);
  },
};
