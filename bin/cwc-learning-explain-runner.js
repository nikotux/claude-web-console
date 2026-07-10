#!/usr/bin/env node
// bin/cwc-learning-explain-runner.js — "🎓 Explicame esto" del MÓDULO DE
// APRENDIZAJE, DESACOPLADO del server (regla de oro: detached+unref, un reinicio
// de la web a mitad NO lo mata).
//
// El endpoint POST /api/learning/:id/explain (modules/learning/index.js) escribe
// el job PENDIENTE en ~/.cwc-data/learning-explain-<id>.json con el snapshot del
// tema y spawnea esto con el id; acá se corre la IA que NAVEGA el código real
// (cwd = la consola o Tolkien según el alcance del tema) y redacta una
// explicación guiada. El resultado se AUTO-GUARDA en el tema (store.saveExplanation)
// y el job pasa a 'done'. El front encuesta GET /api/learning/:id/explain hasta
// que status deja de ser 'running'.
//
// SEGURIDAD (regla 6): READ-ONLY blindada por DOS capas (hook PreToolUse +
// canUseTool) con la allowlist Read/Grep/Glob/TodoWrite (explainToolAllowed).
// settingSources: [] (cero MCP ni permisos pre-aprobados). NUNCA escribe código.
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  EXPLAIN_MAX_TURNS, EXPLAIN_TIMEOUT_MS, EXPLAIN_MODEL,
  explainToolAllowed, explainPrompt, parseExplanation, parseFiles,
  textFingerprint, fileSnapshot, cwdForScope,
  readExplainJob, writeExplainJob,
} from '../src/modules/learning/explain-shared.js';
import { saveExplanation } from '../src/modules/learning/store.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const id = String(process.argv[2] || '');

const denyMsg = 'Aprendizaje guiado: corrida de SOLO LECTURA (Read/Grep/Glob).';
const denyHook = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg,
  },
};

async function explain(topic, opts) {
  let out = '';
  const q = query({
    prompt: explainPrompt(topic, opts),
    options: {
      cwd: cwdForScope(topic.scope),
      model: EXPLAIN_MODEL,
      maxTurns: EXPLAIN_MAX_TURNS,
      permissionMode: 'default',
      settingSources: [], // sin user/project: cero MCP ni permisos pre-aprobados
      // Capa 1: PreToolUse deniega ANTES de la evaluación de permisos.
      hooks: {
        PreToolUse: [{ hooks: [async (input) => (explainToolAllowed(input.tool_name) ? {} : denyHook)] }],
      },
      // Capa 2: allowlist para todo lo que pida permiso.
      canUseTool: async (name, input) => (explainToolAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: denyMsg }),
    },
  });
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('La explicación tardó demasiado (timeout).')), EXPLAIN_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
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
  const job = readExplainJob(id);
  if (!job) { log(`job de explicación (${id}) inexistente.`); process.exit(0); return; }
  const topic = job.topic;
  if (!topic) {
    writeExplainJob(id, { ...job, status: 'error', error: 'Sin datos del tema.', updatedAt: Date.now() });
    process.exit(0); return;
  }
  try {
    const out = await explain(topic, { mode: job.mode, previousExplanation: topic.previousExplanation, reason: topic.reason });
    const explanation = parseExplanation(out);
    if (!explanation) throw new Error('No se pudo interpretar la explicación (respuesta vacía).');
    const files = parseFiles(out);
    const snapshot = fileSnapshot(files, cwdForScope(topic.scope));
    const fingerprint = textFingerprint(topic);
    try { saveExplanation(id, { explanation, model: EXPLAIN_MODEL, scope: topic.scope, fingerprint, files: snapshot }); }
    catch (e) { log('no se pudo auto-guardar en el tema (no rompe el job):', e?.message); }
    writeExplainJob(id, { ...job, status: 'done', error: null, updatedAt: Date.now() });
    log(`OK explicación ${id}: ${explanation.length} chars, ${files.length} archivos citados.`);
  } catch (err) {
    writeExplainJob(id, { ...job, status: 'error', error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL explicación ${id}:`, err?.message || err);
  }
}

main().catch((err) => {
  log('FALLO inesperado:', err?.message || err);
  process.exit(1);
});
