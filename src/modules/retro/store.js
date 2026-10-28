// modules/retro/store.js — store de MEJORA CONTINUA (ROAD-256) contra el Pad
// LOCAL (workspace 'console', colección 'mejora-continua', prefix MC). Molde
// calcado de learning/store.js: async, read-modify-write (el PATCH de `fields`
// REEMPLAZA entero, nunca mergea), id de dominio = ref de Pad (MC-<n>).
//
// Registro PROPIO de lecciones de proceso con aprobación humana. Recurrencia =
// prioridad: una lección que ya existe (por fingerprint) NO se duplica, se le
// incrementa el contador. Nada se auto-aplica (status arranca 'propuesta').
// La efectividad combina señal interna con evidencia externa del medidor
// (verify-shared.js / cwc-retro-verify-runner.js).
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import {
  listItems, getItem, createItem, updateItem, deleteItem as padDeleteItem,
  listLinks, setParent, deleteLink,
} from '../../core/pad-service-client.js';
import { readVerifyState, verifyForLesson } from './verify-shared.js';
import { retroDataDirFor, retroHostUser } from './owner-dirs.js';
import { PROMOTE_TARGETS, LEGACY_PROMOTE_TARGETS } from './promote-targets.js';
import {
  isShareOptedOut, isUnsharedFingerprint, shareLessonToPool,
} from './pool.js';

const COLLECTION = 'mejora-continua';
// Sol de cada lección según su categoría: los 7 buckets `MC · *` de la
// colección `arquitectura` (ver CONVE-1257 / regla dura 11 del CLAUDE.md).
// Sin este link la lección queda huérfana en el grafo de Pad (BUG-1878).
export const MC_SUN_BY_CATEGORY = Object.freeze({
  procedimiento: 'ARQUI-1310',
  metodologia: 'ARQUI-1311',
  convencion: 'ARQUI-1312',
  'feedback-cliente': 'ARQUI-1313',
  nota: 'ARQUI-1314',
  regla: 'ARQUI-1315',
  herramienta: 'ARQUI-1316',
});
export const MC_ID_RE = /^MC-\d+$/;
const ACTIVITY_MAX = 300;

// 'feedback-cliente' (2026-07-19): retroalimentación puntual de un cliente/
// revisor (típicamente Chris, por mail/Teams/llamada) sobre un ticket/PR — NO
// es una lección de proceso, es una preferencia/corrección concreta. Vive acá
// (no en un módulo aparte) para reusar TAL CUAL el destino 'contexto' (se
// inyecta solo en todo chat de bug futuro al adoptarla) y el dedup por
// recurrencia (misma queja repetida = prioridad).
const CATS = ['regla', 'convencion', 'metodologia', 'procedimiento', 'herramienta', 'nota', 'feedback-cliente'];
const DESTS = [...PROMOTE_TARGETS, ...LEGACY_PROMOTE_TARGETS];
const PROJS = ['console', 'tolkien', 'otros'];
const CONFS = ['alta', 'media', 'baja'];
const STATUSES = ['propuesta', 'aprobada', 'promovida', 'descartada'];

const clampStr = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const oneOf = (v, list, def) => (list.includes(v) ? v : def);

// CONVE-1257 del Pad / regla dura 11: todo ítem nace enlazado a su sol.
// Este guard existe porque los soles ARQUI-* de BUG-1878 solo viven en `console`.
function padSunApplies(ctx) {
  const ws = ctx && ctx.workspace;
  return !ws || ws === 'console';
}

function linkTargetRef(link) {
  return link?.target_ref || link?.target?.ref || link?.target_item?.ref || null;
}

