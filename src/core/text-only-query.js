// core/text-only-query.js — corrida del SDK de TEXTO PURO (interpretación sin
// herramientas), helper ÚNICO para los runners de interpretación read-only.
//
// Encapsula el contrato repetido en varios runners (retro, ticket-context, …):
// settingSources: [] (vía settingSourcesFor('none')), las DOS capas de la regla
// dura 6 (PreToolUse deny + canUseTool deny ⇒ CERO herramientas), la carrera
// contra un timeout, y el pump que acumula el texto del stream. Devuelve el
// texto acumulado del asistente, o lanza si vence el timeout.
//
// ⚠️ REGLA DURA 6 (blindaje read-only headless): las dos capas de denegación son
// INCONDICIONALES acá — este helper es SOLO para interpretación pura de texto.
// NO agregar un parámetro que las debilite ni una allowlist: si un runner
// necesita herramientas (p.ej. Read/Grep del auditor de Salud), NO usa este
// helper, arma su propia query() con su allowlist explícita.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { settingSourcesFor } from './sdk-settings.js';

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function textOnlyQuery(prompt, {
  // Quien necesite más calidad pasa 'sonnet', como hacen hoy los callers.
  model = 'haiku', effort, maxTurns = 1, timeoutMs, cwd,
  denyReason = 'Esta corrida no usa herramientas.',
  timeoutMessage = 'La corrida tardó demasiado.',
} = {}) {
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const abortController = new AbortController();
  const deny = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denyReason,
    },
  };
  const q = query({
    prompt,
    options: {
      cwd,
      abortController,
      settingSources: settingSourcesFor('none'), // [] — cero settings/skills/MCP
      model,
      ...(effort ? { effort } : {}),
      maxTurns,
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [async () => deny] }] },        // CAPA 1
      canUseTool: async () => ({ behavior: 'deny', message: 'Sin herramientas.' }), // CAPA 2
    },
  });
  let text = '';
  let timer = null;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      abortController.abort();
      rej(new Error(timeoutMessage));
    }, effectiveTimeoutMs);
  });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
      } else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {}); // si gana el timeout, evita unhandledRejection del pump tardío
  try {
    await Promise.race([pump, timeout]);
  } finally {
    clearTimeout(timer);
    try { await Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  return text;
}
