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
// durable health-solved.json (historial + recurrencias). Falso positivo (FIXNONE)
// ⇒ `dismissed` + registro durable health-dismissed.json (corta el bucle
// escaneo→mismo FP→escaneo, igual que el orquestador de batch). Falla/timeout ⇒
// `failed` con el motivo. La tarjeta del front polea review.json y se actualiza.
//
// MODO TÁNDEM opt-in (2026-07-19, --tandem 1): Claude sigue diagnosticando y
// VERIFICANDO, pero la ESCRITURA real del fix la hace Codex vía la tool MCP
// `delegate_to_codex` (mismo patrón que el chat Tándem — createCodexToolServer
// de chat/codex-tool.js, reusada tal cual). fixToolAllowedTandem DENIEGA
// Edit/Write/MultiEdit/NotebookEdit: el único camino de Claude para tocar un
// archivo es delegar. `node --check` verifica el resultado igual que siempre,
// sin importar quién escribió el diff.
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT, readReview, writeReview, recordSolved, markFindingDismissed, findingId, addProposal,
  writeFixLock, clearFixLock, readFixLock, isFixing, isRunning, fixPrompt,
  FIX_TIMEOUT_MS, FIX_MAX_TURNS, HEARTBEAT_MS, fixToolAllowed, fixToolAllowedTandem,
} from '../src/modules/health/shared.js';
import { createCodexToolServer } from '../src/modules/chat/codex-tool.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const targetId = process.argv[2];
const TANDEM = process.argv[3] === '--tandem';
if (!targetId) { log('falta el id del hallazgo'); process.exit(2); }
// Una delegación a Codex puede durar minutos; el SDK corta las tools MCP a 60s
// por defecto (mismo ajuste que bin/cwc-chat-runner.js en modo Tándem).
if (TANDEM) process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT || '600000';

// No pisar una revisión en curso (regenera findings) ni otro auto-fix.
if (isRunning()) { log('hay una revisión corriendo: salgo.'); process.exit(0); }
// El server reserva con un PLACEHOLDER pid:0 (spawnFix): esa es MI reserva, NO me
// suicido con ella (BUG-51). Solo salgo si el lock fresco tiene un pid REAL ajeno.
const _fl = readFixLock();
if (_fl && _fl.pid && _fl.pid !== process.pid && isFixing()) {
  log(`ya hay un auto-fix corriendo (lock fresco ajeno pid=${_fl.pid}): salgo.`); process.exit(0);
}

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

  const denyReason = TANDEM
    ? 'Auto-fix Tándem: no editás vos — delegá con delegate_to_codex.'
    : 'Auto-fix: solo lectura/edición + node --check.';
  const deny = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: denyReason,
    },
  };
  const allowed = TANDEM ? fixToolAllowedTandem : fixToolAllowed;
  // Prompt COMPARTIDO con el orquestador de batch (fixPrompt de shared.js):
  // misma rama FIXNONE de falso positivo — antes el runner tenía una copia
  // inline divergente ("FIXFAIL falso positivo") y el FP quedaba 'failed' en
  // vez de 'dismissed', re-auditándose en cada revisión. En Tándem se suma la
  // instrucción de delegar (la allowlist YA fuerza el split; esto explica el
  // porqué para que Claude no insista con Edit/Write).
  const prompt = TANDEM
    ? `${fixPrompt(f)}\n\nMODO TÁNDEM: no tenés Edit/Write/MultiEdit — para aplicar el fix, describí el cambio EXACTO en un plan concreto y usá la herramienta delegate_to_codex. Verificá el diff que te devuelve antes de dar FIXOK.`
    : fixPrompt(f);

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
        ...(TANDEM ? { mcpServers: { codex: createCodexToolServer({ cwd: ROOT }) } } : {}),
        hooks: { PreToolUse: [{ hooks: [async (input) => (allowed(input.tool_name, input.tool_input) ? {} : deny)] }] },
        canUseTool: async (name, input) => (allowed(name, input)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: denyReason }),
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
  // Mismo orden de parseo que el orquestador: FIXOK → FIXNONE/falso positivo → FIXFAIL.
  const dismissed = !okMatch && (/FIXNONE/.test(out) || /falso positivo/i.test(out));
  if (okMatch) {
    const summary = (okMatch[1] || '').trim().slice(0, 400);
    patchFinding({ fixStatus: 'resolved', fixSummary: summary, resolvedAt: Date.now(), fixError: null });
    recordSolved(f, summary);
    log(`auto-fix OK: ${f.area} — ${summary}`);
    // Fase 5: si propuso un invariante, lo guardamos PENDIENTE (no se aplica
    // solo). Formato: "PROPOSED-INVARIANT <texto> | <match>".
    const inv = out.match(/PROPOSED-INVARIANT\s+([^\n]+?)\s*\|\s*([^\n]+)/i);
    if (inv) {
      const match = inv[2].trim() || (f.file || '').split(':')[0];
      addProposal({ text: inv[1].trim(), match, fromFinding: f });
      log(`  invariante propuesto: ${inv[1].trim().slice(0, 80)} | ${match}`);
    }
  } else if (dismissed) {
    // No era un bug: falso positivo. NO es un fallo — se marca 'dismissed' en
    // review.json + registro durable (health-dismissed.json) vía el helper
    // COMPARTIDO con el orquestador, para que la próxima auditoría no lo
    // re-encuentre (dismissedFor lo inyecta en el prompt del auditor).
    const reason = (out.match(/FIXNONE\s*(.*)/)?.[1] || out.match(/falso positivo[^\n]*/i)?.[0] || 'no era un bug').trim().slice(0, 200);
    markFindingDismissed(targetId, reason, f);
    log(`auto-fix DISMISS (falso positivo): ${f.area} — ${reason}`);
  } else {
    const reason = (failMatch?.[1] || 'sin confirmación del modelo').trim().slice(0, 200);
    patchFinding({ fixStatus: 'failed', fixError: reason });
    log(`auto-fix FAIL: ${f.area} — ${reason}`);
  }
  finish(okMatch || dismissed ? 0 : 1);
}

main().catch((err) => {
  patchFinding({ fixStatus: 'failed', fixError: String(err?.message || err).slice(0, 200) });
  log('auto-fix EXCEPCIÓN:', err?.message || err);
  finish(1);
});