// Máquina de estados compartida con cwc-pad-mc-parent.js: solo clasifica
// aristas salientes reales y nunca decide topología desde `parent_ref`.
export function planLessonSunLinks(ref, sun, links = []) {
  const outgoing = (Array.isArray(links) ? links : []).filter(
    (link) => !link?.source_ref || link.source_ref === ref,
  );
  const parents = outgoing.filter((link) => link?.link_type === 'parent');
  const parentToSun = parents.some((link) => linkTargetRef(link) === sun);
  const foreignParents = parentToSun
    ? []
    : parents.filter((link) => linkTargetRef(link) !== sun);
  const implementsToDelete = outgoing.filter(
    (link) => link?.link_type === 'implements' && linkTargetRef(link) === sun,
  );
  return {
    createParent: !parentToSun && foreignParents.length === 0,
    foreignParents,
    implementsToDelete,
    parentToSun,
  };
}

// BUG-1878 + console:PEND-2281: cada lección cuelga de su sol con `parent`.
// La consulta previa mantiene idempotentes los reintentos; si el parent correcto
// ya existe (o acaba de crearse), limpia el viejo `implements` redundante.
// Todo es best-effort para no arriesgar la destilación.
async function linkLessonToSun(ref, category, ctx) {
  try {
    const sun = MC_SUN_BY_CATEGORY[category];
    if (!sun || !padSunApplies(ctx)) return;
    const linksR = await listLinks(ref, { ctx });
    if (!linksR?.ok) {
      console.error('[retro] no pude leer los links de la lección en Pad:', linksR?.error || linksR);
      return;
    }
    const plan = planLessonSunLinks(ref, sun, linksR.data);
    if (plan.foreignParents.length > 0) {
      const targets = plan.foreignParents.map(linkTargetRef).filter(Boolean).join(', ') || 'desconocido';
      console.warn(`[retro] ${ref} conserva parent ajeno (${targets}); no se reemplaza por ${sun}`);
      return;
    }
    if (plan.createParent) {
      const parentR = await setParent(ref, sun, { ctx });
      if (!parentR?.ok) {
        console.error('[retro] no pude fijar el parent de la lección a su sol en Pad:', parentR?.error || parentR);
        return;
      }
    }
    for (const link of plan.implementsToDelete) {
      if (!link?.id) {
        console.error(`[retro] no pude borrar implements redundante de ${ref} a ${sun}: link sin id`);
        continue;
      }
      const deleteR = await deleteLink(link.id, { ctx });
      if (!deleteR?.ok) {
        console.error(`[retro] no pude borrar implements redundante de ${ref} a ${sun}:`, deleteR?.error || deleteR);
      }
    }
  } catch (err) {
    console.error('[retro] no pude enlazar la lección a su sol en Pad:', err?.message || err);
  }
}

// Publicación automática al pozo COMÚN (console:PLAN-2222, C3). Best-effort y
// aislada: el pozo es accesorio y JAMÁS puede romper la destilación — mismo
// criterio que linkLessonToSun.
async function shareTolkienLesson(lesson, ctx, sharedCtx) {
  try {
    if (lesson?.project !== 'tolkien' || !sharedCtx) return;
    const dataDir = retroDataDirFor(ownerFor(ctx));
    if (isShareOptedOut(dataDir) || isUnsharedFingerprint(lesson.fingerprint, dataDir)) return;
    // El workspace Pad conserva la identidad cuando el caller no pasa owner:
    // `tenant-*` resuelve su userDataDir y `console`/ctx nulo resuelve al host.
    const tenant = String(ctx?.workspace || '').match(/^tenant-(.+)$/);
    const sharedBy = tenant ? tenant[1] : 'host';
    const result = await shareLessonToPool(lesson, sharedCtx, {
      sharedBy,
      sharedFrom: lesson.id,
    });
    if (!result?.ok) console.error('[retro] no pude publicar la lección en el pozo común:', result?.error || result);
  } catch (err) {
    console.error('[retro] no pude publicar la lección en el pozo común:', err?.message || err);
  }
}

// Lock de archivo para serializar los read-modify-write entre runners de retro.
// El lock auxiliar de recuperación evita que dos esperadores borren por carrera
// el lock fresco que uno de ellos acaba de tomar al reemplazar uno vencido.
const UPSERT_LOCK_STALE_MS = 30_000;
const FILE_LOCK_DEADLINE_MS = 15_000;

