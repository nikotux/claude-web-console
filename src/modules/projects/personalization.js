// modules/projects/personalization.js — superficies per-USUARIO-GLOBAL del
// panel de personalización (SP8, PLAN-594). Scope `me`: el userId SIEMPRE se
// deriva de principalOf(req) (nunca de input del cliente) → cero traversal.
// Se monta sobre el router de `projects` (ver index.js). Contrato: DOC-677.
import { principalOf } from '../../core/auth.js';
import { loadInstance } from '../../core/instance-config.js';
import { hostUser, userGlobalClaudePath } from '../../core/user-space.js';
import { readHooksState, setHookEnabled } from '../../core/user-hooks.js';
import { readPrefs, writePrefs } from '../../core/user-prefs.js';
import {
  listSectionsOfFile, readSectionOfFile, writeSectionOfFile, readTextFile, hashOf,
} from './memory.js';
import {
  analyzeJobId, readAnalyzeJob, writeAnalyzeJob, spawnAnalyzeRunner, jobResult, isFreshRunning,
} from './analyze-shared.js';

// userId del dueño de la request. Un principal por token (username null) o el
// host mapean al host → su ~/.claude/CLAUDE.md real (retrocompat).
const uidOf = (req) => (principalOf(req)?.username || hostUser());

export function mountPersonalization(r) {
  // ── CLAUDE.md GLOBAL per-user, editable por secciones (SP8-3, el corazón) ──
  r.get('/me/global/sections', (req, res) => {
    try { res.json(listSectionsOfFile(userGlobalClaudePath(uidOf(req)))); }
    catch { res.status(500).json({ error: 'No se pudo leer el CLAUDE.md global.' }); }
  });

  r.get('/me/global/section/:i', (req, res) => {
    try { res.json(readSectionOfFile(userGlobalClaudePath(uidOf(req)), req.params.i)); }
    catch (e) { res.status(e.badRequest ? 400 : 500).json({ error: e.message || 'No se pudo leer la sección.' }); }
  });

  // Self-edit: el usuario edita SU propio global (scope `me`, userId saneado) →
  // authenticated basta (ya gateado por el apiRouter). Hash/409 igual que projects.
  r.post('/me/global/section/:i', (req, res) => {
    try {
      writeSectionOfFile(userGlobalClaudePath(uidOf(req)), req.params.i, req.body?.hash, String(req.body?.content ?? ''));
      res.json({ ok: true });
    } catch (e) {
      res.status(e.conflict ? 409 : (e.badRequest ? 400 : 500)).json({ error: e.message || 'No se pudo guardar la sección.' });
    }
  });

  // Guardián IA opcional del cambio (reusa analyze-shared, key sintética 'me-global').
  r.post('/me/global/section/:i/analyze', (req, res) => {
    try {
      const sec = readSectionOfFile(userGlobalClaudePath(uidOf(req)), req.params.i);
      if (sec.hash !== String(req.body?.hash || '')) {
        return res.status(409).json({ error: 'El contenido cambió desde que abriste esta sección. Recargá y reintentá.' });
      }
      const after = String(req.body?.content ?? '');
      const id = analyzeJobId('me-global', req.params.i, sec.hash, after);
      const job = readAnalyzeJob(id);
      if (job && (isFreshRunning(job) || job.status === 'done')) {
        return res.json({ ok: true, id, ...jobResult(job) });
      }
      writeAnalyzeJob(id, {
        status: 'running', key: 'me-global', section: String(req.params.i),
        before: sec.text, after, startedAt: Date.now(), updatedAt: Date.now(),
      });
      spawnAnalyzeRunner(id);
      res.json({ ok: true, id, status: 'running', analysis: null, error: null });
    } catch (e) {
      res.status(e.badRequest ? 400 : (e.conflict ? 409 : 500)).json({ error: String(e?.message || e).slice(0, 300) });
    }
  });

  r.get('/me/global/section/:i/analyze/:id', (req, res) => {
    try {
      if (!/^[0-9a-f]{24}$/.test(String(req.params.id))) {
        return res.status(400).json({ error: 'Id de análisis inválido.' });
      }
      const job = readAnalyzeJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Análisis inexistente (¿expiró?).' });
      res.json({ ok: true, id: req.params.id, ...jobResult(job) });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  });

  // ── Hooks (settings.json) per-user, toggle aditivo/reversible (SP8-4) ──
  r.get('/me/hooks', (req, res) => {
    try { res.json({ hooks: readHooksState(uidOf(req)) }); }
    catch (e) { res.status(e.badRequest ? 400 : 500).json({ error: e.message || 'No se pudo leer los hooks.' }); }
  });

  r.post('/me/hooks/:id', (req, res) => {
    try {
      const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
      const state = setHookEnabled(uidOf(req), req.params.id, enabled);
      res.json({ ok: true, hook: state });
    } catch (e) {
      res.status(e.badRequest ? 400 : 500).json({ error: e.message || 'No se pudo cambiar el hook.' });
    }
  });

  // ── Defaults de modelo/effort/permisos per-user (SP8-5) ──
  r.get('/me/prefs', (req, res) => {
    try { res.json({ prefs: readPrefs(uidOf(req)) }); }
    catch { res.status(500).json({ error: 'No se pudo leer las preferencias.' }); }
  });

  r.post('/me/prefs', (req, res) => {
    try { res.json({ ok: true, prefs: writePrefs(uidOf(req), req.body || {}) }); }
    catch (e) { res.status(e.badRequest ? 400 : 500).json({ error: e.message || 'No se pudo guardar las preferencias.' }); }
  });

  // ── Identidad per-user (frontera SP2: SP8 la EXPONE; SP2 habilita el write) ──
  r.get('/me/identity', (req, res) => {
    try {
      // SP2 aún no migró la identidad per-user → se muestra la del HOST en
      // modo LECTURA con flag. Cuando SP2 provea el store per-user, editable→true.
      const identity = loadInstance()?.identity || { name: '', email: '', github: '', signature: '' };
      res.json({ identity, source: 'host-fallback', editable: false, perUserIdentityAvailable: false });
    } catch { res.status(500).json({ error: 'No se pudo leer la identidad.' }); }
  });

  r.post('/me/identity', (req, res) => {
    // La escritura de identidad per-user es trabajo de SP2 (instance.json →
    // per-user). Hasta que SP2 migre, este endpoint no persiste.
    res.status(501).json({ error: 'La edición de identidad per-user aún no está disponible (la habilita SP2).' });
  });
}
