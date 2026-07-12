// modules/retro/store.js — store de MEJORA CONTINUA (ROAD-256) contra el Pad
// LOCAL (workspace 'console', colección 'mejora-continua', prefix MC). Molde
// calcado de learning/store.js: async, read-modify-write (el PATCH de `fields`
// REEMPLAZA entero, nunca mergea), id de dominio = ref de Pad (MC-<n>).
//
// Registro PROPIO de lecciones de proceso con aprobación humana. Recurrencia =
// prioridad: una lección que ya existe (por fingerprint) NO se duplica, se le
// incrementa el contador. Nada se auto-aplica (status arranca 'propuesta').
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import {
  listItems, getItem, createItem, updateItem, deleteItem as padDeleteItem,
} from '../../core/pad-service-client.js';

const COLLECTION = 'mejora-continua';
export const MC_ID_RE = /^MC-\d+$/;
const ACTIVITY_FILE = path.join(os.homedir(), '.cwc-data', 'retro-activity.json');
const ACTIVITY_MAX = 300;

const CATS = ['regla', 'convencion', 'metodologia', 'procedimiento', 'herramienta', 'nota'];
const DESTS = ['memoria', 'claude-md', 'contexto', 'playbook', 'registro'];
const PROJS = ['console', 'tolkien', 'otros'];
const CONFS = ['alta', 'media', 'baja'];
const STATUSES = ['propuesta', 'aprobada', 'promovida', 'descartada'];

const clampStr = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const oneOf = (v, list, def) => (list.includes(v) ? v : def);

// Lock de archivo para serializar el read-find-create/update de upsertLesson
// entre runners de retro CONCURRENTES (dos sesiones cerrando casi a la vez
// podrían ambas NO encontrar el fingerprint y crear DUPLICADOS). O_EXCL con toma
// del lock viejo (runner muerto) y BEST-EFFORT: si no lo consigue en el deadline
// sigue sin lock — nunca bloquea la destilación.
const UPSERT_LOCK = path.join(os.homedir(), '.cwc-data', 'retro', 'upsert.lock');
const UPSERT_LOCK_STALE_MS = 30_000;
async function withUpsertLock(fn) {
  const deadline = Date.now() + 15_000;
  let held = false;
  try { fs.mkdirSync(path.dirname(UPSERT_LOCK), { recursive: true, mode: 0o700 }); } catch { /* noop */ }
  while (!held && Date.now() < deadline) {
    try {
      const fd = fs.openSync(UPSERT_LOCK, 'wx'); // O_EXCL: falla con EEXIST si ya existe
      fs.writeSync(fd, String(Date.now()));
      fs.closeSync(fd);
      held = true;
    } catch (e) {
      if (e.code !== 'EEXIST') break; // error inesperado: seguí sin lock (best-effort)
      let ts = 0;
      try { ts = Number(fs.readFileSync(UPSERT_LOCK, 'utf8')) || 0; } catch { /* noop */ }
      if (Date.now() - ts > UPSERT_LOCK_STALE_MS) { try { fs.unlinkSync(UPSERT_LOCK); } catch { /* noop */ } continue; }
      await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 120)));
    }
  }
  try { return await fn(); }
  finally { if (held) { try { fs.unlinkSync(UPSERT_LOCK); } catch { /* noop */ } } }
}

function parseFields(item) {
  const f = item?.fields;
  if (f && typeof f === 'object') return f;
  if (typeof f === 'string') { try { return JSON.parse(f); } catch { return {}; } }
  return {};
}
function parseJsonField(v, fb) {
  if (v == null) return fb;
  if (typeof v === 'object') return v;
  try { const p = JSON.parse(v); return p == null ? fb : p; } catch { return fb; }
}
const tsMs = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
function padError(action, r) { return Object.assign(new Error(`Pad local (${action}): ${r?.error || 'error'}`), { padError: true }); }
function notFoundOr500(action, label, r) {
  if (r?.status === 404) return Object.assign(new Error(`${label} inexistente.`), { notFound: true });
  return padError(action, r);
}

// Huella determinística para el dedup/recurrencia: categoría + título normalizado
// (minúsculas, sin acentos, solo alfanumérico). Dos lecciones con el mismo
// espíritu tienden a compartir título → colapsan en una sola con contador.
export function computeFingerprint(category, title) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return crypto.createHash('sha1').update(`${oneOf(category, CATS, 'nota')}|${norm(title)}`).digest('hex').slice(0, 16);
}

function bodyOf(observation, lesson) {
  const o = clampStr(observation, 2000).trim();
  const l = clampStr(lesson, 2000).trim();
  return `**Observación:** ${o || '—'}\n\n**Lección:** ${l || '—'}`;
}

// Fase 6 (loop que aprende): estado de efectividad DERIVADO de una lección
// promovida. hits = recurrencias NUEVAS desde que se promovió (si sigue
// pasando, la promoción no alcanzó → reincide → escalar). NO se persiste.
function computeEffectiveness(status, promAt, rec, recAt) {
  if (status !== 'promovida' || !promAt) return null;
  const hits = Math.max(0, (rec || 1) - (recAt || 0));
  const ageDays = Math.floor((Date.now() - promAt) / 86400000);
  let state = 'observando';
  if (hits > 0) state = 'reincide';
  else if (ageDays >= 7) state = 'efectiva';
  return { state, hits, ageDays };
}