function ownerFor(ctx = null, owner = null) {
  if (owner) return owner;
  const tenant = String(ctx?.workspace || '').match(/^tenant-(.+)$/);
  return tenant ? tenant[1] : retroHostUser();
}
export function retroActivityFileFor(owner) {
  return path.join(retroDataDirFor(owner), 'retro-activity.json');
}
function upsertLockFor(ctx = null) {
  return path.join(retroDataDirFor(ownerFor(ctx)), 'retro', 'upsert.lock');
}

async function withFileLock(lockFile, fn) {
  const reclaimLock = `${lockFile}.reclaim`;
  const deadline = Date.now() + FILE_LOCK_DEADLINE_MS;
  let held = false;
  try { fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 }); } catch { /* noop */ }
  while (!held && Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, 'wx'); // O_EXCL: falla con EEXIST si ya existe
      try { fs.writeSync(fd, String(Date.now())); }
      finally { fs.closeSync(fd); }
      held = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let ts = 0;
      try { ts = Number(fs.readFileSync(lockFile, 'utf8')) || 0; } catch { /* noop */ }
      if (Date.now() - ts > UPSERT_LOCK_STALE_MS) {
        let reclaimFd = null;
        try {
          reclaimFd = fs.openSync(reclaimLock, 'wx');
          fs.writeSync(reclaimFd, String(Date.now()));
        } catch (reclaimErr) {
          if (reclaimFd !== null) { try { fs.closeSync(reclaimFd); } catch { /* noop */ } }
          if (reclaimErr.code !== 'EEXIST') throw reclaimErr;
          await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 120)));
          continue;
        }
        try {
          let currentTs = 0;
          try { currentTs = Number(fs.readFileSync(lockFile, 'utf8')) || 0; } catch { /* noop */ }
          if (Date.now() - currentTs > UPSERT_LOCK_STALE_MS) {
            try { fs.unlinkSync(lockFile); } catch { /* noop */ }
          }
        } finally {
          try { fs.closeSync(reclaimFd); } catch { /* noop */ }
          try { fs.unlinkSync(reclaimLock); } catch { /* noop */ }
        }
        continue; // siempre volver a competir por O_EXCL; nunca entrar directo
      }
      await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 120)));
    }
  }
  if (!held) throw new Error('No se pudo adquirir el lock de Mejora Continua.');
  try { return await fn(); }
  finally { try { fs.unlinkSync(lockFile); } catch { /* noop */ } }
}

