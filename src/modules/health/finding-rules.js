// modules/health/finding-rules.js — ANILLO DETERMINISTA de los motores de Salud.
//
// El patrón de Chris es «lo que una regla puede resolver, lo resuelve la regla;
// la IA sólo ve el residuo ambiguo». Pero una regla no se gana ese lugar por
// parecer plausible: trae precision y support MEDIDOS sobre un corpus real y
// se contrasta con umbrales fijados DE ANTEMANO. Acá el corpus son hallazgos de
// Salud con etiqueta HUMANA: health-solved.json (un humano los hizo arreglar ⇒
// REAL) y health-dismissed.json (un humano los descartó ⇒ FALSO POSITIVO).
//
// Las reglas son DATO, no código suelto: una semilla hand-authored y nunca
// autogenerada, de la misma familia que SEED_INVARIANTS de invariants.js y
// CANONICAL_PATTERNS de core/inventory.js. Este es el anillo 🟢 de DOC-1925.
import fs from 'node:fs';
import {
  DISMISSED_FILE,
  SOLVED_FILE,
  readDismissed,
  readSolved,
} from './shared.js';

// Umbrales HEREDADOS de DOC-1925 (motor de Chris) y fijados ANTES de medir.
// Ajustarlos para que una regla pase es exactamente lo que invalida la medición.
export const MIN_SUPPORT = 3;                 // ≥3 observaciones (umbral de Chris)
export const MIN_PRECISION = 0.75;            // ≥0,75 (umbral de Chris)
export const MIN_LIFT = 2;                    // debe DUPLICAR la tasa base
export const MIN_INDEPENDENT_INCIDENTS = 2;   // evidencia de ≥2 incidentes

// El support de Chris cuenta TICKETS independientes. En nuestro corpus, tres
// filas pueden ser casi-duplicados de UNA auditoría del MISMO módulo y el MISMO
// instante: aparentan support 3, pero la evidencia es 1. Verificado el
// 2026-07-26: las 13 filas de health-dismissed.json provienen de una única
// ventana de 14 minutos del 2026-07-04. No es una vara agregada después de ver
// el resultado: hace explícita y verificable la premisa del support de Chris.

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function incidentId(value, moduleName) {
  const ms = timestampMs(value);
  const minute = ms === null ? 'unknown' : Math.floor(ms / 60_000) * 60_000;
  return `${minute}|${String(moduleName ?? '')}`;
}

function corpusError(errorClass) {
  return {
    available: false,
    rows: [],
    baseRate: 0,
    incidents: 0,
    corpusId: null,
    error: errorClass,
  };
}

export function loadCorpus() {
  try {
    // Los readers existentes son la fuente del shape. Leemos además el JSON
    // crudo sólo para distinguir «archivo vacío legítimo» de la falla que esos
    // readers históricos degradan silenciosamente a [].
    const solvedRaw = JSON.parse(fs.readFileSync(SOLVED_FILE, 'utf8'));
    const dismissedRaw = JSON.parse(fs.readFileSync(DISMISSED_FILE, 'utf8'));
    if (!Array.isArray(solvedRaw) || !Array.isArray(dismissedRaw)) {
      return corpusError('invalid_corpus');
    }
    const solved = readSolved();
    const dismissed = readDismissed();
    const fields = (row, label, origin) => ({
      label,
      area: row?.area ?? '',
      module: row?.module ?? '',
      file: row?.file ?? '',
      severity: row?.severity ?? null,
      kind: row?.kind ?? null,
      incidentId: incidentId(origin, row?.module),
    });
    const rows = [
      ...solved.map((row) => fields(row, 'real', row?.firstResolvedAt)),
      ...dismissed.map((row) => fields(row, 'fp', row?.firstAt)),
    ];
    const newestMtime = Math.trunc(Math.max(
      fs.statSync(SOLVED_FILE).mtimeMs,
      fs.statSync(DISMISSED_FILE).mtimeMs,
    ));
    return {
      available: true,
      rows,
      baseRate: rows.length === 0 ? 0 : dismissed.length / rows.length,
      incidents: new Set(rows.map((row) => row.incidentId)).size,
      corpusId: `health-${solved.length}s-${dismissed.length}d-${newestMtime}`,
      error: null,
    };
  } catch {
    // Sólo sale una clase estable: jamás el mensaje crudo con paths o contenido.
    return corpusError('corpus_read_error');
  }
}

