// core/closed-envelope.js — SOBRE CERRADO + LEDGER DE INTENTOS DE IA.
//
// Este patrón viene de la ingeniería inversa del motor de triage de intake de
// Chris (DOC-1925 del Pad `console`, PLAN-1963). Conserva dos ideas inseparables:
// (a) cuando se llama al modelo, el prompt enumera la lista FINITA de valores
// válidos y la respuesta se valida contra ESA MISMA lista; un valor fuera del
// catálogo se RECHAZA, jamás se coacciona a un default que parezca razonable;
// (b) TODO intento queda en un ledger auditable, también los RECHAZADOS, junto
// con su clase de error y su costo estimado. El principio que gobierna ambos
// lados es «mejor sin regla que con una regla débil»: degradar a «no clasifico»
// antes que a «clasifico mal».
//
// Es plomería in-process, como sdk-settings.js/paths.js: no ejecuta motores ni
// decide políticas de negocio. Todas las operaciones de runtime fallan cerradas
// o best-effort para que un catálogo o ledger roto jamás rompa un motor.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './data-dir.js';

// Enum EXACTO de `intake_triage_attempts` de Chris. No extenderlo sin actualizar
// DOC-1925: los consumidores y las métricas dependen de esta superficie cerrada.
export const OUTCOMES = Object.freeze([
  'started',
  'accepted',
  'rejected_invalid_output',
  'rejected_low_confidence',
  'error',
  'timeout',
]);

// El ledger guarda la CLASE, JAMÁS el mensaje crudo: un mensaje puede arrastrar
// rutas, tokens o contenido del usuario y convertir la auditoría en una fuga.
export const ERROR_CLASSES = Object.freeze([
  'value_out_of_catalog',
  'field_not_supported',
  'missing_required',
  'low_confidence',
  'unparseable_output',
  'empty_catalog',
  'stale_catalog',
  'timeout',
  'unknown',
]);

const OUTCOME_SET = new Set(OUTCOMES);
const ERROR_CLASS_SET = new Set(ERROR_CLASSES);
export const ATTEMPTS_FILE = path.join(resolveDataDir(), 'ai-attempts.jsonl');
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const LEDGER_KEEP_LINES = 2000;

function frozenCatalog(id, field, values, source, empty = false) {
  const catalog = {
    id,
    field,
    values: Object.freeze(values),
    set: new Set(values),
    source,
  };
  if (empty) catalog.empty = true;
  return Object.freeze(catalog);
}

export function defineCatalog({ id, field, values, source } = {}) {
  const validId = typeof id === 'string' && id.trim() !== '';
  const validField = typeof field === 'string' && field.trim() !== '';
  const valuesAreStrings = Array.isArray(values) && values.every((value) => typeof value === 'string');

  // Una definición mal formada también se convierte en catálogo vacío: es una
  // falla de configuración, pero tirar durante el import podría bajar el motor.
  // El consumidor la omite mediante validateField, sin inventar un valor.
  if (!validId || !validField || !valuesAreStrings || values.length === 0) {
    return frozenCatalog(
      validId ? id : '',
      validField ? field : '',
      [],
      source,
      true,
    );
  }
  return frozenCatalog(id, field, [...values], source);
}

export function catalogEnum(catalog) {
  try {
    if (!Array.isArray(catalog?.values) || catalog.values.length === 0) return '';
    // FUENTE ÚNICA: este literal alimenta el prompt y el Set nacido del mismo
    // array alimenta el validador. Así ambos lados no pueden divergir.
    return catalog.values.map((value) => JSON.stringify(value)).join(' | ');
  } catch {
    return '';
  }
}

function safeEvidence(value, max) {
  try { return String(value).slice(0, max); } catch { return ''; }
}

export function validateField(catalog, value) {
  try {
    if (!catalog || catalog.empty) {
      return {
        ok: false,
        omitted: true,
        errorClass: 'empty_catalog',
        field: catalog?.field ?? null,
      };
    }
    if (value === undefined || value === null || value === '') {
      return { ok: false, errorClass: 'missing_required', field: catalog.field };
    }
    if (!(catalog.set instanceof Set) || !catalog.set.has(value)) {
      return {
        ok: false,
        errorClass: 'value_out_of_catalog',
        field: catalog.field,
        offending: safeEvidence(value, 40),
      };
    }
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      errorClass: 'value_out_of_catalog',
      field: catalog?.field ?? null,
      offending: safeEvidence(value, 40),
    };
  }
}