async function withUpsertLock(fn, ctx = null) {
  return withFileLock(upsertLockFor(ctx), fn);
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

// Normaliza refs de ticket/PR/feature ("tkt-519", "#245", "feat 3" → "TKT-519",
// "PR-245", "FEAT-3") para el campo sourceRefs de una lección 'feedback-cliente'
// — permite agrupar/navegar "todo lo que dijo Chris sobre el TKT-519".
const REF_RE = /^(TKT|PR|FEAT)-?(\d+)$/i;
function normRef(s) {
  let t = String(s || '').trim().toUpperCase().replace(/^#/, 'TKT-').replace(/\s+/g, '-');
  const m = t.match(REF_RE);
  if (m) return `${m[1]}-${m[2]}`;
  t = t.replace(/[^A-Z0-9-]/g, '').slice(0, 24);
  return t || null;
}
export function normRefs(arr) {
  const out = [];
  for (const s of (Array.isArray(arr) ? arr : [])) {
    const r = normRef(s);
    if (r && !out.includes(r)) out.push(r);
  }
  return out.slice(0, 20);
}

function bodyOf(observation, lesson) {
  const o = clampStr(observation, 2000).trim();
  const l = clampStr(lesson, 2000).trim();
  return `**Observación:** ${o || '—'}\n\n**Lección:** ${l || '—'}`;
}

// Fase 6 (loop que aprende): estado de efectividad DERIVADO de una lección
// promovida. NO se persiste.
//   · hits INTERNOS = recurrencias nuevas desde promotedAt (re-destilación con
//     el mismo fingerprint). Para 'feedback-cliente' este contador NO puede
//     subir nunca (BUG-1930) ⇒ el semáforo era estructuralmente ciego.
//   · hits EXTERNOS (M1, PLAN-1937) = rondas de review de Chris sobre los PRs
//     de sourceRefs POSTERIORES a la adopción, medidas por
//     bin/cwc-retro-verify-runner.js. Es la única señal que puede poner en rojo
//     una lección de Chris. `hits` los SUMA a propósito: el tablero muestra
//     "🔴 reincide ×hits" y una reincidencia observada afuera es tan real como
//     una re-destilación. El desglose queda en hitsInternal/external.
// OJO: al conectar esto las métricas EMPEORAN (lecciones hoy 🟢 pasan a 🔴).
// Es la prueba de que funciona, NO una regresión: no lo "arregles" volviéndolo
// a verde. Una lección SIN evidencia externa (ext=null) se comporta EXACTAMENTE
// como antes.
function computeEffectiveness(status, promAt, rec, recAt, ext) {
  if (status !== 'promovida' || !promAt) return null;
  const internal = Math.max(0, (rec || 1) - (recAt || 0));
  const external = ext ? Math.max(0, Number(ext.rounds) || 0) : 0;
  const hits = internal + external;
  const ageDays = Math.floor((Date.now() - promAt) / 86400000);
  let state = 'observando';
  if (hits > 0) state = 'reincide';
  else if (ageDays >= 7) state = 'efectiva';
  return {
    state,
    hits,
    ageDays,
    hitsInternal: internal,
    external: ext
      ? {
        rounds: external,
        lastAt: Number(ext.lastAt) || 0,
        prs: Array.isArray(ext.prs) ? ext.prs : [],
        unresolved: Array.isArray(ext.unresolved) ? ext.unresolved : [],
        checkedAt: Number(ext.checkedAt) || 0,
        sample: Array.isArray(ext.sample) ? ext.sample.slice(0, 3) : [],
      }
      : null,
  };
}

function lessonFromPadItem(item, verify = null) {
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
    sourceRefs: parseJsonField(f.sourceRefs, []),
    body: item.content || '',
    // Fase 2/6: destino REAL al que se promovió + snapshot para medir efectividad.
    promotedTo: (f.promotedTo && f.promotedTo !== 'ninguno')
      ? oneOf(f.promotedTo, DESTS, '')
      : '',
    promotedAt: promAtN,
    recurrenceAtPromotion: recAtN,
    effectiveness: computeEffectiveness(status, promAtN, recN, recAtN, verifyForLesson(verify, item.ref)),
    createdAt: tsMs(item.created_at),
    updatedAt: tsMs(item.updated_at),
  };
}

export async function listLessons(ctx = null) {
  const r = await listItems(COLLECTION, { ctx });   // sin all:true (ver gotcha del cliente)
  if (!r.ok) throw padError('listLessons', r);
  const verify = readVerifyState(ownerFor(ctx));
  const lessons = r.data.map((it) => lessonFromPadItem(it, verify));
  const order = { propuesta: 0, aprobada: 1, promovida: 2, descartada: 3 };
  lessons.sort((a, b) => (order[a.status] - order[b.status]) || (b.recurrence - a.recurrence) || (b.updatedAt - a.updatedAt));
  const counts = { propuesta: 0, aprobada: 0, promovida: 0, descartada: 0, total: lessons.length };
  for (const l of lessons) counts[l.status] = (counts[l.status] || 0) + 1;
  return { lessons, counts };
}

export async function getLesson(id, ctx = null) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  const r = await getItem(id, { ctx });
  if (!r.ok) throw notFoundOr500('getLesson', 'Lección', r);
  return lessonFromPadItem(r.data, readVerifyState(ownerFor(ctx)));
}

