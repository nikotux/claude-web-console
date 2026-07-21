#!/usr/bin/env node
// bin/cwc-updates-runner.js — ORQUESTADOR de la actualización de UN solo botón,
// DESACOPLADO del server (regla de oro/regla 2). Es el único runner que REINICIA
// el servicio y SOBREVIVE a ese reinicio (spawneado detached, KillMode=process lo
// protege — igual que los chat-runners que se re-enganchan tras un restart).
//
// El server (POST /api/updates/run) reserva el job {running, phase:'queued', scope}
// y spawnea esto; GET /api/updates/run-status solo LEE el disco. NO usa el SDK (0
// tokens: npm/claude/apt/systemctl locales — la regla 6 no aplica). Lógica en
// src/modules/updates/orchestrate-shared.js.
//
// Fases: planning → draining → applying → verifying → restarting → resuming → done.
// Seguridad: si node --check falla tras aplicar ⇒ ABORTA sin reiniciar (deja hint
// de revert). npm solo a `wanted` (estable). Majors nunca auto-aplicados.
import {
  readJob, writeJob, buildPlan, planActionCount, detectActiveWork, notifyInterfono,
  applyNpm, applyClaudeCli, applyApt, applyAuditFix, verifySyntax, restartService, waitServiceActive, sleep,
  invalidateCensusCache,
} from '../src/modules/updates/orchestrate-shared.js';
import { buildUpdatesCensus } from '../src/modules/updates/shared.js';
import { readRisk } from '../src/modules/updates/analyze-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// Merge parcial al job + heartbeat + persistencia atómica. Cada avance llama a
// esto, así el status endpoint (que solo lee el archivo) ve el progreso en vivo,
// incluso a través del reinicio del server.
function patch(fields) {
  const j = readJob() || {};
  writeJob({ ...j, ...fields, heartbeat: Date.now() });
  return readJob();
}
function pushLog(line) {
  const j = readJob() || {};
  const arr = Array.isArray(j.log) ? j.log : [];
  arr.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  writeJob({ ...j, log: arr.slice(-120), heartbeat: Date.now() });
  log(line);
}
function setStep(id, status, detail) {
  const j = readJob() || {};
  const steps = (j.steps || []).map((s) => (s.id === id ? { ...s, status, detail: detail ?? s.detail } : s));
  writeJob({ ...j, steps, heartbeat: Date.now() });
}

