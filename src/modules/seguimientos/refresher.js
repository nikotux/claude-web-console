// modules/seguimientos/refresher.js — puebla el snapshot de Limbo desde la
// Aduana. F1.1: solo la fuente Desk (determinística, 0 tokens). El clasificador
// IA (F1.2) refina ownerBall/blockedBy en un runner desacoplado aparte y
// re-escribe el snapshot conservando estos frentes.
import { pullDeskFrentes, enrichFrentes } from './desk-source.js';
import { readSnapshot, writeSnapshot } from './store.js';

let running = false;

export function isRefreshing() { return running; }

// Refresca el snapshot: trae frentes de Desk → conteos → persiste. Preserva
// la clasificación IA previa (override/ownerBall) por `id` si el frente sigue.
export async function refreshNow() {
  if (running) return readSnapshot();
  running = true;
  try {
    const prev = readSnapshot();
    const prevById = new Map((prev.frentes || []).map((f) => [f.id, f]));
    const frentes = (await pullDeskFrentes()).map((f) => {
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
    };
    return writeSnapshot({ frentes, counts, updatedAt: new Date().toISOString(), refreshing: false });
  } finally {
    running = false;
  }
}
