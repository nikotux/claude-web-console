#!/usr/bin/env node
// bin/cwc-healthfix-runner.js — RESOLUCIÓN AUTÓNOMA de UN hallazgo de salud,
// desacoplada del server (regla 2: un reinicio a mitad NO la mata).
//
// EXCEPCIÓN a la regla 6 (aprobada por el usuario 2026-07-03): a diferencia de
// la REVISIÓN (read-only), este runner ESCRIBE código de la consola para
// arreglar el hallazgo — pero blindado por DOS capas con la allowlist
// `fixToolAllowed`: solo Read/Grep/Glob/Edit/Write + Bash restringido a
// `node --check`. NADA de git, rm, systemctl, npm, curl, reinicios. El fix
// queda en el working tree (revertible con git); NUNCA reinicia el servicio.
//
// Éxito ⇒ marca el hallazgo `resolved` en review.json + lo agrega al registro
// durable health-solved.json (historial + recurrencias). Falla/timeout ⇒
// `failed` con el motivo. La tarjeta del front polea review.json y se actualiza.
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT, readReview, writeReview, recordSolved, findingId,
  writeFixLock, clearFixLock, isFixing, isRunning,
  FIX_TIMEOUT_MS, FIX_MAX_TURNS, HEARTBEAT_MS, fixToolAllowed,
} from '../src/modules/health/shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const targetId = process.argv[2];
if (!targetId) { log('falta el id del hallazgo'); process.exit(2); }

// No pisar una revisión en curso (regenera findings) ni otro auto-fix.
if (isRunning()) { log('hay una revisión corriendo: salgo.'); process.exit(0); }
if (isFixing()) { log('ya hay un auto-fix corriendo (lock fresco): salgo.'); process.exit(0); }

writeFixLock(process.pid);
const heartbeat = setInterval(() => writeFixLock(process.pid), HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearFixLock(); process.exit(code); }

// Ubica el hallazgo en review.json por id de contenido y le setea campos.
function patchFinding(patch) {
  const st = readReview();
  const list = st.findings || [];
  const f = list.find((x) => findingId(x) === targetId);
  if (!f) return null;
  Object.assign(f, patch);
  st.updatedAt = Date.now();
  writeReview(st);
  return f;
}

async function main() {
  const marked = patchFinding({ fixStatus: 'fixing', fixError: null, fixStartedAt: Date.now() });
  if (!marked) { log('hallazgo no encontrado en review.json'); finish(1); return; }
  const f = { ...marked };
  log(`auto-fix arrancando: ${f.area} (${f.module || '—'})`);

  const deny = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Auto-fix: solo lectura/edición + node --check.',
    },
  };
  const prompt = [
    'Sos un runner autónomo que arregla UN hallazgo de la revisión de salud de esta consola (Claude Web Console). Trabajás SIN supervisión humana.',
    '',
    `Módulo: ${f.module || '—'}`,
    `Severidad: ${f.severity || '—'} · Tipo: ${f.kind || '—'}`,
    `Qué falla: ${f.area}`,
    f.file ? `Archivo: ${f.file}` : '',
    '',
    `Detalle: ${f.detail}`,
    f.suggestedFix ? `Fix sugerido por la auditoría: ${f.suggestedFix}` : '',
    '',
    'Reglas ESTRICTAS:',
    '1. Verificá leyendo el código citado que el hallazgo es REAL. Si es falso positivo, NO edites nada y terminá con: FIXFAIL falso positivo — <por qué>.',
    '2. Si es real, aplicá el fix MÍNIMO editando los archivos necesarios.',
    '3. Verificá CADA archivo .js que edites con `node --check <archivo>` (es la ÚNICA orden de terminal permitida). NO podés correr git, tests, npm, systemctl ni reiniciar nada.',
    '4. Terminá tu ÚLTIMO mensaje con UNA línea exacta: "FIXOK <qué cambiaste, en qué archivos>" si quedó resuelto y verificado, o "FIXFAIL <motivo>" si no pudiste.',
    'No expliques de más: hacé el trabajo y cerrá con FIXOK/FIXFAIL.',
  ].filter(Boolean).join('\n');

  let out = '';
  try {
    const q = query({
      prompt,
      options: {
        cwd: ROOT,
        model: 'sonnet',
        maxTurns: FIX_MAX_TURNS,
        permissionMode: 'default',
        settingSources: [],
        hooks: { PreToolUse: [{ hooks: [async (input) => (fixToolAllowed(input.tool_name, input.tool_input) ? {} : deny)] }] },
        canUseTool: async (name, input) => (fixToolAllowed(name, input)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Auto-fix: solo lectura/edición + node --check.' }),
      },
    });
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), FIX_TIMEOUT_MS); });
    const pump = (async () => {
      for await (const m of q) {
        if (m.type === 'assistant') {
          for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += `${b.text}\n`;
        } else if (m.type === 'result') break;
      }
    })();
    try { await Promise.race([pump, timeout]); }
    finally { clearTimeout(timer); try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
  } catch (err) {
    out += `\nFIXFAIL ${String(err?.message || err).slice(0, 140)}`;
  }

  const okMatch = out.match(/FIXOK\s*(.*)/);
  const failMatch = out.match(/FIXFAIL\s*(.*)/);
  if (okMatch) {
    const summary = (okMatch[1] || '').trim().slice(0, 400);
    patchFinding({ fixStatus: 'resolved', fixSummary: summary, resolvedAt: Date.now(), fixError: null });
    recordSolved(f, summary);
    log(`auto-fix OK: ${f.area} — ${summary}`);
  } else {
    const reason = (failMatch?.[1] || 'sin confirmación del modelo').trim().slice(0, 200);
    patchFinding({ fixStatus: 'failed', fixError: reason });
    log(`auto-fix FAIL: ${f.area} — ${reason}`);
  }
  finish(okMatch ? 0 : 1);
}

main().catch((err) => {
  patchFinding({ fixStatus: 'failed', fixError: String(err?.message || err).slice(0, 200) });
  log('auto-fix EXCEPCIÓN:', err?.message || err);
  finish(1);
});
