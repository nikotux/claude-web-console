// modules/health/shared.js — lo COMPARTIDO entre el módulo server y el runner
// desacoplado de la revisión exhaustiva (bin/cwc-health-runner.js).
//
// La revisión profunda pasó de UNA corrida libre a un BARRIDO módulo por
// módulo: se descubren las "unidades" del proyecto (core + cada módulo de
// src/modules/ + frontend + infra) y se audita CADA una con una corrida IA
// corta (haiku, read-only doble capa), buscando tanto violaciones de las
// reglas de CLAUDE.md como BUGS reales. El progreso se escribe incremental a
// review.json (el front lo encuesta y muestra módulo por módulo). Al final
// una síntesis (sonnet) da el veredicto global. Corre en un runner detached
// (regla 2): un reinicio del server a mitad NO la mata.
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { invariantsFor } from './invariants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del repo
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const REVIEW_FILE = path.join(DATA_DIR, 'health-review.json');
export const LOCK_FILE = path.join(DATA_DIR, 'health-review.lock');
export const LOG_FILE = path.join(DATA_DIR, 'health-review.log');
// Auto-fix (resolución autónoma de un hallazgo): registro durable de resueltos
// (sobrevive a re-análisis, sirve para detectar recurrencias) + lock/log del
// runner desacoplado bin/cwc-healthfix-runner.js.
export const SOLVED_FILE = path.join(DATA_DIR, 'health-solved.json');
export const FIX_LOCK_FILE = path.join(DATA_DIR, 'healthfix.lock');
export const FIX_LOG_FILE = path.join(DATA_DIR, 'healthfix.log');
export const FIX_TIMEOUT_MS = 6 * 60 * 1000; // corte duro del auto-fix
export const FIX_MAX_TURNS = 40;

export const UNIT_TIMEOUT_MS = 3 * 60 * 1000;   // corte por unidad
export const SYNTH_TIMEOUT_MS = 2 * 60 * 1000;  // corte de la síntesis
export const UNIT_MAX_TURNS = 20;               // cota de coste por unidad
export const HEARTBEAT_MS = 3000;
export const LOCK_FRESH_MS = 20000;             // lock más viejo que esto = runner muerto

export const VERDICTS = new Set(['ok', 'atencion', 'critico']);
export const SEVERITY = new Set(['critical', 'high', 'medium', 'low']);
export const KINDS = new Set(['bug', 'regla', 'mejora']); // tipo del hallazgo

// Allowlist de herramientas: SOLO lecturas locales (dos capas — regla 6).
// TodoWrite es la lista de tareas INTERNA del modelo (Agent SDK): solo toca
// estado conversacional, nunca disco — es seguro en una corrida read-only.
export function toolAllowed(name) {
  return ['Read', 'Grep', 'Glob', 'TodoWrite'].includes(name);
}

// Lista los .js de un directorio (recursivo), relativos a ROOT, saltando
// node_modules/.git. Tope por unidad para no inflar el prompt.
function listJs(absDir, { max = 40 } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fss.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) out.push(path.relative(ROOT, p));
    }
  };
  walk(absDir);
  return out.slice(0, max);
}

