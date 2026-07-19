#!/usr/bin/env node
// bin/cwc-health-proposal-mark.js — marca UNA propuesta de Optimización o
// Coherencia como aceptada (aplicada) o descartada (falso positivo/no aplica),
// para que el tablero de Salud refleje que ya se decidió. Es el gemelo de
// cwc-health-resolve.js (que cierra HALLAZGOS de la Revisión) para el otro tipo
// de ítem: las PROPUESTAS. Lo corre el chat de "Resolver todo" (Orquestador)
// como último paso tras aplicar/descartar cada propuesta — sin esto, la
// propuesta quedaba "pending" en su sección aunque ya se hubiera resuelto
// (gap señalado por Niko 2026-07-19).
//
// Determinístico, 0 tokens: solo marca status + decidedAt en el JSON del motor
// (optimization.json / coherence.json) reusando readOpt/writeOpt · readCoh/
// writeCoh de las shared — la MISMA persistencia que el endpoint POST
// /optimize-proposal · /coherence-proposal. NO toca código ni reinicia nada.
// A DIFERENCIA del endpoint, NO crea la tarea en Pad (el registro del trabajo
// va por las skills de Pad / BUG-item si corresponde); acá solo cierra el
// estado del tablero.
//
// Uso:  node bin/cwc-health-proposal-mark.js <optimize|coherence> <id> <accept|reject>
import { readOpt, writeOpt } from '../src/modules/health/optimize-shared.js';
import { readCoh, writeCoh } from '../src/modules/health/coherence-shared.js';

const kind = process.argv[2];
const id = process.argv[3];
const action = process.argv[4];

if (!['optimize', 'coherence'].includes(kind) || !id || !['accept', 'reject'].includes(action)) {
  console.error('Uso: cwc-health-proposal-mark.js <optimize|coherence> <id> <accept|reject>');
  process.exit(2);
}

const [read, write] = kind === 'optimize' ? [readOpt, writeOpt] : [readCoh, writeCoh];
const st = read();
const p = (st.propuestas || []).find((x) => x.id === id);
if (!p) {
  console.error(`Propuesta ${id} no encontrada en ${kind} (¿se re-analizó la salud?). No se marcó nada.`);
  process.exit(1);
}

p.status = action === 'accept' ? 'accepted' : 'rejected';
p.decidedAt = Date.now();
write(st);
console.log(`✅ Propuesta ${id} (${kind}) marcada ${p.status}: ${p.foco || p.motor || ''}`);
