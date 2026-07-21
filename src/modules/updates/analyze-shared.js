// modules/updates/analyze-shared.js — ANÁLISIS DE RIESGO con IA de los saltos
// MAYORES (majors). El escaneo trae versiones (0 tokens); ESTO le da CRITERIO:
// por cada major baja el changelog oficial (Node, determinístico) y una corrida
// IA read-only lee CÓMO este proyecto usa el paquete + los breaking changes →
// veredicto 🟢 seguro / 🟡 riesgoso / 🔴 rompe + confianza + por qué.
//
// Solo se analizan los MAJORS: los in-range (minor/patch dentro del rango semver)
// son compatibles por definición, no hay nada que evaluar. Las betas/RC se
// excluyen ANTES (nunca se analizan ni aplican).
//
// El veredicto lo consume buildPlan (orchestrate-shared): un major 🟢 seguro +
// confianza ALTA se auto-aplica SIN checkbox; el resto queda para tu OK. Aun así
// NO es garantía (un changelog puede omitir algo) → tras aplicar, el orquestador
// corre los Chequeos de Salud.
//
// SEGURIDAD (regla 6): corrida READ-ONLY doble capa (PreToolUse + canUseTool) con
// allowlist Read/Grep/Glob/TodoWrite. settingSources: []. NUNCA escribe. La red
// (bajar el changelog) NO la hace el modelo: la hace Node con `gh`/`npm view`
// (determinístico), y el texto viaja en el prompt.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { run, ROOT } from './shared.js';

const DATA_DIR = path.join(config.home, '.cwc-data');
export const RISK_FILE = path.join(DATA_DIR, 'updates-risk.json');
export const RISK_STALE_MS = 10 * 60 * 1000;

export const ANALYZE_MODEL = 'sonnet';
export const ANALYZE_MAX_TURNS = 16;
export const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;

// Allowlist read-only (dos capas, regla 6) — igual que el auditor de Salud.
export function analyzeToolAllowed(name) {
  return ['Read', 'Grep', 'Glob', 'TodoWrite'].includes(name);
}

// Una versión con etiqueta de pre-release (-rc/-beta/-alpha/-next/-canary/-pre)
// NO se analiza ni aplica NUNCA (tu regla: evitar lo no testeado).
export function isPrerelease(v) {
  // Semver: cualquier etiqueta después de un `-` es pre-release (rc13, beta.1,
  // next.5…). SIN \b: "rc13" no tiene boundary entre "rc" y "1" y se escapaba.
  return /-(rc|beta|alpha|next|canary|preview|pre|dev|snapshot|insiders?)/i.test(String(v || ''));
}

export function riskKey(name, from, to) { return `${name}@${from || '?'}->${to || '?'}`; }

export function readRisk() {
  try { return JSON.parse(fs.readFileSync(RISK_FILE, 'utf8')); } catch { return null; }
}
export function writeRisk(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeJsonAtomic(RISK_FILE, data);
}
export function isRiskRunning(job) {
  return !!job && job.running === true && (Date.now() - (job.heartbeat || job.startedAt || 0)) <= RISK_STALE_MS;
}
export function effectiveRisk(job) {
  if (!job) return { running: false, verdicts: {}, generatedAt: null, error: null };
  if (job.running && !isRiskRunning(job)) return { ...job, running: false, error: job.error || 'El análisis se interrumpió (heartbeat vencido). Reintentá.' };
  return job;
}

// ───────── Changelog (Node, determinístico, 0 tokens) ─────────
// Resuelve el repo de GitHub del paquete y trae las notas de release del salto
// mayor con `gh` (ya autenticado). Best-effort: si algo falla, devuelve '' y el
// modelo evalúa con su conocimiento + el código.
export async function fetchChangelog(name, from, to) {
  try {
    const rurl = await run('npm', ['view', name, 'repository.url'], { timeout: 30_000 });
    const m = rurl.stdout.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?[\s/]*$/mi);
    if (!m) return '';
    const owner = m[1]; const repo = m[2];
    const rel = await run('gh', ['api', `repos/${owner}/${repo}/releases?per_page=40`], { timeout: 40_000 });
    let arr;
    try { arr = JSON.parse(rel.stdout); } catch { return ''; }
    if (!Array.isArray(arr)) return '';
    const fromMajor = majorOf(from);
    const toMajor = majorOf(to);
    // Releases del salto mayor (major > el instalado, hasta el destino).
    const relevant = arr.filter((r) => {
      const v = majorOf(r.tag_name || '');
      return v !== null && v > fromMajor && v <= toMajor;
    });
    const pick = (relevant.length ? relevant : arr.slice(0, 3));
    let text = pick.map((r) => `## ${r.tag_name}\n${(r.body || '').trim()}`).join('\n\n');
    if (text.length > 7000) text = text.slice(0, 7000) + '\n…(truncado)';
    return text;
  } catch { return ''; }
}
function majorOf(tag) {
  const m = String(tag || '').match(/(\d+)\.\d+\.\d+/);
  return m ? Number(m[1]) : null;
}

// ───────── Prompt + parseo del veredicto ─────────
export function analyzePrompt(name, from, to, changelog) {
  return `Sos un auditor de dependencias de Node.js. El proyecto en el directorio actual (Mi Consola, una app Express + ws) quiere SUBIR el paquete "${name}" de la versión ${from} a la ${to} — un salto de versión MAYOR (potencialmente con cambios que rompen compatibilidad).

Tu tarea: decidir si ese salto ROMPE esta app.

CHANGELOG / NOTAS DE RELEASE oficiales del salto (pueden estar incompletas):
"""
${changelog || '(no se pudo obtener el changelog automáticamente — usá tu conocimiento del paquete)'}
"""

PASOS:
1. Con Read/Grep/Glob, buscá CÓMO este proyecto usa "${name}": los imports/require, y qué funciones/APIs del paquete llama realmente (revisá src/ y bin/).
2. Cruzá los BREAKING CHANGES del changelog (y lo que sepas del paquete) contra las APIs que el proyecto REALMENTE usa.
3. Decidí el veredicto.

Devolvé SOLO un bloque de código json con exactamente esta forma (sin texto antes ni después):
\`\`\`json
{
  "level": "seguro" | "riesgoso" | "rompe",
  "confidence": "alta" | "media" | "baja",
  "why": "1-2 frases claras en español: por qué es seguro/riesgoso, qué cambió y si nos afecta",
  "breakingChanges": ["cambio 1 relevante", "cambio 2"],
  "usedApis": ["api del paquete que este proyecto usa", "..."]
}
\`\`\`
Criterio: "seguro" = el proyecto no usa nada de lo que cambió (o el paquete no tuvo breaking changes reales). "riesgoso" = usa algo que PODRÍA verse afectado pero no es seguro. "rompe" = usa una API que el changelog dice que se quitó/cambió. Si no podés ver el uso con confianza, bajá la "confidence".`;
}

export function parseVerdict(out) {
  const m = String(out || '').match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    const level = ['seguro', 'riesgoso', 'rompe'].includes(v.level) ? v.level : 'riesgoso';
    const confidence = ['alta', 'media', 'baja'].includes(v.confidence) ? v.confidence : 'baja';
    return {
      level, confidence,
      why: String(v.why || '').slice(0, 500),
      breakingChanges: Array.isArray(v.breakingChanges) ? v.breakingChanges.map((s) => String(s).slice(0, 200)).slice(0, 8) : [],
      usedApis: Array.isArray(v.usedApis) ? v.usedApis.map((s) => String(s).slice(0, 120)).slice(0, 12) : [],
    };
  } catch { return null; }
}

export { DATA_DIR, ROOT };
