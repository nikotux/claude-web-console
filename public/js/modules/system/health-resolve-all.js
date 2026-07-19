// modules/system/health-resolve-all.js — "Resolver todo" del Escaneo de Salud
// (F2 de PLAN-752, pedido de Niko: "un botón que resuelva todo en el chat
// aprovechando el Orquestador Interno").
//
// ENFOQUE (decisión de diseño): NO construimos un runner-orquestador nuevo en el
// backend — Niko pidió resolver "en el CHAT". El botón junta los hallazgos
// ABIERTOS de la Revisión + las propuestas PENDIENTES de Optimización/Coherencia
// (0 tokens, solo lee los endpoints ya existentes) y abre UN chat supervisado
// (acceptEdits, cwd=console) con un prompt que instruye usar el Orquestador
// Interno (skills `agrupar`/`orquestar`, PLAN-642 / CONVE-654): agrupar por
// COLISIÓN de archivos y resolver los bloques en PARALELO supervisado. Reusa el
// flujo de skills ya probado; cero infra nueva de orquestación en el server.
//
// Cada hallazgo se cierra con `node bin/cwc-health-resolve.js <id>` (igual que
// "Resolver todo en chat" clásico); las propuestas con
// `node bin/cwc-health-proposal-done.js <padRef>` si tienen ref de Pad.
import { t } from '../../ui/i18n.js';

const API = '/api/health';

// Reglas duras compartidas del chat de resolución (espejo de RESOLVE_RULES de
// health-review-modal, con el foco puesto en la orquestación por bloques).
const ORCH_RULES = [
  'Reglas ESTRICTAS:',
  '1. Leé el CLAUDE.md de la raíz ANTES de tocar nada: las reglas duras (1-13) son inviolables — en particular el blindaje read-only de dos capas de las corridas headless, los runners desacoplados (regla de oro) y el bind exclusivo a ZeroTier.',
  '2. AGRUPÁ los ítems por COLISIÓN de archivos: los que tocan archivos distintos pueden resolverse EN PARALELO; los que comparten archivo van en el MISMO bloque (serial entre sí). Usá las skills `agrupar` y `orquestar` (Orquestador Interno) si el volumen lo amerita; con pocos ítems podés resolver los bloques secuencialmente.',
  '3. Verificá leyendo el código que cada ítem sigue vigente. Un HALLAZGO falso positivo: avisá y NO lo toques ni lo marques resuelto. Una PROPUESTA falso positivo / que ya está hecha / que no aplica: marcala `reject` con el CLI (así deja de aparecer pendiente). Toda propuesta que APLIQUES se marca `accept`.',
  '4. Verificá cada archivo .js que edites con `node --check`.',
  '5. FRENÁ y pedí confirmación ANTES de cualquier acción de alto riesgo (git push, reiniciar el servicio, borrar datos). Los hallazgos CRÍTICOS (server/bind/auth/tls/config) NO se resuelven sin supervisión explícita.',
  '6. Al terminar, resumí qué cambiaste por bloque, en qué archivos y cómo verificarlo.',
].join('\n');

function findingLine(f, i) {
  const sev = f.severity ? `[${f.severity}] ` : '';
  const mod = f.module ? ` (${f.module})` : '';
  const file = f.file ? ` — ${f.file}` : '';
  const fix = f.suggestedFix ? `\n   Fix sugerido: ${f.suggestedFix}` : '';
  return `${i + 1}. ${sev}${f.area || f.detail || '?'}${mod}${file}  (id=${f.id})\n   ${f.detail || ''}${fix}`;
}

function proposalLine(kind, p, i) {
  return `${i + 1}. ${p.foco || p.motor || '?'}${p.archivo ? ` (${p.archivo})` : ''}  (id=${p.id})\n   ${p.actual || ''} → ${p.propuesta || ''}\n   ${p.razon || ''}`;
}

