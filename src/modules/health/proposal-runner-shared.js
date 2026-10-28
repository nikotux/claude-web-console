// modules/health/proposal-runner-shared.js — INFRAESTRUCTURA GENÉRICA
// compartida por los motores de PROPUESTAS de la pestaña Salud: la
// Optimización IA (optimize-shared.js) y el Módulo de Coherencia
// (coherence-shared.js). Nació de un hallazgo de la propia Optimización IA
// (2026-07-06): ambos módulos duplicaban casi línea por línea el
// lock/heartbeat del runner, el store del resultado persistido y el parseo
// defensivo de propuestas — la misma clase de duplicación que Coherencia sale
// a cazar en OTROS módulos (regla 2 de evaluateCoherence), aplicada a su
// propia infraestructura hermana.
//
// QUÉ HAY ACÁ: tres FÁBRICAS puras (sin estado global) que cada módulo
// instancia con sus rutas/campos, re-exportando sus nombres históricos
// (writeOptLock, parseCoherence, …) para no tocar los runners ni el server:
//   - makeLock({file, freshMs}): lock/heartbeat del runner desacoplado
//     (patrón desk/triage; reserva pid:0 del server + reclamo del runner).
//   - makeResultStore({file, tag, empty}): resultado persistido en
//     ~/.cwc-data (sobrevive reinicios; el front lo encuesta).
//   - makeProposalParser({keyField, tipos, risks, engine, catalogs}): parseo
//     defensivo del texto del modelo → propuestas con id estable (sha1).
// Más la allowlist read-only común (regla 6) y el sha corto compartido.
//
// GARANTÍAS: no cambia NINGÚN comportamiento — es la extracción literal del
// código que estaba duplicado. Las reglas duras siguen intactas: regla de oro
// (runner detached + lock/heartbeat + estado en ~/.cwc-data) y regla 6 (dos
// capas read-only con la allowlist de abajo).
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  validateField, recordAttempt, charsToUnits, estimateCostUsd,
} from '../../core/closed-envelope.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';

export const DATA_DIR = path.join(os.homedir(), '.cwc-data');

// Allowlist de herramientas: SOLO lecturas locales (dos capas — regla 6).
// Idéntica a la del auditor de salud (toolAllowed de shared.js) a propósito:
// estos motores LEEN código y datos, jamás escriben.
export function readOnlyToolAllowed(name) {
  return ['Read', 'Grep', 'Glob', 'TodoWrite'].includes(name);
}

// sha corto compartido (ids estables de propuestas/hallazgos).
export const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// ===== Fábrica de lock/heartbeat del runner (patrón desk/triage) =====
// Guarda { pid, ts, phase } — phase alimenta el progreso del front. El server
// RESERVA con pid:0 antes de spawnear (cierra la carrera TOCTOU, patrón
// spawnFix); el runner reclama esa reserva (otherAlive exige pid real).
export function makeLock({ file, freshMs }) {
  const write = (state) => {
    try {
      fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      fss.writeFileSync(file, JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 });
    } catch { /* noop */ }
  };
  const clear = () => { try { fss.unlinkSync(file); } catch { /* noop */ } };
  const read = () => {
    try {
      const l = JSON.parse(fss.readFileSync(file, 'utf8'));
      if (Date.now() - l.ts >= freshMs) return null; // lock viejo = runner muerto
      return l;
    } catch { return null; }
  };
  const isRunning = () => !!read();
  // ¿Hay OTRO runner realmente corriendo? Exige pid REAL (≠ 0): la reserva del
  // server (pid:0) NO cuenta — sin esto el runner vería su propia reserva y se
  // auto-deadlockearía (mismo patrón que otherBatchAlive del orquestador).
  const otherAlive = () => {
    try {
      const { pid, ts } = JSON.parse(fss.readFileSync(file, 'utf8'));
      return !!pid && pid !== process.pid && Date.now() - ts < freshMs;
    } catch { return false; }
  };
  return { write, clear, read, isRunning, otherAlive };
}

// ===== Fábrica del resultado persistido (sobrevive reinicios) =====
// `empty` es una FUNCIÓN que devuelve el shape vacío (objeto fresco por
// llamada — un literal compartido dejaría arrays mutables en común).
export function makeResultStore({ file, tag, empty }) {
  const read = () => {
    try { return JSON.parse(fss.readFileSync(file, 'utf8')); }
    catch { return empty(); }
  };
  const write = (data) => {
    try {
      writeJsonAtomic(file, data);
    } catch (err) { console.error(`[${tag}] no pude escribir ${path.basename(file)}:`, err?.message); }
  };
  return { read, write };
}

