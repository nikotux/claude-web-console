// core/user-prefs.js — preferencias per-user del chat (defaults de modelo/
// effort/modo de permisos). Persistido en <userDataDir(userId)>/prefs.json,
// escritura atómica, lectura best-effort. Lo consume POST /api/chat/create
// cuando el body NO trae el valor (el body explícito SIEMPRE gana). SP8-5
// (PLAN-594, DOC-677).
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { userDataDir } from './user-space.js';

// Enums válidos (espejo de public/js/ui/models.js CHAT_MODEL_OPTIONS/EFFORT_OPTIONS
// y core/tool-policy.js PERMISSION_MODES). 'auto' en effort = seguir el tier.
export const PREF_MODEL_CHOICES = new Set(['auto', 'tandem', 'opusplan', 'fable', 'opus', 'sonnet', 'haiku', 'default']);
export const PREF_EFFORTS = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
export const PREF_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan']);

function prefsPath(userId) { return path.join(userDataDir(userId), 'prefs.json'); }

// Lee las prefs del usuario (best-effort → {} si no hay o está corrupto).
// Solo devuelve las claves conocidas y válidas (defensivo).
export function readPrefs(userId) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(prefsPath(userId), 'utf8')) || {}; } catch { return {}; }
  const out = {};
  if (PREF_MODEL_CHOICES.has(raw.defaultModelChoice)) out.defaultModelChoice = raw.defaultModelChoice;
  if (PREF_EFFORTS.has(raw.defaultEffort)) out.defaultEffort = raw.defaultEffort;
  if (PREF_PERMISSION_MODES.has(raw.defaultPermissionMode)) out.defaultPermissionMode = raw.defaultPermissionMode;
  return out;
}

// Escribe un patch (merge sobre lo existente). Valida cada campo contra su
// enum; un valor inválido → error badRequest. Un campo ausente en el patch no
// se toca; un campo con valor null/'' lo BORRA (volver al default del sistema).
export function writePrefs(userId, patch) {
  const cur = readPrefs(userId);
  const next = { ...cur };
  const apply = (key, set) => {
    if (!(key in (patch || {}))) return;
    const v = patch[key];
    if (v == null || v === '') { delete next[key]; return; }
    if (!set.has(v)) throw Object.assign(new Error(`Valor inválido para ${key}: ${v}`), { badRequest: true });
    next[key] = v;
  };
  apply('defaultModelChoice', PREF_MODEL_CHOICES);
  apply('defaultEffort', PREF_EFFORTS);
  apply('defaultPermissionMode', PREF_PERMISSION_MODES);
  const p = prefsPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeJsonAtomic(p, next, { space: 2 });
  return next;
}