// Descubre las UNIDADES a auditar. Cada una: { name, label, files[] }.
// El orden es el del barrido; el front lo espeja como grilla de estado.
export function discoverUnits() {
  const units = [];

  // 1) core + bootstrap
  units.push({
    name: 'core',
    label: 'Core (config, auth, wss, paths…)',
    files: [
      'src/server.js',
      ...listJs(path.join(ROOT, 'src', 'core')),
    ].filter((f) => fss.existsSync(path.join(ROOT, f))),
  });

  // 2) un unidad por cada módulo de src/modules/ (+ su runner en bin/ si existe)
  const modDir = path.join(ROOT, 'src', 'modules');
  let mods = [];
  try { mods = fss.readdirSync(modDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* noop */ }
  const binRunners = (() => {
    try { return fss.readdirSync(path.join(ROOT, 'bin')).filter((f) => f.endsWith('.js')); } catch { return []; }
  })();
  for (const m of mods.sort()) {
    const files = listJs(path.join(modDir, m));
    // Adjunta el runner desacoplado del módulo si su nombre lo referencia.
    for (const r of binRunners) {
      // r.includes(m) cubre chat/health/etc.; 'bugs' mapea a su runner
      // 'triage' (el módulo se renombró de 'tickets' a 'bugs' en 2026-07).
      if (r.includes(m) || (m === 'bugs' && r.includes('triage'))) {
        files.push(`bin/${r}`);
      }
    }
    units.push({ name: `mod:${m}`, label: `Módulo ${m}`, files });
  }

  // 3) frontend (shell + ui compartido)
  units.push({
    name: 'frontend-core',
    label: 'Frontend · shell + ui/',
    files: [
      'public/js/main.js',
      ...listJs(path.join(ROOT, 'public', 'js', 'ui')),
    ].filter((f) => fss.existsSync(path.join(ROOT, f))),
  });
  units.push({
    name: 'frontend-modules',
    label: 'Frontend · módulos',
    files: listJs(path.join(ROOT, 'public', 'js', 'modules'), { max: 60 }),
  });

  return units.filter((u) => u.files.length);
}

// Prompt de auditoría de UNA unidad. Devuelve findings de ESE conjunto de
// archivos (no del resto del repo). Cada finding trae severidad + tipo +
// (opcional) fix sugerido. La UI usa la severidad como semáforo visual y
// abre un chat con el detalle si el usuario decide trabajarlo.
export function unitPrompt(unit) {
  // FOCO (Fase 4): en vez de pedir el CLAUDE.md ENTERO, se apunta a las reglas
  // duras + se INYECTAN los invariantes que aplican a esta unidad (verificables
  // sí o sí). Menos ruido, más señal en lo que importa de ESTA unidad.
  const invs = invariantsFor(unit);
  const invBlock = invs.length
    ? ['', 'INVARIANTES que DEBEN cumplirse en esta unidad — verificá CADA UNO',
      'leyendo el código; si alguno se viola es un finding (critical/high) con',
      'el código exacto citado:', ...invs.map((t, i) => `  ${i + 1}. ${t}`)]
    : [];
  return [
    'Sos el AUDITOR DE SALUD de Claude Web Console. Corrida NO interactiva,',
    'SOLO LECTURA (no modifiques nada, no corras comandos).',
    '',
    `Auditá EXCLUSIVAMENTE esta unidad del proyecto: «${unit.label}».`,
    'Consultá las REGLAS DURAS (numeradas 1-9) y las convenciones de CLAUDE.md',
    'de la raíz; después leé y analizá EN PROFUNDIDAD estos archivos:',
    ...unit.files.map((f) => `  - ${f}`),
    ...invBlock,
    '',
    'Buscá DOS clases de problemas, con foco en lo REAL y verificable:',
    '  1. BUGS: lógica incorrecta, estados que no se persisten, condiciones de',
    '     carrera, fugas, manejo de error faltante, asimetrías sospechosas',
    '     (p.ej. un camino guarda estado y su gemelo no), validaciones ausentes.',
    '  2. Violaciones de las reglas de CLAUDE.md, sus convenciones o los',
    '     INVARIANTES de arriba.',
    'NO inventes problemas para llenar: si la unidad está sana, devolvé [].',
    'Cada hallazgo debe poder verificarse leyendo el código citado.',
    '',
    'Respondé ÚNICAMENTE con un bloque ```json con un array de hallazgos, cada',
    'uno EXACTAMENTE con estas claves:',
    '{',
    '  "area": "tema corto (qué falla)",',
    '  "severity": "critical" | "high" | "medium" | "low",',
    '  "kind": "bug" | "regla" | "mejora",',
    '  "detail": "qué encontraste, por qué importa y cómo se ve el síntoma",',
    '  "file": "ruta relativa:linea si la sabés, o \'\'",',
    '  "suggestedFix": "en una línea, qué habría que cambiar (o \'\')"',
    '}',
    'Si la unidad está sana: ```json\n[]\n```. Nada de texto fuera del bloque.',
  ].join('\n');
}

// Síntesis final: toma TODOS los hallazgos (ya en JSON, no re-lee código) y
// arma el veredicto ejecutivo. Barato: procesa texto, no navega el repo.
export function synthesisPrompt(findings) {
  return [
    'Sos el auditor de salud de Claude Web Console. Ya se auditó módulo por',
    'módulo y estos son TODOS los hallazgos (JSON):',
    '```json',
    JSON.stringify(findings),
    '```',
    'Devolvé ÚNICAMENTE un bloque ```json con:',
    '{',
    '  "verdict": "ok" | "atencion" | "critico",',
    '  "summary": "3-5 líneas en criollo: estado general, lo más urgente primero"',
    '}',
    'Criterio: "critico" si hay algún bug critical/high o violación de regla',
    'dura; "atencion" si hay medios; "ok" si todo es low o está limpio. Sin',
    'texto fuera del bloque.',
  ].join('\n');
}

export function parseFindings(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\[[\s\S]*\]/) || [])[0];
  if (!raw) return null;
  let arr;
  try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr.slice(0, 30).map((f) => ({
    area: String(f.area ?? '').slice(0, 100),
    severity: SEVERITY.has(f.severity) ? f.severity : 'medium',
    kind: KINDS.has(f.kind) ? f.kind : 'bug',
    detail: String(f.detail ?? '').slice(0, 1000),
    file: String(f.file ?? '').slice(0, 200),
    suggestedFix: String(f.suggestedFix ?? '').slice(0, 400),
  }));
}