// Crea la lección o, si ya existe una con el mismo fingerprint, le suma
// recurrencia + registra el chat de origen (NO duplica, NO resucita el estado:
// una lección ya descartada sigue descartada pero su contador crece = señal de
// "esto sigue pasando"). Lo llama el runner tras destilar.
export async function upsertLesson(input = {}, ctx = null, sharedCtx = null) {
  const title = clampStr(input.title, 200).trim() || 'Lección sin título';
  const category = oneOf(input.category, CATS, 'nota');
  const fingerprint = input.fingerprint || computeFingerprint(category, title);
  const src = input.sourceChat && typeof input.sourceChat === 'object'
    ? { sessionId: clampStr(input.sourceChat.sessionId, 80) || null, title: clampStr(input.sourceChat.title, 120), at: Number(input.sourceChat.at) || Date.now() }
    : null;
  const refs = normRefs(input.sourceRefs);

  // El read-find-create/update va bajo lock para que dos runners concurrentes no
  // creen duplicados del mismo fingerprint (ver withUpsertLock).
  return withUpsertLock(async () => {
    let existing = null;
    const lr = await listItems(COLLECTION, { ctx });
    if (!lr.ok) throw padError('listar para upsertLesson', lr);
    existing = lr.data.find((it) => parseFields(it).fingerprint === fingerprint) || null;

    if (existing) {
      const f = parseFields(existing);
      const rec = (parseInt(f.recurrence, 10) || 1) + 1;
      const chats = parseJsonField(f.sourceChats, []);
      if (src && !chats.some((c) => c.sessionId && c.sessionId === src.sessionId)) chats.unshift(src);
      const mergedRefs = normRefs([...parseJsonField(f.sourceRefs, []), ...refs]);
      const updatedFields = {
        ...f, recurrence: String(rec), sourceChats: chats.slice(0, 50), sourceRefs: mergedRefs,
      };
      const r = await updateItem(existing.ref, { fields: updatedFields }, { ctx });
      if (!r.ok) throw padError('upsertLesson', r);
      await appendActivity({ kind: 'recurrente', refId: existing.ref, title, detail: `x${rec}` }, ctx);
      // Auto-sana lecciones viejas que hubieran quedado huérfanas al reincidir.
      await linkLessonToSun(existing.ref, f.category || category, ctx);
      const fresh = await getItem(existing.ref, { ctx });
      const lesson = lessonFromPadItem(
        fresh.ok ? fresh.data : { ...existing, fields: updatedFields },
        readVerifyState(ownerFor(ctx)),
      );
      await shareTolkienLesson(lesson, ctx, sharedCtx);
      return { created: false, lesson };
    }

    const content = bodyOf(input.observation, input.lesson);
    const fields = {
      status: 'propuesta',
      category,
      project: oneOf(input.project, PROJS, 'otros'),
      destination: oneOf(input.destination, DESTS, 'registro'),
      recurrence: '1',
      confidence: oneOf(input.confidence, CONFS, 'media'),
      fingerprint,
      sourceChats: src ? [src] : [],
      sourceRefs: refs,
    };
    const r = await createItem(COLLECTION, {
      title,
      content,
      fields,
    }, { ctx });
    if (!r.ok) throw padError('upsertLesson', r);
    await appendActivity({ kind: 'nueva', refId: r.data.ref, title }, ctx);
    await linkLessonToSun(r.data.ref, category, ctx);
    const fresh = await getItem(r.data.ref, { ctx });
    const lesson = lessonFromPadItem(
      fresh.ok ? fresh.data : {
        ...r.data, ref: r.data.ref, title, content, fields,
      },
      readVerifyState(ownerFor(ctx)),
    );
    await shareTolkienLesson(lesson, ctx, sharedCtx);
    return { created: true, lesson };
  }, ctx);
}

