// core/forbidden-actions.js — REGISTRO de ACCIONES PROHIBIDAS por lección (M5 de
// DOC-1926 / PLAN-1934). Es el ÚNICO mecanismo de la casa que IMPIDE en vez de
// sugerir: lo consume `lessonsPreToolUseHook()` de tool-policy.js, que corre como
// hook `PreToolUse` y por lo tanto es INMUNE a `bypassPermissions` y a las
// allow-rules del ~/.claude/settings.json (gotcha del CLAUDE.md raíz: canUseTool
// NO es capa de seguridad confiable en chat interactivo).
//
// LÍMITE HONESTO (no forzar el mecanismo): sólo entran acá las lecciones
// traducibles a "NUNCA ejecutes X". "Escribí PRs más chicos" NO es una regla de
// este registro y no se puede volver una. Si una lección no calza, se queda en
// los otros destinos de Mejora Continua (memoria/claude-md/contexto/playbook).
//
// DOS FUENTES:
//   1. SEED en código (abajo): reglas con origen documentado en el repo. Siempre
//      compilan — un registro externo roto NO puede desactivarlas.
//   2. EXTRA en disco: <dataDir>/forbidden-actions.json, para sumar reglas
//      adoptadas después sin tocar código. Se lee con caché por mtime y FALLA
//      ABIERTO (un JSON corrupto no puede tapar la consola entera).
//
// OVERRIDE CONSCIENTE Y REGISTRADO: un gate ciego se vuelve un obstáculo. El
// override se pide con `bin/cwc-forbidden-override.js <regla> "<motivo>"`, exige
// un motivo real, dura minutos, es de UN SOLO USO y queda en el ledger
// <dataDir>/forbidden-overrides.json. El hook lo CONSUME al aplicarlo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from './data-dir.js';
import { writeJsonAtomic } from './atomic-write.js';

const CONSOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Cada regla: { id, lesson (origen citable), title, pattern (regex string),
// why (por qué duele), hint (qué hacer en su lugar), match: 'bash'|'path',
// tools: [nombres de tool], enabled }.
export const SEED_FORBIDDEN_ACTIONS = [
  {
    id: 'git-descarta-cambios-ajenos',
    lesson: 'CLAUDE.md raíz · Gotchas conocidos',
    title: 'Nunca `git checkout --` / `git restore` para limpiar una prueba',
    match: 'bash',
    pattern: '(?:^|[\\s;&|(])git\\s+(?:checkout\\s+--(?:\\s|$)|restore\\s+(?!--staged))',
    why: 'Pasó de verdad: descartó los cambios SIN COMMITEAR de una sesión paralela sobre el mismo archivo y hubo que recuperarlos desde los transcripts de ~/.claude/projects.',
    hint: 'Revertí aplicando el cambio INVERSO (deshacé lo tuyo, no el árbol) y mirá `git status` ANTES de decidir que un archivo está limpio.',
  },
  {
    id: 'pkill-server-mata-el-shell',
    lesson: 'CLAUDE.md raíz · Gotchas conocidos',
    title: 'Nunca `pkill -f src/server.js`',
    match: 'bash',
    pattern: '(?:^|[\\s;&|(])(?:pkill|killall)\\s+[^;&|]*src/server\\.js',
    why: 'El patrón matchea el propio comando y mata al shell que lo ejecuta, dejando el server en un estado indefinido.',
    hint: 'Reiniciá SIEMPRE con `systemctl --user restart claude-web-console`.',
  },
  {
    id: 'reboot-de-la-maquina',
    lesson: 'memoria de Niko · feedback-nunca-reboot-maquina',
    title: 'Nunca reiniciar/apagar la MÁQUINA física',
    match: 'bash',
    pattern: '(?:^|[\\s;&|(])(?:sudo\\s+)?(?:reboot|shutdown|halt|poweroff|systemctl\\s+(?:reboot|poweroff|halt)|init\\s+[06])(?:\\s|$)',
    why: 'Instrucción explícita de Niko: la máquina corre sesiones tmux, runners y servicios de otras personas; un reboot los mata a todos sin aviso.',
    hint: 'Reiniciar el SERVICIO sí está permitido: `systemctl --user restart claude-web-console`.',
  },
];

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const MATCH_KINDS = ['bash', 'path'];
const PATTERN_MAX = 400;

function compileRule(raw, origin) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!ID_RE.test(id)) return null;
  if (raw.enabled === false) return null;
  const pattern = String(raw.pattern || '');
  if (!pattern || pattern.length > PATTERN_MAX) return null;
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { return null; }
  const match = MATCH_KINDS.includes(raw.match) ? raw.match : 'bash';
  const tools = Array.isArray(raw.tools) && raw.tools.length
    ? raw.tools.map((t) => String(t)).slice(0, 12)
    : (match === 'bash' ? ['Bash'] : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  return {
    id,
    lesson: String(raw.lesson || '').slice(0, 200),
    title: String(raw.title || id).slice(0, 200),
    why: String(raw.why || '').slice(0, 600),
    hint: String(raw.hint || '').slice(0, 600),
    match,
    tools,
    pattern,
    re,
    origin,
  };
}

// ---- registro EXTRA en disco (caché por mtime, falla abierto) ----
function extraFile() { return path.join(resolveDataDir(), 'forbidden-actions.json'); }
let extraCache = { file: '', mtimeMs: -1, rules: [] };
function loadExtraRules() {
  const file = extraFile();
  let st = null;
  try { st = fs.statSync(file); } catch { extraCache = { file, mtimeMs: -1, rules: [] }; return []; }
  if (extraCache.file === file && extraCache.mtimeMs === st.mtimeMs) return extraCache.rules;
  let rules = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rules) ? parsed.rules : []);
    rules = list.map((r) => compileRule(r, 'disco')).filter(Boolean).slice(0, 200);
  } catch {
    rules = []; // FALLA ABIERTO: un registro externo roto no puede tapar la consola
  }
  extraCache = { file, mtimeMs: st.mtimeMs, rules };
  return rules;
}

