// modules/tickets/context-store.js — contextos de prompt EDITABLES ('work'/'pr')
// que se inyectan en cada "Trabajar en el chat". Migrado de v1 (bugfixes) al
// coronar Tickets & Features como oficial (2026-07-07). Usa los MISMOS archivos
// en ~/.cwc-data (bugfix-context.md / bugfix-pr-context.md) para no perder lo
// ya editado. Los lee el panel de contextos (system/project-context-panel).
//
// ESPEJO A TOLKIEN (2026-07-10, pedido de Niko — "blindaje"): la inyección al
// prompt del tablero SOLO cubre los chats abiertos desde el botón de un ticket;
// una sesión abierta de otra forma (launcher / TUI / reanudada) sobre ~/tolkien
// NUNCA veía estos contextos. Para que TODA sesión de Tolkien los tenga sí o sí,
// al guardar espejamos el SUBSET de trabajo (work + pr) como TEXTO FÍSICO dentro
// de una sección gestionada de ~/tolkien/CLAUDE.local.md — un archivo LOCAL, ya
// excluido del repo (.git/info/exclude), que Claude Code AUTO-CARGA en cada
// sesión de ese repo (chat, TUI, launcher, reanudada). No es una referencia
// ("andá a leer allá") que dependa de que el modelo obedezca: es el texto real.
// El master (fuente de verdad, con TODO) sigue viviendo en ~/.cwc-data; a Tolkien
// solo baja lo necesario para trabajar tickets/features/PR. Un verificador
// (verifySync) avisa si el espejo quedó desincronizado en vez de fallar callado.
import fss from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { writeFileAtomic } from '../../core/atomic-write.js';
import { config } from '../../core/config.js';
import { findForeignRefsForTolkien, replaceForeignRefsForTolkien } from '../../core/pad-world-refs.js';
import { systemScopeFor } from '../../core/system-scope.js';
import { hostUser } from '../../core/user-space.js';
import { listUsers } from '../../core/users.js';

export { findForeignRefsForTolkien } from '../../core/pad-world-refs.js';

const CONTEXT_FILENAMES = {
  work: 'bugfix-context.md',
  pr: 'bugfix-pr-context.md',
};

function hostScope() {
  return systemScopeFor({ type: 'token', admin: true });
}

// Función pura: no toca disco ni congela rutas al importar el módulo.
// Host conserva EXACTAMENTE sus ubicaciones históricas; cada inquilino guarda
// los masters bajo su dataDir privado y espeja dentro de SU clon de Tolkien.
export function contextPathsFor(scope = hostScope(), kind = 'work') {
  if (!CONTEXT_FILENAMES[kind]) throw new Error(`Contexto desconocido: ${kind}`);
  const projectDir = scope.isHost ? config.projectDir : path.join(scope.workspace, 'tolkien');
  return {
    storeFile: path.join(scope.dataDir, CONTEXT_FILENAMES[kind]),
    mirrorFile: path.join(projectDir, 'CLAUDE.local.md'),
    playbookFile: path.join(projectDir, '.cwc-ticket-playbook.md'),
    projectDir,
  };
}

// Marcadores de la sección que gestionamos NOSOTROS. Todo lo que Niko escribió
// a mano en CLAUDE.local.md queda FUERA de estos marcadores y no se toca jamás.
const MARK_START = '<!-- cwc:tickets-context:start -->';
const MARK_END = '<!-- cwc:tickets-context:end -->';

// PLAN-1938 + PLAN-3237: CLAUDE.local.md se auto-carga en cada sesión. El render
// garantiza este techo repartiendo las unidades de `## 6.` entre espejo, playbook
// y archivo; adoptar feedback nunca falla por espacio. Solo puede excederse si la
// parte fija (sin unidades de feedback) ya supera por sí sola el presupuesto.
export const MIRROR_BUDGET = 30000;
export const PLAYBOOK_FEEDBACK_BUDGET = 40000;
export const CONTEXT_RANK_RE = /<!-- cwc:retro-rank:(\d+) -->/;
export const CONTEXT_ARCHIVED_RE = /^<!-- cwc:retro-archived:([a-f0-9]{12}) rank=(\d+) -->$/;

