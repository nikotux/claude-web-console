#!/usr/bin/env node
// bin/cwc-retro-verify-runner.js — MEDIDOR REAL de efectividad de Mejora
// Continua (M1 de DOC-1926 / PLAN-1937). 0 TOKENS: NO usa el SDK; lee los PRs
// con fetchPrRich (comms/pr-read-shared.js, lector ÚNICO ya cacheado 60 s).
//
// Regla dura 2: lock con heartbeat pid-aware, estado en
// ~/.cwc-data/retro-verify.json y progreso INCREMENTAL por PR y REANUDABLE (un
// PR chequeado hace menos de PR_ENTRY_TTL_MS no se vuelve a consultar).
// Sobrevive a un reinicio de la interfaz web. 0 escrituras a GitHub y 0 al Pad:
// el resultado no se persiste en Pad porque es derivado.
import { fetchPrRich } from '../src/modules/comms/pr-read-shared.js';
import { readContacts, readSelf } from '../src/modules/comms/shared.js';
import { listLessons } from '../src/modules/retro/store.js';
import { padContextForUser } from '../src/core/pad-context.js';
import {
  aggregateLesson,
  chrisRoundsFromPr,
  clearVerifyLock,
  emptyVerifyState,
  PR_ENTRY_TTL_MS,
  prRefsFrom,
  readVerifyLock,
  readVerifyState,
  VERIFY_HEARTBEAT_MS,
  VERIFY_TIMEOUT_MS,
  writeVerifyLock,
  writeVerifyState,
} from '../src/modules/retro/verify-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, '[retro-verify]', ...a);
const FEEDBACK_CONTACT_ID = 'chris';

const _resv = readVerifyLock();
if (_resv && _resv.pid !== process.pid) { log('ya hay otra verificación (lock fresco ajeno): salgo.'); process.exit(0); }
const beat = () => writeVerifyLock({ pid: process.pid });
const heartbeat = setInterval(beat, VERIFY_HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearVerifyLock(); process.exit(code); }

