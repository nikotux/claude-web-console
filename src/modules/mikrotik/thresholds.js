import fs from 'node:fs';
import path from 'node:path';

import { resolveDataDir } from '../../core/data-dir.js';

// Los cortes combinan los requisitos de NICE CXone para agentes en VDI con
// ITU-T G.114 para voz. Para comparar ambos criterios usamos one-way ≈ RTT/2.
// El thr-avg=100ms de fábrica de netwatch no sirve como umbral operativo acá:
// estos trabajadores ya tienen 80-92ms reales y el estado parpadearía ante
// cualquier variación normal.
export const DEFAULT_THRESHOLDS = Object.freeze({
  optimo: Object.freeze({ rttAvg: 100, jitter: 20, lossPercent: 0.5 }),
  atencion: Object.freeze({ rttAvg: 150, jitter: 40, lossPercent: 1 }),
  degradado: Object.freeze({ rttAvg: 250, jitter: 75, lossPercent: 3 }),
});

const STATES = ['optimo', 'atencion', 'degradado', 'critico'];
const AXES = ['rttAvg', 'jitter', 'lossPercent'];

let thresholdsCache = { file: '', mtimeMs: null, thresholds: null };

function copyDefaults() {
  return Object.fromEntries(
    Object.entries(DEFAULT_THRESHOLDS).map(([state, values]) => [state, { ...values }]),
  );
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateThresholds(thresholds) {
  for (const axis of AXES) {
    let previous = -Infinity;
    for (const state of ['optimo', 'atencion', 'degradado']) {
      const value = thresholds[state][axis];
      if (!Number.isFinite(value) || value < 0 || value < previous) {
        throw new TypeError(`Umbral inválido para ${state}.${axis}`);
      }
      previous = value;
    }
  }
}

function configMtime(configPath) {
  try {
    return fs.statSync(configPath).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function loadThresholds() {
  const configPath = path.join(resolveDataDir(), 'mikrotik', 'thresholds.json');
  let thresholds = copyDefaults();
  let mtimeMs = null;

  try {
    if (fs.existsSync(configPath)) {
      // Evita la ventana TOCTOU: el mtime previo identifica el contenido leído;
      // si cambia después, el cache queda deliberadamente viejo y fuerza otra lectura.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const mtimeBefore = configMtime(configPath);
        const overrides = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!isPlainObject(overrides)) {
          throw new TypeError('thresholds.json debe contener un objeto plano');
        }
        const candidate = copyDefaults();
        for (const state of ['optimo', 'atencion', 'degradado']) {
          if (overrides[state] === undefined) continue;
          if (!isPlainObject(overrides[state])) {
            throw new TypeError(`Override inválido para ${state}`);
          }
          Object.assign(candidate[state], overrides[state]);
        }
        validateThresholds(candidate);

        const mtimeAfter = configMtime(configPath);
        thresholds = candidate;
        mtimeMs = mtimeBefore;
        if (mtimeAfter === mtimeBefore) break;
      }
    } else {
      validateThresholds(thresholds);
    }
  } catch (error) {
    console.error(`[mikrotik] thresholds.json inválido; se usan los umbrales por defecto: ${error?.message}`);
    thresholds = copyDefaults();
    try {
      mtimeMs = configMtime(configPath);
    } catch {
      mtimeMs = null;
    }
    validateThresholds(thresholds);
  }

  thresholdsCache = {
    file: configPath,
    mtimeMs,
    thresholds,
  };
  return thresholds;
}

function currentThresholds() {
  const configPath = path.join(resolveDataDir(), 'mikrotik', 'thresholds.json');
  let mtimeMs;
  try {
    mtimeMs = configMtime(configPath);
  } catch (error) {
    // Falla abierto: un problema transitorio de acceso no invalida cortes ya probados.
    if (thresholdsCache.thresholds) return thresholdsCache.thresholds;
    throw error;
  }

  if (
    thresholdsCache.thresholds
    && thresholdsCache.file === configPath
    && thresholdsCache.mtimeMs === mtimeMs
  ) {
    return thresholdsCache.thresholds;
  }

  try {
    return loadThresholds();
  } catch (error) {
    // Falla abierto: un JSON ilegible o inválido no reemplaza los últimos umbrales válidos.
    if (thresholdsCache.thresholds) return thresholdsCache.thresholds;
    throw error;
  }
}

function classifyAxis(value, axis, thresholds) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`Medición inválida para ${axis}`);
  }
  if (value <= thresholds.optimo[axis]) return 'optimo';
  if (value <= thresholds.atencion[axis]) return 'atencion';
  if (value <= thresholds.degradado[axis]) return 'degradado';
  return 'critico';
}

export function classify({ rttAvg, jitter, lossPercent, responding }) {
  if (!responding) return 'caido';

  const thresholds = currentThresholds();
  const axisStates = [
    classifyAxis(rttAvg, 'rttAvg', thresholds),
    classifyAxis(jitter, 'jitter', thresholds),
    classifyAxis(lossPercent, 'lossPercent', thresholds),
  ].filter((state) => state !== null);

  // Los datos parciales son válidos, pero sin ninguna medición el caller no puede afirmar "óptimo".
  if (!axisStates.length) throw new TypeError('Sin mediciones para clasificar');

  return axisStates.reduce(
    (worst, state) => (STATES.indexOf(state) > STATES.indexOf(worst) ? state : worst),
    'optimo',
  );
}
