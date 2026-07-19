#!/usr/bin/env node
// bin/cwc-health-proposal-done.js — marca en Pad (colección `pendientes`, ref
// PEND-N) como 'hecha' la TAREA que se creó al APROBAR una propuesta de
// Optimización IA / Coherencia (pad-writeback-shared.js). Lo corre el PROPIO
// chat supervisado ("Aplicar en chat") como último paso, una vez que verificó
// e implementó el cambio — así el circuito Pad se cierra solo: proponer →
// aprobar (crea la tarea) → trabajar → chat cierra (marca hecha).
//
// Es DETERMINÍSTICO y NO consume tokens: getItem + updateItem (HTTP a Pad
// local), patrón cwc-health-resolve.js. `fields` se REEMPLAZA ENTERO en un
// PATCH (ver pad-service-client.js) — por eso hace read-modify-write en vez de
// mandar solo {status:'hecha'} (perdería priority/tags existentes).
//
// Uso: node bin/cwc-health-proposal-done.js <ref PEND-N>
import { getItem, updateItem } from '../src/core/pad-service-client.js';

const ref = process.argv[2];
if (!ref || !/^PEND-\d+$/.test(ref)) {
  console.error('Uso: cwc-health-proposal-done.js <ref PEND-N>');
  process.exit(2);
}

async function main() {
  const opts = { workspace: 'console' };
  const r = await getItem(ref, opts);
  if (!r || !r.ok) {
    console.error(`No pude leer ${ref} en Pad: ${r?.error || 'error'}`);
    process.exit(1);
  }
  let fields = r.data?.fields;
  if (typeof fields === 'string') { try { fields = JSON.parse(fields); } catch { fields = {}; } }
  const up = await updateItem(ref, { fields: { ...(fields || {}), status: 'hecha' } }, opts);
  if (!up || !up.ok) {
    console.error(`No pude actualizar ${ref} en Pad: ${up?.error || 'error'}`);
    process.exit(1);
  }
  console.log(`✅ ${ref} marcado como hecha en Pad.`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
