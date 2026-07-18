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
import { writeJsonAtomic } from '../../core/atomic-write.js';
import * as padLocal from '../../core/pad-service-client.js';

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
// Registro DURABLE de FALSOS POSITIVOS: hallazgos que el auto-fix revisó y
// descartó (no eran bugs). Sobrevive corridas → el motor NO los vuelve a poner
// en la cola de "por resolver" (corta el bucle escaneo→mismo FP→escaneo).
export const DISMISSED_FILE = path.join(DATA_DIR, 'health-dismissed.json');
export const FIX_LOCK_FILE = path.join(DATA_DIR, 'healthfix.lock');
export const FIX_LOG_FILE = path.join(DATA_DIR, 'healthfix.log');
export const FIX_TIMEOUT_MS = 6 * 60 * 1000; // corte duro del auto-fix
export const FIX_MAX_TURNS = 40;

export const UNIT_TIMEOUT_MS = 3 * 60 * 1000;   // corte por unidad
export const SYNTH_TIMEOUT_MS = 2 * 60 * 1000;  // corte de la síntesis
export const UNIT_MAX_TURNS = 20;               // cota de coste por unidad
export const HEARTBEAT_MS = 3000;
// MODELO del AUDITOR por unidad (fuente ÚNICA — el runner NO hardcodea el
// modelo). Sonnet parejo: haiku (chico) alucinaba falsos positivos incluso en
// módulos chicos (race conditions en código síncrono, validaciones "ausentes"
// que ya existían) y era inconsistente entre corridas ("cada Completo encuentra
// más"). Sonnet da resultados estables y con muchos menos FP. Punto único para
// un futuro híbrido/opus (p.ej. sonnet general + opus en unidades grandes).
// OJO: unitFingerprint incluye este valor → cambiar el modelo re-audita todo.
export function auditModelFor(_unit) { return 'sonnet'; }
export const LOCK_FRESH_MS = 20000;             // lock más viejo que esto = runner muerto

// ===== Reglas duras de CLAUDE.md, pre-masticadas (optimización IA 2026-07-05) ==
// Antes unitPrompt le pedía al modelo "consultá las REGLAS DURAS de CLAUDE.md":
// un Read del archivo ENTERO (~1300 líneas) POR UNIDAD auditada. Ahora la
// sección '## Reglas duras' se recorta UNA vez acá en Node y se INYECTA como
// texto en el prompt (mismo patrón que invBlock/fpBlock con los invariantes).
// Caché a nivel proceso: el runner es un proceso fresco por corrida, así que
// siempre audita con las reglas actuales; unitFingerprint la hashea para que
// editarlas invalide la caché incremental. Si la extracción falla (archivo
// movido / sección renombrada) devuelve '' y unitPrompt cae a la instrucción
// vieja de consultar el archivo — nunca se pierde cobertura.
let _hardRules = null;
export function hardRulesText() {
  if (_hardRules !== null) return _hardRules;
  try {
    const lines = fss.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8').split('\n');
    const start = lines.findIndex((l) => /^##\s+Reglas duras/.test(l));
    if (start === -1) { _hardRules = ''; return _hardRules; }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break; }
    }
    _hardRules = lines.slice(start, end).join('\n').trim();
  } catch { _hardRules = ''; }
  return _hardRules;
}

