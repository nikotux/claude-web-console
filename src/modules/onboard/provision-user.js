import { provisionUserPad } from '../../core/pad-provision.js';
import { provisionUserWorkspace } from '../../core/workspace-provision.js';
import {
  ensureCliOnboarded,
  ensureUserSpace,
  userClaudeDir,
} from '../../core/user-space.js';
import { installDefaults } from '../skills/catalog.js';
import { provisionTolkienMcp } from './tolkien-mcp-shared.js';
import { markProvisionStep, startProvision } from './provision-state.js';

function redact(s) {
  return String(s || '')
    .replace(/mcp_[A-Za-z0-9_-]+/g, 'mcp_****')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-****');
}

export async function provisionTolkienBestEffort(user) {
  try {
    const result = await provisionTolkienMcp(user);
    if (!result.ok) console.error('[onboard] provisioning de Tolkien MCP best-effort falló:', redact(result.error || result.reason));
  } catch (e) {
    console.error('[onboard] provisioning de Tolkien MCP best-effort excepción:', redact(e?.message || e));
  }
}

export function provisionNewUser(username) {
  try { ensureUserSpace(username); ensureCliOnboarded(username); } catch { /* best-effort: el space se re-asegura al spawnear */ }
  // El provisioning sigue corriendo DESPUÉS de responder — deliberado, para no
  // bloquear el alta — pero su resultado YA NO se pierde en el journal: queda
  // persistido para el checklist final del wizard y para el check
  // `onboard-provisioning` de Salud (console:BUG-2118).
  startProvision(username);
  // Pad PROPIO del inquilino (B2-F3): si el Pad local está caído, el chat
  // funciona igual y el provisioning se reintenta lazy al primer uso (F8).
  // NUNCA await acá.
  provisionUserPad(username, { name: username })
    .then((r) => {
      if (!r.ok) console.error('[onboard] provisioning de Pad best-effort falló:', r.error);
      markProvisionStep(username, 'pad', r.ok ? 'ok' : 'failed', r.ok ? null : r.error);
    })
    .catch((e) => {
      console.error('[onboard] provisioning de Pad best-effort excepción:', e?.message || e);
      markProvisionStep(username, 'pad', 'failed', e?.message || e);
    });
  // Clon del repo de trabajo (Tolkien) en el workspace del inquilino
  // (SP9-7/TASK-673), best-effort e idempotente. `skipped` es el host: cuenta
  // como paso resuelto, no como fallo.
  provisionUserWorkspace(username)
    .then(async (r) => {
      const done = !!(r.ok || r.skipped);
      if (!done) console.error('[onboard] clon de workspace best-effort falló:', r.error);
      markProvisionStep(username, 'workspace', done ? 'ok' : 'failed', done ? null : r.error);
      if (done) await provisionTolkienBestEffort(username);
    })
    .catch((e) => {
      console.error('[onboard] clon de workspace excepción:', e?.message || e);
      markProvisionStep(username, 'workspace', 'failed', e?.message || e);
    });
  // Skills base del catálogo, best-effort. Se difiere con una Promise para que
  // la copia síncrona de archivos no bloquee el handler ni demore la respuesta.
  // NUNCA await acá.
  Promise.resolve()
    .then(() => installDefaults(userClaudeDir(username)))
    .then((r) => {
      const failed = r.failed.map((item) => item.dirName);
      const error = failed.length ? `Skills del catálogo fallidas: ${failed.join(', ')}` : null;
      if (error) console.error('[onboard] provisioning de skills best-effort falló:', error);
      markProvisionStep(username, 'skills', error ? 'failed' : 'ok', error);
    })
    .catch((e) => {
      console.error('[onboard] provisioning de skills best-effort excepción:', e?.message || e);
      markProvisionStep(username, 'skills', 'failed', e?.message || e);
    });
}
