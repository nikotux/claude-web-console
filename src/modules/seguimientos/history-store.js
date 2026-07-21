// modules/seguimientos/history-store.js — registro DIARIO de conteos del
// dashboard (PLAN-553). Alimenta los gráficos de TENDENCIA con filtro de tiempo
// (día/semana/mes/año) de la sección Métricas. Empieza vacío y se llena hacia
// adelante en cada refresh (no hay historia pasada que reconstruir). Vive en
// ~/.cwc-data/seguimientos/history.json (Limbo lo hospeda). Escritura atómica.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomic } from '../../core/atomic-write.js';

const DIR = path.join(os.homedir(), '.cwc-data', 'seguimientos');
const HISTORY = path.join(DIR, 'history.json');
const KEEP_DAYS = 400;

// Día LOCAL (Medellín, UTC-5 fijo) — mismo criterio que el módulo tokens.
function localDay() {
  const d = new Date(Date.now() - 5 * 3600000);
  return d.toISOString().slice(0, 10);
}

export function readHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
    return Array.isArray(j.days) ? j.days : [];
  } catch { return []; }
}

// Registra/actualiza el punto del DÍA con los conteos actuales. Upsert por fecha
// (varios refresh en el mismo día pisan el punto del día, no lo duplican).
export function appendHistory({ open = 0, done = 0, byProject = {}, byDomain = {}, blocked = 0 } = {}) {
  const day = localDay();
  const days = readHistory().filter((d) => d.date !== day);
  days.push({ date: day, open, done, blocked, byProject, byDomain });
  days.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = days.slice(-KEEP_DAYS);
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    writeJsonAtomic(HISTORY, { days: trimmed });
  } catch { /* best-effort: nunca romper el refresh por la historia */ }
  return trimmed;
}

export { HISTORY };