function lessonFromPadItem(item) {
  const f = parseFields(item);
  const rec = parseInt(f.recurrence, 10);
  const recAtProm = parseInt(f.recurrenceAtPromotion, 10);
  const promAt = parseInt(f.promotedAt, 10);
  const recN = Number.isFinite(rec) && rec > 0 ? rec : 1;
  const recAtN = Number.isFinite(recAtProm) && recAtProm > 0 ? recAtProm : 0;
  const promAtN = Number.isFinite(promAt) && promAt > 0 ? promAt : 0;
  const status = oneOf(f.status, STATUSES, 'propuesta');
  return {
    id: item.ref,
    title: item.title || 'Lección sin título',
    category: oneOf(f.category, CATS, 'nota'),
    project: oneOf(f.project, PROJS, 'otros'),
    destination: oneOf(f.destination, DESTS, 'registro'),
    status,
    recurrence: recN,
    confidence: oneOf(f.confidence, CONFS, 'media'),
    fingerprint: f.fingerprint || '',
    sourceChats: parseJsonField(f.sourceChats, []),
    body: item.content || '',
    // Fase 2/6: destino REAL al que se promovió + snapshot para medir efectividad.
    promotedTo: (f.promotedTo && f.promotedTo !== 'ninguno') ? f.promotedTo : '',
    promotedAt: promAtN,
    recurrenceAtPromotion: recAtN,
    effectiveness: computeEffectiveness(status, promAtN, recN, recAtN),
    createdAt: tsMs(item.created_at),
    updatedAt: tsMs(item.updated_at),
  };
}

export async function listLessons() {
  const r = await listItems(COLLECTION);   // sin all:true (ver gotcha del cliente)
  if (!r.ok) throw padError('listLessons', r);
  const lessons = r.data.map(lessonFromPadItem);
  const order = { propuesta: 0, aprobada: 1, promovida: 2, descartada: 3 };
  lessons.sort((a, b) => (order[a.status] - order[b.status]) || (b.recurrence - a.recurrence) || (b.updatedAt - a.updatedAt));
  const counts = { propuesta: 0, aprobada: 0, promovida: 0, descartada: 0, total: lessons.length };
  for (const l of lessons) counts[l.status] = (counts[l.status] || 0) + 1;
  return { lessons, counts };
}

export async function getLesson(id) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  const r = await getItem(id);
  if (!r.ok) throw notFoundOr500('getLesson', 'Lección', r);
  return lessonFromPadItem(r.data);
}

// Crea la lección o, si ya existe una con el mismo fingerprint, le suma
// recurrencia + registra el chat de origen (NO duplica, NO resucita el estado:
// una lección ya descartada sigue descartada pero su contador crece = señal de
// "esto sigue pasando"). Lo llama el runner tras destilar.
export async function upsertLesson(input = {}) {
  const title = clampStr(input.title, 200).trim() || 'Lección sin título';
  const category = oneOf(input.category, CATS, 'nota');
  const fingerprint = input.fingerprint || computeFingerprint(category, title);
  const src = input.sourceChat && typeof input.sourceChat === 'object'
    ? { sessionId: clampStr(input.sourceChat.sessionId, 80) || null, title: clampStr(input.sourceChat.title, 120), at: Number(input.sourceChat.at) || Date.now() }
    : null;

  // El read-find-create/update va bajo lock para que dos runners concurrentes no
  // creen duplicados del mismo fingerprint (ver withUpsertLock).
  return withUpsertLock(async () => {
    let existing = null;
    const lr = await listItems(COLLECTION);
    if (lr.ok) existing = lr.data.find((it) => parseFields(it).fingerprint === fingerprint) || null;

    if (existing) {
      const f = parseFields(existing);
      const rec = (parseInt(f.recurrence, 10) || 1) + 1;
      const chats = parseJsonField(f.sourceChats, []);
      if (src && !chats.some((c) => c.sessionId && c.sessionId === src.sessionId)) chats.unshift(src);
      const r = await updateItem(existing.ref, { fields: { ...f, recurrence: String(rec), sourceChats: chats.slice(0, 50) } });
      if (!r.ok) throw padError('upsertLesson', r);
      appendActivity({ kind: 'recurrente', refId: existing.ref, title, detail: `x${rec}` });
      const fresh = await getItem(existing.ref);
      return { created: false, lesson: lessonFromPadItem(fresh.ok ? fresh.data : existing) };
    }

    const r = await createItem(COLLECTION, {
      title,
      content: bodyOf(input.observation, input.lesson),
      fields: {
        status: 'propuesta',
        category,
        project: oneOf(input.project, PROJS, 'otros'),
        destination: oneOf(input.destination, DESTS, 'registro'),
        recurrence: '1',
        confidence: oneOf(input.confidence, CONFS, 'media'),
        fingerprint,
        sourceChats: src ? [src] : [],
      },
    });
    if (!r.ok) throw padError('upsertLesson', r);
    appendActivity({ kind: 'nueva', refId: r.data.ref, title });
    const fresh = await getItem(r.data.ref);
    return { created: true, lesson: lessonFromPadItem(fresh.ok ? fresh.data : r.data) };
  });
}

