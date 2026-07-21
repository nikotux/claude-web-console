#!/usr/bin/env node
// bin/cwc-updates-analyze-runner.js — ANÁLISIS DE RIESGO de los saltos MAYORES
// (módulo `updates`, Fase B), DESACOPLADO (regla de oro). Por cada major: baja el
// changelog con Node/gh (determinístico) y una corrida IA READ-ONLY (doble capa
// regla 6: Read/Grep/Glob, settingSources []) lee cómo el proyecto usa el paquete
// → veredicto seguro/riesgoso/rompe + confianza. Solo majors NO-beta. Estado en
// ~/.cwc-data/updates-risk.json (heartbeat, reanudable). Lógica en analyze-shared.js.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildUpdatesCensus } from '../src/modules/updates/shared.js';
import { buildPlan } from '../src/modules/updates/orchestrate-shared.js';
import { runAdaptivePool } from '../src/core/pool.js';
import {
  ANALYZE_MODEL, ANALYZE_MAX_TURNS, ANALYZE_TIMEOUT_MS,
  analyzeToolAllowed, analyzePrompt, parseVerdict, fetchChangelog, isPrerelease,
  riskKey, readRisk, writeRisk, ROOT,
} from '../src/modules/updates/analyze-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const denyMsg = 'Análisis de riesgo: corrida de SOLO LECTURA (Read/Grep/Glob).';
const denyHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg } };

async function assess(name, from, to, changelog) {
  let out = '';
  const q = query({
    prompt: analyzePrompt(name, from, to, changelog),
    options: {
      cwd: ROOT,
      model: ANALYZE_MODEL,
      maxTurns: ANALYZE_MAX_TURNS,
      permissionMode: 'default',
      settingSources: [],
      hooks: { PreToolUse: [{ hooks: [async (input) => (analyzeToolAllowed(input.tool_name) ? {} : denyHook)] }] },
      canUseTool: async (n, input) => (analyzeToolAllowed(n) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: denyMsg }),
    },
  });
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ANALYZE_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text; }
      else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {});
  try { await Promise.race([pump, timeout]); } finally {
    clearTimeout(timer);
    try { await Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  return out;
}

function bump(fields) {
  const j = readRisk() || {};
  writeRisk({ ...j, ...fields, heartbeat: Date.now() });
}

async function main() {
  const job = readRisk();
  if (!job || !job.running) { log('no hay job de riesgo running; salgo.'); return; }
  try {
    bump({ phase: 'censo' });
    const census = await buildUpdatesCensus();
    const plan = buildPlan(census, { apt: false });
    // Solo majors NO-beta (los beta/RC nunca se analizan ni aplican).
    const majors = (plan.majors || []).filter((m) => !isPrerelease(m.latest));
    log(`Analizando ${majors.length} salto(s) mayor(es).`);
    bump({ phase: 'analizando', total: majors.length, done: 0 });

    const verdicts = { ...(job.verdicts || {}) };
    let done = 0;
    await runAdaptivePool(majors, async (m) => {
      const from = m.current || m.wanted; const to = m.latest;
      log(`→ ${m.name} ${from}→${to}: changelog…`);
      const changelog = await fetchChangelog(m.name, from, to);
      let verdict;
      try {
        const out = await assess(m.name, from, to, changelog);
        verdict = parseVerdict(out) || { level: 'riesgoso', confidence: 'baja', why: 'No se pudo interpretar el análisis; tratá como riesgoso.', breakingChanges: [], usedApis: [] };
      } catch (e) {
        verdict = { level: 'riesgoso', confidence: 'baja', why: `Análisis falló (${String(e?.message || e).slice(0, 80)}); tratá como riesgoso.`, breakingChanges: [], usedApis: [] };
      }
      verdict.name = m.name; verdict.from = from; verdict.to = to; verdict.hadChangelog = !!changelog; verdict.at = Date.now();
      verdicts[riskKey(m.name, from, to)] = verdict;
      done += 1;
      bump({ verdicts, done });
      log(`  ✓ ${m.name}: ${verdict.level}/${verdict.confidence}`);
    }, { max: 3 });

    bump({ running: false, phase: 'done', verdicts, generatedAt: Date.now(), error: null, finishedAt: Date.now() });
    log('OK análisis de riesgo.');
  } catch (err) {
    bump({ running: false, phase: 'error', error: String(err?.message || err).slice(0, 300), finishedAt: Date.now() });
    log('FAIL análisis:', err?.message || err);
  }
}

main().catch((err) => { log('FALLO fatal:', err?.message || err); process.exit(1); });