// Reglas activas = SEED (siempre) + EXTRA de disco (el id del seed gana).
export function listForbiddenActions() {
  const seed = SEED_FORBIDDEN_ACTIONS.map((r) => compileRule(r, 'seed')).filter(Boolean);
  const seen = new Set(seed.map((r) => r.id));
  const out = seed.slice();
  for (const r of loadExtraRules()) { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } }
  return out;
}

export function getForbiddenAction(id) {
  return listForbiddenActions().find((r) => r.id === id) || null;
}

// Evalúa UNA tool call. `command` debe venir YA normalizado (fuera de comillas,
// espacios colapsados) desde tool-policy.js — así no duplicamos el parser de shell.
export function evaluateForbiddenAction({ toolName, toolInput, command } = {}) {
  const name = String(toolName || '');
  if (!name) return null;
  for (const rule of listForbiddenActions()) {
    if (!rule.tools.includes(name)) continue;
    if (rule.match === 'bash') {
      const cmd = String(command || '');
      if (cmd && rule.re.test(cmd)) return rule;
    } else {
      const target = String(toolInput?.file_path || toolInput?.path || '');
      if (target && rule.re.test(target)) return rule;
    }
  }
  return null;
}

export function forbiddenDenyMessage(rule) {
  const lines = [
    `⛔ ACCIÓN PROHIBIDA POR LECCIÓN (${rule.id}${rule.lesson ? ` · ${rule.lesson}` : ''}): ${rule.title}.`,
  ];
  if (rule.why) lines.push(`POR QUÉ: ${rule.why}`);
  if (rule.hint) lines.push(`EN VEZ DE ESO: ${rule.hint}`);
  lines.push(
    'Este bloqueo es un hook PreToolUse: no lo saltea el modo "Todo" ni una allow-rule.',
    `Si el caso es una EXCEPCIÓN REAL, pedíselo al usuario y, con su OK explícito, registrá el override consciente: node ${CONSOLE_ROOT}/bin/cwc-forbidden-override.js ${rule.id} "<motivo de al menos 20 caracteres>"`,
    'El override dura minutos, sirve UNA sola vez y queda registrado. No lo uses por tu cuenta para esquivar la lección.',
  );
  return lines.join('\n');
}

// ---- overrides conscientes (ledger append-only) ----
const OVERRIDE_MAX = 200;
const MOTIVO_MIN = 20;
export const OVERRIDE_DEFAULT_MINUTES = 10;
const OVERRIDE_MAX_MINUTES = 60;

function overridesFile() { return path.join(resolveDataDir(), 'forbidden-overrides.json'); }
function loadOverrides() {
  try {
    const parsed = JSON.parse(fs.readFileSync(overridesFile(), 'utf8'));
    return Array.isArray(parsed?.grants) ? parsed.grants : [];
  } catch { return []; }
}
function saveOverrides(grants) {
  writeJsonAtomic(overridesFile(), { grants: grants.slice(0, OVERRIDE_MAX) }, { space: 2 });
}

export function grantForbiddenOverride({ ruleId, motivo, by = null, chatId = null, minutes = OVERRIDE_DEFAULT_MINUTES } = {}) {
  const rule = getForbiddenAction(String(ruleId || ''));
  if (!rule) { const e = new Error(`No existe la regla prohibitiva "${ruleId}".`); e.code = 'unknown_rule'; throw e; }
  const m = String(motivo || '').trim();
  if (m.length < MOTIVO_MIN) { const e = new Error(`El motivo del override debe tener al menos ${MOTIVO_MIN} caracteres (es el registro de por qué se saltea la lección).`); e.code = 'bad_motivo'; throw e; }
  const mins = Math.max(1, Math.min(OVERRIDE_MAX_MINUTES, Number(minutes) || OVERRIDE_DEFAULT_MINUTES));
  const now = Date.now();
  const grant = {
    id: `OV-${now}-${crypto.randomBytes(3).toString('hex')}`,
    ruleId: rule.id,
    motivo: m.slice(0, 500),
    by: by ? String(by).slice(0, 80) : null,
    chatId: chatId ? String(chatId).slice(0, 120) : null,
    at: now,
    expiresAt: now + mins * 60_000,
    consumedAt: 0,
    usedByChat: null,
  };
  const grants = loadOverrides();
  grants.unshift(grant);
  saveOverrides(grants);
  return grant;
}

// Consume (UN SOLO USO) un override vivo para `ruleId`. Devuelve el grant o null.
export function consumeForbiddenOverride(ruleId, { chatId = null } = {}) {
  const grants = loadOverrides();
  const now = Date.now();
  const i = grants.findIndex((g) => g && g.ruleId === ruleId && !g.consumedAt && Number(g.expiresAt) > now
    && (!g.chatId || !chatId || g.chatId === chatId));
  if (i < 0) return null;
  grants[i] = { ...grants[i], consumedAt: now, usedByChat: chatId ? String(chatId).slice(0, 120) : null };
  saveOverrides(grants);
  return grants[i];
}

export function listForbiddenOverrides(limit = 20) {
  const n = Math.max(1, Math.min(OVERRIDE_MAX, Number(limit) || 20));
  return loadOverrides().slice(0, n);
}
