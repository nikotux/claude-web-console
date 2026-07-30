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

let loadedThresholds;

function copyDefaults() {
  return Object.fromEntries(
    Object.entries(DEFAULT_THRESHOLDS).map(([state, values]) => [state, { ...values }]),
  );
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

export function loadThresholds() {
  const thresholds = copyDefaults();
  const configPath = path.join(resolveDataDir(), 'mikrotik', 'thresholds.json');

  if (fs.existsSync(configPath)) {
    const overrides = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const state of ['optimo', 'atencion', 'degradado']) {
      if (overrides[state] && typeof overrides[state] === 'object') {
        Object.assign(thresholds[state], overrides[state]);
      }
    }
  }

  validateThresholds(thresholds);
  loadedThresholds = thresholds;
  return thresholds;
}

function classifyAxis(value, axis, thresholds) {
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

  const thresholds = loadedThresholds ?? loadThresholds();
  const axisStates = [
    classifyAxis(rttAvg, 'rttAvg', thresholds),
    classifyAxis(jitter, 'jitter', thresholds),
    classifyAxis(lossPercent, 'lossPercent', thresholds),
  ];

  return axisStates.reduce(
    (worst, state) => (STATES.indexOf(state) > STATES.indexOf(worst) ? state : worst),
    'optimo',
  );
}
