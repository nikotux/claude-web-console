// core/user-hooks.js — toggle per-user de los hooks de Claude Code (observer /
// interfono / pelota) sobre el settings.json del USUARIO (userClaudeDir).
// Espeja las definiciones de bin/install-{observer,interfono,pelota}.js pero
// contra un target arbitrario (no ~/.claude fijo). Aditivo/reversible por MARCA:
// enable = agrega nuestras entradas; disable = las quita; SIEMPRE preserva las
// entradas AJENAS. Los instaladores standalone del HOST siguen sin tocarse.
// SP8-4 (PLAN-594, DOC-677). Gotcha: un runner ya vivo no toma el cambio hasta
// reabrir (los hooks se capturan al iniciar Claude Code).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-write.js';
import { userClaudeDir } from './user-space.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OBSERVE = path.join(REPO, 'bin', 'cwc-observe.js');
const BUS = path.join(REPO, 'bin', 'cwc-bus.js');

const PELOTA_REMINDER = "🎾 [cwc-pelota] Recordatorio de formato: cerrá tu respuesta con UNA línea final '🎾 Pelota: ...' — nadie (🟢 nada pendiente, puede cerrar) / TUYA (🟡 + la acción exacta que le pedís al usuario) / MÍA (🔵 seguís trabajando vos) / OTRO (📨 quién y qué la libera). Es lo ÚLTIMO del mensaje.";

// Registro declarativo de los 3 hooks. `mark` = string que identifica NUESTRAS
// entradas (para filtrarlas al reemplazar). `hooks` = { event: [entry...] } que
// se AGREGAN al habilitar. `statusLine` opcional (solo observer).
const HOOK_DEFS = {
  observer: {
    name: 'Observador de estado',
    mark: 'cwc-observe.js',
    statusLine: { type: 'command', command: `node ${OBSERVE} statusline` },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${OBSERVE} working` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `node ${OBSERVE} waiting` }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: `node ${OBSERVE} ended` }] }],
    },
  },
  interfono: {
    name: 'Interfono entre sesiones',
    mark: 'cwc-bus.js',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `node ${BUS} hook-inject` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${BUS} hook-inject` }] }],
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: `node ${BUS} hook-guard` }] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: `node ${BUS} hook-claim` }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: `node ${BUS} hook-release` }] }],
    },
  },
  pelota: {
    name: 'La pelota (cierre de turno)',
    mark: 'cwc-pelota',
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo "${PELOTA_REMINDER.replace(/"/g, '\\\\"')}"` }] }],
    },
  },
};

export function hookIds() { return Object.keys(HOOK_DEFS); }

function settingsPath(userId) { return path.join(userClaudeDir(userId), 'settings.json'); }

function readSettings(userId) {
  try { return JSON.parse(fs.readFileSync(settingsPath(userId), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    // Existe pero no parsea: NO pisar config ajena. Propagar como error.
    throw Object.assign(new Error(`El settings.json del usuario existe pero no es JSON válido: ${e.message}`), { badRequest: true });
  }
}

// ¿Está habilitado un hook? True si alguna entrada de sus eventos (o la
// statusLine, para observer) contiene su MARCA en el settings del usuario.
function isEnabled(settings, def) {
  if (def.statusLine && settings.statusLine && JSON.stringify(settings.statusLine).includes(def.mark)) return true;
  const hooks = settings.hooks || {};
  for (const event of Object.keys(def.hooks)) {
    if ((hooks[event] || []).some((e) => JSON.stringify(e).includes(def.mark))) return true;
  }
  return false;
}

// Estado de los 3 hooks para el usuario: [{id, name, enabled}].
export function readHooksState(userId) {
  const settings = readSettings(userId);
  return hookIds().map((id) => ({ id, name: HOOK_DEFS[id].name, enabled: isEnabled(settings, HOOK_DEFS[id]) }));
}

// Habilita/deshabilita un hook. Aditivo/reversible por marca: filtra SIEMPRE
// nuestras entradas previas (idempotente) y, si enabled, agrega las frescas;
// preserva las entradas AJENAS. Escritura atómica.
export function setHookEnabled(userId, id, enabled) {
  const def = HOOK_DEFS[id];
  if (!def) throw Object.assign(new Error(`Hook desconocido: ${id}`), { badRequest: true });
  const settings = readSettings(userId);
  settings.hooks = settings.hooks || {};

  // statusLine (solo observer): quitar la nuestra; si enabled, ponerla — salvo
  // que exista una AJENA (no la pisamos).
  if (def.statusLine) {
    const cur = settings.statusLine;
    const ours = cur && JSON.stringify(cur).includes(def.mark);
    if (!enabled && ours) delete settings.statusLine;
    else if (enabled) {
      if (!cur || ours) settings.statusLine = def.statusLine;
      // si hay una statusLine ajena, se respeta (no se toca).
    }
  }

  for (const [event, entries] of Object.entries(def.hooks)) {
    const kept = (settings.hooks[event] || []).filter((e) => !JSON.stringify(e).includes(def.mark));
    if (enabled) kept.push(...entries);
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }

  const p = settingsPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(settings, null, 2) + '\n', { mode: 0o644 });
  return readHooksState(userId).find((h) => h.id === id);
}