// ===== Fábrica de parseo defensivo de propuestas =====
// `keyField` es el campo protagonista de cada motor ('motor' en Optimización,
// 'foco' en Coherencia); tipos/risks conservan la API histórica y catalogs
// aporta los sobres cerrados cuando están disponibles; engine identifica el
// ledger. El id (sha1 de keyField|tipo|propuesta) y los topes (12 propuestas,
// recortes de campos) son EXACTAMENTE los históricos — no cambiarlos: los ids
// persistidos en optimization.json/coherence.json dependen de esta fórmula.
export function makeProposalParser({
  keyField, tipos, risks, engine = 'health-proposals', catalogs = {},
}) {
  const validate = (catalog, legacySet, field, value) => (
    catalog
      ? validateField(catalog, value)
      : legacySet?.has(value)
        ? { ok: true, value }
        : { ok: false, errorClass: 'value_out_of_catalog', field, offending: String(value ?? '').slice(0, 40) }
  );
  const proposalId = (p) => sha(`${p[keyField] || ''}|${p.tipo || ''}|${p.propuesta || ''}`);
  const parse = (text) => {
    const outputUnits = charsToUnits(String(text || '').length);
    const rejectUnparseable = () => {
      recordAttempt({
        engine,
        outcome: 'rejected_invalid_output',
        errorClass: 'unparseable_output',
        outputUnits,
        estimatedCostUsd: estimateCostUsd({ outputUnits }),
      });
      return null;
    };
    const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
    const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
    if (!raw) return rejectUnparseable();
    let o;
    try { o = JSON.parse(raw); } catch { return rejectUnparseable(); }
    if (!o || typeof o !== 'object') return rejectUnparseable();
    const propuestas = [];
    for (const p of (Array.isArray(o.propuestas) ? o.propuestas : []).slice(0, 12)) {
      const tipo = validate(catalogs.tipo, tipos, 'tipo', p?.tipo);
      const riesgo = validate(catalogs.riesgo, risks, 'riesgo', p?.riesgo);
      const invalid = !tipo.ok ? tipo : !riesgo.ok ? riesgo : null;
      if (invalid) {
        recordAttempt({
          engine,
          outcome: 'rejected_invalid_output',
          errorClass: invalid.errorClass,
          field: invalid.field,
          offending: invalid.offending,
          outputUnits,
          estimatedCostUsd: estimateCostUsd({ outputUnits }),
          deterministicReason: 'valor fuera del catálogo cerrado: la propuesta se rechaza en vez de coaccionarse a un default',
        });
        continue;
      }
      const clean = {
        [keyField]: String(p[keyField] ?? '').slice(0, 80),
        archivo: String(p.archivo ?? '').slice(0, 200),
        tipo: tipo.value,
        actual: String(p.actual ?? '').slice(0, 400),
        propuesta: String(p.propuesta ?? '').slice(0, 500),
        razon: String(p.razon ?? '').slice(0, 600),
        impacto: String(p.impacto ?? '').slice(0, 300),
        riesgo: riesgo.value,
        archivos: (Array.isArray(p.archivos) ? p.archivos : []).slice(0, 6).map((a) => String(a).slice(0, 200)),
        pasos: (Array.isArray(p.pasos) ? p.pasos : []).slice(0, 8).map((s) => String(s).slice(0, 300)),
        status: 'pending',
      };
      // ESTABILIDAD DE IDs: la fórmula histórica keyField|tipo|propuesta no se
      // toca. Las propuestas válidas nunca pasaban por coerción, por lo que sus
      // ids persistidos en optimization.json/coherence.json siguen resolviendo.
      propuestas.push({ ...clean, id: proposalId(clean) });
    }
    const fn = o.flujoNuevo && typeof o.flujoNuevo === 'object' ? o.flujoNuevo : null;
    return {
      resumen: String(o.resumen ?? '').slice(0, 1200),
      propuestas,
      flujoNuevo: fn ? {
        vale: fn.vale === true,
        titulo: String(fn.titulo ?? '').slice(0, 120),
        descripcion: String(fn.descripcion ?? '').slice(0, 800),
        diseno: (Array.isArray(fn.diseno) ? fn.diseno : []).slice(0, 10).map((s) => String(s).slice(0, 300)),
      } : null,
    };
  };
  return { proposalId, parse };
}
