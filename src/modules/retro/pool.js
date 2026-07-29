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
  listItems, getItem, createItem, updateItem, deleteItem,
} from '../../core/pad-service-client.js';

export const POOL_COLLECTION = 'mejora-continua';

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

function poolLessonFromItem(item) {
  const fields = parseFields(item);
  const recurrence = Number(fields.recurrence);
  return {
    ref: item?.ref || '',
    title: item?.title || 'Lección sin título',
    content: item?.content || '',
    category: fields.category || 'nota',
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

    const listed = await listItems(POOL_COLLECTION, { ctx: sharedCtx });
    if (!listed?.ok) return { ok: false, error: listed?.error || 'No se pudo leer el pozo común.' };
    const existing = (Array.isArray(listed.data) ? listed.data : [])
      .find((item) => parseFields(item).fingerprint === fingerprint);

    if (existing) {
      const fields = parseFields(existing);
      const donors = uniqueStrings(parseArray(fields.sharedBy));
      const donor = String(sharedBy || '').trim();
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
      content: lesson?.body || '',
      fields: {
        status: 'propuesta',
        category: lesson?.category || 'nota',
        project: 'tolkien',
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
    return { ok: true, created: true, ref: created.data?.ref };
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