export function parseSynthesis(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  return {
    verdict: VERDICTS.has(o.verdict) ? o.verdict : 'atencion',
    summary: String(o.summary ?? '').slice(0, 1200),
  };
}

export function readReview() {
  try { return JSON.parse(fss.readFileSync(REVIEW_FILE, 'utf8')); }
  catch { return { updatedAt: null, verdict: null, summary: null, findings: [], units: [], error: null }; }
}

export function writeReview(data) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(REVIEW_FILE, JSON.stringify(data), { mode: 0o600 });
  } catch (err) { console.error('[health] no pude escribir review.json:', err?.message); }
}

// ===== Identidad de un hallazgo =====
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
// `sig` = firma GRUESA (módulo·área·archivo): identifica "el mismo bug" entre
// análisis distintos → registro de resueltos + detección de recurrencia.
export const findingSig = (f) => sha(`${f.module || ''}|${f.area || ''}|${f.file || ''}`);
// `id` = firma FINA (agrega el detalle): distingue hallazgos del MISMO archivo
// dentro de una revisión → el runner de auto-fix apunta a uno exacto.
export const findingId = (f) => sha(`${f.module || ''}|${f.area || ''}|${f.file || ''}|${f.detail || ''}`);

// ===== Registro DURABLE de bugs resueltos (health-solved.json) =====
// Nunca se borra (a diferencia de review.json, que es foto fresca por corrida):
// es el historial de lo arreglado y la base para marcar recurrencias.
export function readSolved() {
  try { const o = JSON.parse(fss.readFileSync(SOLVED_FILE, 'utf8')); return Array.isArray(o) ? o : []; }
  catch { return []; }
}
export function writeSolved(list) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(SOLVED_FILE, JSON.stringify(list), { mode: 0o600 });
  } catch (err) { console.error('[health] no pude escribir health-solved.json:', err?.message); }
}
// Agrega/actualiza por firma. Si ya existía (bug recurrente), suma `count` y
// actualiza lastResolvedAt conservando firstResolvedAt.
export function recordSolved(f, summary) {
  const sig = findingSig(f);
  const list = readSolved();
  const now = Date.now();
  const prev = list.find((e) => e.sig === sig);
  if (prev) {
    prev.count = (prev.count || 1) + 1;
    prev.lastResolvedAt = now;
    prev.summary = String(summary || prev.summary || '').slice(0, 400);
    prev.area = f.area || prev.area; prev.module = f.module || prev.module; prev.file = f.file || prev.file;
  } else {
    list.push({
      sig, area: f.area || '', module: f.module || '', file: f.file || '',
      severity: f.severity || null, kind: f.kind || null,
      summary: String(summary || '').slice(0, 400),
      firstResolvedAt: now, lastResolvedAt: now, count: 1,
    });
  }
  writeSolved(list);
  return prev || list[list.length - 1];
}

