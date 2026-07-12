#!/usr/bin/env node
// bin/cwc-retro-curate-runner.js — CURADURÍA IA del registro de MEJORA CONTINUA
// (ROAD-256, Fase 5), DESACOPLADO (regla de oro). Corrida TEXTO PURO read-only
// doble capa (regla 6: sonnet, maxTurns 1, settingSources [], PreToolUse deny +
// canUseTool deny — CERO herramientas). El server ya juntó lessons+rules en el
// job; acá solo prompt-eamos y parseamos. Un solo job (retro-curation.json).
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT, CURATE_TIMEOUT_MS, curatePrompt, parseCuration,
  readCurationJob, writeCurationJob,
} from '../src/modules/retro/curate-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const deny = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'La curaduría de mejora continua no usa herramientas.',
  },
};

async function run(job) {
  let text = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('La curaduría tardó demasiado.')), CURATE_TIMEOUT_MS); });
  const q = query({
    prompt: curatePrompt(job.context),
    options: {
      cwd: ROOT,
      settingSources: [],
      model: 'sonnet',
      maxTurns: 1,
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [async () => deny] }] },
      canUseTool: async () => ({ behavior: 'deny', message: 'Sin herramientas.' }),
    },
  });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
      } else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {});
  try { await Promise.race([pump, timeout]); }
  finally { clearTimeout(timer); try { await Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
  const parsed = parseCuration(text);
  if (!parsed) throw new Error('No se pudo interpretar la respuesta de la curaduría.');
  return parsed;
}

async function main() {
  const job = readCurationJob();
  if (!job) { log('no hay job de curaduría.'); process.exit(0); return; }
  try {
    const result = await run(job);
    const cur = readCurationJob();
    if (!cur) { log('job borrado durante la corrida.'); return; }
    writeCurationJob({ ...cur, status: 'done', result, error: null, updatedAt: Date.now() });
    const n = result.duplicados.length + result.contradicciones.length + result.redundantes.length + result.consolidables.length + result.huecos.length;
    log(`OK curaduría: ${n} hallazgo(s)`);
  } catch (err) {
    const cur = readCurationJob();
    if (cur) writeCurationJob({ ...cur, status: 'error', result: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log('FAIL curaduría:', err?.message || err);
  }
}

main().catch((err) => { log('FALLO inesperado:', err?.message || err); process.exit(1); });
