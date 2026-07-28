// modules/onboard/provision-state.js — estado PERSISTIDO del provisioning que
// corre DESPUÉS de responder /register (console:BUG-2118). El registro contesta
// ok:true sin esperar a Pad, workspace ni skills — es deliberado, para no
// bloquear el alta —, así que si alguno falla el único
// rastro era un console.error en el journal que nadie mira en ese momento y el
// inquilino quedaba sin Pad o sin clon del repo sin saber por qué. Acá el
// resultado queda en disco: el wizard lo muestra en su checklist final y el
// check `onboard-provisioning` de Salud se lo canta al admin.
//
// Vive en el HOME del HOST (igual que onboard-jobs/ y onboard-tokens.json): es
// estado de ADMINISTRACIÓN del alta — lo escribe el server y lo lee el admin —,
// no dato user-scoped del inquilino. Escritura ATÓMICA (CONVE-5), mode 600.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';

export const PROVISION_DIR = path.join(config.home, '.cwc-data', 'onboard-provisioning');
export const PROVISION_STEPS = ['pad', 'workspace', 'skills'];
const USER_RE = /^[a-zA-Z0-9_.-]{1,32}$/; // mismo whitelist que isValidUsername
const ERROR_MAX = 200;

// El motivo se guarda SANEADO: nunca un token, nunca un texto sin tope.
function sanitizeError(err) {
  return String((err && err.message) || err || '')
    .replace(/mcp_[A-Za-z0-9_-]+/g, 'mcp_****')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-****')
    .slice(0, ERROR_MAX);
}

function filePath(user) {
  if (!USER_RE.test(String(user || ''))) return null; // nombre fuera del whitelist => no toca disco
  return path.join(PROVISION_DIR, `${user}.json`);
}

// pending si falta algún paso; failed si alguno falló; ok solo si TODOS salieron bien.
export function overallStatus(steps) {
  const values = Object.values(steps || {});
  if (!values.length) return 'pending';
  if (values.some((s) => s.status === 'failed')) return 'failed';
  if (values.some((s) => s.status === 'pending')) return 'pending';
  return 'ok';
}

export function readProvisionState(user) {
  const file = filePath(user);
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Marca el arranque del provisioning de un alta: todos los pasos en pending.
export function startProvision(user, steps = PROVISION_STEPS) {
  const file = filePath(user);
  if (!file) return null;
  const now = Date.now();
  const state = {
    user,
    startedAt: now,
    ts: now,
    status: 'pending',
    steps: Object.fromEntries(steps.map((s) => [s, { status: 'pending', ts: now }])),
  };
  try { writeJsonAtomic(file, state); } catch { /* best-effort: jamás puede romper el alta */ }
  return state;
}

// Cierra un paso. Es read-modify-write y los pasos corren en paralelo, pero
// entre la lectura y la escritura NO hay ningún await: el event loop no puede
// intercalar el otro paso en el medio, así que ninguno pisa la clave del otro.
export function markProvisionStep(user, step, status, error) {
  const file = filePath(user);
  if (!file) return null;
  const state = readProvisionState(user) || { user, startedAt: Date.now(), steps: {} };
  state.steps = state.steps || {};
  state.steps[step] = {
    status,
    ts: Date.now(),
    ...(error ? { error: sanitizeError(error) } : {}),
  };
  state.status = overallStatus(state.steps);
  state.ts = Date.now();
  try { writeJsonAtomic(file, state); } catch { /* best-effort */ }
  return state;
}

// Censo para Salud: todos los estados persistidos, el más reciente primero.
export function listProvisionStates() {
  let names = [];
  try { names = fs.readdirSync(PROVISION_DIR).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names
    .map((n) => readProvisionState(n.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
