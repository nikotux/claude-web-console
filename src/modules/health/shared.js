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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del repo
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const REVIEW_FILE = path.join(DATA_DIR, 'health-review.json');
export const LOCK_FILE = path.join(DATA_DIR, 'health-review.lock');
export const LOG_FILE = path.join(DATA_DIR, 'health-review.log');

export const UNIT_TIMEOUT_MS = 3 * 60 * 1000;   // corte por unidad
export const SYNTH_TIMEOUT_MS = 2 * 60 * 1000;  // corte de la síntesis
export const UNIT_MAX_TURNS = 20;               // cota de coste por unidad
export const HEARTBEAT_MS = 3000;
export const LOCK_FRESH_MS = 20000;             // lock más viejo que esto = runner muerto

export const VERDICTS = new Set(['ok', 'atencion', 'critico']);
export const SEVERITY = new Set(['critical', 'high', 'medium', 'low']);
export const KINDS = new Set(['bug', 'regla', 'mejora']); // tipo del hallazgo

// Allowlist de herramientas: SOLO lecturas locales (dos capas — regla 6).
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
      if (r.includes(m) || (m === 'chat' && r.includes('chat')) || (m === 'tickets' && r.includes('triage')) || (m === 'bugs' && r.includes('triage')) || (m === 'health' && r.includes('health'))) {
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
  return [
    'Sos el AUDITOR DE SALUD de Claude Web Console. Corrida NO interactiva,',
    'SOLO LECTURA (no modifiques nada, no corras comandos).',
    '',
    `Auditá EXCLUSIVAMENTE esta unidad del proyecto: «${unit.label}».`,
    'Leé PRIMERO el CLAUDE.md de la raíz (reglas duras, mapa, convenciones) y',
    'después leé y analizá EN PROFUNDIDAD estos archivos:',
    ...unit.files.map((f) => `  - ${f}`),
    '',
    'Buscá DOS clases de problemas, con foco en lo REAL y verificable:',
    '  1. BUGS: lógica incorrecta, estados que no se persisten, condiciones de',
    '     carrera, fugas, manejo de error faltante, asimetrías sospechosas',
    '     (p.ej. un camino guarda estado y su gemelo no), validaciones ausentes.',
    '  2. Violaciones de las reglas de CLAUDE.md o de sus convenciones.',
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