export async function setStatus(id, status) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  const st = oneOf(status, STATUSES, null);
  if (!st) throw Object.assign(new Error('Estado inválido.'), { badRequest: true });
  const cur = await getItem(id);
  if (!cur.ok) throw notFoundOr500('setStatus', 'Lección', cur);
  const f = parseFields(cur.data);
  const r = await updateItem(id, { fields: { ...f, status: st } });   // read-modify-write: fields completo
  if (!r.ok) throw padError('setStatus', r);
  appendActivity({ kind: 'estado', refId: id, title: cur.data.title, detail: st });
  const fresh = await getItem(id);
  return lessonFromPadItem(fresh.ok ? fresh.data : cur.data);
}

// Marca una lección como PROMOVIDA a un destino real (memoria|claude-md|
// contexto|playbook) + snapshotea la recurrencia y el momento de la promoción
// (Fase 6: para medir después si la lección "funcionó" — dejó de recurrir). NO
// escribe el destino en sí (eso lo hace promote-shared.js); solo el estado.
const PROMOTE_TO = ['memoria', 'claude-md', 'contexto', 'playbook'];
export async function markPromoted(id, target) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  if (!PROMOTE_TO.includes(target)) throw Object.assign(new Error('Destino de promoción inválido.'), { badRequest: true });
  const cur = await getItem(id);
  if (!cur.ok) throw notFoundOr500('markPromoted', 'Lección', cur);
  const f = parseFields(cur.data);
  const rec = parseInt(f.recurrence, 10) || 1;
  const r = await updateItem(id, {
    fields: {
      ...f, status: 'promovida', promotedTo: target,
      promotedAt: String(Date.now()), recurrenceAtPromotion: String(rec),
    },
  });
  if (!r.ok) throw padError('markPromoted', r);
  appendActivity({ kind: 'promovida', refId: id, title: cur.data.title, detail: target });
  const fresh = await getItem(id);
  return lessonFromPadItem(fresh.ok ? fresh.data : cur.data);
}

// Fusiona lecciones (Fase 5, curaduría): conserva keepId sumándole la
// recurrencia + los chats de origen de las mergeIds, y borra las mergeIds.
// La recurrencia acumulada preserva la señal de prioridad al deduplicar.
export async function mergeLessons(keepId, mergeIds = []) {
  if (!MC_ID_RE.test(keepId)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  const keepR = await getItem(keepId);
  if (!keepR.ok) throw notFoundOr500('mergeLessons', 'Lección', keepR);
  const kf = parseFields(keepR.data);
  const chats = parseJsonField(kf.sourceChats, []);
  let addRec = 0;
  let mergedCount = 0;
  for (const mid of mergeIds) {
    if (!MC_ID_RE.test(mid) || mid === keepId) continue;
    const mR = await getItem(mid);
    if (!mR.ok) continue;
    const mf = parseFields(mR.data);
    // Borrar PRIMERO y absorber SOLO si el item realmente desapareció: si el
    // delete falla, el item sigue existiendo con su recurrencia, así que sumarla
    // acá la duplicaría (contada en keepId Y en el item que quedó vivo).
    const d = await padDeleteItem(mid);
    if (!d.ok) continue;
    mergedCount += 1;
    addRec += (parseInt(mf.recurrence, 10) || 1);
    for (const c of parseJsonField(mf.sourceChats, [])) {
      if (!chats.some((x) => x.sessionId && x.sessionId === c.sessionId)) chats.push(c);
    }
  }
  const newRec = (parseInt(kf.recurrence, 10) || 1) + addRec;
  const r = await updateItem(keepId, { fields: { ...kf, recurrence: String(newRec), sourceChats: chats.slice(0, 50) } });
  if (!r.ok) throw padError('mergeLessons', r);
  appendActivity({ kind: 'fusion', refId: keepId, title: keepR.data.title, detail: `+${mergedCount}` });
  const fresh = await getItem(keepId);
  return lessonFromPadItem(fresh.ok ? fresh.data : keepR.data);
}

export async function deleteLesson(id) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  const r = await padDeleteItem(id);
  if (!r.ok) throw notFoundOr500('deleteLesson', 'Lección', r);
  appendActivity({ kind: 'borrada', refId: id, title: id });
  return { ok: true };
}

// ===== Actividad local (append-only, patrón learning/tasks) =====
function loadActivity() {
  try { const a = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
export function listActivity(limit = 40) {
  return loadActivity().slice(0, Math.max(1, Math.min(100, Number(limit) || 40)));
}
function appendActivity(ev) {
  try {
    const list = loadActivity();
    list.unshift({ id: `E${Date.now()}-${Math.floor(Math.random() * 1000)}`, ts: Date.now(), ...ev });
    writeJsonAtomic(ACTIVITY_FILE, list.slice(0, ACTIVITY_MAX));
  } catch { /* best-effort */ }
}