export function validateEnvelope(obj, { catalogs = [], minConfidence = null } = {}) {
  const values = {};
  const violations = [];
  try {
    const envelope = obj && typeof obj === 'object' ? obj : {};
    const governed = Array.isArray(catalogs) ? catalogs : [];
    for (const catalog of governed) {
      const field = catalog?.field;
      const result = validateField(catalog, field == null ? undefined : envelope[field]);
      if (result.ok) values[field] = result.value;
      else {
        const violation = { field: result.field ?? null, errorClass: result.errorClass };
        if (Object.hasOwn(result, 'offending')) violation.offending = result.offending;
        violations.push(violation);
      }
    }

    // Chris rechaza confidence < 0,7 y el enum de outcomes conserva ese caso.
    // Salud/Coherencia todavía NO emiten `confidence`, por eso hoy queda inerte:
    // no se inventa el campo en ningún prompt; sólo se valida si el llamador
    // decide explícitamente activar un mínimo.
    if (minConfidence !== null) {
      const confidence = envelope.confidence;
      const minimum = Number(minConfidence);
      if (
        typeof confidence !== 'number'
        || !Number.isFinite(confidence)
        || confidence < 0
        || confidence > 1
        || !Number.isFinite(minimum)
        || confidence < minimum
      ) {
        violations.push({ field: 'confidence', errorClass: 'low_confidence' });
      } else {
        values.confidence = confidence;
      }
    }
  } catch {
    violations.push({ field: null, errorClass: 'unparseable_output' });
  }
  return { ok: violations.length === 0, values, violations };
}

function finiteOrNull(value) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

function stringOrNull(value, max) {
  if (value === undefined || value === null) return null;
  return safeEvidence(value, max);
}