export async function setStatus(id, status, ctx = null) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  const st = oneOf(status, STATUSES, null);
  if (!st) throw Object.assign(new Error('Estado inválido.'), { badRequest: true });
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('setStatus', 'Lección', cur);
  const f = parseFields(cur.data);
  const r = await updateItem(id, { fields: { ...f, status: st } }, { ctx });   // read-modify-write: fields completo
  if (!r.ok) throw padError('setStatus', r);
  await appendActivity({ kind: 'estado', refId: id, title: cur.data.title, detail: st }, ctx);
  const fresh = await getItem(id, { ctx });
  return lessonFromPadItem(fresh.ok ? fresh.data : cur.data, readVerifyState(ownerFor(ctx)));
}

export async function revertPromotion(id, prev, ctx = null) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  const status = oneOf(prev?.status, STATUSES, null);
  if (!status) throw Object.assign(new Error('Estado previo inválido.'), { badRequest: true });
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('revertPromotion', 'Lección', cur);
  const f = parseFields(cur.data);
  const fields = {
    ...f,
    status,
    promotedTo: prev?.promotedTo || 'ninguno',
    promotedAt: prev?.promotedAt ? String(prev.promotedAt) : '',
    recurrenceAtPromotion: prev?.recurrenceAtPromotion ? String(prev.recurrenceAtPromotion) : '',
  };
  const r = await updateItem(id, { fields }, { ctx });
  if (!r.ok) throw padError('revertPromotion', r);
  await appendActivity({ kind: 'estado', refId: id, title: cur.data.title, detail: `${status} (revertida)` }, ctx);
  const fresh = await getItem(id, { ctx });
  return lessonFromPadItem(fresh.ok ? fresh.data : { ...cur.data, fields }, readVerifyState(ownerFor(ctx)));
}

// Cambia SOLO el destino sugerido. La promoción real es otra decisión humana.
export async function setDestination(id, destination, ctx = null) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  if (!PROMOTE_TARGETS.includes(destination)) throw Object.assign(new Error('Destino inválido.'), { badRequest: true });
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('setDestination', 'Lección', cur);
  const f = parseFields(cur.data);
  const r = await updateItem(id, { fields: { ...f, destination } }, { ctx });
  if (!r.ok) throw padError('setDestination', r);
  await appendActivity({ kind: 'redestinada', refId: id, title: cur.data.title, detail: destination }, ctx);
  const fresh = await getItem(id, { ctx });
  return lessonFromPadItem(fresh.ok ? fresh.data : { ...cur.data, fields: { ...f, destination } }, readVerifyState(ownerFor(ctx)));
}

// Marca una lección como PROMOVIDA a un destino real + snapshotea la
// recurrencia y el momento de la promoción
// (Fase 6: para medir después si la lección "funcionó" — dejó de recurrir). NO
// escribe el destino en sí (eso lo hace promote-shared.js); solo el estado.
// PLAN-1936: `contrato` e `invariante` son los destinos VERIFICABLES — la lección
// deja de ser texto y pasa a chequearse sola. El schema de la colección en Pad ya
// admite ambos en `destination` y en `promotedTo` (un valor no listado ahí lo
// rechaza el server de Pad con 500, aunque el oneOf() de acá lo validara).
export async function markPromoted(id, target, ctx = null) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  if (!PROMOTE_TARGETS.includes(target)) throw Object.assign(new Error('Destino de promoción inválido.'), { badRequest: true });
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('markPromoted', 'Lección', cur);
  const f = parseFields(cur.data);
  const rec = parseInt(f.recurrence, 10) || 1;
  const r = await updateItem(id, {
    fields: {
      ...f, status: 'promovida', promotedTo: target,
      promotedAt: String(Date.now()), recurrenceAtPromotion: String(rec),
    },
  }, { ctx });
  if (!r.ok) throw padError('markPromoted', r);
  await appendActivity({ kind: 'promovida', refId: id, title: cur.data.title, detail: target }, ctx);
  const fresh = await getItem(id, { ctx });
  return lessonFromPadItem(fresh.ok ? fresh.data : cur.data, readVerifyState(ownerFor(ctx)));
}

