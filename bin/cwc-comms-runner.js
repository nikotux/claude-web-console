#!/usr/bin/env node
// bin/cwc-comms-runner.js — runner DESACOPLADO del escaneo de comunicaciones.
// Recolecta con `gh` (determinístico, 0 tokens) las reviews y comentarios de
// los contactos (con login de GitHub) sobre el repo Tolkien y arma los hilos
// del índice (github.json). Reanudable: lock/heartbeat como el triage; caché
// incremental por PR (fingerprint número+updatedAt) para no re-pedir detalle
// de lo que no cambió. Un reinicio del server a mitad NO lo mata.
import { execFile } from 'node:child_process';
import { config } from '../src/core/config.js';
import * as C from '../src/modules/comms/shared.js';
import { fetchPrRich, listPrs } from '../src/modules/comms/pr-read-shared.js';

function log(...a) { try { console.log(new Date().toISOString(), '[comms-runner]', ...a); } catch { /* noop */ } }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]}: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout).trim());
    });
  });
}
const GH_OPTS = { cwd: config.projectDir };
const ts = (s) => { const n = Date.parse(s || ''); return Number.isFinite(n) ? n : 0; };

// Arma los eventos (reviews + comentarios) de un PR, en crudo con su login.
function eventsFromPr(det) {
  const evs = [];
  for (const rv of (det.reviews || [])) {
    const body = String(rv.body || '').trim();
    const state = rv.state ? `[${rv.state}] ` : '';
    if (!body && !rv.state) continue;
    evs.push({ login: (rv.author?.login || '').toLowerCase(), ts: ts(rv.submittedAt) || ts(det.updatedAt), text: (state + body).slice(0, 4000), kind: 'review' });
  }
  for (const cm of (det.comments || [])) {
    const body = String(cm.body || '').trim();
    if (!body) continue;
    evs.push({ login: (cm.author?.login || '').toLowerCase(), ts: ts(cm.createdAt) || ts(det.updatedAt), text: body.slice(0, 4000), kind: 'comment' });
  }
  return evs;
}

// CORRECTITUD DE ATRIBUCIÓN: un hilo de GitHub es "conversación conmigo y el
// contacto" SOLO si el PR es MÍO (yo, self.github, soy el autor) o yo participé
// (comenté/revisé). Si es un PR ajeno donde el contacto habla con otro y yo no
// estoy, NO es mi conversación → se descarta. Guarda participants para auditar.
function threadsForPr(det, contacts, self, myLogin) {
  const byLogin = {};
  for (const c of contacts) if (c.github) byLogin[c.github.toLowerCase()] = c;
  const evs = eventsFromPr(det);
  const authorLogin = (det.author?.login || '').toLowerCase();
  const me = String(myLogin || '').toLowerCase();
  const iAmAuthor = !!me && authorLogin === me;
  const iParticipated = !!me && evs.some((e) => e.login === me);
  // Guarda: sin identidad propia no filtro (fallback al comportamiento viejo);
  // con identidad, exijo que el PR sea mío o que yo haya participado.
  if (me && !iAmAuthor && !iParticipated) return [];

  const reviewReq = (det.reviewRequests || []).map((x) => (x.login || '').toLowerCase()).filter(Boolean);
  const meName = self?.name || 'Yo';
  const out = [];
  for (const c of contacts) {
    if (!c.github) continue;
    const gl = c.github.toLowerCase();
    const involved = evs.some((e) => e.login === gl);
    const requested = reviewReq.includes(gl);
    if (!involved && !requested) continue;
    const messages = evs.map((e) => ({
      author: e.login === me ? meName : (byLogin[e.login]?.name || e.login || 'alguien'),
      login: e.login,
      ts: e.ts,
      text: e.text,
      kind: e.kind,
      url: det.url,
      fromContact: e.login === gl,
    }));
    if (requested && !messages.length) {
      messages.push({ author: meName, login: me, ts: ts(det.updatedAt) || Date.now(), text: `Revisión solicitada a ${c.name} en el PR #${det.number}.`, kind: 'request', url: det.url, fromContact: false });
    }
    if (!messages.length) continue;
    out.push({
      id: `gh:${det.number}:${c.id}`,
      contactId: c.id,
      source: 'github',
      project: config.projectName,
      title: `PR #${det.number} · ${String(det.title || '').slice(0, 120)}`,
      url: det.url,
      state: det.state || null,
      participants: [
        { name: self?.name || 'Yo', email: self?.email || '' },
        { name: c.name, email: c.email || '' },
      ],
      messages,
    });
  }
  return out;
}