// ===== Auditoría INCREMENTAL (Fase 2 del sistema nervioso) =====
// Cache por unidad: { fingerprint, findings crudos, auditedAt }. En cada
// corrida, si el fingerprint de la unidad no cambió → se REUSAN sus findings
// (no se gasta haiku); solo se re-audita lo que cambió. Misma técnica de
// fingerprint que core/inventory.js (hash de contenido).
export const AUDIT_CACHE_FILE = path.join(DATA_DIR, 'health-audit-cache.json');
export function readAuditCache() {
  try { const o = JSON.parse(fss.readFileSync(AUDIT_CACHE_FILE, 'utf8')); return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}
export function writeAuditCache(cache) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(AUDIT_CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
  } catch (err) { console.error('[health] no pude escribir audit-cache:', err?.message); }
}
// Fingerprint de una unidad → cambia si cambia su código O sus invariantes
// aplicables (Fase 4): así, editar un invariante fuerza re-auditar las unidades
// que toca (el fingerprint no dependía de invariants.js, que vive aparte).
export function unitFingerprint(unit) {
  const h = crypto.createHash('sha1');
  for (const f of unit.files || []) {
    h.update(f).update('\0');
    try { h.update(fss.readFileSync(path.join(ROOT, f))); } catch { /* archivo faltante */ }
  }
  for (const t of invariantsFor(unit)) h.update('\0INV\0').update(t);
  return h.digest('hex').slice(0, 12);
}

// ===== Invariantes PROPUESTOS (Fase 5: loop que aprende) =====
// El auto-fix, al resolver un bug de una clase que vale la pena blindar,
// propone un invariante. Se guarda PENDIENTE acá (no se auto-agrega — decisión
// del usuario); el modal de salud lo aprueba (→ invariants-learned.json) o lo
// descarta.
export const PROPOSALS_FILE = path.join(DATA_DIR, 'health-invariant-proposals.json');
export function readProposals() {
  try { const o = JSON.parse(fss.readFileSync(PROPOSALS_FILE, 'utf8')); return Array.isArray(o) ? o : []; }
  catch { return []; }
}
export function writeProposals(list) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(PROPOSALS_FILE, JSON.stringify(list), { mode: 0o600 });
  } catch (err) { console.error('[health] no pude escribir invariant-proposals:', err?.message); }
}
export function addProposal({ text, match, fromFinding }) {
  const t = String(text || '').trim();
  if (!t) return;
  const m = String(match || '').trim();
  const list = readProposals();
  const id = crypto.createHash('sha1').update(`${t}|${m}`).digest('hex').slice(0, 12);
  if (list.some((p) => p.id === id)) return; // dedup
  list.push({
    id, text: t.slice(0, 400), match: m.slice(0, 200),
    fromFinding: fromFinding ? { area: fromFinding.area, module: fromFinding.module, file: fromFinding.file } : null,
    proposedAt: Date.now(), status: 'pending',
  });
  writeProposals(list);
}

// ===== Lock del runner de auto-fix (uno a la vez) =====
export function writeFixLock(pid) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(FIX_LOCK_FILE, JSON.stringify({ pid, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}
export function clearFixLock() { try { fss.unlinkSync(FIX_LOCK_FILE); } catch { /* noop */ } }
export function isFixing() {
  try {
    const { ts } = JSON.parse(fss.readFileSync(FIX_LOCK_FILE, 'utf8'));
    return Date.now() - ts < LOCK_FRESH_MS;
  } catch { return false; }
}

// ===== Allowlist del auto-fix (DOS capas, regla 6 — excepción de ESCRITURA) =====
// Puede LEER, EDITAR/CREAR archivos y verificar SOLO con `node --check`/`node -c`.
// Todo lo demás (git, rm, systemctl, npm, curl, kill, reinicios…) DENEGADO: el
// fix queda en el working tree (revertible con git) y el usuario reinicia al
// revisar. Bash restringido por contenido a la verificación de sintaxis.
export function fixToolAllowed(name, input) {
  if (['Read', 'Grep', 'Glob', 'TodoWrite', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return true;
  if (name === 'Bash') {
    const cmd = String(input?.command || '').trim();
    return /^node\s+(--check|-c)\s+[^;&|]+(\s*&&\s*node\s+(--check|-c)\s+[^;&|]+)*$/.test(cmd);
  }
  return false;
}

// ===== Lock de "revisión corriendo" (heartbeat del runner) =====
export function writeLock(pid) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(LOCK_FILE, JSON.stringify({ pid, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}
export function clearLock() {
  try { fss.unlinkSync(LOCK_FILE); } catch { /* noop */ }
}
export function isRunning() {
  try {
    const { ts } = JSON.parse(fss.readFileSync(LOCK_FILE, 'utf8'));
    return Date.now() - ts < LOCK_FRESH_MS;
  } catch { return false; }
}