export async function launchResolveAll(ctx, { isAdmin, onClose } = {}) {
  const { dialog, openChat } = ctx;
  if (!isAdmin) {
    await dialog.alertDialog({ title: t('system.resolveAll.title', 'Resolver todo'), message: t('system.resolveAll.adminOnly', 'Solo un administrador puede resolver los hallazgos (edita código y consume tokens).') });
    return;
  }
  // Juntar hallazgos abiertos + propuestas pendientes (0 tokens, endpoints ya existentes).
  let findings = []; let optProps = []; let cohProps = [];
  try {
    const [rev, opt, coh] = await Promise.all([
      fetch(`${API}/review`).then((r) => r.json()).catch(() => ({})),
      fetch(`${API}/optimization`).then((r) => r.json()).catch(() => ({})),
      fetch(`${API}/coherence`).then((r) => r.json()).catch(() => ({})),
    ]);
    findings = (rev.findings || []).filter((f) => f.fixStatus !== 'resolved' && f.fixStatus !== 'dismissed');
    optProps = (opt.propuestas || []).filter((p) => p.status === 'pending');
    cohProps = (coh.propuestas || []).filter((p) => p.status === 'pending');
  } catch {
    await dialog.alertDialog({ title: t('system.resolveAll.title', 'Resolver todo'), message: t('system.resolveAll.readError', 'No se pudo leer el estado de la Revisión.') });
    return;
  }

  const total = findings.length + optProps.length + cohProps.length;
  if (!total) {
    await dialog.alertDialog({ title: t('system.resolveAll.title', 'Resolver todo'), message: t('system.resolveAll.nothing', 'No hay hallazgos abiertos ni propuestas pendientes. ¡Todo en orden!') });
    return;
  }

  const ok = await dialog.confirmDialog({
    title: t('system.resolveAll.title', 'Resolver todo (Orquestador)'),
    message: t('system.resolveAll.confirm', 'Se abre UN chat supervisado (modo Aceptar ediciones) que va a resolver {total} ítem(s): {f} hallazgo(s) de Revisión + {o} propuesta(s) de Optimización + {c} de Coherencia.\n\nLos agrupa por colisión de archivos y los resuelve con el Orquestador Interno (en paralelo cuando no colisionan). Frena y te pide confirmación en cada decisión de alto riesgo. Lo ves en vivo y podés detenerlo cuando quieras.\n\nCONSUME TOKENS. ¿Arrancar?', { total, f: findings.length, o: optProps.length, c: cohProps.length }),
    confirmLabel: t('system.resolveAll.start', 'Resolver {total} ítem(s)', { total }),
  });
  if (!ok) return;

  const sections = [];
  sections.push(t('system.resolveAll.promptIntro', 'La Salud de la consola (Claude Web Console) tiene {total} ítem(s) por resolver: hallazgos de la Revisión Exhaustiva + propuestas de Optimización/Coherencia. Resolvelos de forma supervisada usando el ORQUESTADOR INTERNO — agrupá por colisión de archivos y resolvé los bloques en paralelo cuando no compartan archivos.', { total }));
  sections.push('');
  if (findings.length) {
    sections.push(`### ${t('system.resolveAll.reviewFindings', 'Hallazgos de la Revisión')} (${findings.length})`);
    sections.push(findings.map(findingLine).join('\n\n'));
    sections.push('');
    sections.push(t('system.resolveAll.reviewClose', 'Cerrá CADA hallazgo resuelto con: node bin/cwc-health-resolve.js <id> "<resumen>"  (solo si de verdad lo resolviste; falso positivo = NO marcar y avisar).'));
    sections.push('');
  }
  if (optProps.length) {
    sections.push(`### ${t('system.resolveAll.optimizationProposals', 'Propuestas de Optimización')} (${optProps.length})`);
    sections.push(optProps.map((p, i) => proposalLine('optimize', p, i)).join('\n\n'));
    sections.push('');
    sections.push(t('system.resolveAll.optimizeClose', 'Cerrá CADA propuesta de Optimización con: node bin/cwc-health-proposal-mark.js optimize <id> <accept|reject>  (accept si la APLICASTE, reject si es falso positivo / no aplica / ya estaba hecha). Sin esto la propuesta queda "pending" en el tablero aunque la hayas resuelto.'));
    sections.push('');
  }
  if (cohProps.length) {
    sections.push(`### ${t('system.resolveAll.coherenceProposals', 'Propuestas de Coherencia')} (${cohProps.length})`);
    sections.push(cohProps.map((p, i) => proposalLine('coherence', p, i)).join('\n\n'));
    sections.push('');
    sections.push(t('system.resolveAll.coherenceClose', 'Cerrá CADA propuesta de Coherencia con: node bin/cwc-health-proposal-mark.js coherence <id> <accept|reject>  (mismo criterio: accept si la aplicaste, reject si es falso positivo / no aplica).'));
    sections.push('');
  }
  sections.push(ORCH_RULES);

  onClose?.();
  await openChat?.({
    cwd: 'claude-web-console',
    mode: 'acceptEdits',
    prompt: sections.join('\n'),
    title: t('system.resolveAll.chatTitle', 'Resolver salud (orquestado)').slice(0, 50),
  });
}
