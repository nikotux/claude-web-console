// modules/health/pad-writeback-shared.js — cierra el circuito de escritura a
// Pad para las propuestas de Optimización IA / Coherencia (2026-07-19, pedido
// de Niko: "que se hablen entre sí a través de Pad"). Hasta ahora ambos motores
// solo LEÍAN el backlog (padContext() de shared.js, inyectado en el prompt) —
// aprobar una propuesta abría el chat supervisado de siempre pero NUNCA quedaba
// registrada en Pad (la lección de Mejora Continua "cruzar y registrar contra
// el backlog de Pad" seguía siendo un paso manual que a veces se olvidaba).
//
// createTaskFromProposal(): al aprobar, crea la TAREA en la colección
// `pendientes` (el mismo tablero de Pendientes de Niko) — 0 tokens, HTTP a Pad.
// El ref se guarda en la propuesta persistida (optimization.json/coherence.json)
// para poder referenciarla. best-effort: si Pad no responde, la aprobación NO
// se bloquea (igual queda 'accepted'), solo sin padRef.
import * as padLocal from '../../core/pad-service-client.js';
import { loadArquiIndex, linkItemToArqui } from './arqui-link-shared.js';

const KIND_LABEL = { optimize: 'Optimización IA', coherence: 'Coherencia' };

export async function createTaskFromProposal(p, kind) {
  const focus = kind === 'optimize' ? p.motor : p.foco;
  const label = KIND_LABEL[kind] || kind;
  const title = `[${label}] ${focus || '?'}: ${String(p.propuesta || '').slice(0, 100)}`.slice(0, 140);
  const body = [
    `Tipo: ${p.tipo || '—'} · Riesgo: ${p.riesgo || '—'}`,
    p.archivo ? `Archivo: ${p.archivo}` : '',
    `Actual: ${p.actual || ''}`,
    `Propuesta: ${p.propuesta || ''}`,
    `Razón: ${p.razon || ''}`,
    p.impacto ? `Impacto esperado: ${p.impacto}` : '',
    p.archivos?.length ? `Archivos a tocar: ${p.archivos.join(', ')}` : '',
    p.pasos?.length ? `Pasos:\n${p.pasos.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
    `\n(Creado desde ${label} — propuesta aprobada por Niko.)`,
  ].filter(Boolean).join('\n');
  const r = await padLocal.createItem('pendientes', {
    title,
    content: body,
    // `tags` es nativo y Pad solo lo aplica plano; ver pad-service-client.js:261.
    tags: [kind],
    fields: { status: 'pendiente', priority: 'media' },
  }, { workspace: 'console' });
  if (!r || !r.ok) throw new Error(`Pad no aceptó la tarea: ${r?.error || 'error'}`);
  const ref = r.data?.ref || null;
  if (ref) {
    try { const idx = await loadArquiIndex(); await linkItemToArqui(ref, p, idx); }
    catch (err) { console.error('[pad-writeback] link ARQUI de la tarea falló (best-effort):', err?.message); }
  }
  return ref;
}