// CONTEXTO DE PAD LOCAL para los motores de Salud (Gap #4, TASK-297). Lee, por
// HTTP plano (NO MCP → no toca el blindaje read-only de la regla 6), lo que el
// proyecto YA tiene rastreado en el Pad local (workspace `console`): los BUGs
// abiertos del mapeo/modularización + los programas (ROAD) en curso. Se inyecta
// en los prompts de Optimización y Coherencia para que el análisis NO re-reporte
// lo ya sabido y alinee sus propuestas con lo que está en marcha. best-effort:
// si el Pad local no responde, devuelve '' y el análisis sigue igual (patrón
// commsContextFor). NO se inyecta en unitPrompt (la Revisión exhaustiva) porque
// unitFingerprint hashea el prompt → invalidaría toda la caché incremental.
export async function padContext() {
  // OJO: el REST del Pad local devuelve `fields` como STRING JSON (no objeto,
  // a diferencia del MCP) — parsearlo antes de leer status/module/severity.
  const field = (it, k) => {
    let f = it?.fields;
    if (typeof f === 'string') { try { f = JSON.parse(f); } catch { f = {}; } }
    return f?.[k] ?? it?.[k];
  };
  try {
    const [bugsR, roadR] = await Promise.all([
      padLocal.listItems('bugs', { workspace: 'console' }),
      padLocal.listItems('roadmap-items', { workspace: 'console' }),
    ]);
    if ((!bugsR || !bugsR.ok) && (!roadR || !roadR.ok)) return '';
    const lines = [];
    if (bugsR?.ok) {
      const open = (Array.isArray(bugsR.data) ? bugsR.data : [])
        .filter((b) => ['open', 'verifying'].includes(field(b, 'status')));
      if (open.length) {
        lines.push(`BUGS ABIERTOS ya rastreados en Pad (${open.length}) — NO los re-reportes como hallazgos nuevos; si tu análisis toca alguno, referencialo por su ref:`);
        for (const b of open.slice(0, 40)) {
          lines.push(`- ${b.ref || '?'} [${field(b, 'module') || '?'} · ${field(b, 'severity') || '?'}] ${(b.title || '').slice(0, 160)}`);
        }
      }
    }
    if (roadR?.ok) {
      const active = (Array.isArray(roadR.data) ? roadR.data : [])
        .filter((r) => field(r, 'status') === 'in_progress');
      if (active.length) {
        lines.push('', `PROGRAMAS / ROADS EN CURSO en Pad (${active.length}) — alineá tus propuestas con lo que ya está en marcha:`);
        for (const r of active.slice(0, 15)) lines.push(`- ${r.ref || '?'} ${(r.title || '').slice(0, 160)}`);
      }
    }
    return lines.join('\n');
  } catch { return ''; }
}

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
  // FALSOS POSITIVOS ya descartados en esta unidad (Fase 5, corta el bucle en
  // origen): se listan para que el auditor NO los vuelva a reportar salvo que
  // encuentre evidencia NUEVA y concreta de que ahora sí son reales.
  const fps = dismissedFor(unit);
  const fpBlock = fps.length
    ? ['', 'FALSOS POSITIVOS YA REVISADOS Y DESCARTADOS (NO los reportes de nuevo',
      'salvo que el código haya cambiado y encuentres evidencia CONCRETA de que',
      'ahora sí es un bug real):', ...fps.map((e, i) => `  ${i + 1}. ${e.area}${e.reason ? ` — ${e.reason}` : ''}`)]
    : [];
  // REGLAS DURAS ya masticadas (0 tool calls): si hardRulesText() trae texto se
  // inyecta y se le PROHÍBE al modelo abrir CLAUDE.md (ahorra un Read de ~1300
  // líneas por unidad); si vino vacío, fallback a la instrucción vieja.
  const rules = hardRulesText();
  const rulesBlock = rules
    ? ['', 'REGLAS DURAS del proyecto (sección «## Reglas duras» de CLAUDE.md, YA',
      'extraída acá — NO abras CLAUDE.md, usá este texto directo):', '', rules]
    : [];
  return [
    'Sos el AUDITOR DE SALUD de Claude Web Console. Corrida NO interactiva,',
    'SOLO LECTURA (no modifiques nada, no corras comandos).',
    '',
    `Auditá EXCLUSIVAMENTE esta unidad del proyecto: «${unit.label}».`,
    ...(rules
      ? ['Las REGLAS DURAS van INYECTADAS más abajo (no hace falta leer CLAUDE.md).',
        'Leé y analizá EN PROFUNDIDAD estos archivos:']
      : ['Consultá las REGLAS DURAS (numeradas 1-9) y las convenciones de CLAUDE.md',
        'de la raíz; después leé y analizá EN PROFUNDIDAD estos archivos:']),
    ...unit.files.map((f) => `  - ${f}`),
    ...rulesBlock,
    ...invBlock,
    ...fpBlock,
    '',
    'Buscá DOS clases de problemas, con foco en lo REAL y verificable:',
    '  1. BUGS: lógica incorrecta, estados que no se persisten, condiciones de',
    '     carrera, fugas, manejo de error faltante, asimetrías sospechosas',
    '     (p.ej. un camino guarda estado y su gemelo no), validaciones ausentes.',
    '  2. Violaciones de las REGLAS DURAS de arriba, las convenciones del',
    '     proyecto o los INVARIANTES.',
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
// padCtx (Gap #4, 2026-07-12): se inyecta SOLO acá (la síntesis corre 1 sola vez
// al final, sin fingerprint por-unidad) — NUNCA en unitPrompt, que SÍ se cachea
// por fingerprint: meter Pad ahí re-auditaría todo. Sirve para que el veredicto
// NO trate como "nuevo" un hallazgo que ya está rastreado como BUG en Pad.
export function synthesisPrompt(findings, padCtx = '') {
  return [
    'Sos el auditor de salud de Claude Web Console. Ya se auditó módulo por',
    'módulo y estos son TODOS los hallazgos (JSON):',
    '```json',
    JSON.stringify(findings),
    '```',
    ...(padCtx ? [
      'CONTEXTO DE PAD LOCAL (workspace `console`) — bugs YA rastreados +',
      'programas en curso. Si un hallazgo de arriba coincide con un BUG ya',
      'listado acá, NO lo trates como novedad: mencionalo por su ref y bajale el',
      'tono en el resumen (ya está en el radar del proyecto):',
      padCtx,
    ] : []),
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
  // Atómico (tmp+rename, fix B2 2026-07-11): health-solved.json es memoria DURABLE
  // ("nunca se poda"); un crash/disco-lleno a mitad de un writeFileSync directo lo
  // truncaba y readSolved lo tragaba como [] → se perdía el historial de resueltos
  // y la detección de recurrencia (reabría el bucle escaneo→mismo FP).
  try { writeJsonAtomic(SOLVED_FILE, list); }
  catch (err) { console.error('[health] no pude escribir health-solved.json:', err?.message); }
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

// Marca UN hallazgo como resuelto: setea fixStatus:'resolved' en review.json
// (foto de la corrida) + lo suma al registro DURABLE (recordSolved). Punto ÚNICO
// de "marcar resuelto" fuera del auto-fix runner — lo usan el runner mini
// bin/cwc-health-resolve.js (lo corre el propio chat supervisado al terminar) y
// el endpoint POST /finding-resolve (botón manual, red de seguridad). Devuelve el
// hallazgo actualizado o null si ya no está en review.json (se re-analizó).
export function markFindingResolved(id, summary) {
  const st = readReview();
  const f = (st.findings || []).find((x) => findingId(x) === id);
  if (!f) return null;
  Object.assign(f, {
    fixStatus: 'resolved',
    fixSummary: String(summary || '').slice(0, 400),
    resolvedAt: Date.now(),
    fixError: null,
  });
  st.updatedAt = Date.now();
  writeReview(st);
  recordSolved(f, summary);
  return f;
}

// Marca UN hallazgo como FALSO POSITIVO: setea fixStatus:'dismissed' en
// review.json (sale de la cola "por resolver") + lo suma al registro DURABLE
// (recordDismissed) para que la próxima auditoría no lo re-encuentre (corta el
// bucle escaneo→mismo FP→escaneo). Punto ÚNICO de "marcar descartado" — lo usan
// el auto-fix individual (bin/cwc-healthfix-runner.js) y el orquestador de
// batch (bin/cwc-healthfix-orchestrator.js). `fallback` = el hallazgo original
// por si ya no está en review.json (se re-analizó): el registro durable se
// escribe igual, que es lo que evita la re-auditoría.
export function markFindingDismissed(id, reason, fallback = null) {
  const st = readReview();
  const f = (st.findings || []).find((x) => findingId(x) === id);
  if (f) {
    Object.assign(f, {
      fixStatus: 'dismissed',
      dismissReason: String(reason || '').slice(0, 300),
      dismissedAt: Date.now(),
    });
    st.updatedAt = Date.now();
    writeReview(st);
  }
  const base = f || fallback;
  if (base) recordDismissed(base, reason);
  return f || null;
}

// ===== Registro DURABLE de FALSOS POSITIVOS (health-dismissed.json) =====
// Clave = firma GRUESA (module|area|file), la misma que recurrencias: así, si el
// motor re-encuentra el MISMO hallazgo, se reconoce como ya-descartado. No es
// código; es memoria del "sistema nervioso" para no repetir el análisis.
export function readDismissed() {
  try { const o = JSON.parse(fss.readFileSync(DISMISSED_FILE, 'utf8')); return Array.isArray(o) ? o : []; }
  catch { return []; }
}
export function writeDismissed(list) {
  // Atómico (tmp+rename, fix B2 2026-07-11): health-dismissed.json es memoria
  // DURABLE de los falsos positivos; si se corrompe a medias, los FP descartados
  // reaparecen y el auditor los re-audita con sonnet en cada corrida (bucle).
  try { writeJsonAtomic(DISMISSED_FILE, list); }
  catch (err) { console.error('[health] no pude escribir health-dismissed.json:', err?.message); }
}
// Upsert por firma. Si el motor lo volvió a proponer y se re-descartó, suma count.
export function recordDismissed(f, reason) {
  const sig = findingSig(f);
  const list = readDismissed();
  const now = Date.now();
  const prev = list.find((e) => e.sig === sig);
  if (prev) {
    prev.count = (prev.count || 1) + 1;
    prev.lastAt = now;
    prev.reason = String(reason || prev.reason || '').slice(0, 300);
    prev.area = f.area || prev.area; prev.module = f.module || prev.module; prev.file = f.file || prev.file;
  } else {
    list.push({
      sig, area: f.area || '', module: f.module || '', file: f.file || '',
      severity: f.severity || null, kind: f.kind || null,
      reason: String(reason || '').slice(0, 300),
      firstAt: now, lastAt: now, count: 1,
    });
  }
  writeDismissed(list);
  return prev || list[list.length - 1];
}
// Quita un FP del registro por firma (para "Restaurar": vuelve a la cola).
export function removeDismissed(sig) {
  const list = readDismissed();
  const next = list.filter((e) => e.sig !== sig);
  if (next.length !== list.length) writeDismissed(next);
  return list.length - next.length;
}
// FP conocidos que aplican a una UNIDAD (por sus archivos/módulo) → se inyectan
// en el prompt del auditor para que no los reporte de nuevo (corta en origen).
export function dismissedFor(unit) {
  const files = unit?.files || [];
  const mods = new Set(files.map((f) => f.split('/').slice(0, 3).join('/')));
  return readDismissed().filter((e) => files.includes(e.file) || (e.file && [...mods].some((m) => e.file.startsWith(m))));
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
  // El modelo del auditor es parte de la identidad de la auditoría: cambiarlo
  // (p.ej. haiku→sonnet) invalida la caché y fuerza re-auditar con el nuevo.
  h.update('\0MODEL\0').update(auditModelFor(unit));
  // Las REGLAS DURAS van inyectadas en el prompt (hardRulesText): editarlas
  // cambia la auditoría → invalida la caché igual que invariantes/modelo.
  h.update('\0RULES\0').update(hardRulesText());
  return h.digest('hex').slice(0, 12);
}

// ===== Batch de resolución (Fase B del orquestador) =====
// El batch se resuelve en un RUNNER DESACOPLADO (bin/cwc-healthfix-orchestrator.js)
// con estado en archivo + lock/heartbeat → sobrevive a un reinicio de la web
// (regla de oro) y es REANUDABLE. El front polea BATCH_FILE.
export const BATCH_FILE = path.join(DATA_DIR, 'healthfix-batch.json');
export const BATCH_LOCK = path.join(DATA_DIR, 'healthfix-batch.lock');
export function readBatch() { try { return JSON.parse(fss.readFileSync(BATCH_FILE, 'utf8')); } catch { return null; } }
export function writeBatch(b) {
  try { fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); fss.writeFileSync(BATCH_FILE, JSON.stringify(b), { mode: 0o600 }); }
  catch (err) { console.error('[health] no pude escribir batch:', err?.message); }
}
export function writeBatchLock(pid) {
  try { fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); fss.writeFileSync(BATCH_LOCK, JSON.stringify({ pid, ts: Date.now() }), { mode: 0o600 }); }
  catch { /* noop */ }
}
export function clearBatchLock() { try { fss.unlinkSync(BATCH_LOCK); } catch { /* noop */ } }
export function isBatchRunning() {
  try { const { ts } = JSON.parse(fss.readFileSync(BATCH_LOCK, 'utf8')); return Date.now() - ts < LOCK_FRESH_MS; }
  catch { return false; }
}
// ¿Hay OTRO orquestador realmente corriendo? Igual que isBatchRunning pero EXIGE
// un pid REAL (≠ 0). El server escribe un lock-placeholder con pid:0 para
// RESERVAR el turno antes de spawnear; el orquestador que arranca debe poder
// RECLAMAR ese placeholder (si usara isBatchRunning se auto-deadlockearía: vería
// su propia reserva y se saldría). isBatchRunning (incluye pid:0) sigue sirviendo
// al server para bloquear un segundo spawn.
export function otherBatchAlive() {
  try { const { pid, ts } = JSON.parse(fss.readFileSync(BATCH_LOCK, 'utf8')); return !!pid && Date.now() - ts < LOCK_FRESH_MS; }
  catch { return false; }
}

// Prompt de resolución autónoma de UN hallazgo (compartido con el auto-fix de a
// uno): edita el fix mínimo, verifica con node --check, y opcionalmente propone
// un invariante (Fase 5). `f` = { area, module, severity, kind, file, detail,
// suggestedFix }.
export function fixPrompt(f) {
  return [
    'Sos un runner autónomo que arregla UN hallazgo de la revisión de salud de esta consola (Claude Web Console). Trabajás SIN supervisión humana.',
    '',
    `Módulo: ${f.module || '—'}`,
    `Severidad: ${f.severity || '—'} · Tipo: ${f.kind || '—'}`,
    `Qué falla: ${f.area}`,
    f.file ? `Archivo: ${f.file}` : '',
    '',
    `Detalle: ${f.detail}`,
    f.suggestedFix ? `Fix sugerido por la auditoría: ${f.suggestedFix}` : '',
    '',
    'Reglas ESTRICTAS:',
    '1. Verificá leyendo el código citado que el hallazgo es REAL. Si NO hay bug (falso positivo: el código ya valida/maneja el caso), NO edites nada y terminá con: FIXNONE <por qué no era un bug>.',
    '2. Si es real, aplicá el fix MÍNIMO editando los archivos necesarios.',
    '3. Verificá CADA archivo .js que edites con `node --check <archivo>` (única orden de terminal permitida). NO corras git, tests, npm, systemctl ni reinicies nada.',
    '4. Terminá tu ÚLTIMO mensaje con UNA línea exacta: "FIXOK <qué cambiaste, en qué archivos>" (fix aplicado), "FIXNONE <por qué>" (falso positivo, no era bug) o "FIXFAIL <motivo>" (era real pero no pudiste arreglarlo).',
    '5. Solo si el fix fue OK y el bug es una CLASE que conviene blindar, agregá DESPUÉS del FIXOK: "PROPOSED-INVARIANT <aserción verificable> | <patrón de archivos>". Si no, "NO-INVARIANT".',
  ].filter(Boolean).join('\n');
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
// Lee el lock de auto-fix crudo {pid, ts} (o null) — mismo rol que readLock para
// el review: el runner distingue el PLACEHOLDER de reserva del server (pid:0,
// spawnFix) de un lock ajeno real (pid≠0) y NO se suicida con su propia reserva
// (BUG-51: el runner era pid-agnóstico y salía al ver su propio placeholder).
export function readFixLock() {
  try { return JSON.parse(fss.readFileSync(FIX_LOCK_FILE, 'utf8')); }
  catch { return null; }
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
    // El token de RUTA de `node --check <ruta>` se acota a una allowlist de
    // caracteres seguros: excluye espacios y TODO metacaracter de shell que
    // permita encadenar o sustituir comandos — newline/CR, `;` `&` `|` `$`
    // backtick `(` `)` `<` `>`, comillas y backslash. El `&&` de encadenar más
    // verificaciones SÍ se permite (va en la ESTRUCTURA, no en el token de ruta).
    // ENDURECIDO (fix B2 2026-07-11): la clase vieja `[^;&|]` dejaba pasar
    // `node --check a.js\nsystemctl restart …`, `node --check $(...)` y
    // `` node --check `id` `` — el auto-fix LEE código no confiable (posible
    // prompt-injection) y esto derrotaba el guardrail entero de la regla 6.
    return /^node\s+(--check|-c)\s+[^\s;&|$`()<>'"\\]+(\s*&&\s*node\s+(--check|-c)\s+[^\s;&|$`()<>'"\\]+)*$/.test(cmd);
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
// Lee el lock crudo {pid, ts} (o null). Lo usa el runner para distinguir el
// PLACEHOLDER de reserva del server (pid:0, escrito por spawnReview en el mismo
// turno JS que isRunning() para cerrar la ventana TOCTOU — BUG-48) de un lock
// fresco de OTRO runner real (pid≠0): con pid:0 el runner PROCEDE y lo pisa con
// su pid; con un pid ajeno fresco, sale. Sin esto, el runner se suicidaría con su
// propio placeholder (el patrón roto que describe BUG-51 para el auto-fix).
export function readLock() {
  try { return JSON.parse(fss.readFileSync(LOCK_FILE, 'utf8')); }
  catch { return null; }
}

// ===== Censo VIVO de runners/motores en segundo plano (panel de Actividad) =====
// Alimenta GET /api/health/active-runners → widget del pie de la barra derecha +
// su modal. Es 0 tokens y SOLO LECTURA de estado en disco: escanea los archivos de
// lock/job que YA escriben los runners desacoplados y reporta cuáles están vivos
// AHORA. No importa los ~15 módulos (evita acoplamiento/dependencias circulares):
// la detección de "vivo" es idéntica en todos (heartbeat/updatedAt fresco), así que
// se centraliza acá con un REGISTRO declarativo. Si un runner nuevo aparece, se
// suma una fila; si su lock/job nunca existe, sencillamente no se lista.
//
// El MODELO por runner es estático (documentado en CLAUDE.md, consistente): se usa
// para el semáforo "modelo dominante". Un runner sin IA (p.ej. el scan de comms por
// gh) lleva model:null y no cuenta para el dominante.
const RUNNER_FRESH_MS = 20000;        // locks: heartbeat 3s → 20s de gracia (igual a LOCK_FRESH_MS)
const JOB_STALE_MS = 10 * 60 * 1000;  // jobs: cota amplia (timeout máx ~6min) para no colgar filas de un job muerto

// kind 'lock'  → archivo <x>.lock con {pid, ts, phase?}: vivo si ts fresco.
// kind 'heartbeat' → lock/heartbeat con freshMs configurable.
// kind 'job'   → archivo <x>.json con {status:'running', startedAt, updatedAt?}: vivo si running + fresco.
// kind 'jobflag' → archivo <x>.json con {running:true}: vivo si running + mtime fresco.
// kind 'jobglob' → varios <base><algo>.json (jobs por id) en DATA_DIR: escanea cada uno como 'job'.
// kind 'jobdir'  → carpeta con <id>.json (jobs por id): escanea cada uno como 'job'.
const RUNNER_REGISTRY = [
  // --- Familia LOCK (heartbeat) --- (icon = nombre válido de public/js/ui/icons.js)
  { key: 'health-review', kind: 'lock', file: 'health-review.lock', label: 'Revisión de salud', icon: 'checklist', model: 'sonnet', role: 'sdk' },
  { key: 'healthfix', kind: 'lock', file: 'healthfix.lock', label: 'Auto-fix de salud', icon: 'gear', model: 'sonnet', role: 'sdk' },
  { key: 'healthfix-batch', kind: 'lock', file: 'healthfix-batch.lock', label: 'Batch de auto-fix', icon: 'gear', model: 'sonnet', role: 'sdk' },
  { key: 'optimize', kind: 'lock', file: 'optimize.lock', label: 'Optimización IA', icon: 'sparkle', model: 'sonnet', role: 'sdk' },
  { key: 'coherence', kind: 'lock', file: 'coherence.lock', label: 'Coherencia', icon: 'relay', model: 'sonnet', role: 'sdk' },
  { key: 'comms-scan', kind: 'lock', file: 'comms/comms.lock', label: 'Escaneo de comunicaciones', icon: 'externalLink', model: null, role: 'job' },
  { key: 'comms-teams', kind: 'lock', file: 'comms/teams.lock', label: 'Escaneo Teams', icon: 'externalLink', model: 'sonnet', role: 'sdk' },
  { key: 'comms-chatbot', kind: 'lock', file: 'comms/chatbot.lock', label: 'Chatbot (comunicaciones)', icon: 'externalLink', model: 'sonnet', role: 'sdk' },
  // --- Familia JOB (status:'running') ---
  { key: 'tasks-analyze', kind: 'jobglob', base: 'tasks-analysis-', label: 'Análisis de Pendientes', icon: 'list', model: 'sonnet', role: 'sdk' },
  { key: 'learning-explain', kind: 'jobglob', base: 'learning-explain-', label: 'Explicame esto (aprendizaje)', icon: 'sparkle', model: 'sonnet', role: 'sdk' },
  { key: 'learning-context', kind: 'jobglob', base: 'learning-context-', label: 'Contexto (aprendizaje)', icon: 'sparkle', model: 'sonnet', role: 'sdk' },
  { key: 'learning-analyze', kind: 'job', file: 'learning-analysis.json', label: 'Analizar aprendizaje', icon: 'sparkle', model: 'sonnet', role: 'sdk' },
  { key: 'commitmsg', kind: 'jobdir', dir: 'commitmsg', label: 'Mensaje de commit IA', icon: 'edit', model: 'haiku', role: 'sdk' },
  { key: 'projects-analyze', kind: 'jobdir', dir: 'projects-analyze', label: 'Guardián de contexto', icon: 'eye', model: 'haiku', role: 'sdk' },
  { key: 'audio', kind: 'jobdir', dir: 'audio', label: 'Análisis de audio', icon: 'mic', model: 'sonnet', role: 'sdk' },
  { key: 'comms-analyze', kind: 'jobdir', dir: 'comms/analyze', label: 'Análisis de hilo (comms)', icon: 'externalLink', model: 'haiku', role: 'sdk' },
  { key: 'ticket-context', kind: 'jobdir', dir: 'ticket-context', label: 'Contexto de ticket', icon: 'sparkle', model: 'sonnet', role: 'sdk' },
  // --- Silenciosos / determinísticos que antes no se registraban ---
  { key: 'tolkien-refresh', kind: 'jobflag', file: 'tolkien-refresh.json', label: 'Refresh DB Tolkien', icon: 'gitBranch', model: null, role: 'job' },
  { key: 'whatsapp', kind: 'heartbeat', file: 'comms/whatsapp-daemon.json', freshMs: 300000, label: 'WhatsApp (daemon)', icon: 'externalLink', model: null, role: 'service' },
  { key: 'retro', kind: 'jobdir', dir: 'retro', label: 'Mejora continua', icon: 'sparkle', model: 'sonnet', role: 'sdk' },
  { key: 'retro-curate', kind: 'job', file: 'retro-curation.json', label: 'Curaduría mejora continua', icon: 'sparkle', model: 'sonnet', role: 'sdk' },
  { key: 'health-scan', kind: 'lock', file: 'health-scan.lock', label: 'Escaneo de salud', icon: 'checklist', model: 'sonnet', role: 'sdk' },
  { key: 'desk', kind: 'lock', file: 'desk.lock', label: 'Consulta Zoho Desk', icon: 'externalLink', model: 'sonnet', role: 'sdk' },
  { key: 'investigate', kind: 'lock', file: 'investigate.lock', label: 'Investigar PR', icon: 'eye', model: 'sonnet', role: 'sdk' },
  { key: 'ticket-investigate', kind: 'lock', file: 'ticket-investigate.lock', label: 'Investigar ticket', icon: 'eye', model: 'sonnet', role: 'sdk' },
];

// birthtime del archivo ≈ momento de spawn (los locks solo traen heartbeat `ts`,
// no el inicio). Para jobs preferimos su startedAt (más exacto).
function birthMs(abs) {
  try { return fss.statSync(abs).birthtimeMs || fss.statSync(abs).ctimeMs; } catch { return null; }
}
// Lee un archivo de lock; devuelve {startedAt, phase} si está vivo, o null.
function readLiveLock(abs, freshMs = RUNNER_FRESH_MS) {
  try {
    const l = JSON.parse(fss.readFileSync(abs, 'utf8'));
    if (!l || typeof l.ts !== 'number' || Date.now() - l.ts >= freshMs) return null;
    return { startedAt: birthMs(abs) || l.ts, phase: l.phase || l.progress || l.state || null, state: l.state || null };
  } catch { return null; }
}
// Lee un archivo de job; devuelve {startedAt, phase} si status running + fresco.
function readLiveJob(abs) {
  try {
    const j = JSON.parse(fss.readFileSync(abs, 'utf8'));
    if (!j || j.status !== 'running') return null;
    const started = j.startedAt || birthMs(abs);
    const beat = j.updatedAt || j.startedAt || j.ts || 0;
    if (beat && Date.now() - beat >= JOB_STALE_MS) return null; // job muerto
    return { startedAt: started || Date.now(), phase: j.phase || null };
  } catch { return null; }
}
// Job con shape {running:true} (p.ej. tolkien-refresh.json): vivo si running + mtime fresco.
function readLiveJobFlag(abs) {
  try {
    const j = JSON.parse(fss.readFileSync(abs, 'utf8'));
    if (!j || j.running !== true) return null;
    let mtime = 0;
    try { mtime = fss.statSync(abs).mtimeMs; } catch {}
    if (mtime && Date.now() - mtime >= 15 * 60 * 1000) return null; // job colgado
    return { startedAt: birthMs(abs) || mtime || Date.now(), phase: 'corriendo' };
  } catch { return null; }
}

// Foto de TODOS los procesos/runners vivos ahora. Cada entrada:
// { key, label, icon, model, phase, startedAt, role, kind:'process' }.
export function collectActiveRunners() {
  const out = [];
  for (const r of RUNNER_REGISTRY) {
    if (r.kind === 'lock') {
      const live = readLiveLock(path.join(DATA_DIR, r.file));
      if (live) out.push({ key: r.key, label: r.label, icon: r.icon, model: r.model, phase: live.phase, startedAt: live.startedAt, role: r.role || 'sdk', kind: 'process' });
    } else if (r.kind === 'heartbeat') {
      const live = readLiveLock(path.join(DATA_DIR, r.file), r.freshMs);
      if (live) out.push({ key: r.key, label: r.label, icon: r.icon, model: r.model, phase: live.phase, startedAt: live.startedAt, role: r.role || 'sdk', kind: 'process' });
    } else if (r.kind === 'job') {
      const live = readLiveJob(path.join(DATA_DIR, r.file));
      if (live) out.push({ key: r.key, label: r.label, icon: r.icon, model: r.model, phase: live.phase, startedAt: live.startedAt, role: r.role || 'sdk', kind: 'process' });
    } else if (r.kind === 'jobflag') {
      const live = readLiveJobFlag(path.join(DATA_DIR, r.file));
      if (live) out.push({ key: r.key, label: r.label, icon: r.icon, model: r.model, phase: live.phase, startedAt: live.startedAt, role: r.role || 'sdk', kind: 'process' });
    } else if (r.kind === 'jobglob' || r.kind === 'jobdir') {
      const dir = r.kind === 'jobdir' ? path.join(DATA_DIR, r.dir) : DATA_DIR;
      let names = [];
      try { names = fss.readdirSync(dir); } catch { names = []; }
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        if (r.kind === 'jobglob' && !n.startsWith(r.base)) continue;
        const live = readLiveJob(path.join(dir, n));
        if (live) out.push({ key: `${r.key}:${n.replace(/\.json$/, '')}`, label: r.label, icon: r.icon, model: r.model, phase: live.phase, startedAt: live.startedAt, role: r.role || 'sdk', kind: 'process' });
      }
    }
  }
  return out;
}