export function normalizeText(s) {
  try {
    // Anillo 🔵 de Chris (normalizeIntakeText): las reglas operan sobre esta
    // forma canónica, no sobre variantes accidentales de mayúsculas/diacríticos.
    return String(s ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

const RULE_FIELDS = new Set(['area', 'module', 'file', 'severity', 'kind']);

export function matchRule(rule, row) {
  try {
    if (!rule || !row || !RULE_FIELDS.has(rule.field)) return false;
    const candidate = normalizeText(row[rule.field]);
    if (Object.hasOwn(rule, 'equals')) {
      return candidate === normalizeText(rule.equals);
    }
    if (typeof rule.pattern !== 'string') return false;
    let re;
    try { re = new RegExp(rule.pattern, typeof rule.flags === 'string' ? rule.flags : ''); }
    catch { return false; } // regex inválido: falla cerrado, nunca tira
    return re.test(candidate);
  } catch {
    return false;
  }
}

export function measureRule(rule, corpus) {
  try {
    const rows = corpus?.available && Array.isArray(corpus.rows) ? corpus.rows : [];
    const hits = rows.filter((row) => matchRule(rule, row));
    const fpHits = hits.filter((row) => row.label === 'fp');
    const support = hits.length;
    const fp = fpHits.length;
    const precision = support === 0 ? 0 : fp / support;
    const baseRate = Number(corpus?.baseRate);
    const lift = Number.isFinite(baseRate) && baseRate > 0 ? precision / baseRate : 0;
    // Como la regla predice FP, la independencia se mide sobre los FP que
    // sostienen esa predicción, no sobre sus contraejemplos reales. Los tres FP
    // de la candidata comparten minuto+módulo y aportan UNA sola evidencia.
    const independentIncidents = new Set(fpHits.map((row) => row.incidentId)).size;
    const failedOn = [];
    if (support < MIN_SUPPORT) failedOn.push('support');
    if (precision < MIN_PRECISION) failedOn.push('precision');
    if (lift < MIN_LIFT) failedOn.push('lift');
    if (independentIncidents < MIN_INDEPENDENT_INCIDENTS) failedOn.push('independence');
    return {
      support,
      fp,
      precision,
      lift,
      independentIncidents,
      passes: failedOn.length === 0,
      failedOn,
    };
  } catch {
    return {
      support: 0,
      fp: 0,
      precision: 0,
      lift: 0,
      independentIncidents: 0,
      passes: false,
      failedOn: ['support', 'precision', 'lift', 'independence'],
    };
  }
}

export const CANDIDATE_RULES = [
  {
    id: 'falta-validacion-suele-ser-fp',
    field: 'area',
    pattern: 'falta\\w*\\s+validaci',
    flags: 'i',
    predicts: 'fp',
    action: 'requiere-verificacion', // NUNCA descarta el hallazgo por su cuenta
    approvalState: 'draft',
    measured: {
      corpusId: 'health-183s-13d-1784984597014',
      support: 4,
      fp: 3,
      precision: 0.75,
      lift: 11.3,
      independentIncidents: 1,
      measuredAt: '2026-07-26',
    },
    note: 'Pasa support ≥3 y precision ≥0,75, pero sus 4 hits son TODOS de Módulo admin y los 3 FP comparten el firstAt exacto 2026-07-04T00:31:39.423Z: independentIncidents = 1, por debajo de MIN_INDEPENDENT_INCIDENTS. Queda en draft y NO se ejecuta. Coincide con el gotcha de src/modules/health/CLAUDE.md: el auditor alucinaba «validaciones ausentes que ya existían», así que es un candidato plausible; pero plausible no es medido. Mejor sin regla que con una regla débil.',
  },
];

// ALCANCE DE LA MEDICIÓN: sólo se pudo medir area/module/file/severity/kind.
// `summary` en solved describe el FIX y `reason` en dismissed explica el
// DESCARTE: ambos son post-hoc, no entrada del clasificador. Además severity y
// kind los etiquetó la propia IA; minar reglas sobre ellos enseñaría a imitar
// al modelo, no a la realidad. Esta tabla evita reproponer candidatos ya
// descartados por datos sin que exista evidencia nueva.
export const DISCARDED_BY_MEASUREMENT = [
  { candidate: '/(ausente|faltante|falta)/', field: 'area', support: 14, fp: 5, precision: 0.357, lift: 5.4, reason: 'precision' },
  { candidate: '/race condition/', field: 'area', support: 6, fp: 2, precision: 0.333, lift: 5.0, reason: 'precision' },
  { candidate: '/parametro/', field: 'area', support: 5, fp: 2, precision: 0.400, lift: 6.0, reason: 'precision' },
  { candidate: '/users|username/', field: 'area', support: 12, fp: 3, precision: 0.250, lift: 3.8, reason: 'precision' },
  { candidate: 'tmux', field: 'module', support: 17, fp: 4, precision: 0.235, lift: 3.5, reason: 'precision' },
  { candidate: 'admin', field: 'module', support: 18, fp: 4, precision: 0.222, lift: 3.4, reason: 'precision' },
  { candidate: 'high', field: 'severity', support: 56, fp: 4, precision: 0.071, lift: 1.1, reason: 'sin lift sobre la tasa base' },
  { candidate: 'low', field: 'severity', support: 42, fp: 3, precision: 0.071, lift: 1.1, reason: 'sin lift sobre la tasa base' },
  { candidate: 'regla', field: 'kind', support: 73, fp: 0, precision: 0.000, lift: 0.0, reason: 'precision' },
  { candidate: 'mejora', field: 'kind', support: 10, fp: 1, precision: 0.100, lift: 1.5, reason: 'precision y lift' },
  { candidate: 'public/', field: 'file', support: 26, fp: 2, precision: 0.077, lift: 1.2, reason: 'sin lift sobre la tasa base' },
  { candidate: '/sin (validar|verificar|manejo)/', field: 'area', support: 5, fp: 0, precision: 0.000, lift: 0.0, reason: 'precision' },
];

export function activeRules(corpus) {
  try {
    if (corpus?.available !== true) return [];
    // approvalState replica intake_routing_rules de Chris
    // (draft|approved|rejected|retired): sólo approved se ejecuta. Las reglas
    // son configuración versionada y aprobada, no código que corre por existir.
    // Se re-miden contra el corpus ACTUAL: si la evidencia envejece, se apagan
    // solas. Sin corpus, el anillo se OMITE (C4): no clasificar es preferible a
    // usar evidencia que ya no puede verificarse.
    return CANDIDATE_RULES.filter(
      (rule) => rule.approvalState === 'approved' && measureRule(rule, corpus).passes,
    );
  } catch {
    return [];
  }
}

export function classifyFinding(finding, corpus) {
  try {
    for (const rule of activeRules(corpus)) {
      if (!matchRule(rule, finding)) continue;
      const current = measureRule(rule, corpus);
      const precision = Number(current.precision.toFixed(3));
      return {
        ruleId: rule.id,
        predicts: rule.predicts,
        action: rule.action,
        deterministicReason: `regla ${rule.id}: ${current.fp}/${current.support} de esta clase fueron falsos positivos (precision ${precision}, support ${current.support})`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Este anillo NUNCA descarta ni resuelve por su cuenta. Es el mismo criterio
// del dedup de Chris: «nunca auto-mergea; linkea y deja una nota». Con
// action:'requiere-verificacion' el hallazgo queda ANOTADO con su prior medido,
// no eliminado: a precision 0,75, auto-descartar borraría 1 hallazgo REAL de 4.

export function rulesStatus() {
  try {
    const corpus = loadCorpus();
    const rules = CANDIDATE_RULES.map((rule) => {
      const current = measureRule(rule, corpus);
      return {
        id: rule.id,
        approvalState: rule.approvalState,
        measured: rule.measured,
        current,
        active: corpus.available === true
          && rule.approvalState === 'approved'
          && current.passes,
      };
    });
    return {
      corpus: {
        available: corpus.available,
        rows: corpus.rows.length,
        baseRate: corpus.baseRate,
        incidents: corpus.incidents,
        corpusId: corpus.corpusId,
        error: corpus.error,
      },
      thresholds: {
        MIN_SUPPORT,
        MIN_PRECISION,
        MIN_LIFT,
        MIN_INDEPENDENT_INCIDENTS,
      },
      rules,
      activeCount: rules.filter((rule) => rule.active).length,
      draftCount: rules.filter((rule) => rule.approvalState === 'draft').length,
      discardedCount: DISCARDED_BY_MEASUREMENT.length,
    };
  } catch {
    return {
      corpus: {
        available: false,
        rows: 0,
        baseRate: 0,
        incidents: 0,
        corpusId: null,
        error: 'rules_status_error',
      },
      thresholds: {
        MIN_SUPPORT,
        MIN_PRECISION,
        MIN_LIFT,
        MIN_INDEPENDENT_INCIDENTS,
      },
      rules: [],
      activeCount: 0,
      draftCount: 0,
      discardedCount: DISCARDED_BY_MEASUREMENT.length,
    };
  }
}
