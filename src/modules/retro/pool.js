// modules/retro/pool.js — puente BEST-EFFORT entre el registro PROPIO de
// Mejora Continua y el pozo COMÚN (console:PLAN-2222, F2). El pozo comparte la
// lección destilada y agrega recurrencia entre personas, pero no su procedencia
// privada: `sourceChats` jamás cruza de workspace. El retiro manual se recuerda
// en disco porque borrar sólo en Pad haría que la próxima destilación publicara
// de nuevo; tanto ese veto como el opt-out se resuelven por `resolveDataDir()`
// POR OPERACIÓN para respetar CWC_DATA_DIR y no mezclar estado user-scoped.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../../core/data-dir.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import {
  listItems, getItem, createItem, updateItem, deleteItem, setParent,
} from '../../core/pad-service-client.js';
import {
  normalizePoolTopic, poolLessonTags, POOL_TOPICS_COLLECTION, POOL_TOPIC_FALLBACK,
} from './pool-topics.js';

export const POOL_COLLECTION = 'mejora-continua';
const POOL_PROJECTS = ['console', 'tolkien', 'otros'];

// Segmentación copiada de bin/cwc-pad-wikilinks-fix.js: Pad no interpreta
// wiki-links dentro de código y el pozo debe respetar exactamente ese límite.
function lineEnd(content, start) {
  const newline = content.indexOf('\n', start);
  return newline === -1 ? content.length : newline;
}

function lineAfter(content, end) {
  return end < content.length ? end + 1 : end;
}

function fenceAtLineStart(content, start, openingFence = null) {
  const end = lineEnd(content, start);
  let cursor = start;
  let indentation = 0;
  while (cursor < end && content[cursor] === ' ' && indentation < 4) {
    cursor += 1;
    indentation += 1;
  }
  if (indentation > 3) return null;

  const marker = content[cursor];
  if (openingFence && marker !== openingFence.marker) return null;
  if (!openingFence && marker !== '`' && marker !== '~') return null;

  let markerEnd = cursor;
  while (markerEnd < end && content[markerEnd] === marker) markerEnd += 1;
  const length = markerEnd - cursor;
  if (length < 3 || (openingFence && length < openingFence.length)) return null;

  const remainder = content.slice(markerEnd, end).replace(/\r$/, '');
  if (openingFence) {
    if (!/^[ \t]*$/.test(remainder)) return null;
  } else if (marker === '`' && remainder.includes('`')) {
    return null;
  }

  return { marker, length, end };
}

function pushSegment(segments, code, content) {
  if (content.length === 0) return;
  const previous = segments.at(-1);
  if (previous?.code === code) previous.content += content;
  else segments.push({ code, content });
}

function tokenizeMarkdownCode(content) {
  const segments = [];
  let cursor = 0;
  let plainStart = 0;
  let codeStart = null;
  let fence = null;
  let inlineTicks = null;

  while (cursor < content.length) {
    const atLineStart = cursor === 0 || content[cursor - 1] === '\n';

    if (fence) {
      const closing = atLineStart
        ? fenceAtLineStart(content, cursor, fence)
        : null;
      if (closing) {
        cursor = lineAfter(content, closing.end);
        pushSegment(segments, true, content.slice(codeStart, cursor));
        codeStart = null;
        fence = null;
        plainStart = cursor;
      } else {
        cursor = lineAfter(content, lineEnd(content, cursor));
      }
      continue;
    }

    if (inlineTicks === null && atLineStart) {
      const opening = fenceAtLineStart(content, cursor);
      if (opening) {
        pushSegment(segments, false, content.slice(plainStart, cursor));
        codeStart = cursor;
        fence = opening;
        cursor = lineAfter(content, opening.end);
        continue;
      }
    }

    if (content[cursor] !== '`') {
      cursor += 1;
      continue;
    }

    let runEnd = cursor;
    while (runEnd < content.length && content[runEnd] === '`') runEnd += 1;
    const runLength = runEnd - cursor;
    if (inlineTicks === null) {
      pushSegment(segments, false, content.slice(plainStart, cursor));
      codeStart = cursor;
      inlineTicks = runLength;
    } else if (runLength === inlineTicks) {
      pushSegment(segments, true, content.slice(codeStart, runEnd));
      codeStart = null;
      inlineTicks = null;
      plainStart = runEnd;
    }
    cursor = runEnd;
  }

  if (fence) {
    pushSegment(segments, true, content.slice(codeStart));
  } else if (inlineTicks !== null) {
    // Un delimitador inline sin cierre es texto literal, no código Markdown.
    pushSegment(segments, false, content.slice(codeStart));
  } else {
    pushSegment(segments, false, content.slice(plainStart));
  }
  return segments;
}