function pruneLedger() {
  try {
    const stat = fs.statSync(ATTEMPTS_FILE);
    if (stat.size <= MAX_LEDGER_BYTES) return;
    // Es un ledger de auditoría ACOTADO, no un histórico eterno. Conservamos
    // contexto reciente suficiente y evitamos crecimiento sin límite; además,
    // ~/.cwc-data es runtime y no se versiona.
    const lines = fs.readFileSync(ATTEMPTS_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const kept = lines.slice(-LEDGER_KEEP_LINES);
    fs.writeFileSync(ATTEMPTS_FILE, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
  } catch {
    // La poda es mantenimiento best-effort: no debe impedir registrar el intento.
  }
}

export function recordAttempt(rec) {
  try {
    const input = rec && typeof rec === 'object' ? rec : {};
    const row = {
      ts: Date.now(),
      engine: stringOrNull(input.engine, 80),
      provider: input.provider == null ? 'anthropic' : safeEvidence(input.provider, 80),
      model: stringOrNull(input.model, 80),
      latencyMs: finiteOrNull(input.latencyMs),
      inputUnits: finiteOrNull(input.inputUnits),
      outputUnits: finiteOrNull(input.outputUnits),
      estimatedCostUsd: finiteOrNull(input.estimatedCostUsd),
      deterministicReason: stringOrNull(input.deterministicReason, 200),
      outcome: OUTCOME_SET.has(input.outcome) ? input.outcome : 'error',
      errorClass: ERROR_CLASS_SET.has(input.errorClass) ? input.errorClass : 'unknown',
      field: stringOrNull(input.field, 40),
      offending: stringOrNull(input.offending, 40),
      ref: stringOrNull(input.ref, 80),
    };
    fs.mkdirSync(path.dirname(ATTEMPTS_FILE), { recursive: true, mode: 0o700 });
    pruneLedger();
    // Whitelist explícita: `row` se construye campo por campo. Ninguna clave
    // ajena de `rec` alcanza el disco aunque el llamador pase un objeto entero.
    fs.appendFileSync(ATTEMPTS_FILE, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    // Auditar es importante; romper el motor porque no se pudo auditar es peor.
  }
}

export function readAttempts({ limit = 200 } = {}) {
  try {
    const parsedLimit = Math.max(0, Math.floor(Number(limit) || 0));
    if (parsedLimit === 0) return [];
    const lines = fs.readFileSync(ATTEMPTS_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines.slice(-parsedLimit)) {
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object' && !Array.isArray(row)) out.push(row);
      } catch {
        // Una línea truncada/corrupta no invalida las demás.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function increment(bucket, key) {
  const safeKey = typeof key === 'string' && key ? key : 'unknown';
  bucket[safeKey] = (bucket[safeKey] || 0) + 1;
}

export function attemptStats({ limit = 2000 } = {}) {
  const rows = readAttempts({ limit });
  const stats = {
    total: rows.length,
    byOutcome: {},
    byErrorClass: {},
    byEngine: {},
    rejected: 0,
    estimatedCostUsd: 0,
    rejectedCostUsd: 0,
    oldestTs: null,
    newestTs: null,
  };
  let totalCost = 0;
  let rejectedCost = 0;
  for (const row of rows) {
    increment(stats.byOutcome, row.outcome);
    increment(stats.byErrorClass, row.errorClass);
    increment(stats.byEngine, row.engine);
    const rejected = typeof row.outcome === 'string' && row.outcome.startsWith('rejected');
    if (rejected) stats.rejected += 1;
    const cost = finiteOrNull(row.estimatedCostUsd) ?? 0;
    totalCost += cost;
    if (rejected) rejectedCost += cost;
    const ts = finiteOrNull(row.ts);
    if (ts !== null) {
      stats.oldestTs = stats.oldestTs === null ? ts : Math.min(stats.oldestTs, ts);
      stats.newestTs = stats.newestTs === null ? ts : Math.max(stats.newestTs, ts);
    }
  }
  stats.estimatedCostUsd = Number(totalCost.toFixed(6));
  // Esta es LA cifra ausente hasta hoy: cuánto equivalente de API se paga por
  // respuestas que el sistema termina descartando.
  stats.rejectedCostUsd = Number(rejectedCost.toFixed(6));
  return stats;
}

export function charsToUnits(chars) {
  // Heurística deliberadamente explícita: 4 chars ≈ 1 token. El ledger dice
  // "units", no "tokens", porque esto NO es el conteo real entregado por el SDK.
  return Math.ceil(Math.max(0, Number(chars) || 0) / 4);
}

export function estimateCostUsd({ model, inputUnits = 0, outputUnits = 0 } = {}) {
  // Es un EQUIVALENTE a precios de API, no gasto real: la suscripción del CLI
  // no factura por token (misma advertencia que el módulo `tokens`).
  //
  // Esta tabla DUPLICA a propósito las funciones privadas pin()/pout() de
  // src/modules/tokens/index.js:80-93. No están exportadas y `core/` no debe
  // importar desde un módulo: invertiría la arquitectura. Esta copia queda
  // declarada como ubicación CANÓNICA futura. Unificar exportando desde acá y
  // haciendo que tokens/index.js la consuma es un contrato FORWARD, fuera de la
  // superficie de PLAN-1963.
  const key = safeEvidence(model, 80).toLowerCase();
  let inputPerMillion = 5;
  let outputPerMillion = 25;
  if (/fable|mythos/.test(key)) {
    inputPerMillion = 10;
    outputPerMillion = 50;
  } else if (/opus/.test(key)) {
    inputPerMillion = 5;
    outputPerMillion = 25;
  } else if (/sonnet/.test(key)) {
    inputPerMillion = 3;
    outputPerMillion = 15;
  } else if (/haiku/.test(key)) {
    inputPerMillion = 1;
    outputPerMillion = 5;
  }
  const input = finiteOrNull(inputUnits) ?? 0;
  const output = finiteOrNull(outputUnits) ?? 0;
  return (input / 1_000_000) * inputPerMillion + (output / 1_000_000) * outputPerMillion;
}
