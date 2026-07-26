// modules/retro/curate-shared.js — CURADURÍA IA del registro de MEJORA CONTINUA
// (ROAD-256, Fase 5). Una pasada IA sobre TODAS las lecciones vigentes que
// detecta: duplicados (dedup SEMÁNTICO, más allá del fingerprint por título),
// contradicciones, redundantes (ya cubiertas por una Regla Dura del CLAUDE.md),
// consolidables y huecos. Molde de tasks/analyze-shared.js.
//
// LIGHT a propósito: este archivo lo carga TAMBIÉN el runner, así que NO importa
// el store ni health (que son pesados). El SERVER (retro/index.js) arma el
// `context` {lessons, rules} y lo escribe en el job; el runner solo lee el job y
// prompt-ea. Corrida TEXTO PURO read-only (regla 6) en bin/cwc-retro-curate-runner.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { PROMOTE_TARGETS } from './promote-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..');
const JOB_FILE = path.join(os.homedir(), '.cwc-data', 'retro-curation.json');
const LOG_FILE = path.join(os.homedir(), '.cwc-data', 'retro-curate.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-retro-curate-runner.js');

export const CURATE_TIMEOUT_MS = 4 * 60 * 1000;
export const CURATE_STALE_MS = CURATE_TIMEOUT_MS + 30 * 1000;

export function readCurationJob() {
  try { return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')); }
  catch { return null; }
}
export function writeCurationJob(data) {
  fs.mkdirSync(path.dirname(JOB_FILE), { recursive: true, mode: 0o700 });
  writeJsonAtomic(JOB_FILE, data); // atómico tmp-por-PID (server 'running' + runner 'done')
}

export function isFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= CURATE_STALE_MS;
}
export function jobResult(job) {
  if (!job) return { status: 'idle', result: null, error: null };
  if (job.status === 'running' && !isFreshRunning(job)) {
    return { status: 'error', result: null, error: 'La curaduría no respondió a tiempo (el runner se interrumpió). Reintentá.' };
  }
  return { status: job.status, result: job.result || null, error: job.error || null };
}