export function neutralizePoolCitations(text) {
  const before = text == null ? '' : String(text);
  return tokenizeMarkdownCode(before)
    .map((segment) => {
      if (segment.code) return segment.content;
      return segment.content.replace(/\[\[([^\r\n]*?)\]\]/g, (citation, inner) => {
        const separator = inner.indexOf('|');
        const source = separator === -1 ? inner : inner.slice(0, separator);
        const label = separator === -1 ? null : inner.slice(separator + 1);
        if (!source.trim() || (label !== null && !label.trim())) return citation;
        return label === null ? source : label;
      });
    })
    .join('');
}

function optOutFile(dataDir) {
  return path.join(dataDir || resolveDataDir(), 'retro-share-optout.json');
}

function unsharedFile(dataDir) {
  return path.join(dataDir || resolveDataDir(), 'retro-unshared.json');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function parseFields(item) {
  const fields = item?.fields;
  if (fields && typeof fields === 'object') return fields;
  if (typeof fields === 'string') {
    try {
      const parsed = JSON.parse(fields);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function uniqueStrings(values) {
  const out = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function contextError(sharedCtx) {
  if (!sharedCtx) return 'Falta el contexto del pozo común.';
  if (!sharedCtx.token) return 'Falta el token del pozo común.';
  return null;
}

function timestampOf(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

// console:PLAN-3595: el vínculo temático y sus tags son enriquecimiento
// best-effort. Ninguna falla de la taxonomía puede romper una publicación.
async function connectPoolLesson(ref, { topic, project, category, existingTags } = {}, sharedCtx) {
  try {
    const listed = await listItems(POOL_TOPICS_COLLECTION, { ctx: sharedCtx });
    if (!listed?.ok) throw new Error(listed?.error || 'no se pudo listar la colección de temas');
    const topics = Array.isArray(listed.data) ? listed.data : [];
    const wanted = normalizePoolTopic(topic);
    const topicItem = topics.find((item) => parseFields(item).slug === wanted)
      || topics.find((item) => parseFields(item).slug === POOL_TOPIC_FALLBACK);
    if (!topicItem?.ref) return { connected: false };

    const parent = await setParent(ref, topicItem.ref, { ctx: sharedCtx });
    if (!parent?.ok) throw new Error(parent?.error || `no se pudo conectar ${ref} con ${topicItem.ref}`);
    const tagged = await updateItem(ref, {
      tags: poolLessonTags({ topic: wanted, project, category, existing: existingTags }),
    }, { ctx: sharedCtx });
    if (!tagged?.ok) throw new Error(tagged?.error || `no se pudieron actualizar los tags de ${ref}`);
    return { connected: true };
  } catch (err) {
    console.error('[retro-pool] no pude conectar la lección con su tema:', err?.message || err);
    return { connected: false };
  }
}

async function connectExistingPoolLessonIfOrphan(existing, lesson, project, sharedCtx) {
  try {
    const fetched = await getItem(existing.ref, { ctx: sharedCtx });
    if (!fetched?.ok) {
      console.error('[retro-pool] no pude comprobar el parent de la lección existente:', fetched?.error || fetched);
      return;
    }
    const item = fetched.data || existing;
    if (item?.parent_ref || item?.parent_link_id) return;
    const fields = parseFields(item);
    await connectPoolLesson(existing.ref, {
      topic: lesson?.topic,
      project: fields.project || project,
      category: fields.category || lesson?.category,
      existingTags: parseArray(item?.tags),
    }, sharedCtx);
  } catch (err) {
    console.error('[retro-pool] no pude comprobar el parent de la lección existente:', err?.message || err);
  }
}

function poolLessonFromItem(item) {
  const fields = parseFields(item);
  const recurrence = Number(fields.recurrence);
  return {
    ref: item?.ref || '',
    title: item?.title || 'Lección sin título',
    content: item?.content || '',
    category: fields.category || 'nota',
    // Compatibilidad: sólo los ítems antiguos del pozo pueden no traer etiqueta.
    project: fields.project || 'tolkien',
    destination: fields.destination || 'registro',
    confidence: fields.confidence || 'media',
    fingerprint: fields.fingerprint || '',
    recurrence: Number.isFinite(recurrence) && recurrence > 0 ? recurrence : 1,
    sourceRefs: parseArray(fields.sourceRefs),
    sharedBy: parseArray(fields.sharedBy),
    sharedFrom: String(fields.sharedFrom || '').trim(),
    createdAt: timestampOf(item?.created_at),
    updatedAt: timestampOf(item?.updated_at),
  };
}

export async function listPoolLessons(sharedCtx) {
  try {
    const ctxError = contextError(sharedCtx);
    // Fail-closed: sin credenciales compartidas ni siquiera se consulta Pad.
    if (ctxError) return { ok: false, lessons: [], error: ctxError };
    const listed = await listItems(POOL_COLLECTION, { ctx: sharedCtx });
    if (!listed?.ok) {
      return {
        ok: false,
        lessons: [],
        error: listed?.error || 'No se pudo leer el pozo común.',
      };
    }
    const lessons = (Array.isArray(listed.data) ? listed.data : []).map(poolLessonFromItem);
    // La recurrencia entre personas es la señal principal del pozo; ante empate,
    // lo observado más recientemente merece aparecer primero.
    lessons.sort((a, b) => (b.recurrence - a.recurrence) || (b.updatedAt - a.updatedAt));
    return { ok: true, lessons };
  } catch (err) {
    return {
      ok: false,
      lessons: [],
      error: String(err?.message || err).slice(0, 300),
    };
  }
}

export async function getPoolLesson(ref, sharedCtx) {
  try {
    const ctxError = contextError(sharedCtx);
    // Igual que el listado: sin contexto válido no se filtra una lectura al Pad.
    if (ctxError) return { ok: false, error: ctxError };
    const fetched = await getItem(ref, { ctx: sharedCtx });
    if (!fetched?.ok) {
      return {
        ok: false,
        error: fetched?.error || 'No se pudo leer la lección del pozo común.',
      };
    }
    return { ok: true, lesson: poolLessonFromItem(fetched.data) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
}

export function isShareOptedOut(dataDir = resolveDataDir()) {
  const data = readJson(optOutFile(dataDir), null);
  return data?.optOut === true;
}

export function setShareOptOut(value, dataDir = resolveDataDir()) {
  const optOut = value === true;
  writeJsonAtomic(optOutFile(dataDir), { optOut });
  return optOut;
}

export function isUnsharedFingerprint(fp, dataDir = resolveDataDir()) {
  const fingerprint = String(fp || '').trim();
  if (!fingerprint) return false;
  const data = readJson(unsharedFile(dataDir), null);
  return uniqueStrings(Array.isArray(data?.fingerprints) ? data.fingerprints : []).includes(fingerprint);
}

export function markUnsharedFingerprint(fp, dataDir = resolveDataDir()) {
  const fingerprint = String(fp || '').trim();
  if (!fingerprint) return false;
  const data = readJson(unsharedFile(dataDir), null);
  const fingerprints = uniqueStrings(Array.isArray(data?.fingerprints) ? data.fingerprints : []);
  if (!fingerprints.includes(fingerprint)) fingerprints.push(fingerprint);
  writeJsonAtomic(unsharedFile(dataDir), { fingerprints });
  return true;
}

export async function shareLessonToPool(lesson, sharedCtx, { sharedBy, sharedFrom } = {}) {
  try {
    const ctxError = contextError(sharedCtx);
    if (ctxError) return { ok: false, error: ctxError };
    const fingerprint = String(lesson?.fingerprint || '').trim();
    if (!fingerprint) return { ok: false, error: 'Falta el fingerprint de la lección.' };
    const project = POOL_PROJECTS.includes(lesson?.project) ? lesson.project : 'otros';

    const listed = await listItems(POOL_COLLECTION, { ctx: sharedCtx });
    if (!listed?.ok) return { ok: false, error: listed?.error || 'No se pudo leer el pozo común.' };
    const existing = (Array.isArray(listed.data) ? listed.data : [])
      .find((item) => parseFields(item).fingerprint === fingerprint);

    if (existing) {
      const fields = parseFields(existing);
      const donors = uniqueStrings(parseArray(fields.sharedBy));
      const donor = String(sharedBy || '').trim();
      // El detalle fresco trae parent_ref/parent_link_id, ausentes en algunos
      // listados resumidos. También corre para el donante ya registrado.
      await connectExistingPoolLessonIfOrphan(existing, lesson, project, sharedCtx);
      if (donors.includes(donor)) return { ok: true, merged: false, ref: existing.ref };
      const sourceRefs = uniqueStrings([
        ...parseArray(fields.sourceRefs),
        ...parseArray(lesson?.sourceRefs),
      ]);
      const recurrence = (parseInt(fields.recurrence, 10) || 1) + 1;
      const updated = await updateItem(existing.ref, {
        // Pad reemplaza `fields` entero: preservar cada campo es obligatorio.
        fields: {
          ...fields,
          recurrence: String(recurrence),
          sharedBy: uniqueStrings([...donors, donor]),
          sourceRefs,
        },
      }, { ctx: sharedCtx });
      if (!updated?.ok) return { ok: false, error: updated?.error || 'No se pudo agregar la recurrencia al pozo común.' };
      return { ok: true, merged: true, ref: existing.ref };
    }

    const created = await createItem(POOL_COLLECTION, {
      title: lesson?.title || 'Lección sin título',
      // La cita nació en otro registro; aquí resolvería a un ítem ajeno.
      content: neutralizePoolCitations(lesson?.body || ''),
      fields: {
        status: 'propuesta',
        category: lesson?.category || 'nota',
        project,
        destination: lesson?.destination || 'registro',
        recurrence: '1',
        confidence: lesson?.confidence || 'media',
        fingerprint,
        // Los sessionIds identifican chats privados del donante: el pozo sólo
        // recibe la lección y sus refs públicas, nunca ese rastro.
        sourceChats: [],
        sourceRefs: uniqueStrings(parseArray(lesson?.sourceRefs)),
        sharedBy: uniqueStrings([sharedBy]),
        sharedFrom: String(sharedFrom || '').trim(),
      },
    }, { ctx: sharedCtx });
    if (!created?.ok) return { ok: false, error: created?.error || 'No se pudo publicar la lección en el pozo común.' };
    const connected = await connectPoolLesson(created.data?.ref, {
      topic: lesson?.topic,
      project,
      category: lesson?.category || 'nota',
      existingTags: parseArray(created.data?.tags),
    }, sharedCtx);
    return { ok: true, created: true, ref: created.data?.ref, connected: connected.connected };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
}

export async function unshareLessonFromPool(fingerprint, sharedCtx, { sharedBy } = {}) {
  try {
    const ctxError = contextError(sharedCtx);
    if (ctxError) return { ok: false, error: ctxError };
    const fp = String(fingerprint || '').trim();
    if (!fp) return { ok: false, error: 'Falta el fingerprint de la lección.' };

    const listed = await listItems(POOL_COLLECTION, { ctx: sharedCtx });
    if (!listed?.ok) return { ok: false, error: listed?.error || 'No se pudo leer el pozo común.' };
    const existing = (Array.isArray(listed.data) ? listed.data : [])
      .find((item) => parseFields(item).fingerprint === fp);
    if (!existing) return { ok: true, removed: false };

    const fields = parseFields(existing);
    const donor = String(sharedBy || '').trim();
    const donors = uniqueStrings(parseArray(fields.sharedBy));
    if (!donors.includes(donor)) return { ok: true, removed: false, remaining: donors.length };
    const remainingDonors = donors.filter((value) => value !== donor);

    if (remainingDonors.length === 0) {
      const deleted = await deleteItem(existing.ref, { ctx: sharedCtx });
      if (!deleted?.ok) return { ok: false, error: deleted?.error || 'No se pudo retirar la lección del pozo común.' };
      return { ok: true, removed: true, remaining: 0 };
    }

    const recurrence = Math.max(1, (parseInt(fields.recurrence, 10) || 1) - 1);
    const updated = await updateItem(existing.ref, {
      // El PATCH no mergea custom fields: mandar el objeto completo evita
      // borrar categoría, huella o procedencia de los otros donantes.
      fields: { ...fields, sharedBy: remainingDonors, recurrence: String(recurrence) },
    }, { ctx: sharedCtx });
    if (!updated?.ok) return { ok: false, error: updated?.error || 'No se pudo actualizar el retiro en el pozo común.' };
    return { ok: true, removed: true, remaining: remainingDonors.length };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
}