// --- Reserva del lock (patrón triage): reconocer la reserva del server ---
const lock = C.readLock();
if (lock && lock.pid !== process.pid && Date.now() - lock.ts < C.LOCK_FRESH_MS) {
  log('ya hay un escaneo corriendo (lock fresco ajeno): salgo.');
  process.exit(0);
}
C.writeLock(process.pid);
const heartbeat = setInterval(() => C.writeLock(process.pid), C.HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); C.clearLock(); process.exit(code); }

(async () => {
  C.ensureSeed();
  const contacts = C.readContacts().filter((c) => c.github);
  if (!contacts.length) {
    log('sin contactos con GitHub: nada que escanear.');
    C.writeGithub({ threads: [], scannedAt: Date.now(), error: null });
    finish(0);
    return;
  }
  const self = C.readSelf();
  let myLogin = String(self.github || '').toLowerCase();
  if (!myLogin) { try { myLogin = (await run('gh', ['api', 'user', '--jq', '.login'], GH_OPTS)).toLowerCase(); } catch { /* sin login: no filtra */ } }
  log('identidad propia:', self.name, '/ gh', myLogin || '(desconocido)');
  try {
    // Fuente única del listado (comms/pr-read-shared.js:listPrs). El detalle por
    // PR ya usaba fetchPrRich; ahora el listado también sale del lector central.
    let prs = await listPrs({ state: 'all', limit: Number(C.PR_SCAN_LIMIT), cwd: config.projectDir });
    // Priorizar abiertos y recientes; cap al detalle (cada view es una llamada).
    prs.sort((a, b) => {
      const ao = a.state === 'OPEN' || a.state === 'open' ? 0 : 1;
      const bo = b.state === 'OPEN' || b.state === 'open' ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return ts(b.updatedAt) - ts(a.updatedAt);
    });
    prs = prs.slice(0, C.PR_DETAIL_CAP);

    const cache = C.readGhCache();
    const nextCache = {};
    const threads = [];
    let done = 0;
    for (const pr of prs) {
      const fp = C.prFingerprint(pr);
      let hilos = (cache[pr.number] && cache[pr.number].fp === fp && cache[pr.number].v === 2) ? cache[pr.number].threads : null;
      if (!hilos) {
        try {
          // Fase C: lectura centralizada (misma caché que prLive/investigate).
          const det = await fetchPrRich(pr.number, { fresh: true });
          hilos = threadsForPr(det, contacts, self, myLogin);
        } catch (e) {
          log('PR', pr.number, 'error de detalle:', e.message);
          hilos = (cache[pr.number] && cache[pr.number].threads) || [];
        }
      }
      nextCache[pr.number] = { fp, v: 2, threads: hilos };
      for (const t of hilos) threads.push(t);
      done += 1;
      // Escritura INCREMENTAL: el front ve crecer la lista mientras escanea.
      C.writeGithub({ threads, scannedAt: Date.now(), error: null });
    }
    C.writeGhCache(nextCache);
    C.writeGithub({ threads, scannedAt: Date.now(), error: null });
    log('listo:', threads.length, 'hilos de', done, 'PRs revisados.');
    finish(0);
  } catch (e) {
    log('error general:', e.message);
    const prev = C.readGithub();
    C.writeGithub({ threads: prev.threads || [], scannedAt: Date.now(), error: String(e.message).slice(0, 300) });
    finish(1);
  }
})();
