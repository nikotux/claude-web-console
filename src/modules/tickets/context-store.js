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
import path from 'node:path';
import { writeFileAtomic } from '../../core/atomic-write.js';
import { config } from '../../core/config.js';
import { findForeignRefsForTolkien, replaceForeignRefsForTolkien } from '../../core/pad-world-refs.js';
import { systemScopeFor } from '../../core/system-scope.js';

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

// PLAN-1938: presupuesto de peso del espejo (techo de CONVE-1942). Lo que baja a
// CLAUDE.local.md AUTO-CARGA en CADA sesión de Tolkien: engordar acá es gratis para
// quien escribe y caro para todos los que leen. No cambia comportamiento — avisa
// (log al sincronizar + campos en verifySync) para que el engorde silencioso sea
// imposible. `retro/promote-shared.js` reutiliza esta constante y mide el espejo
// candidato ANTES de escribir `## 6.`; si no entra, rota texto viejo a referencias
// o falla ruidosamente. 30 kB deja margen sobre los ~28 kB medidos tras la poda.
export const MIRROR_BUDGET = 30000;

// Secciones que viajan SIEMPRE al espejo de Tolkien (REGLA: lo que una sesión
// necesita desde el primer turno). El resto — procedimiento por fases,
// checklists y lecciones — va al playbook que se lee a demanda.
// PEND-1864: antes viajaba todo (~60k en CADA sesión de Tolkien).
// PLAN-1938: las reglas se verificaron y quedan IGUAL — la clasificación por sección
// ya era correcta; el peso salió del maestro (poda de `## 6.`), no de las reglas.
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

function splitContextForMirror(kind, text, scope = hostScope()) {
  const source = text ?? getContext(kind, scope);
  const split = splitTopSections(source);
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

  const referenceSections = split.sections.filter((section) => !sectionMatches(kind, section));
  return {
    preamble: split.preamble,
    mirror: [split.preamble, ...ruleSections.map((s) => s.text)].join('').trim(),
    playbook: [split.preamble, ...referenceSections.map((s) => s.text)].join('').trim(),
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

// Cuerpo de la sección gestionada (SIN marcadores). Incluye la NOTA-en-el-
// documento para que un future-Niko que abra CLAUDE.local.md sepa qué es y no
// lo confunda con un objeto raro. Se genera desde el master (work + pr), pero
// baja solo REGLA; el procedimiento largo queda en .cwc-ticket-playbook.md.
function renderManagedSectionResult(overrides = {}, scope = hostScope()) {
  const sources = {
    work: overrides.work ?? getContext('work', scope),
    pr: overrides.pr ?? getContext('pr', scope),
  };
  const work = splitContextForMirror('work', sources.work, scope);
  const pr = splitContextForMirror('pr', sources.pr, scope);
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
  const { rendered, sanitizedRefs } = sanitizeForTolkien(
    raw,
    lessonTitlesFromContexts(Object.values(sources)),
  );
  return { rendered, sanitizedRefs };
}

export function renderManagedSection(overrides = {}, scope = hostScope()) {
  return renderManagedSectionResult(overrides, scope).rendered;
}

export function renderPlaybook(scope = hostScope()) {
  const work = splitContextForMirror('work', undefined, scope);
  const pr = splitContextForMirror('pr', undefined, scope);
  return [
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
}

// Bloque completo con marcadores (lo que buscamos/reemplazamos en el archivo).
function managedBlockResult(overrides = {}, scope = hostScope()) {
  const { rendered, sanitizedRefs } = renderManagedSectionResult(overrides, scope);
  return {
    block: `${MARK_START}\n${rendered}\n${MARK_END}`,
    sanitizedRefs,
  };
}

function managedBlock(overrides = {}, scope = hostScope()) {
  return managedBlockResult(overrides, scope).block;
}

// El escritor de `## 6. Feedback adoptado` usa esta misma medición ANTES de
// guardar. Así el presupuesto no depende de un warning posterior al sync ni
// duplica el número en otro módulo.
export function measureMirrorBytes(overrides = {}, scope = hostScope()) {
  return Buffer.byteLength(managedBlock(overrides, scope), 'utf8');
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

// Reemplaza (o inserta al final) el bloque gestionado en CLAUDE.local.md,
// preservando byte a byte todo lo que esté fuera de los marcadores. Devuelve
// { ok, reason?, created? }. best-effort: si Tolkien no existe, no rompe el
// guardado del master — el verificador lo reportará como 'unavailable'.
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

    const mirrorBytes = Buffer.byteLength(block, 'utf8');
    if (mirrorBytes > MIRROR_BUDGET) {
      console.warn(`[tickets/context-store] PLAN-1938: el espejo a Tolkien pesa ${mirrorBytes} B y supera el presupuesto de ${MIRROR_BUDGET} B; podá el maestro (probablemente "## 6. Feedback adoptado").`);
    }
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
      return {
        ok: true,
        reason: 'sin-cambios',
        playbookChanged: playbook.changed,
        sanitizedRefs,
      };
    }
    // 0o644: archivo de texto legible (el master en ~/.cwc-data queda 0o600).
    writeFileAtomic(mirrorFile, next, { mode: 0o644 });
    return {
      ok: true,
      created: !fileExisted,
      playbookChanged: playbook.changed,
      sanitizedRefs,
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
    const mirrorBytes = Buffer.byteLength(expected, 'utf8');
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
  // .md a medias si algo falla justo ahí (lo lee cada chat de trabajo).
  // Cap generoso (2026-07-10): antes 20.000 — el manual `work` v3.0 (6 fases +
  // lecciones L1/L2 + reglas de reunión) no entra en 20k y se truncaba silencioso
  // (cortó la Lección L1 a mitad de palabra). 60k da margen para la metodología
  // completa. OJO: PEND-1864 separa REGLA (CLAUDE.local.md) de REFERENCIA
  // (.cwc-ticket-playbook.md) para no auto-cargar el procedimiento largo en
  // cada sesión de Tolkien.
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
  writeFileAtomic(storeFile, String(text).slice(0, 60000));
  // Espejar el subset a Tolkien (best-effort: si falla, el master ya quedó
  // guardado y el verificador lo marcará desincronizado).
  syncToTolkien(scope);
}