async function run() {
  const full = process.argv.includes('--full');
  const contact = readContacts().find((c) => c.id === FEEDBACK_CONTACT_ID);
  if (!contact?.github) {
    throw new Error('No hay un contacto "chris" con login de GitHub configurado en Comunicaciones — sin él no puedo saber qué reviews son suyas.');
  }
  const login = String(contact.github);
  const selfLogin = String(readSelf()?.github || '');
  const ctx = padContextForUser(null);
  const { lessons } = await listLessons(ctx);
  const selected = lessons.filter((l) => l.category === 'feedback-cliente'
    && l.status === 'promovida'
    && l.promotedAt > 0
    && Array.isArray(l.sourceRefs)
    && l.sourceRefs.length);
  const startedAt = Date.now();

  if (!selected.length) {
    writeVerifyState({
      ...emptyVerifyState(),
      status: 'done',
      startedAt,
      scannedAt: Date.now(),
      summary: {
        lessons: 0, withRounds: 0, prs: 0, resumed: 0,
        unresolvedRefs: 0, errors: 0, reviewer: login,
      },
    });
    log(`OK: 0 lección(es) · 0 con rondas nuevas de ${login} · 0 PR(s) leídos (0 reusados) · 0 ref(s) sin resolver.`);
    return;
  }

  const targets = selected.map((l) => {
    const refs = prRefsFrom(l.sourceRefs);
    return {
      id: l.id,
      promotedAt: l.promotedAt,
      direct: refs.direct,
      candidates: refs.candidates,
      ignored: refs.ignored,
    };
  });
  const numbers = [...new Set(targets.flatMap((t) => [...t.direct, ...t.candidates]))].sort((a, b) => a - b);
  const wanted = new Set(numbers);
  const prev = full ? emptyVerifyState() : readVerifyState();
  const prs = {};
  for (const [n, entry] of Object.entries(prev.prs || {})) {
    if (wanted.has(Number(n)) && entry?.checkedAt && Date.now() - entry.checkedAt < PR_ENTRY_TTL_MS) prs[n] = entry;
  }
  const resumed = Object.keys(prs).length;
  log(`${resumed} PR(s) reanudadas desde el estado persistido.`);

  const shortError = (entry) => String(entry?.error || 'error desconocido').slice(0, 80);
  function resolvedTarget(target, prsState) {
    const accepted = [];
    const unresolved = target.ignored.map((ref) => `${ref} (no es un PR)`);

    for (const n of target.direct) {
      const entry = prsState[n];
      if (!entry) unresolved.push(`PR-${n} (todavía no chequeado)`);
      else if (entry.error) unresolved.push(`PR-${n} (no se pudo leer: ${shortError(entry)})`);
      else if (!accepted.includes(n)) accepted.push(n);
    }

    for (const n of target.candidates) {
      if (target.direct.includes(n)) continue;
      const entry = prsState[n];
      if (!entry) {
        unresolved.push(`TKT-${n} (todavía no chequeado)`);
        continue;
      }
      if (entry.error) {
        unresolved.push(`TKT-${n} (no existe como PR: ${shortError(entry)})`);
        continue;
      }
      const author = String(entry.author || '');
      const ours = selfLogin ? author === selfLogin : author !== login;
      if (!ours) {
        unresolved.push(`TKT-${n} (PR de ${author || 'autor desconocido'}, no nuestro)`);
        continue;
      }
      if (!accepted.includes(n)) accepted.push(n);
    }

    return { id: target.id, promotedAt: target.promotedAt, prs: accepted, unresolved };
  }

  // Un `PR-n` cuenta siempre que haya podido leerse. Un candidato `TKT-n` cuenta
  // solo si el PR existe Y es NUESTRO: si el autor es el propio revisor (Chris
  // reescribió el trabajo, p.ej. #353/#354) sus rondas ahí no miden nuestra
  // ejecución. Cuando conocemos nuestro login lo exigimos; si no, alcanza con que
  // el autor no sea el revisor. Todo lo que no resuelve queda listado en
  // `unresolved` — el medidor NO adivina en silencio.
  function aggregate(targetList, prsState) {
    return Object.fromEntries(targetList.map((target) => {
      const resolved = resolvedTarget(target, prsState);
      return [target.id, aggregateLesson(resolved, prsState)];
    }));
  }

  let done = resumed;
  writeVerifyState({
    ...emptyVerifyState(),
    status: 'running',
    startedAt,
    progress: { done, total: numbers.length },
    prs,
    lessons: prev.lessons || {},
  });

  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let partial = false;
  for (const n of numbers) {
    if (prs[n]) continue;
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    try {
      const pr = await fetchPrRich(n);
      prs[n] = {
        number: n,
        author: String(pr?.author?.login || ''),
        state: String(pr?.state || ''),
        rounds: chrisRoundsFromPr(pr, login),
        checkedAt: Date.now(),
        error: null,
      };
    } catch (err) {
      // Un PR inexistente es el caso NORMAL de un candidato TKT-n que en realidad
      // era un ticket de Desk (p.ej. TKT-617): no es un fallo del medidor.
      prs[n] = {
        number: n,
        author: '',
        state: '',
        rounds: [],
        checkedAt: Date.now(),
        error: String(err?.message || err).slice(0, 200),
      };
    }
    done += 1;
    writeVerifyState({
      ...emptyVerifyState(),
      status: 'running',
      startedAt,
      progress: { done, total: numbers.length },
      prs,
      lessons: aggregate(targets, prs),
    });
  }

  const lessonsOut = aggregate(targets, prs);
  const withRounds = Object.values(lessonsOut).filter((x) => x.rounds > 0).length;
  const errors = Object.values(prs).filter((p) => p.error).length;
  const unresolvedRefs = Object.values(lessonsOut).reduce((a, x) => a + (x.unresolved?.length || 0), 0);
  writeVerifyState({
    status: partial ? 'partial' : 'done',
    startedAt,
    scannedAt: Date.now(),
    error: null,
    progress: { done, total: numbers.length },
    prs,
    lessons: lessonsOut,
    summary: {
      lessons: targets.length,
      withRounds,
      prs: numbers.length,
      resumed,
      unresolvedRefs,
      errors,
      reviewer: login,
    },
  });
  log(`OK: ${targets.length} lección(es) · ${withRounds} con rondas nuevas de ${login} · ${numbers.length} PR(s) leídos (${resumed} reusados) · ${unresolvedRefs} ref(s) sin resolver.`);
}

log(`retro-verify arrancando (pid ${process.pid})`);
run().then(() => finish(0)).catch((err) => {
  log('FALLÓ:', err?.message || err);
  try {
    const prev = readVerifyState();
    writeVerifyState({
      ...prev,
      status: 'error',
      error: String(err?.message || err).slice(0, 300),
      scannedAt: prev.scannedAt || 0,
    });
  } catch { /* noop */ }
  finish(1);
});
