#!/usr/bin/env node
// bin/cwc-learning-context-runner.js — "🎙️ Contexto adicional" de un TEMA de
// aprendizaje, DESACOPLADO del server (regla de oro: detached+unref, un
// reinicio de la web a mitad NO lo mata).
//
// El endpoint POST /api/learning/:id/context-analyze (modules/learning/index.js)
// escribe el job PENDIENTE en ~/.cwc-data/learning-context-<jobId>.json con la
// transcripción y spawnea esto; acá se corre la IA que INTERPRETA el texto
// (CERO herramientas — no navega código, ver context-shared.js) y AUTO-GUARDA
// el resultado en el tema (store.saveContexto). El front encuesta GET
// /api/learning/:id/context-analyze/:jobId hasta que status deja de ser
// 'running'.
//
// SEGURIDAD (regla 6): CERO herramientas en las DOS capas (hook PreToolUse +
// canUseTool deniegan TODO). settingSources: []. NUNCA lee/escribe código.
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  CONTEXT_MODEL, CONTEXT_MAX_TURNS, CONTEXT_TIMEOUT_MS,
  contextPrompt, parseContext, renderContextText,
  readContextJob, writeContextJob,
} from '../src/modules/learning/context-shared.js';
import { addContexto } from '../src/modules/learning/store.js';
import { registerLearningSession } from '../src/modules/learning/session-log.js';
import { padContextForUser } from '../src/core/pad-context.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const id = String(process.argv[2] || '');

const denyMsg = 'Contexto adicional: corrida de TEXTO PURO, sin herramientas.';
const denyHook = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg,
  },
};

async function interpret(job) {
  let out = '';
  const q = query({
    prompt: contextPrompt({ transcript: job.transcript, itemTitle: job.itemTitle, itemDesc: job.itemDesc }),
    options: {
      model: CONTEXT_MODEL,
      maxTurns: CONTEXT_MAX_TURNS,
      permissionMode: 'default',
      settingSources: [], // sin user/project: cero MCP ni permisos pre-aprobados
      // Capa 1: PreToolUse deniega ANTES de la evaluación de permisos.
      hooks: { PreToolUse: [{ hooks: [async () => denyHook] }] },
      // Capa 2: allowlist vacía para todo lo que pida permiso.
      canUseTool: async () => ({ behavior: 'deny', message: denyMsg }),
    },
  });
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('La interpretación tardó demasiado (timeout).')), CONTEXT_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      // Registra el session_id de ESTA corrida (system/init) para que el panel
      // de Uso la atribuya al bucket 'aprendizaje', no a 'consola' (mismo cwd).
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) registerLearningSession(m.session_id);
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text;
      } else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {}); // el rechazo tardío no debe colarse como unhandledRejection
  try { await Promise.race([pump, timeout]); } finally {
    clearTimeout(timer);
    try { await Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  return out;
}

async function main() {
  const job = readContextJob(id);
  if (!job) { log(`job de contexto (${id}) inexistente.`); process.exit(0); return; }
  const ctx = padContextForUser(job.owner || null);
  try {
    const out = await interpret(job);
    const parsed = parseContext(out);
    if (!parsed) throw new Error('No se pudo interpretar la transcripción (respuesta inválida).');
    const rendered = renderContextText(parsed);
    if (job.topicId) {
      try { await addContexto(job.topicId, { text: rendered, source: 'ia' }, ctx); }
      catch (e) { log('no se pudo auto-guardar en el tema (no rompe el job):', e?.message); }
    }
    writeContextJob(id, { ...job, status: 'done', result: parsed, rendered, error: null, updatedAt: Date.now() });
    log(`OK contexto ${id}: ${rendered.length} chars.`);
  } catch (err) {
    writeContextJob(id, { ...job, status: 'error', error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL contexto ${id}:`, err?.message || err);
  }
}

main().catch((err) => {
  log('FALLO inesperado:', err?.message || err);
  process.exit(1);
});
