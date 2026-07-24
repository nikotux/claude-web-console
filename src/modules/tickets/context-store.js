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
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../core/atomic-write.js';
import { config } from '../../core/config.js';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const CONTEXT_FILES = {
  work: path.join(DATA_DIR, 'bugfix-context.md'),
  pr: path.join(DATA_DIR, 'bugfix-pr-context.md'),
};

// Archivo LOCAL de Tolkien que auto-carga en toda sesión (no versionado).
const TOLKIEN_LOCAL_MD = path.join(config.projectDir, 'CLAUDE.local.md');
// Playbook LOCAL de Tolkien: procedimiento largo, no auto-cargado; se lee a demanda.
const TOLKIEN_PLAYBOOK_MD = path.join(config.projectDir, '.cwc-ticket-playbook.md');
// Marcadores de la sección que gestionamos NOSOTROS. Todo lo que Niko escribió
// a mano en CLAUDE.local.md queda FUERA de estos marcadores y no se toca jamás.
const MARK_START = '<!-- cwc:tickets-context:start -->';
const MARK_END = '<!-- cwc:tickets-context:end -->';

// Secciones que viajan SIEMPRE al espejo de Tolkien (REGLA: lo que una sesión
// necesita desde el primer turno). El resto — procedimiento por fases,
// checklists y lecciones — va al playbook que se lee a demanda.
// PEND-1864: antes viajaba todo (~60k en CADA sesión de Tolkien).
const MIRROR_RULES = {
  work: [/gate pre-push/i, /^##\s*0\./, /^##\s*1\./],
  pr: [/^##\s*1\./, /^##\s*2\./, /^##\s*5\./],
};

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

export function getContext(kind = 'work') {
  try { return fss.readFileSync(CONTEXT_FILES[kind], 'utf8'); } catch { return DEFAULT_CONTEXTS[kind]; }
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

function splitContextForMirror(kind) {
  const text = getContext(kind);
  const split = splitTopSections(text);
  const ruleSections = split.sections.filter((section) => sectionMatches(kind, section));
  if (!ruleSections.length && split.sections.length) {
    console.warn(`[tickets/context-store] PEND-1864: ninguna sección de regla matcheó para ${kind}; se espeja completo.`);
    return {
      preamble: split.preamble,
      mirror: text.trim(),
      playbook: text.trim(),
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
export function renderManagedSection() {
  const work = splitContextForMirror('work');
  const pr = splitContextForMirror('pr');
  return [
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
}

export function renderPlaybook() {
  const work = splitContextForMirror('work');
  const pr = splitContextForMirror('pr');
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
function managedBlock() {
  return `${MARK_START}\n${renderManagedSection()}\n${MARK_END}`;
}

function ensureGitExclude() {
  try {
    const exclude = path.join(config.projectDir, '.git', 'info', 'exclude');
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

function writePlaybook() {
  const next = `${renderPlaybook()}\n`;
  let existing = null;
  try { existing = fss.readFileSync(TOLKIEN_PLAYBOOK_MD, 'utf8'); } catch { /* no existe aún */ }
  if (existing === next) return { ok: true, changed: false };
  writeFileAtomic(TOLKIEN_PLAYBOOK_MD, next, { mode: 0o644 });
  return { ok: true, changed: true };
}

// Reemplaza (o inserta al final) el bloque gestionado en CLAUDE.local.md,
// preservando byte a byte todo lo que esté fuera de los marcadores. Devuelve
// { ok, reason?, created? }. best-effort: si Tolkien no existe, no rompe el
// guardado del master — el verificador lo reportará como 'unavailable'.
export function syncToTolkien() {
  try {
    ensureGitExclude();
    const playbook = writePlaybook();
    let existing = '';
    let fileExisted = false;
    try { existing = fss.readFileSync(TOLKIEN_LOCAL_MD, 'utf8'); fileExisted = true; } catch { /* no existe aún */ }

    const block = managedBlock();
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
      next = `# Reglas personales de Nico para sesiones en este repo (NO versionado)\n\n${block}\n`;
    }

    if (next === existing) return { ok: true, reason: 'sin-cambios', playbookChanged: playbook.changed };
    // 0o644: archivo de texto legible (el master en ~/.cwc-data queda 0o600).
    writeFileAtomic(TOLKIEN_LOCAL_MD, next, { mode: 0o644 });
    return { ok: true, created: !fileExisted, playbookChanged: playbook.changed };
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
export function verifySync() {
  try {
    let text = '';
    try { text = fss.readFileSync(TOLKIEN_LOCAL_MD, 'utf8'); }
    catch { return { status: 'unavailable', file: TOLKIEN_LOCAL_MD }; }
    const present = extractManaged(text);
    if (present == null) return { status: 'missing', file: TOLKIEN_LOCAL_MD };
    const expected = renderManagedSection().trim();
    if (present !== expected) return { status: 'stale', file: TOLKIEN_LOCAL_MD };

    const expectedPlaybook = `${renderPlaybook()}\n`;
    let playbook = '';
    try { playbook = fss.readFileSync(TOLKIEN_PLAYBOOK_MD, 'utf8'); }
    catch {
      return {
        status: 'stale',
        file: TOLKIEN_LOCAL_MD,
        detail: 'playbook-missing',
        playbookStatus: 'playbook-missing',
        playbookFile: TOLKIEN_PLAYBOOK_MD,
      };
    }
    if (playbook !== expectedPlaybook) {
      return {
        status: 'stale',
        file: TOLKIEN_LOCAL_MD,
        detail: 'playbook-stale',
        playbookStatus: 'playbook-stale',
        playbookFile: TOLKIEN_PLAYBOOK_MD,
      };
    }
    return {
      status: 'ok',
      file: TOLKIEN_LOCAL_MD,
      playbookStatus: 'ok',
      playbookFile: TOLKIEN_PLAYBOOK_MD,
    };
  } catch (err) {
    return { status: 'unavailable', file: TOLKIEN_LOCAL_MD, reason: err?.message || String(err) };
  }
}

export function saveContext(kind, text) {
  if (!CONTEXT_FILES[kind]) throw new Error(`Contexto desconocido: ${kind}`);
  // Atómico (tmp+rename): editar el contexto desde el panel no puede dejar el
  // .md a medias si algo falla justo ahí (lo lee cada chat de trabajo).
  // Cap generoso (2026-07-10): antes 20.000 — el manual `work` v3.0 (6 fases +
  // lecciones L1/L2 + reglas de reunión) no entra en 20k y se truncaba silencioso
  // (cortó la Lección L1 a mitad de palabra). 60k da margen para la metodología
  // completa. OJO: PEND-1864 separa REGLA (CLAUDE.local.md) de REFERENCIA
  // (.cwc-ticket-playbook.md) para no auto-cargar el procedimiento largo en
  // cada sesión de Tolkien.
  writeFileAtomic(CONTEXT_FILES[kind], String(text).slice(0, 60000));
  // Espejar el subset a Tolkien (best-effort: si falla, el master ya quedó
  // guardado y el verificador lo marcará desincronizado).
  syncToTolkien();
}
