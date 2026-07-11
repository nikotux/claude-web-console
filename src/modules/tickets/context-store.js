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
// Marcadores de la sección que gestionamos NOSOTROS. Todo lo que Niko escribió
// a mano en CLAUDE.local.md queda FUERA de estos marcadores y no se toca jamás.
const MARK_START = '<!-- cwc:tickets-context:start -->';
const MARK_END = '<!-- cwc:tickets-context:end -->';

export const DEFAULT_CONTEXTS = {
  work: [
    'ANTES de tocar nada — verificación exhaustiva:',
    '1. Estado del ticket: ¿sigue abierto? ¿cambió su status? Revisá el ticket',
    '   y su hilo en Desk.',
    '2. ¿Chris (cswenor) ya está trabajando en esto? Buscá PRs/branches/commits',
    '   recientes (gh pr list --state all, git log) antes de duplicar trabajo.',
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

// Cuerpo de la sección gestionada (SIN marcadores). Incluye la NOTA-en-el-
// documento para que un future-Niko que abra CLAUDE.local.md sepa qué es y no
// lo confunda con un objeto raro. Se genera desde el master (work + pr).
export function renderManagedSection() {
  const work = getContext('work');
  const pr = getContext('pr');
  return [
    '## ⚙️ Contexto de trabajo · Tickets / Features / PR — gestionado por Mi Consola',
    '',
    '> Sección GENERADA y actualizada automáticamente desde **Mi Consola →',
    '> Sistema → Proyectos → Tickets & Features**. NO la edites a mano: se',
    '> sobrescribe cada vez que guardás en ese panel. Archivo LOCAL, NO',
    '> versionado (ya excluido en `.git/info/exclude`). La fuente completa vive',
    '> en la consola web (`~/.cwc-data`); acá baja solo el subset necesario para',
    '> trabajar tickets/features/PR.',
    '',
    '### Cómo se trabaja un ticket/feature',
    '',
    work.trim(),
    '',
    '### Cómo se redacta el PR',
    '',
    pr.trim(),
  ].join('\n');
}

// Bloque completo con marcadores (lo que buscamos/reemplazamos en el archivo).
function managedBlock() {
  return `${MARK_START}\n${renderManagedSection()}\n${MARK_END}`;
}

// Reemplaza (o inserta al final) el bloque gestionado en CLAUDE.local.md,
// preservando byte a byte todo lo que esté fuera de los marcadores. Devuelve
// { ok, reason?, created? }. best-effort: si Tolkien no existe, no rompe el
// guardado del master — el verificador lo reportará como 'unavailable'.
export function syncToTolkien() {
  try {
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

    if (next === existing) return { ok: true, reason: 'sin-cambios' };
    // 0o644: archivo de texto legible (el master en ~/.cwc-data queda 0o600).
    writeFileAtomic(TOLKIEN_LOCAL_MD, next, { mode: 0o644 });
    return { ok: true, created: !fileExisted };
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
    return {
      status: present === expected ? 'ok' : 'stale',
      file: TOLKIEN_LOCAL_MD,
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
  // completa. OJO: renderManagedSection espeja los manuales ENTEROS a Tolkien, así
  // que lo que crezca acá crece en cada sesión de Tolkien — mantenerlos densos.
  writeFileAtomic(CONTEXT_FILES[kind], String(text).slice(0, 60000));
  // Espejar el subset a Tolkien (best-effort: si falla, el master ya quedó
  // guardado y el verificador lo marcará desincronizado).
  syncToTolkien();
}
