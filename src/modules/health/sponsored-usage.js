// Chequeo informativo del consumo diario de usuarios patrocinados.
//
// Reusa buildSummary(), la fuente única del módulo Uso: allí se resuelven los
// transcripts con userClaudeDir(owner) y el día local de America/Bogota. El
// costo es el equivalente en USD calculado por ese módulo, no una factura real.
// Este chequeo NUNCA bloquea runners ni impone un tope: solo avisa en Salud.
//
// USD 10/día es el default deliberadamente conservador: alcanza para detectar
// una jornada individual intensiva sin convertir variaciones chicas en ruido.
// Se puede ajustar con CWC_SPONSORED_USAGE_WARN_USD (número >= 0).
import { getUserTier, listUsers, sponsorOf } from '../../core/users.js';
import { buildSummary } from '../tokens/index.js';

const DEFAULT_WARN_USD = 10;
const ID = 'sponsored-usage';
const LABEL = 'Consumo de usuarios patrocinados';

function warnThresholdUsd() {
  const raw = process.env.CWC_SPONSORED_USAGE_WARN_USD;
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_WARN_USD;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_WARN_USD;
}

function usd(value) {
  return `$${value.toFixed(2)}`;
}

// Resiliencia por ítem: un espacio de usuario nuevo, incompleto o ilegible se
// informa como indeterminado y no cambia el estado global a fail/error. Los
// demás patrocinados se siguen midiendo en paralelo.
async function usageFor(user, thresholdUsd) {
  let sponsor = user.sponsor || null;
  try {
    sponsor = sponsorOf(user.username) || sponsor;
    const summary = await buildSummary(user.username);
    const todayUsageUsd = Number(summary?.today?.cost);
    const projects = summary?.projects;
    if (!Number.isFinite(todayUsageUsd) || !Array.isArray(projects)) {
      throw new Error('consumo diario no disponible');
    }
    // buildSummary tolera líneas JSONL dañadas. Si no pudo rescatar ningún
    // transcript de Claude, no confundimos ese vacío (también normal en una
    // cuenta recién creada) con un consumo real de USD 0.
    if (!projects.length && todayUsageUsd === 0) {
      throw new Error('sin transcripts de Claude utilizables');
    }
    return {
      username: user.username,
      sponsor,
      todayUsageUsd,
      thresholdUsd,
      status: todayUsageUsd > thresholdUsd ? 'warn' : 'ok',
    };
  } catch (err) {
    return {
      username: user.username,
      sponsor,
      todayUsageUsd: null,
      thresholdUsd,
      status: 'indeterminate',
      reason: String(err?.message || err).slice(0, 160),
    };
  }
}

export async function checkSponsoredUsage() {
  const thresholdUsd = warnThresholdUsd();
  let sponsored;
  try {
    sponsored = listUsers().filter((user) => getUserTier(user.username) === 'sponsored');
  } catch (err) {
    return {
      id: ID,
      label: LABEL,
      status: 'warn',
      detail: `no pude enumerar usuarios patrocinados (${String(err?.message || err).slice(0, 160)})`,
      users: [],
    };
  }

  if (!sponsored.length) {
    return {
      id: ID,
      label: LABEL,
      status: 'ok',
      detail: 'no hay usuarios patrocinados',
      users: [],
    };
  }

  const users = await Promise.all(sponsored.map((user) => usageFor(user, thresholdUsd)));
  const exceeded = users.filter((user) => user.status === 'warn');
  const detail = users.map((user) => user.status === 'indeterminate'
    ? `${user.username} (sponsor: ${user.sponsor || '?'}) · consumo indeterminado · umbral ${usd(user.thresholdUsd)}`
    : `${user.username} (sponsor: ${user.sponsor || '?'}) · hoy ${usd(user.todayUsageUsd)} · umbral ${usd(user.thresholdUsd)}`
  ).join(' · ');

  return {
    id: ID,
    label: LABEL,
    status: exceeded.length ? 'warn' : 'ok',
    detail,
    users,
  };
}