export function spawnRetroCurateRunner() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUNNER], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.on('error', (err) => {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn FAIL curate: ${err?.message || err}\n`); } catch { /* noop */ }
    try {
      const job = readCurationJob();
      if (job && job.status === 'running') writeCurationJob({ ...job, status: 'error', result: null, error: 'No se pudo iniciar el runner de curaduría.', updatedAt: Date.now() });
    } catch { /* noop */ }
  });
  child.unref();
  fs.closeSync(logFd);
}

// ===== Prompt (el server ya juntó lessons + rules en `context`) =====
export function curatePrompt(context) {
  const lessons = context?.lessons || [];
  const rules = String(context?.rules || '');
  const list = lessons.map((l) => `${l.id} [${l.category}·${l.project}·x${l.recurrence}·${l.status}·dest:${l.promotedTo || l.destination || '-'}] ${l.title}\n   ${String(l.body || '').replace(/\s+/g, ' ').slice(0, 240)}`).join('\n');
  return `Sos un CURADOR del registro de LECCIONES DE PROCESO de un equipo de desarrollo. Te paso TODAS las lecciones vigentes y un extracto de las REGLAS DURAS del proyecto. Analizá el conjunto y encontrá:

- duplicados: lecciones que dicen esencialmente LO MISMO aunque estén redactadas distinto (dedup semántico). Elegí una para CONSERVAR (keep) y listá las demás (merge).
- contradicciones: lecciones que se CONTRADICEN entre sí.
- redundantes: lecciones YA cubiertas por una Regla Dura existente (citá cuál regla).
- consolidables: 2+ lecciones PARCIALES que convendría unir en una sola mejor.
- huecos: temas de proceso que se repiten o son importantes pero NO tienen lección todavía.
- destinos: lecciones cuyo DESTINO es equivocado. Una lección que es una REGLA ("verificar X antes de Y") pertenece a una convención o contrato, NO a un procedimiento invocable. Destinos válidos: memoria (recordatorio del proyecto) · claude-md (regla permanente del proyecto) · contexto (guía de tickets/PRs) · convencion (regla del equipo) · contrato (obligación VERIFICABLE mecánicamente) · invariante (regla que un chequeo audita sobre archivos). El destino "playbook" está DEPRECADO: toda lección que hoy lo tenga necesita destino nuevo.

Sé CONSERVADOR: solo hallazgos REALES y claros. Si una categoría no aplica, devolvé lista vacía. En español. Usá los ids EXACTOS (MC-N) que te paso.

Respondé ÚNICAMENTE con un bloque \`\`\`json con esta forma EXACTA, sin texto fuera:
\`\`\`json
{ "resumen": "...", "duplicados": [ { "keep": "MC-1", "merge": ["MC-2"], "why": "..." } ], "contradicciones": [ { "ids": ["MC-1","MC-2"], "why": "..." } ], "redundantes": [ { "id": "MC-1", "rule": "..." } ], "consolidables": [ { "ids": ["MC-1","MC-2"], "title": "...", "lesson": "...", "category": "metodologia" } ], "huecos": [ { "tema": "...", "why": "..." } ], "destinos": [ { "id": "MC-1", "actual": "playbook", "sugerido": "convencion", "why": "..." } ] }
\`\`\`

=== REGLAS DURAS (extracto) ===
${rules.slice(0, 6000)}

=== LECCIONES VIGENTES ===
${list}`;
}

// ===== Parseo defensivo =====
const CATS = ['regla', 'convencion', 'metodologia', 'procedimiento', 'herramienta', 'nota'];
const VALID_DESTS = PROMOTE_TARGETS;
const clamp = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const ids = (a) => (Array.isArray(a) ? a.filter((x) => /^MC-\d+$/.test(x)) : []);

export function parseCuration(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  const arr = (x, n, f) => (Array.isArray(x) ? x.slice(0, n).map(f).filter(Boolean) : []);
  return {
    resumen: clamp(o?.resumen, 1500),
    duplicados: arr(o?.duplicados, 40, (d) => {
      const keep = /^MC-\d+$/.test(d?.keep) ? d.keep : null;
      const merge = ids(d?.merge).filter((x) => x !== keep);
      return keep && merge.length ? { keep, merge, why: clamp(d?.why, 400) } : null;
    }),
    contradicciones: arr(o?.contradicciones, 40, (c) => {
      const cc = ids(c?.ids);
      return cc.length >= 2 ? { ids: cc.slice(0, 6), why: clamp(c?.why, 400) } : null;
    }),
    redundantes: arr(o?.redundantes, 40, (r) => (/^MC-\d+$/.test(r?.id) ? { id: r.id, rule: clamp(r?.rule, 400) } : null)),
    consolidables: arr(o?.consolidables, 40, (c) => {
      const cc = ids(c?.ids);
      return cc.length >= 2 && clamp(c?.title, 200).trim()
        ? { ids: cc.slice(0, 6), title: clamp(c.title, 200).trim(), lesson: clamp(c?.lesson, 2000), category: CATS.includes(c?.category) ? c.category : 'nota' }
        : null;
    }),
    huecos: arr(o?.huecos, 40, (h) => (clamp(h?.tema, 200).trim() ? { tema: clamp(h.tema, 200).trim(), why: clamp(h?.why, 400) } : null)),
    destinos: arr(o?.destinos, 40, (d) => {
      const id = /^MC-\d+$/.test(d?.id) ? d.id : null;
      const sugerido = VALID_DESTS.includes(d?.sugerido) ? d.sugerido : null;
      return id && sugerido ? { id, actual: clamp(d?.actual, 40), sugerido, why: clamp(d?.why, 400) } : null;
    }),
  };
}
