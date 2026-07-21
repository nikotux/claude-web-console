// modules/seguimientos/refresher.js — puebla el snapshot de Limbo desde la
// Aduana. F1.1: solo la fuente Desk (determinística, 0 tokens). El clasificador
// IA (F1.2) refina ownerBall/blockedBy en un runner desacoplado aparte y
// re-escribe el snapshot conservando estos frentes.
import { pullDeskData, enrichFrentes } from './desk-source.js';
import { readSnapshot, writeSnapshot } from './store.js';
import { appendHistory } from './history-store.js';

let running = false;

export function isRefreshing() { return running; }

// Refresca el snapshot: trae open+done de Desk → enriquece → conteos → persiste.
// Preserva la clasificación IA previa (override/ownerBall) por `id` si el frente
// no cambió. `done` alimenta las métricas; no entra a la tabla de tickets.
export async function refreshNow() {
  if (running) return readSnapshot();
  running = true;
  try {
    const prev = readSnapshot();
    const prevById = new Map((prev.frentes || []).map((f) => [f.id, f]));
    const { open, done } = await pullDeskData();
    const frentes = open.map((f) => {
      const old = prevById.get(f.id);
      if (!old) return f;
      // Conservar lo que puso el clasificador/override si el ticket no cambió.
      return old.fingerprint === f.fingerprint
        ? { ...f, ownerBall: old.ownerBall, ownerType: old.ownerType, blockedBy: old.blockedBy, involucrados: old.involucrados, nextAction: old.nextAction, isBackend: old.isBackend, isMine: old.isMine, override: old.override }
        : { ...f, override: old.override };
    });
    await enrichFrentes(frentes, prevById);
    const counts = {
      total: frentes.length,
      casa: frentes.filter((f) => f.domain === 'casa').length,
      oficina: frentes.filter((f) => f.domain === 'oficina').length,
      onHold: frentes.filter((f) => f.statusType === 'On Hold').length,
      mine: frentes.filter((f) => f.mine).length,
      withDeadline: frentes.filter((f) => f.dueDate).length,
      done: done.length,
    };
    // Registro diario para las tendencias de Métricas (best-effort).
    const byProject = {}; const byDomain = {};
    for (const f of frentes) { const p = f.project || 'Otros'; byProject[p] = (byProject[p] || 0) + 1; byDomain[f.domain || 'otros'] = (byDomain[f.domain || 'otros'] || 0) + 1; }
    appendHistory({ open: frentes.length, done: done.length, blocked: frentes.filter((f) => f.statusType === 'On Hold').length, byProject, byDomain });
    return writeSnapshot({ frentes, done, counts, updatedAt: new Date().toISOString(), refreshing: false });
  } finally {
    running = false;
  }
}