// Secciones de REGLA que viajan al espejo de Tolkien. `## 6.` figura para que
// el fail-safe reconozca el heading, pero sus unidades las reparte el planificador
// global de ventanas; nunca baja como sección monolítica.
// PEND-1864: antes viajaba todo (~60k en CADA sesión de Tolkien).
const MIRROR_RULES = {
  // BUG-1927: el feedback adoptado debe llegar al archivo de auto-carga.
  work: [/gate pre-push/i, /^##\s*0\./, /^##\s*1\./, /^##\s*6\./],
  // PR ya usa "## 5." para quick reference; "## 6." queda para feedback.
  pr: [/^##\s*1\./, /^##\s*2\./, /^##\s*5\./, /^##\s*6\./],
};

const INTERNAL_REF_LABELS = {
  CONVE: 'convención interna',
  PLAN: 'plan interno',
  TASK: 'tarea interna',
  BUG: 'bug interno',
  ARQUI: 'decisión de arquitectura interna',
  DOC: 'documento interno',
  PLAYB: 'playbook interno',
  ROAD: 'hoja de ruta interna',
  PEND: 'pendiente interno',
  MC: 'lección interna de Mejora Continua',
  FEAT: 'feature interna',
  FB: 'feedback interno',
  TDA: 'decisión técnica interna',
  RDA: 'decisión interna',
  CDT: 'contexto interno',
  IDR: 'registro interno',
  AR: 'registro interno',
};
const CONTEXT_LESSON_RE = /^### 🔄 Lección de Mejora Continua \((MC-\d+)\) — (.+)$/gm;
const CONTEXT_MARKER_RE = /<!-- cwc:retro-context:([a-f0-9]{12}) -->/;
const FEEDBACK_HEADING_RE = /^##\s*6\./;

export const DEFAULT_CONTEXTS = {
  work: [
    'ANTES de tocar nada — verificación exhaustiva:',
    '1. Estado del ticket: ¿sigue abierto? ¿cambió su status? Revisá el ticket',
    '   y su hilo en Desk.',
    `2. ¿${config.instance.client.reviewer.name} (${config.instance.client.reviewer.github}) ya está trabajando en esto? Buscá`,
    '   PRs/branches/commits recientes (gh pr list --state all, git log) antes de duplicar trabajo.',
    '',
    'Proceso de resolución — mostralo explícito:',
    '- CUÁL ES EL PROBLEMA: en criollo, con la causa raíz.',
    '- QUÉ PODEMOS HACER: las opciones de arreglo.',
    '- ANTES de implementar: evaluá si es LA MEJOR solución y esperá mi OK.',
    '',
    'Trabajá SIEMPRE directamente sobre ~/tolkien, en una feature branch desde',
    'origin/main. El PR lo publica ESTA sesión — pero SOLO después del push gate',
    'acordado con vos en la conversación. Nunca merge: mergea Chris.',
  ].join('\n'),
  pr: [
    'Cómo se redactan las notas del PR (lo que lee Chris):',
    '- Formales, claras, concisas; cada afirmación verificable en el diff.',
    '- Tu ÚLTIMO mensaje del chat debe tener EXACTAMENTE este formato:',
    'Problema: <qué estaba roto y su causa raíz>',
    'Qué hice: <qué se cambió y en qué archivos>',
    'Mejor solución: <por qué es la mejor, o qué alternativa se descartó y por qué>',
  ].join('\n'),
};

export function getContext(kind = 'work', scope = hostScope()) {
  const { storeFile } = contextPathsFor(scope, kind);
  try {
    return fss.readFileSync(storeFile, 'utf8');
  } catch (err) {
    // Semilla lazy y de SOLO LECTURA: mientras el inquilino no guardó su copia,
    // ve el master vigente del host. El primer guardado materializa sus archivos
    // privados; desde ese momento quedan desacoplados de cambios futuros del host.
    if (!scope.isHost && err?.code === 'ENOENT') return getContext(kind, hostScope());
    return DEFAULT_CONTEXTS[kind];
  }
}

// ---- Espejo a Tolkien -------------------------------------------------------

export function splitTopSections(text) {
  const source = String(text ?? '');
  const lines = source.match(/[^\n]*\n|[^\n]+/g) || [];
  let preamble = '';
  const sections = [];
  let current = null;
  let inFence = false;

  for (const line of lines) {
    const isFence = line.startsWith('```');
    const isHeading = !inFence && line.startsWith('## ');
    if (isHeading) {
      current = { title: line.replace(/\r?\n$/, ''), text: '' };
      sections.push(current);
    }
    if (current) current.text += line;
    else preamble += line;
    if (isFence) inFence = !inFence;
  }

  const joined = preamble + sections.map((s) => s.text).join('');
  if (joined !== source) throw new Error('splitTopSections invariant failed');
  return { preamble, sections };
}

function sectionMatches(kind, section) {
  return (MIRROR_RULES[kind] || []).some((re) => re.test(section.title));
}

function internalRefPlaceholder(prefix) {
  return `[${INTERNAL_REF_LABELS[prefix] || 'referencia interna'}; identificador omitido]`;
}

function lessonTitlesFromContexts(contexts) {
  const titles = new Map();
  for (const context of contexts) {
    for (const match of String(context || '').matchAll(CONTEXT_LESSON_RE)) {
      const title = replaceForeignRefsForTolkien(
        match[2].replace(/[\r\n]+/g, ' ').trim(),
        (_ref, prefix) => internalRefPlaceholder(prefix),
      );
      titles.set(match[1], title);
    }
  }
  return titles;
}

// El master es interno y conserva sus refs literales. La frontera está en este
// render: un MC conocido baja como título humano y cualquier otra ref del Pad
// console conserva solo su tipo semántico. El conteo permite auditar cada sync.
function sanitizeForTolkien(text, lessonTitles) {
  let sanitizedRefs = 0;
  const rendered = replaceForeignRefsForTolkien(text, (ref, prefix) => {
    sanitizedRefs += 1;
    const title = lessonTitles.get(ref);
    return title ? `“${title}”` : internalRefPlaceholder(prefix);
  });
  return { rendered, sanitizedRefs };
}

export function parseFeedbackSection(sectionText) {
  const source = String(sectionText ?? '');
  const firstNewline = source.indexOf('\n');
  const headingEnd = firstNewline === -1 ? source.length : firstNewline + 1;
  const heading = source.slice(0, firstNewline === -1 ? source.length : firstNewline).replace(/\r$/, '');
  const starts = [];
  let offset = headingEnd;
  let inFence = false;

  for (const line of source.slice(headingEnd).match(/[^\n]*\n|[^\n]+/g) || []) {
    const bare = line.replace(/\r?\n$/, '');
    if (!inFence) {
      let kind = null;
      let key = null;
      let rank = Number(bare.match(CONTEXT_RANK_RE)?.[1] || 1);
      if (bare.startsWith('### 🔄 Lección de Mejora Continua')) {
        kind = 'full';
        key = bare.match(CONTEXT_MARKER_RE)?.[1] || null;
        const legacyId = bare.match(/\((MC-\d+)\)/)?.[1];
        if (!key && legacyId) key = crypto.createHash('sha1').update(legacyId).digest('hex').slice(0, 12);
      } else if (bare.startsWith('> ↩ **Referencia de Mejora Continua:**')) {
        kind = 'ref';
        key = bare.match(CONTEXT_MARKER_RE)?.[1] || null;
      } else {
        const archived = bare.match(CONTEXT_ARCHIVED_RE);
        if (archived) {
          kind = 'archived';
          key = archived[1];
          rank = Number(archived[2]);
        }
      }
      if (kind) starts.push({ start: offset, lineEnd: offset + line.length, kind, key, rank });
    }
    if (bare.startsWith('```')) inFence = !inFence;
    offset += line.length;
  }

  const units = starts.map((entry, order) => {
    const nextStart = starts[order + 1]?.start ?? source.length;
    const end = entry.kind === 'archived' ? entry.lineEnd : nextStart;
    return {
      key: entry.key,
      kind: entry.kind,
      rank: Number.isInteger(entry.rank) && entry.rank >= 1 ? entry.rank : 1,
      order,
      text: source.slice(entry.start, end),
      start: entry.start,
      end,
    };
  });
  const prefaceEnd = starts[0]?.start ?? source.length;
  return { heading, preface: source.slice(headingEnd, prefaceEnd), units };
}

function stripRankMarkers(text) {
  return String(text ?? '').replace(/<!-- cwc:retro-rank:\d+ -->/g, '');
}

function compareFeedbackPriority(a, b) {
  return b.unit.rank - a.unit.rank
    || b.unit.order - a.unit.order
    || a.serial - b.serial;
}

function prepareContexts(sources) {
  const prepared = {};
  for (const kind of Object.keys(CONTEXT_FILENAMES)) {
    const split = splitTopSections(sources[kind]);
    const feedbackSection = split.sections.find((section) => FEEDBACK_HEADING_RE.test(section.title)) || null;
    prepared[kind] = {
      split,
      feedbackSection,
      feedback: feedbackSection ? parseFeedbackSection(feedbackSection.text) : null,
    };
  }
  return prepared;
}

function feedbackNotice(playbookCount, archivedCount) {
  const details = [];
  if (playbookCount) details.push(`${playbookCount} más en \`.cwc-ticket-playbook.md\` (§6)`);
  if (archivedCount) {
    details.push(`${archivedCount} archivada${archivedCount === 1 ? '' : 's'}, completas en el archivo de Mejora Continua de Mi Consola`);
  }
  return `> Lecciones adoptadas más relevantes (por recurrencia).${details.length ? ` Hay ${details.join(' y ')}.` : ''}`;
}

function renderFeedbackSection(parsed, records, mode, counts) {
  const units = records.map((record) => record.unit.text.trim()).filter(Boolean);
  if (mode === 'mirror') {
    return [
      parsed.heading,
      feedbackNotice(counts.playbook, counts.archived),
      ...units,
    ].filter(Boolean).join('\n\n');
  }
  return [parsed.heading, parsed.preface.trim(), ...units].filter(Boolean).join('\n\n');
}

function splitContextForMirror(kind, source, preparedKind, selection) {
  const split = preparedKind.split;
  const ruleSections = split.sections.filter((section) => sectionMatches(kind, section));
  if (!ruleSections.length && split.sections.length) {
    console.warn(`[tickets/context-store] PEND-1864: ninguna sección de regla matcheó para ${kind}; se espeja completo.`);
    return {
      preamble: split.preamble,
      mirror: source.trim(),
      playbook: source.trim(),
      failSafe: true,
    };
  }

  const mirrorSections = [];
  const playbookSections = [];
  for (const section of split.sections) {
    if (section === preparedKind.feedbackSection) {
      const counts = {
        playbook: selection.playbook.filter((record) => record.kind === kind).length,
        archived: selection.archived.filter((record) => record.kind === kind).length,
      };
      mirrorSections.push(`${renderFeedbackSection(
        preparedKind.feedback,
        selection.mirror.filter((record) => record.kind === kind),
        'mirror',
        counts,
      )}\n`);
      playbookSections.push(`${renderFeedbackSection(
        preparedKind.feedback,
        selection.playbook.filter((record) => record.kind === kind),
        'playbook',
        counts,
      )}\n`);
    } else if (sectionMatches(kind, section)) {
      mirrorSections.push(section.text);
    } else {
      playbookSections.push(section.text);
    }
  }
  return {
    preamble: split.preamble,
    mirror: [split.preamble, ...mirrorSections].join('').trim(),
    playbook: [split.preamble, ...playbookSections].join('').trim(),
    failSafe: false,
  };
}

function playbookPointer(contextName) {
  return [
    '> **📖 Procedimiento completo (fases, checklists y lecciones registradas):**',
    '> está en `.cwc-ticket-playbook.md`, en la raíz de este repo. **Leelo ANTES de',
    `> empezar a trabajar ${contextName}** — acá arriba están solo las`,
    '> reglas que aplican siempre; el paso a paso, los checklists y las lecciones',
    '> registradas viven allá. (Archivo local, no versionado, lo genera Mi Consola.)',
  ].join('\n');
}

function renderManagedForSelection(sources, prepared, selection, lessonTitles) {
  const work = splitContextForMirror('work', sources.work, prepared.work, selection);
  const pr = splitContextForMirror('pr', sources.pr, prepared.pr, selection);
  const raw = [
    '## ⚙️ Contexto de trabajo · Tickets / Features / PR — gestionado por Mi Consola',
    '',
    '> Sección GENERADA y actualizada automáticamente desde **Mi Consola →',
    '> Sistema → Proyectos → Tickets & Features**. NO la edites a mano: se',
    '> sobrescribe cada vez que guardás en ese panel. Archivo LOCAL, NO',
    '> versionado (ya excluido en `.git/info/exclude`). La fuente completa vive',
    '> en la consola web (`~/.cwc-data`); acá bajan solo las reglas que deben',
    '> estar presentes desde el primer turno. El procedimiento completo está en',
    '> `.cwc-ticket-playbook.md` y se lee a demanda.',
    '',
    '### Cómo se trabaja un ticket/feature',
    '',
    work.mirror,
    '',
    playbookPointer('un ticket o feature'),
    '',
    '### Cómo se redacta el PR',
    '',
    pr.mirror,
    '',
    playbookPointer('un PR'),
  ].join('\n');
  const { rendered, sanitizedRefs } = sanitizeForTolkien(stripRankMarkers(raw), lessonTitles);
  return { rendered, sanitizedRefs };
}

function managedBlockForSelection(sources, prepared, selection, lessonTitles) {
  const result = renderManagedForSelection(sources, prepared, selection, lessonTitles);
  return { ...result, block: `${MARK_START}\n${result.rendered}\n${MARK_END}` };
}

function selectPlaybookWindow(records) {
  const playbook = [];
  let bytes = 0;
  for (const record of records) {
    if (bytes + record.bytes > PLAYBOOK_FEEDBACK_BUDGET) break;
    playbook.push(record);
    bytes += record.bytes;
  }
  return { playbook, archived: records.slice(playbook.length), bytes };
}

function createContextWindowPlan(overrides = {}, scope = hostScope(), warn = true) {
  const sources = {
    work: overrides.work ?? getContext('work', scope),
    pr: overrides.pr ?? getContext('pr', scope),
  };
  const prepared = prepareContexts(sources);
  const lessonTitles = lessonTitlesFromContexts(Object.values(sources));
  let serial = 0;
  const candidates = [];
  const alreadyArchived = [];
  for (const kind of Object.keys(CONTEXT_FILENAMES)) {
    for (const unit of prepared[kind].feedback?.units || []) {
      const record = { kind, unit, serial: serial++ };
      if (unit.kind === 'archived') {
        alreadyArchived.push(record);
      } else {
        const rendered = sanitizeForTolkien(stripRankMarkers(unit.text).trim(), lessonTitles).rendered;
        candidates.push({ ...record, bytes: Buffer.byteLength(rendered, 'utf8') });
      }
    }
  }
  candidates.sort(compareFeedbackPriority);
  alreadyArchived.sort(compareFeedbackPriority);

  const selectionForMirror = (mirror) => {
    const secondary = selectPlaybookWindow(candidates.slice(mirror.length));
    return {
      mirror,
      playbook: secondary.playbook,
      archived: [...secondary.archived, ...alreadyArchived].sort(compareFeedbackPriority),
      playbookFeedbackBytes: secondary.bytes,
    };
  };

  let selection = selectionForMirror([]);
  const fixedResult = managedBlockForSelection(sources, prepared, selection, lessonTitles);
  const fixedBytes = Buffer.byteLength(fixedResult.block, 'utf8');
  const fixedOverBudget = fixedBytes > MIRROR_BUDGET;
  const mirror = [];
  let estimatedBytes = fixedBytes;
  if (!fixedOverBudget) {
    for (const record of candidates) {
      const renderedCost = record.bytes + 2; // separador `\n\n` delante de cada unidad
      if (estimatedBytes + renderedCost > MIRROR_BUDGET) break;
      mirror.push(record);
      estimatedBytes += renderedCost;
    }
  }

  selection = selectionForMirror(mirror);
  let managedResult = managedBlockForSelection(sources, prepared, selection, lessonTitles);
  let mirrorBytes = Buffer.byteLength(managedResult.block, 'utf8');
  while (mirrorBytes > MIRROR_BUDGET && mirror.length) {
    mirror.pop();
    selection = selectionForMirror(mirror);
    managedResult = managedBlockForSelection(sources, prepared, selection, lessonTitles);
    mirrorBytes = Buffer.byteLength(managedResult.block, 'utf8');
  }
  if (fixedOverBudget && warn) {
    console.warn(`[tickets/context-store] PLAN-3237: la parte fija del espejo pesa ${fixedBytes} B y supera el presupuesto de ${MIRROR_BUDGET} B; ## 6 no aporta unidades.`);
  }

  return {
    sources,
    prepared,
    lessonTitles,
    selection,
    managedResult,
    mirrorBytes,
    fixedOverBudget,
    playbookFeedbackBytes: selection.playbookFeedbackBytes,
  };
}

function publicWindowPlan(plan) {
  const byKind = {};
  for (const kind of Object.keys(CONTEXT_FILENAMES)) {
    byKind[kind] = {
      mirror: plan.selection.mirror.filter((record) => record.kind === kind).map((record) => record.unit.key),
      playbook: plan.selection.playbook.filter((record) => record.kind === kind).map((record) => record.unit.key),
      archived: plan.selection.archived.filter((record) => record.kind === kind).map((record) => record.unit.key),
    };
  }
  return {
    ...byKind,
    mirrorBytes: plan.mirrorBytes,
    playbookFeedbackBytes: plan.playbookFeedbackBytes,
    fixedOverBudget: plan.fixedOverBudget,
  };
}

export function planContextWindows(overrides = {}, scope = hostScope()) {
  return publicWindowPlan(createContextWindowPlan(overrides, scope));
}

function renderManagedSectionResult(overrides = {}, scope = hostScope()) {
  return createContextWindowPlan(overrides, scope).managedResult;
}

export function renderManagedSection(overrides = {}, scope = hostScope()) {
  return renderManagedSectionResult(overrides, scope).rendered;
}

function renderPlaybookForPlan(plan) {
  const work = splitContextForMirror('work', plan.sources.work, plan.prepared.work, plan.selection);
  const pr = splitContextForMirror('pr', plan.sources.pr, plan.prepared.pr, plan.selection);
  const raw = [
    '# Playbook local de tickets/features/PR — generado por Mi Consola',
    '',
    '> Archivo GENERADO automáticamente. NO lo edites a mano: se regenera al',
    '> guardar el contexto en Mi Consola. Archivo local, NO versionado. La fuente',
    '> de verdad son los contextos editables en ⚙ Sistema → Proyectos.',
    '',
    '## Cómo se trabaja un ticket/feature — referencia',
    '',
    work.playbook || work.preamble.trim(),
    '',
    '## Cómo se redacta el PR — referencia',
    '',
    pr.playbook || pr.preamble.trim(),
  ].join('\n');
  return sanitizeForTolkien(stripRankMarkers(raw), plan.lessonTitles).rendered;
}

export function renderPlaybook(scope = hostScope()) {
  return renderPlaybookForPlan(createContextWindowPlan({}, scope));
}

// Bloque completo con marcadores (lo que buscamos/reemplazamos en el archivo).
function managedBlockResult(overrides = {}, scope = hostScope()) {
  return createContextWindowPlan(overrides, scope).managedResult;
}

// PLAN-3237: el render por ventanas garantiza el presupuesto; adoptar feedback
// nunca falla por espacio y el master conserva todas las unidades.
export function measureMirrorBytes(overrides = {}, scope = hostScope()) {
  return createContextWindowPlan(overrides, scope).mirrorBytes;
}

function ensureGitExclude(projectDir) {
  try {
    const exclude = path.join(projectDir, '.git', 'info', 'exclude');
    let text = '';
    try { text = fss.readFileSync(exclude, 'utf8'); } catch { text = ''; }
    const line = '.cwc-ticket-playbook.md';
    if (text.split(/\r?\n/).includes(line)) return false;
    const next = `${text}${text.endsWith('\n') ? '' : '\n'}${line}\n`;
    fss.mkdirSync(path.dirname(exclude), { recursive: true, mode: 0o700 });
    fss.writeFileSync(exclude, next, { mode: 0o644 });
    return true;
  } catch (err) {
    console.warn(`[tickets/context-store] No se pudo actualizar .git/info/exclude: ${err?.message || String(err)}`);
    return false;
  }
}

function writePlaybook(scope, playbookFile) {
  const next = `${renderPlaybook(scope)}\n`;
  let existing = null;
  try { existing = fss.readFileSync(playbookFile, 'utf8'); } catch { /* no existe aún */ }
  if (existing === next) return { ok: true, changed: false };
  writeFileAtomic(playbookFile, next, { mode: 0o644 });
  return { ok: true, changed: true };
}

// Clasifica sin escribir: un clon sin masters propios es semilla y puede
// regenerarse desde el fallback de getContext(); uno con cualquier master es
// dueño de su contexto y el fan-out del host no debe tocarlo.
export function classifyTenantsForFanout() {
  const host = hostUser();
  return listUsers().filter((user) => user?.username && user.username !== host).map((user) => {
    const id = user.username;
    const scope = systemScopeFor({ type: 'session', username: id, admin: !!user.admin });
    const projectDir = path.join(scope.workspace, 'tolkien');
    let kind = 'seed';
    if (!fss.existsSync(projectDir) || !fss.existsSync(path.join(projectDir, '.git'))) {
      kind = 'no-clone';
    } else if (
      fss.existsSync(contextPathsFor(scope, 'work').storeFile)
      || fss.existsSync(contextPathsFor(scope, 'pr').storeFile)
    ) {
      kind = 'own';
    }
    return { user, kind, scope };
  });
}

// Después del espejo host, genera el espejo de cada inquilino semilla desde su
// scope. Cada usuario es best-effort: clones ausentes y contextos propios no se
// tocan, y ningún fallo cambia el resultado exitoso del espejo host.
function syncSeedTenants() {
  const summary = { reached: 0, skippedOwn: 0, failed: [] };
  let tenants;
  try {
    tenants = classifyTenantsForFanout();
  } catch (err) {
    const reason = err?.message || String(err);
    summary.failed.push({ user: '*', reason });
    console.warn(`[tickets/context-store] No se pudieron clasificar los inquilinos para el espejo: ${reason}`);
    return summary;
  }

  for (const { user, kind, scope } of tenants) {
    const id = user.username;
    if (kind === 'no-clone') continue;
    if (kind === 'own') {
      summary.skippedOwn += 1;
      continue;
    }
    try {
      const result = syncToTolkien(scope);
      if (!result.ok) {
        const reason = result.reason || 'sync-fallido';
        summary.failed.push({ user: id, reason });
        console.warn(`[tickets/context-store] No se pudo generar el espejo del inquilino ${id}: ${reason}`);
        continue;
      }
      if (result.skipped) continue;
      summary.reached += 1;
    } catch (err) {
      const reason = err?.message || String(err);
      summary.failed.push({ user: id, reason });
      console.warn(`[tickets/context-store] No se pudo generar el espejo del inquilino ${id}: ${reason}`);
    }
  }
  return summary;
}

// Reemplaza (o inserta al final) el bloque gestionado en CLAUDE.local.md,
// preservando byte a byte todo lo que esté fuera de los marcadores. Devuelve
// { ok, reason?, created?, tenantSync? }. best-effort: si Tolkien no existe,
// no rompe el guardado del master — el verificador lo reportará como
// 'unavailable'. En el scope host, el fan-out a inquilinos ocurre DESPUÉS de
// completar este espejo y tampoco puede volverlo fallido.
export function syncToTolkien(scope = hostScope()) {
  try {
    const {
      mirrorFile, playbookFile, projectDir,
    } = contextPathsFor(scope);
    // El onboarding puede no haber clonado Tolkien todavía. Para inquilinos no
    // creamos el repo ni directorios en su nombre: el master ya quedó guardado
    // y el espejo se intentará de nuevo cuando el clon exista.
    if (!scope.isHost && !fss.existsSync(projectDir)) {
      return { ok: true, skipped: true, reason: 'tolkien-ausente' };
    }
    const { block, sanitizedRefs } = managedBlockResult({}, scope);
    const foreignRefs = findForeignRefsForTolkien(block);
    if (foreignRefs.length) {
      const detail = foreignRefs.map(({ ref, line }) => `  - ${ref} (línea ${line})`).join('\n');
      console.error(`[tickets/context-store] BUG-1984: espejo a Tolkien bloqueado; contiene refs foráneos:\n${detail}`);
      return { ok: false, reason: 'foreign-refs', foreignRefs, sanitizedRefs };
    }

    ensureGitExclude(projectDir);
    const playbook = writePlaybook(scope, playbookFile);
    let existing = '';
    let fileExisted = false;
    try { existing = fss.readFileSync(mirrorFile, 'utf8'); fileExisted = true; } catch { /* no existe aún */ }

    let next;
    const i = existing.indexOf(MARK_START);
    const j = existing.indexOf(MARK_END);
    if (i !== -1 && j !== -1 && j > i) {
      // Reemplazo in-place del bloque viejo (conserva lo de antes y después).
      const before = existing.slice(0, i);
      const after = existing.slice(j + MARK_END.length);
      next = `${before}${block}${after}`;
    } else if (fileExisted) {
      // Sin marcadores todavía: apéndalo al final, separado por una línea.
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      next = `${existing}${sep}${block}\n`;
    } else {
      // Archivo nuevo: cabecera mínima + el bloque.
      const owner = scope.isHost ? 'Nico' : scope.user;
      next = `# Reglas personales de ${owner} para sesiones en este repo (NO versionado)\n\n${block}\n`;
    }

    if (next === existing) {
      const tenantSync = scope.isHost ? syncSeedTenants() : null;
      return {
        ok: true,
        reason: 'sin-cambios',
        playbookChanged: playbook.changed,
        sanitizedRefs,
        ...(tenantSync ? { tenantSync } : {}),
      };
    }
    // 0o644: archivo de texto legible (el master en ~/.cwc-data queda 0o600).
    writeFileAtomic(mirrorFile, next, { mode: 0o644 });
    const tenantSync = scope.isHost ? syncSeedTenants() : null;
    return {
      ok: true,
      created: !fileExisted,
      playbookChanged: playbook.changed,
      sanitizedRefs,
      ...(tenantSync ? { tenantSync } : {}),
    };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

// Extrae el cuerpo del bloque gestionado presente HOY en CLAUDE.local.md.
function extractManaged(text) {
  const i = text.indexOf(MARK_START);
  const j = text.indexOf(MARK_END);
  if (i === -1 || j === -1 || j <= i) return null;
  return text.slice(i + MARK_START.length, j).trim();
}

// Verificador: ¿el espejo en Tolkien está al día con el master?
//   ok          — el bloque existe y coincide con lo que renderiza el master.
//   stale       — existe pero difiere (quedó viejo / editado a mano).
//   missing     — el archivo existe pero NO tiene el bloque gestionado.
//   unavailable — no se puede leer CLAUDE.local.md (Tolkien ausente, etc.).
export function verifySync(scope = hostScope()) {
  const { mirrorFile, playbookFile } = contextPathsFor(scope);
  try {
    let text = '';
    try { text = fss.readFileSync(mirrorFile, 'utf8'); }
    catch { return { status: 'unavailable', file: mirrorFile }; }
    const present = extractManaged(text);
    if (present == null) return { status: 'missing', file: mirrorFile };
    const expected = renderManagedSection({}, scope).trim();
    const mirrorBytes = Buffer.byteLength(`${MARK_START}\n${expected}\n${MARK_END}`, 'utf8');
    if (present !== expected) {
      return {
        status: 'stale',
        file: mirrorFile,
        mirrorBytes,
        mirrorBudget: MIRROR_BUDGET,
        mirrorOverBudget: mirrorBytes > MIRROR_BUDGET,
      };
    }

    const expectedPlaybook = `${renderPlaybook(scope)}\n`;
    let playbook = '';
    try { playbook = fss.readFileSync(playbookFile, 'utf8'); }
    catch {
      return {
        status: 'stale',
        file: mirrorFile,
        detail: 'playbook-missing',
        playbookStatus: 'playbook-missing',
        playbookFile,
        mirrorBytes,
        mirrorBudget: MIRROR_BUDGET,
        mirrorOverBudget: mirrorBytes > MIRROR_BUDGET,
      };
    }
    if (playbook !== expectedPlaybook) {
      return {
        status: 'stale',
        file: mirrorFile,
        detail: 'playbook-stale',
        playbookStatus: 'playbook-stale',
        playbookFile,
        mirrorBytes,
        mirrorBudget: MIRROR_BUDGET,
        mirrorOverBudget: mirrorBytes > MIRROR_BUDGET,
      };
    }
    return {
      status: 'ok',
      file: mirrorFile,
      playbookStatus: 'ok',
      playbookFile,
      mirrorBytes,
      mirrorBudget: MIRROR_BUDGET,
      mirrorOverBudget: mirrorBytes > MIRROR_BUDGET,
    };
  } catch (err) {
    return { status: 'unavailable', file: mirrorFile, reason: err?.message || String(err) };
  }
}

export function saveContext(kind, text, scope = hostScope()) {
  const { storeFile } = contextPathsFor(scope, kind);
  // Atómico (tmp+rename): editar el contexto desde el panel no puede dejar el
  // .md a medias si algo falla justo ahí (lo lee cada chat de trabajo). El master
  // conserva todo: PLAN-3237 limita las dos salidas renderizadas, no esta fuente.
  if (!scope.isHost) {
    // En el primer guardado se materializa también el hermano faltante desde el
    // host. Así work+pr quedan congelados como un par propio y cambios posteriores
    // del host no se filtran indirectamente al espejo del inquilino.
    for (const sibling of Object.keys(CONTEXT_FILENAMES)) {
      if (sibling === kind) continue;
      const siblingFile = contextPathsFor(scope, sibling).storeFile;
      if (!fss.existsSync(siblingFile)) {
        writeFileAtomic(siblingFile, getContext(sibling, hostScope()));
      }
    }
  }
  writeFileAtomic(storeFile, String(text));
  // Espejar el subset a Tolkien (best-effort: si falla, el master ya quedó
  // guardado y el verificador lo marcará desincronizado).
  syncToTolkien(scope);
}