// Fusiona lecciones (Fase 5, curaduría): conserva keepId sumándole la
// recurrencia + los chats de origen de las mergeIds, y borra las mergeIds.
// La recurrencia acumulada preserva la señal de prioridad al deduplicar.
export async function mergeLessons(keepId, mergeIds = [], ctx = null) {
  if (!MC_ID_RE.test(keepId)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  const keepR = await getItem(keepId, { ctx });
  if (!keepR.ok) throw notFoundOr500('mergeLessons', 'Lección', keepR);
  const kf = parseFields(keepR.data);
  const chats = parseJsonField(kf.sourceChats, []);
  let refs = parseJsonField(kf.sourceRefs, []);
  let addRec = 0;
  let mergedCount = 0;
  for (const mid of mergeIds) {
    if (!MC_ID_RE.test(mid) || mid === keepId) continue;
    const mR = await getItem(mid, { ctx });
    if (!mR.ok) continue;
    const mf = parseFields(mR.data);
    // Borrar PRIMERO y absorber SOLO si el item realmente desapareció: si el
    // delete falla, el item sigue existiendo con su recurrencia, así que sumarla
    // acá la duplicaría (contada en keepId Y en el item que quedó vivo).
    const d = await padDeleteItem(mid, { ctx });
    if (!d.ok) continue;
    mergedCount += 1;
    addRec += (parseInt(mf.recurrence, 10) || 1);
    for (const c of parseJsonField(mf.sourceChats, [])) {
      if (!chats.some((x) => x.sessionId && x.sessionId === c.sessionId)) chats.push(c);
    }
    refs = normRefs([...refs, ...parseJsonField(mf.sourceRefs, [])]);
  }
  const newRec = (parseInt(kf.recurrence, 10) || 1) + addRec;
  const r = await updateItem(keepId, { fields: { ...kf, recurrence: String(newRec), sourceChats: chats.slice(0, 50), sourceRefs: refs } }, { ctx });
  if (!r.ok) throw padError('mergeLessons', r);
  await appendActivity({ kind: 'fusion', refId: keepId, title: keepR.data.title, detail: `+${mergedCount}` }, ctx);
  const fresh = await getItem(keepId, { ctx });
  return lessonFromPadItem(fresh.ok ? fresh.data : keepR.data, readVerifyState(ownerFor(ctx)));
}

export async function deleteLesson(id, ctx = null) {
  if (!MC_ID_RE.test(id)) throw Object.assign(new Error('Id inválido.'), { badRequest: true });
  const r = await padDeleteItem(id, { ctx });
  if (!r.ok) throw notFoundOr500('deleteLesson', 'Lección', r);
  await appendActivity({ kind: 'borrada', refId: id, title: id }, ctx);
  return { ok: true };
}

// ===== Actividad local (append-only, patrón learning/tasks) =====
function loadActivity(owner) {
  try { const a = JSON.parse(fs.readFileSync(retroActivityFileFor(owner), 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
export function listActivity(limit = 40, owner = retroHostUser()) {
  return loadActivity(owner).slice(0, Math.max(1, Math.min(100, Number(limit) || 40)));
}
async function appendActivity(ev, ctx = null) {
  try {
    const owner = ownerFor(ctx);
    const activityFile = retroActivityFileFor(owner);
    await withFileLock(`${activityFile}.lock`, async () => {
      const list = loadActivity(owner);
      list.unshift({ id: `E${Date.now()}-${Math.floor(Math.random() * 1000)}`, ts: Date.now(), ...ev });
      fs.mkdirSync(retroDataDirFor(owner), { recursive: true, mode: 0o700 });
      writeJsonAtomic(activityFile, list.slice(0, ACTIVITY_MAX));
    });
  } catch { /* best-effort */ }
}