async function main() {
  const job = readJob();
  if (!job || !job.running) { log('no hay job running reservado; salgo.'); return; }
  const scope = job.scope || { apt: true };

  try {
    // ── 1 · PLANNING ──────────────────────────────────────────────────────
    patch({ phase: 'planning' });
    pushLog('Planeando: censo fresco de versiones…');
    const census = await buildUpdatesCensus();
    const verdicts = (readRisk() || {}).verdicts || {};
    const plan = buildPlan(census, scope, job.includeMajors || [], verdicts);
    const count = planActionCount(plan);

    // Steps de la fase de aplicado (checklist para la UI). Orden lógico:
    // vulnerabilidades primero (lo más seguro), luego libs, majors, CLI, apt.
    const steps = [];
    if (plan.vulnFix) steps.push({ id: 'vuln-fix', label: '🔐 Arreglar vulnerabilidades (npm audit fix)', status: 'pending', kind: 'vuln' });
    for (const l of plan.inRange) steps.push({ id: `npm:${l.name}`, label: `${l.name} ${l.from} → ${l.to}`, status: 'pending', kind: 'npm' });
    for (const l of plan.majorsToApply) steps.push({ id: `major:${l.name}`, label: `⚠ ${l.name} ${l.from} → ${l.to} (mayor)`, status: 'pending', kind: 'major' });
    if (plan.claudeCli) steps.push({ id: 'claude-cli', label: `Claude CLI ${plan.claudeCli.from} → ${plan.claudeCli.to}`, status: 'pending', kind: 'cli' });
    if (plan.apt) steps.push({ id: 'apt', label: `Sistema operativo (${plan.apt.count} paquetes apt)`, status: 'pending', kind: 'apt' });
    patch({ plan, steps });

    if (count === 0) {
      patch({ running: false, phase: 'done', finishedAt: Date.now(), error: null, result: { message: 'Todo ya estaba al día — nada que actualizar.' } });
      pushLog('Nada que actualizar. Listo.');
      return;
    }
    pushLog(`Plan: ${plan.inRange.length} lib(s) npm + ${plan.claudeCli ? 'CLI' : 'sin CLI'} + ${plan.apt ? plan.apt.count + ' apt' : 'sin apt'} · ${plan.majors.length} salto(s) mayor(es) quedan para tu revisión.`);

    // ── 2 · DRAINING ──────────────────────────────────────────────────────
    patch({ phase: 'draining' });
    const active = detectActiveWork();
    patch({ activeWork: active });
    notifyInterfono(`🔄 Actualización en curso: voy a aplicar updates y reiniciar el servicio en instantes. Tu trabajo sobrevive el reinicio (runners desacoplados), pero si estás a mitad de un turno crítico, guardá tu punto.`, 'note');
    if (active.length) {
      pushLog(`Hay ${active.length} proceso(s) de fondo activos (${active.map((a) => a.label || a.key).join(', ')}). Aviso por interfono y espero drenaje acotado…`);
      // Espera acotada a que el fondo repose (no bloquea para siempre: los
      // runners sobreviven el reinicio, esto solo evita cortar algo casi listo).
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await sleep(4000);
        const still = detectActiveWork();
        patch({ activeWork: still });
        if (!still.length) { pushLog('Fondo en reposo. Sigo.'); break; }
      }
      const finalStill = detectActiveWork();
      if (finalStill.length) pushLog(`Timeout de drenaje: ${finalStill.length} proceso(s) siguen activos (sobreviven el reinicio). Continúo.`);
    } else {
      pushLog('Sin trabajo de fondo activo. Sigo.');
    }

    // ── 3 · APPLYING ──────────────────────────────────────────────────────
    patch({ phase: 'applying' });
    let touchedNpm = false;

    // Vulnerabilidades PRIMERO (npm audit fix seguro, dentro de rango).
    if (plan.vulnFix) {
      setStep('vuln-fix', 'running');
      pushLog('npm audit fix (arreglo seguro de vulnerabilidades)…');
      const r = await applyAuditFix();
      setStep('vuln-fix', r.ok ? 'ok' : 'fail', r.detail);
      if (r.ok) touchedNpm = true; else pushLog(`⚠️ audit fix: ${r.detail}`);
    }

    for (const l of plan.inRange) {
      setStep(`npm:${l.name}`, 'running');
      pushLog(`npm install ${l.name}@${l.to}…`);
      const r = await applyNpm(l.name, l.to);
      setStep(`npm:${l.name}`, r.ok ? 'ok' : 'fail', r.detail);
      if (r.ok) { touchedNpm = true; } else { pushLog(`⚠️ Falló ${l.name}: ${r.detail}`); }
    }

    // Saltos MAYORES tildados por el usuario (opt-in). Se aplican a `latest`
    // (fuera de rango) — pueden romper en RUNTIME (node --check solo caza sintaxis);
    // por eso el aviso explícito y quedan separados de los in-range.
    for (const l of plan.majorsToApply) {
      setStep(`major:${l.name}`, 'running');
      pushLog(`⚠ SALTO MAYOR (tu OK): npm install ${l.name}@${l.to}… — puede requerir cambios de código; probá la consola tras el reinicio.`);
      const r = await applyNpm(l.name, l.to);
      setStep(`major:${l.name}`, r.ok ? 'ok' : 'fail', r.detail);
      if (r.ok) { touchedNpm = true; } else { pushLog(`⚠️ Falló major ${l.name}: ${r.detail}`); }
    }

    // Verificación TEMPRANA tras tocar npm: si la sintaxis se rompió, ABORTAR
    // ANTES de tocar el CLI/apt o reiniciar (no reiniciar sobre código roto).
    if (touchedNpm) {
      const early = await verifySyntax();
      if (!early.ok) {
        patch({ running: false, phase: 'error', finishedAt: Date.now(), syntax: early,
          error: 'node --check falló tras actualizar npm — ABORTADO sin reiniciar. Revertí con: git checkout -- package.json package-lock.json && npm install' });
        pushLog('❌ Sintaxis rota tras npm. Abortado sin reiniciar.');
        return;
      }
    }

    if (plan.claudeCli) {
      setStep('claude-cli', 'running');
      pushLog('claude update…');
      const r = await applyClaudeCli();
      setStep('claude-cli', r.ok ? 'ok' : 'fail', r.detail);
      if (!r.ok) pushLog(`⚠️ CLI: ${r.detail}`);
    }

    let rebootRequired = false;
    if (plan.apt) {
      setStep('apt', 'running');
      pushLog('apt-get update && apt-get upgrade -y (SO)…');
      const r = await applyApt();
      rebootRequired = !!r.rebootRequired;
      setStep('apt', r.ok ? 'ok' : 'fail', r.detail);
      if (!r.ok) pushLog(`⚠️ apt: ${r.detail}`);
    }
    patch({ rebootRequired });
    // El censo cacheado quedó viejo tras aplicar → invalidarlo para que la UI no
    // siga mostrando "por actualizar" lo que ya se aplicó.
    invalidateCensusCache();

    // ── 4 · VERIFYING ─────────────────────────────────────────────────────
    patch({ phase: 'verifying' });
    pushLog('Verificando sintaxis (node --check de todo el árbol + runners)…');
    const syntax = await verifySyntax();
    patch({ syntax });
    if (!syntax.ok) {
      patch({ running: false, phase: 'error', finishedAt: Date.now(),
        error: 'node --check falló en la verificación final — NO se reinicia. Revertí con: git checkout -- package.json package-lock.json && npm install' });
      pushLog('❌ Verificación falló. No reinicio.');
      return;
    }
    pushLog('✅ Sintaxis OK.');

    // ── 5 · RESTARTING ────────────────────────────────────────────────────
    patch({ phase: 'restarting' });
    notifyInterfono('🔁 Reiniciando el servicio para tomar las actualizaciones. Vuelvo en unos segundos.', 'note');
    pushLog('Reiniciando el servicio… (el runner sobrevive por KillMode=process)');
    await restartService();
    const back = await waitServiceActive({ timeoutMs: 60_000 });
    pushLog(back ? '✅ Servicio activo de nuevo.' : '⚠️ El servicio no confirmó estar activo a tiempo (revisá journalctl).');
    // Un respiro para que el HTTP termine de bindear antes de reanudar.
    await sleep(2000);

    // ── 6 · RESUMING ──────────────────────────────────────────────────────
    patch({ phase: 'resuming' });
    // NUNCA se sugiere reiniciar la máquina (regla dura de Niko: jamás sudo reboot).
    // Si algún paquete del SO lo requería, queda como dato en el job, sin nag.
    notifyInterfono('✅ Actualización aplicada y servicio reiniciado. Podés continuar.', 'note');
    pushLog('📨 Interfono de continuación enviado.');

    patch({ running: false, phase: 'done', finishedAt: Date.now(), error: null, rebootRequired,
      result: { message: 'Actualización completa y verificada.' } });
    pushLog('🎉 Listo.');
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 400);
    patch({ running: false, phase: 'error', finishedAt: Date.now(), error: `Fallo inesperado: ${msg}` });
    pushLog(`❌ Fallo inesperado: ${msg}`);
  }
}

main().catch((err) => { log('FALLO fatal:', err?.message || err); process.exit(1); });
