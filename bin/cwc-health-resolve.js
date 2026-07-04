#!/usr/bin/env node
// bin/cwc-health-resolve.js — marca UN hallazgo de la revisión de salud como
// RESUELTO. Lo corre el PROPIO chat supervisado ("En chat" del modal de Salud)
// como último paso, una vez que verificó e implementó el fix — así el tablero de
// Salud refleja el hallazgo como resuelto y la lista de "sin resolver" queda
// fiel para el seguimiento en vivo (antes el camino "En chat" no marcaba nada).
//
// Es DETERMINÍSTICO y NO consume tokens: solo escribe archivos (review.json +
// health-solved.json) reusando markFindingResolved() de health/shared.js — el
// mismo patrón que los otros runners desacoplados (regla 2). No toca código, no
// reinicia nada.
//
// Uso:  node bin/cwc-health-resolve.js <findingId> [resumen corto del fix]
import { markFindingResolved } from '../src/modules/health/shared.js';

const id = process.argv[2];
const summary = process.argv.slice(3).join(' ').trim();

if (!id) {
  console.error('Uso: cwc-health-resolve.js <findingId> [resumen del fix]');
  process.exit(2);
}

const f = markFindingResolved(id, summary);
if (!f) {
  console.error(`Hallazgo ${id} no encontrado en review.json (¿se re-analizó la salud?). No se marcó nada.`);
  process.exit(1);
}

console.log(`✅ Hallazgo marcado como resuelto: ${f.area || id}${summary ? ` — ${summary}` : ''}`);
