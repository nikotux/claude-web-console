// modules/projects/personalization.js — superficies per-USUARIO-GLOBAL del
// panel de personalización (SP8, PLAN-594). Scope `me`: el userId SIEMPRE se
// deriva de principalOf(req) (nunca de input del cliente) → cero traversal.
// Se monta sobre el router de `projects` (ver index.js). Contrato: DOC-677.
import { principalOf } from '../../core/auth.js';
import { loadInstance, saveInstance } from '../../core/instance-config.js';
import { systemScopeFor } from '../../core/system-scope.js';
import { hostUser, userGlobalClaudePath } from '../../core/user-space.js';
import { readHooksState, setHookEnabled } from '../../core/user-hooks.js';
import { readPrefs, writePrefs } from '../../core/user-prefs.js';
import {
  listSectionsOfFile, readSectionOfFile, writeSectionOfFile, readTextFile, hashOf,
} from './memory.js';
import {
  analyzeJobId, readAnalyzeJob, writeAnalyzeJob, spawnAnalyzeRunner, jobResult, isFreshRunning,
} from './analyze-shared.js';

// PLAN-2117: el token maestro/admin ES el host; sin principal no es nadie.
export function uidForPrincipal(principal) {
  if (!principal) {
    const error = new Error('uidOf: request sin principal');
    error.statusCode = 401;
    throw error;
  }
  if (principal.username) return principal.username;
  if (principal.type === 'token' || principal.admin) return hostUser();
  const error = new Error('uidOf: principal sin username');
  error.statusCode = 403;
  throw error;
}

export function uidOf(req) {
  return uidForPrincipal(principalOf(req));
}

const statusFor = (e, fallback) => e.statusCode || fallback;
const messageFor = (e, fallback) => (e.statusCode ? 'No autorizado.' : fallback);

export function pickIdentity(body) {
  const nested = body?.identity;
  const source = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : body;
  const clean = {};
  for (const field of ['name', 'email', 'github', 'signature']) {
    if (source && Object.prototype.hasOwnProperty.call(source, field)) {
      clean[field] = String(source[field] ?? '').trim().slice(0, 200);
    }
  }
  return clean;
}

