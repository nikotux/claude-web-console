// modules/tokens/time.js — huso horario LOCAL del dashboard de Uso.
//
// Todo el consumo (día "hoy", buckets por hora, series por día/semana/mes) se
// calcula en la hora LOCAL de Medellín/Bogotá (America/Bogota = UTC-5 FIJO, sin
// horario de verano) — pedido del usuario 2026-07-10. Al ser un offset fijo NO
// hace falta una librería de zonas: se corre el reloj -5 h y se leen los campos
// con los getters UTC (truco estándar de offset fijo). Si algún día la zona
// tuviera DST, esto habría que reemplazarlo por Intl.DateTimeFormat.
//
// Fuente ÚNICA del offset: la comparten el parser (index.js) y el histórico
// (history-store.js) — ambos DEBEN usar la misma convención o los días no cierran.

export const TZ_LABEL = 'America/Bogota';
const OFFSET_MIN = -300; // UTC-5

// Reloj local: un Date corrido para que sus getters UTC devuelvan la hora local.
function shifted(utcMs) { return new Date(utcMs + OFFSET_MIN * 60000); }

// 'YYYY-MM-DD' de la fecha LOCAL de un timestamp UTC (ms).
export function localDayStr(utcMs) { return shifted(utcMs).toISOString().slice(0, 10); }
// 'YYYY-MM-DDTHH' de la hora LOCAL (clave de bucket horario).
export function localHourKey(utcMs) { return shifted(utcMs).toISOString().slice(0, 13); }
// Fecha local de HOY.
export function localTodayStr() { return localDayStr(Date.now()); }
// Hora local actual (0-23).
export function localHourNow() { return Number(localHourKey(Date.now()).slice(11, 13)); }

// UTC ms de la medianoche LOCAL de una fecha 'YYYY-MM-DD' (para caminar días
// exactos: sin DST, cada día local = 86400000 ms). La medianoche local 00:00
// equivale a las 05:00 UTC → se suma el offset inverso.
export function localDateStartMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00Z`) - OFFSET_MIN * 60000;
}
// UTC ms del inicio de una hora local 'YYYY-MM-DDTHH'.
export function localHourStartMs(hourKey) {
  return Date.parse(`${hourKey}:00:00Z`) - OFFSET_MIN * 60000;
}
