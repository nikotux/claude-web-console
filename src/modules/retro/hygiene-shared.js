// modules/retro/hygiene-shared.js — barrido determinístico de higiene del
// registro. Solo lee Pad y compara strings: 0 IA, 0 tokens.
import { listItems } from '../../core/pad-service-client.js';
import { LEGACY_PROMOTE_TARGETS, PROMOTE_TARGETS } from './promote-shared.js';

const LEGACY_MARKER = 'Borrador generado desde la lección de Mejora Continua';
const MC_REF_RE = /\bMC-\d+\b/;

function fieldsOf(item) {
  if (item?.fields && typeof item.fields === 'object') return item.fields;
  if (typeof item?.fields === 'string') {
    try { return JSON.parse(item.fields); } catch { return {}; }
  }
  return {};
}

function padError(action, result) {
  return Object.assign(new Error(`Pad local (${action}): ${result?.error || 'error'}`), { padError: true });
}

function legacyParentRef(item) {
  return String(item?.content || '').match(MC_REF_RE)?.[0] || null;
}

function isLegacyCopy(item) {
  const content = String(item?.content || '');
  return fieldsOf(item).status === 'draft'
    && content.includes(LEGACY_MARKER)
    && content.includes('## Cuándo')
    && content.includes('## Procedimiento');
}

export async function scanHygiene(ctx = null) {
  const [playbooksR, lessonsR, conventionsR] = await Promise.all([
    listItems('playbooks', { ctx }),
    listItems('mejora-continua', { ctx }),
    listItems('conventions', { ctx }),
  ]);
  if (!playbooksR.ok) throw padError('listar playbooks para higiene', playbooksR);
  if (!lessonsR.ok) throw padError('listar lecciones para higiene', lessonsR);
  if (!conventionsR.ok) throw padError('listar convenciones para higiene', conventionsR);

  const lessonsByRef = new Map(lessonsR.data.map((item) => [item.ref, item]));
  const destinationTitles = {
    convencion: new Set(conventionsR.data.map((item) => item.title)),
  };

  const copiasRedundantes = [];
  const huerfanosDescartados = [];
  for (const item of playbooksR.data) {
    if (fieldsOf(item).status !== 'draft') continue;
    const mcRef = legacyParentRef(item);
    const parent = mcRef ? lessonsByRef.get(mcRef) : null;
    const parentStatus = parent ? fieldsOf(parent).status : null;
    if (isLegacyCopy(item)) {
      copiasRedundantes.push({
        ref: item.ref,
        title: item.title || '',
        mcRef,
        // Los soft-deleted de Pad ya no aparecen en listItems: alcanza con que el padre esté presente.
        mcExists: !!parent,
      });
    }
    if (mcRef && parentStatus === 'descartada') {
      huerfanosDescartados.push({ ref: item.ref, title: item.title || '', mcRef });
    }
  }

  const refsRotas = [];
  const destinoDeprecado = [];
  for (const item of lessonsR.data) {
    const fields = fieldsOf(item);
    if (fields.status !== 'promovida') continue;
    // Separarlos evita 80 falsas refs rotas permanentes al borrar las copias:
    // los destinos legacy se resuelven con redestinar, no borrando nada.
    if (LEGACY_PROMOTE_TARGETS.includes(fields.promotedTo)) {
      destinoDeprecado.push({ id: item.ref, title: item.title || '', promotedTo: fields.promotedTo });
      continue;
    }
    if (!PROMOTE_TARGETS.includes(fields.promotedTo)) continue;
    const titles = destinationTitles[fields.promotedTo];
    if (titles && !titles.has(item.title)) {
      refsRotas.push({ id: item.ref, title: item.title || '', promotedTo: fields.promotedTo });
    }
  }

  return {
    copiasRedundantes,
    refsRotas,
    huerfanosDescartados,
    destinoDeprecado,
    scannedAt: Date.now(),
  };
}