export function mountPersonalization(r) {
  // ── CLAUDE.md GLOBAL per-user, editable por secciones (SP8-3, el corazón) ──
  r.get('/me/global/sections', (req, res) => {
    try { res.json(listSectionsOfFile(userGlobalClaudePath(uidOf(req)))); }
    catch (e) { res.status(statusFor(e, 500)).json({ error: messageFor(e, 'No se pudo leer el CLAUDE.md global.') }); }
  });

  r.get('/me/global/section/:i', (req, res) => {
    try { res.json(readSectionOfFile(userGlobalClaudePath(uidOf(req)), req.params.i)); }
    catch (e) {
      res.status(statusFor(e, e.badRequest ? 400 : 500)).json({ error: messageFor(e, e.message || 'No se pudo leer la sección.') });
    }
  });

  // Self-edit: el usuario edita SU propio global (scope `me`, userId saneado) →
  // authenticated basta (ya gateado por el apiRouter). Hash/409 igual que projects.
  r.post('/me/global/section/:i', (req, res) => {
    try {
      writeSectionOfFile(userGlobalClaudePath(uidOf(req)), req.params.i, req.body?.hash, String(req.body?.content ?? ''));
      res.json({ ok: true });
    } catch (e) {
      res.status(statusFor(e, e.conflict ? 409 : (e.badRequest ? 400 : 500)))
        .json({ error: messageFor(e, e.message || 'No se pudo guardar la sección.') });
    }
  });

  // Guardián IA opcional del cambio (reusa analyze-shared, key sintética 'me-global').
  r.post('/me/global/section/:i/analyze', (req, res) => {
    try {
      const owner = uidOf(req);
      const sec = readSectionOfFile(userGlobalClaudePath(owner), req.params.i);
      if (sec.hash !== String(req.body?.hash || '')) {
        return res.status(409).json({ error: 'El contenido cambió desde que abriste esta sección. Recargá y reintentá.' });
      }
      const after = String(req.body?.content ?? '');
      const id = analyzeJobId('me-global', req.params.i, sec.hash, after, owner);
      const job = readAnalyzeJob(id, owner);
      if (job && (isFreshRunning(job, owner) || job.status === 'done')) {
        return res.json({ ok: true, id, ...jobResult(job, owner) });
      }
      const pending = {
        status: 'running', key: 'me-global', section: String(req.params.i),
        before: sec.text, after, startedAt: Date.now(), updatedAt: Date.now(),
      };
      writeAnalyzeJob(id, pending, owner);
      try {
        spawnAnalyzeRunner(id, owner);
      } catch (e) {
        writeAnalyzeJob(id, {
          ...pending, status: 'error', analysis: null,
          error: String(e?.message || e).slice(0, 300), updatedAt: Date.now(),
        }, owner);
        throw e;
      }
      res.json({ ok: true, id, status: 'running', analysis: null, error: null });
    } catch (e) {
      res.status(statusFor(e, e.badRequest ? 400 : (e.conflict ? 409 : 500)))
        .json({ error: messageFor(e, String(e?.message || e).slice(0, 300)) });
    }
  });

  r.get('/me/global/section/:i/analyze/:id', (req, res) => {
    try {
      if (!/^[0-9a-f]{24}$/.test(String(req.params.id))) {
        return res.status(400).json({ error: 'Id de análisis inválido.' });
      }
      const owner = uidOf(req);
      const job = readAnalyzeJob(req.params.id, owner);
      if (!job) return res.status(404).json({ error: 'Análisis inexistente (¿expiró?).' });
      res.json({ ok: true, id: req.params.id, ...jobResult(job, owner) });
    } catch (e) {
      res.status(statusFor(e, 500)).json({ error: messageFor(e, String(e?.message || e).slice(0, 300)) });
    }
  });

  // ── Hooks (settings.json) per-user, toggle aditivo/reversible (SP8-4) ──
  r.get('/me/hooks', (req, res) => {
    try { res.json({ hooks: readHooksState(uidOf(req)) }); }
    catch (e) {
      res.status(statusFor(e, e.badRequest ? 400 : 500)).json({ error: messageFor(e, e.message || 'No se pudo leer los hooks.') });
    }
  });

  r.post('/me/hooks/:id', (req, res) => {
    try {
      const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
      const state = setHookEnabled(uidOf(req), req.params.id, enabled);
      res.json({ ok: true, hook: state });
    } catch (e) {
      res.status(statusFor(e, e.badRequest ? 400 : 500)).json({ error: messageFor(e, e.message || 'No se pudo cambiar el hook.') });
    }
  });

  // ── Defaults de modelo/effort/permisos per-user (SP8-5) ──
  r.get('/me/prefs', (req, res) => {
    try { res.json({ prefs: readPrefs(uidOf(req)) }); }
    catch (e) { res.status(statusFor(e, 500)).json({ error: messageFor(e, 'No se pudo leer las preferencias.') }); }
  });

  r.post('/me/prefs', (req, res) => {
    try { res.json({ ok: true, prefs: writePrefs(uidOf(req), req.body || {}) }); }
    catch (e) {
      res.status(statusFor(e, e.badRequest ? 400 : 500))
        .json({ error: messageFor(e, e.message || 'No se pudo guardar las preferencias.') });
    }
  });

  // ── Identidad per-user ──
  // El dataDir sale SIEMPRE del principal; para el host resuelve a ~/.cwc-data
  // (retrocompat total). La allowlist de cuatro campos es defensa en profundidad.
  r.get('/me/identity', (req, res) => {
    try {
      const scope = systemScopeFor(req);
      const identity = loadInstance({ dataDir: scope.dataDir })?.identity
        || { name: '', email: '', github: '', signature: '' };
      res.json({ identity, source: 'user', editable: true, perUserIdentityAvailable: true });
    } catch (e) {
      res.status(statusFor(e, 500)).json({ error: messageFor(e, 'No se pudo leer la identidad.') });
    }
  });

  r.post('/me/identity', (req, res) => {
    try {
      const scope = systemScopeFor(req);
      const clean = pickIdentity(req.body);
      const next = saveInstance({ identity: clean }, { dataDir: scope.dataDir });
      res.json({ ok: true, identity: next.identity });
    } catch (e) {
      res.status(statusFor(e, 500)).json({ error: messageFor(e, 'No se pudo guardar la identidad.') });
    }
  });
}
