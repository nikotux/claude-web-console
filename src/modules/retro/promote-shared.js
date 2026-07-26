// modules/retro/promote-shared.js — ROUTER de PROMOCIÓN de MEJORA CONTINUA
// (ROAD-256, Fase 2). Una lección aprobada se "promueve" a un DESTINO donde
// realmente cambia el comportamiento futuro. Cada destino tiene su mecánica:
//
//   memoria   → nota mejora-continua.md en la carpeta memory/ del proyecto
//               (append; la próxima sesión la auto-carga). [Fase 1, movido acá]
//   claude-md → para console queda en Pad y se consulta desde el índice
//               enrutador; para tolkien se mantiene CLAUDE.local.md (NO
//               versionado → nunca se filtra al repo del equipo). Se RENDERIZA desde el
//               conjunto de lecciones promovidas (idempotente); NUNCA toca lo
//               que está fuera de los marcadores (Reglas duras/Convenciones a
//               mano). Patrón syncToTolkien de tickets/context-store.js.
//   contexto  → Tolkien: bugfix-work/pr + espejo con presupuesto; console/otros:
//               queda canónica en Pad y no cruza al mundo externo.
//   convencion→ regla activa en la colección conventions de Pad.
//   contrato  → fila de obligación en un contrato de Pad (CONVE-1969 por
//               defecto) + su check en el registro que lee `emitTasks()`. Desde
//               ahí la lección se verifica sola, con 0 tokens: el emisor abre un
//               PEND al incumplirse y lo CIERRA SOLO al cumplirse. [PLAN-1936]
//   invariante→ `appendLearnedInvariant({match,text})`: el auditor de Salud lo
//               inyecta y verifica SÍ O SÍ en cada escaneo de la unidad que
//               matchea el glob. El glob sale del campo declarado
//               `**Archivos:**` del cuerpo de la lección (o el explícito de
//               quien promueve); si falta, el destino NO se ofrece — fallar
//               cerrado es preferible a inventar un patrón. Límite honesto:
//               ese auditor solo audita Mi Consola. [PLAN-1936]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { writeFileAtomic } from '../../core/atomic-write.js';
import { findForeignRefsForTolkien, replaceForeignRefsForTolkien } from '../../core/pad-world-refs.js';
import { readNote, writeNote, readIndex, writeIndex, hashOf } from '../projects/memory.js';
import {
  getContext,
  saveContext,
  splitTopSections,
  measureMirrorBytes,
  renderManagedSection,
  MIRROR_BUDGET,
} from '../tickets/context-store.js';
import { createItem, addLink, getItem, listItems, listLinks, updateItem } from '../../core/pad-service-client.js';
import { appendLessonContract } from '../../core/pad-contracts.js';
import { appendLearnedInvariant } from '../health/invariants.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MEMORY_NOTE = 'mejora-continua.md';
export const MARK_START = '<!-- cwc:mejora-continua:start -->';
export const MARK_END = '<!-- cwc:mejora-continua:end -->';

// CONVE-1257 del Pad / regla dura 11: todo ítem nace enlazado a su sol.
// Este guard existe porque los soles ARQUI-* de BUG-1878 solo viven en `console`.
function padSunApplies(ctx) {
  const ws = ctx && ctx.workspace;
  return !ws || ws === 'console';
}

// Destinos cableados. memoria+claude-md (Fase 2) · contexto (Fase 3) ·
// convencion (regla activa en Pad) · contrato+invariante (PLAN-1936: destinos
// VERIFICABLES, la lección deja de ser texto que el modelo puede ignorar).
export const PROMOTE_TARGETS = ['memoria', 'claude-md', 'contexto', 'convencion', 'contrato', 'invariante'];
// Compatibilidad de LECTURA: hay lecciones históricas selladas con estos
// destinos. No se ofrecen ni pasan el gate de escritura de una promoción nueva.
export const LEGACY_PROMOTE_TARGETS = ['playbook', 'registro'];
// Destinos que necesitan un directorio de proyecto (escriben al filesystem del
// repo). contexto decide por mundo y convencion escribe en Pad; ninguno necesita dir.
export const TARGETS_NEED_DIR = ['memoria', 'claude-md'];

// console → la raíz de este repo; tolkien → config.projectDir; otros → sin memoria.
export function projectDirFor(project) {
  if (project === 'console') return ROOT;
  if (project === 'tolkien') return config.projectDir;
  return null;
}

// Archivo de CLAUDE.md destino por proyecto. Para Tolkien apuntamos a
// CLAUDE.local.md (NO versionado, igual que el espejo de tickets-context) para
// no meter lecciones auto en el CLAUDE.md que ve el equipo. Para la consola es
// su propio CLAUDE.md (repo de Nico, que él commitea revisando).
function claudeFileFor(project) {
  const dir = projectDirFor(project);
  if (!dir) return null;
  return project === 'tolkien' ? path.join(dir, 'CLAUDE.local.md') : path.join(dir, 'CLAUDE.md');
}

// ===== Destino: MEMORIA (append a la nota + índice) =====
function promoteToMemory(projectDir, l) {
  let cur = '';
  try { cur = readNote(projectDir, MEMORY_NOTE); } catch { cur = ''; }
  if (cur.includes(`(${l.id})`)) return; // idempotente: ya promovida a esta nota (evita duplicar al escalar)
  const header = cur ? '' : '# Mejora Continua — lecciones de proceso promovidas\n\n> Promovidas desde el módulo Mejora Continua de Mi Consola (ROAD-256). Cada una cambió cómo trabajamos; la próxima sesión las lee acá.\n';
  const stamp = new Date().toISOString().slice(0, 10);
  const entry = `\n## ${l.title} (${l.id})\n_${l.category} · confianza ${l.confidence} · recurrencia x${l.recurrence} · ${stamp}_\n\n${l.body}\n`;
  writeNote(projectDir, MEMORY_NOTE, `${cur || header}${entry}`, cur ? hashOf(cur) : undefined);
  const idx = readIndex(projectDir);
  if (!idx.includes(MEMORY_NOTE)) {
    const line = `- [Mejora Continua](${MEMORY_NOTE}) — lecciones de proceso promovidas por el módulo Mejora Continua (ROAD-256)`;
    writeIndex(projectDir, idx ? `${idx}\n${line}` : `# Memorias\n\n${line}`, idx ? hashOf(idx) : undefined);
  }
}

// ===== Destino: CLAUDE.md (sección gestionada, render desde el conjunto) =====
// Neutraliza cualquier aparición de los marcadores DENTRO del texto de una
// lección (p.ej. un transcript que incluía el comentario HTML): si no, el
// próximo indexOf(MARK_END) encontraría el marcador inyectado y truncaría mal
// el bloque, corrompiendo el CLAUDE.md.
function stripMarkers(s) {
  return String(s || '').split(MARK_START).join('cwc:mc:start').split(MARK_END).join('cwc:mc:end');
}

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

function internalRefPlaceholder(prefix) {
  return `[${INTERNAL_REF_LABELS[prefix] || 'referencia interna'}; identificador omitido]`;
}

// Las lecciones pueden citar legítimamente refs de su mundo de origen. El
// destino Tolkien necesita la lección, no el identificador interno: cuando
// conocemos un MC lo sustituimos por su título; para los demás preservamos el
// tipo semántico y omitimos el id. Se sanea también dentro de fences: un bloque
// de código sigue siendo contenido que cruza la frontera.
function sanitizeLessonForTolkien(text, lessonTitles) {
  return replaceForeignRefsForTolkien(stripMarkers(text), (ref, prefix) => {
    const title = lessonTitles.get(ref);
    if (title) return `“${stripMarkers(title)}”`;
    return internalRefPlaceholder(prefix);
  });
}

export function renderManagedBlock(lessons, allLessons = lessons) {
  const lessonTitles = new Map(
    allLessons.map((lesson) => {
      const title = String(lesson.title || '').replace(/[\r\n]+/g, ' ').trim();
      const safeTitle = replaceForeignRefsForTolkien(stripMarkers(title), (_ref, prefix) => internalRefPlaceholder(prefix));
      return [lesson.id, safeTitle];
    }),
  );
  const body = lessons.length
    ? lessons.map((l) => `### ${sanitizeLessonForTolkien(l.title, lessonTitles)}\n_${l.category} · confianza ${l.confidence} · recurrencia x${l.recurrence}_\n\n${sanitizeLessonForTolkien(l.body, lessonTitles)}`).join('\n\n')
    : '_(sin lecciones promovidas todavía)_';
  return `${MARK_START}\n## Mejora Continua (auto)\n<!-- Gestionado por el módulo Mejora Continua de Mi Consola. NO editar a mano DENTRO de los marcadores: se regenera al promover. Lo de AFUERA (Reglas duras, Convenciones, etc.) queda intacto. -->\n\n${body}\n${MARK_END}`;
}

async function promoteToClaudeMd(project, ctx = null) {
  // En console ya no espejamos las lecciones al CLAUDE.md: la entrada
  // "Si vas a cerrar trabajo" del índice enrutador las trae desde Pad por tarea.
  // Tolkien conserva su espejo externo en CLAUDE.local.md.
  if (project === 'console') return;
  const file = claudeFileFor(project);
  if (!file) throw Object.assign(new Error(`El proyecto "${project}" no tiene CLAUDE.md promovible (solo console/tolkien).`), { badRequest: true });
  // Import diferido para que store.js pueda derivar sus enums de los destinos
  // exportados por este módulo sin crear un ciclo de inicialización ESM.
  const { listLessons } = await import('./store.js');
  const { lessons } = await listLessons(ctx);
  const mine = lessons.filter((l) => l.project === project && l.promotedTo === 'claude-md' && l.status === 'promovida');
  const block = renderManagedBlock(mine, lessons);
  const foreignRefs = findForeignRefsForTolkien(block);
  if (foreignRefs.length) {
    const detail = foreignRefs.map(({ ref, line }) => `  - ${ref} (línea ${line})`).join('\n');
    const message = `BUG-1984: promoción a Tolkien bloqueada; el bloque cwc:mejora-continua contiene refs foráneos:\n${detail}`;
    console.error(`[retro/promote-shared] ${message}`);
    throw Object.assign(new Error(message), {
      badRequest: true,
      reason: 'foreign-refs',
      foreignRefs,
    });
  }
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = ''; }
  const i = existing.indexOf(MARK_START);
  const j = existing.indexOf(MARK_END);
  let next;
  if (i !== -1 && j !== -1 && j > i) {
    // Reemplazo IN-PLACE del bloque (preserva byte a byte todo lo de afuera).
    next = `${existing.slice(0, i)}${block}${existing.slice(j + MARK_END.length)}`;
  } else if (existing) {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    next = `${existing}${sep}${block}\n`;
  } else {
    next = `# ${project === 'tolkien' ? 'Reglas personales para sesiones en este repo (NO versionado)' : 'Contexto del proyecto'}\n\n${block}\n`;
  }
  if (next === existing) return;
  writeFileAtomic(file, next, { mode: 0o644 }); // atómico: CLAUDE.md/.local.md que lee Claude Code
}

// ===== Destino: CONTEXTO de trabajo (Fase 3, + espejo Tolkien) =====
// Apéndala al contexto 'work' o 'pr' (bugfix-work/pr), que se inyecta en los
// chats de ticket/PR y se ESPEJA a la CLAUDE.local.md de Tolkien vía saveContext
// (syncToTolkien adentro). Idempotente por id (no re-apendea la misma lección).
const FEEDBACK_CONTEXT_HEADING = '## 6. Feedback adoptado';
const CONTEXT_ENTRY_PREFIX = '### 🔄 Lección de Mejora Continua';
const LEGACY_CONTEXT_ENTRY_RE = /^### 🔄 Lección de Mejora Continua \((MC-\d+)\) — (.+)$/gm;
const CONTEXT_MARKER_RE = /<!-- cwc:retro-context:([a-f0-9]{12}) -->/;

function contextMarkerFor(lessonId) {
  const key = crypto.createHash('sha1').update(String(lessonId || '')).digest('hex').slice(0, 12);
  return `<!-- cwc:retro-context:${key} -->`;
}

function contextContainsLesson(text, lessonId) {
  return String(text || '').includes(String(lessonId || ''))
    || String(text || '').includes(contextMarkerFor(lessonId));
}

// El destino `contexto` cruza mundos solo para Tolkien. Console y `otros`
// permanecen en la lección canónica de Pad, que el índice interno trae por
// tarea; copiarlas al master global volvería a inyectarlas en el mundo externo.
export function contextRouteForProject(project) {
  if (project === 'tolkien') return 'tolkien-mirror';
  if (project === 'console' || project === 'otros') return 'internal-pad';
  throw Object.assign(
    new Error(`la lección debe declarar project "tolkien", "console" u "otros"; recibió "${project || '(vacío)'}". Corregí el project antes de promover`),
    { badRequest: true, reason: 'context-project-unknown' },
  );
}

// BUG-1927: crear la sección no alcanza. El splitter corta cada "## " fuera de
// fences, y un fence impar puede ocultar todos los encabezados posteriores.
export function sanitizeContextEntry(title, body) {
  const safeTitle = String(title || '').replace(/[\r\n]+/g, ' ');
  let safeBody = String(body || '').replace(/^## /gm, '### ');
  const fenceCount = safeBody.split('\n').filter((line) => line.startsWith('```')).length;
  if (fenceCount % 2 !== 0) safeBody = `${safeBody}${safeBody.endsWith('\n') ? '' : '\n'}\`\`\``;
  return { title: safeTitle, body: safeBody };
}

function lessonTitlesFromFeedback(text) {
  const titles = new Map();
  for (const match of String(text || '').matchAll(LEGACY_CONTEXT_ENTRY_RE)) {
    titles.set(match[1], match[2].replace(/\s*<!-- cwc:retro-context:[a-f0-9]{12} -->\s*$/, '').trim());
  }
  return titles;
}

// Entradas históricas anteriores al guard llevan refs console literales. Al
// tocar la sección, las vuelve aptas para Tolkien: el título conserva la
// referencia humana y un hash estable conserva la idempotencia sin filtrar el
// identificador interno.
function sanitizeFeedbackRefs(text, lessonTitles) {
  const withMarkers = String(text || '').replace(
    LEGACY_CONTEXT_ENTRY_RE,
    (_whole, id, title) => `${CONTEXT_ENTRY_PREFIX} — ${title} ${contextMarkerFor(id)}`,
  );
  return replaceForeignRefsForTolkien(withMarkers, (ref, prefix) => {
    const title = lessonTitles.get(ref);
    if (title) return `“${title}”`;
    return internalRefPlaceholder(prefix);
  });
}

function contextEntryFor(lesson, lessonTitles) {
  const safe = sanitizeContextEntry(lesson.title, lesson.body);
  const title = sanitizeLessonForTolkien(safe.title, lessonTitles);
  const body = sanitizeLessonForTolkien(safe.body, lessonTitles);
  return `${CONTEXT_ENTRY_PREFIX} — ${title} ${contextMarkerFor(lesson.id)}\n_${lesson.category} · confianza ${lesson.confidence}_\n\n${body}`;
}

function contextEntryRanges(text) {
  const source = String(text || '');
  const lines = source.match(/[^\n]*\n|[^\n]+/g) || [];
  const starts = [];
  let offset = 0;
  let inFence = false;
  for (const line of lines) {
    if (!inFence && line.startsWith(CONTEXT_ENTRY_PREFIX)) starts.push(offset);
    if (line.startsWith('```')) inFence = !inFence;
    offset += line.length;
  }
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? source.length,
    text: source.slice(start, starts[index + 1] ?? source.length),
  }));
}

function rotateOldestContextEntry(sectionText, protectedMarker) {
  const oldest = contextEntryRanges(sectionText)
    .find((range) => !range.text.includes(protectedMarker));
  if (!oldest) return null;
  const heading = oldest.text.split(/\r?\n/, 1)[0];
  const title = heading
    .slice(CONTEXT_ENTRY_PREFIX.length)
    .replace(/^\s*(?:\([^)]*\)\s*)?—\s*/, '')
    .replace(/\s*<!-- cwc:retro-context:[a-f0-9]{12} -->\s*$/, '')
    .trim();
  const marker = oldest.text.match(CONTEXT_MARKER_RE)?.[0] || '';
  const reference = `> ↩ **Referencia de Mejora Continua:** “${title}”. Texto canónico en Pad; contenido omitido por presupuesto.${marker ? ` ${marker}` : ''}\n\n`;
  return `${sectionText.slice(0, oldest.start)}${reference}${sectionText.slice(oldest.end)}`;
}

function promoteToContext(lesson, kind) {
  const route = contextRouteForProject(lesson?.project);
  if (route === 'internal-pad') return { route, rotated: 0 };

  const k = kind === 'pr' ? 'pr' : 'work';
  const cur = getContext(k) || '';
  if (contextContainsLesson(cur, lesson.id)) return { route, rotated: 0 }; // ya está

  const split = splitTopSections(cur);
  let section = split.sections.find((s) => s.title === FEEDBACK_CONTEXT_HEADING);
  const oldSectionText = section?.text || '';
  const lessonTitles = lessonTitlesFromFeedback(oldSectionText);
  lessonTitles.set(lesson.id, String(lesson.title || '').replace(/[\r\n]+/g, ' ').trim());
  const entry = contextEntryFor(lesson, lessonTitles);
  const protectedMarker = contextMarkerFor(lesson.id);

  if (section) {
    section.text = sanitizeFeedbackRefs(section.text, lessonTitles);
    const sep = section.text.endsWith('\n\n') ? '' : (section.text.endsWith('\n') ? '\n' : '\n\n');
    section.text = `${section.text}${sep}${entry}\n`;
  } else {
    // BUG-1927: sección propia y espejable. Usamos 6 porque el contexto PR ya
    // reserva "## 5." para su quick reference.
    section = { title: FEEDBACK_CONTEXT_HEADING, text: `${FEEDBACK_CONTEXT_HEADING}\n\n${entry}\n` };
    split.sections.push(section);
  }

  let next = split.preamble + split.sections.map((s) => s.text).join('');
  let projectedBytes = measureMirrorBytes({ [k]: next });
  let rotated = 0;
  while (projectedBytes > MIRROR_BUDGET) {
    const compacted = rotateOldestContextEntry(section.text, protectedMarker);
    if (!compacted) {
      throw Object.assign(
        new Error(`No se puede adoptar ${lesson.id} como contexto: aun rotando todas las entradas anteriores, el espejo pesaría ${projectedBytes} B y supera el presupuesto de ${MIRROR_BUDGET} B. Acortá la lección o reducí el contexto fijo antes de reintentar.`),
        { badRequest: true, reason: 'context-mirror-budget', mirrorBytes: projectedBytes, mirrorBudget: MIRROR_BUDGET },
      );
    }
    section.text = compacted;
    rotated += 1;
    next = split.preamble + split.sections.map((s) => s.text).join('');
    projectedBytes = measureMirrorBytes({ [k]: next });
  }

  const foreignRefs = findForeignRefsForTolkien(renderManagedSection({ [k]: next }));
  if (foreignRefs.length) {
    throw Object.assign(
      new Error('No se puede adoptar como contexto: el espejo candidato todavía contiene referencias internas. Corregí el contexto base antes de reintentar.'),
      { badRequest: true, reason: 'foreign-refs', foreignRefs },
    );
  }
  saveContext(k, next);
  if (rotated) {
    console.warn(`[retro/promote-shared] presupuesto de contexto: se rotaron ${rotated} entrada(s) antigua(s) a referencias; espejo candidato ${projectedBytes}/${MIRROR_BUDGET} B.`);
  }
  return { route, rotated, mirrorBytes: projectedBytes };
}

// ===== Destino: CONVENCIÓN activa de Pad =====
export const CONVENTION_TRIGGER_BY_CATEGORY = {
  regla: 'always',
  convencion: 'always',
  metodologia: 'on-plan',
  procedimiento: 'on-implement',
  herramienta: 'on-implement',
  'feedback-cliente': 'on-pr-create',
  nota: 'on-implement',
};

async function promoteToConvention(lesson, ctx = null) {
  const content = `${lesson.body}\n\n---\n> Promovida desde la lección ${lesson.id} de Mejora Continua.`;
  const listed = await listItems('conventions', { ctx });
  if (!listed.ok) throw Object.assign(new Error(`Pad local (listar convenciones): ${listed.error || 'error'}`), { padError: true });
  const existing = listed.data.find((item) => item.title === lesson.title);
  let item;
  if (existing) {
    const updated = await updateItem(existing.ref, { content }, { ctx });
    if (!updated.ok) throw Object.assign(new Error(`Pad local (actualizar convención): ${updated.error || 'error'}`), { padError: true });
    item = updated.data || { ...existing, content };
  } else {
    const created = await createItem('conventions', {
      title: lesson.title,
      content,
      fields: {
        status: 'active',
        scope: 'all',
        priority: 'should',
        trigger: CONVENTION_TRIGGER_BY_CATEGORY[lesson.category] || CONVENTION_TRIGGER_BY_CATEGORY.nota,
      },
    }, { ctx });
    if (!created.ok) throw Object.assign(new Error(`Pad local (crear convención): ${created.error || 'error'}`), { padError: true });
    item = created.data;
  }
  try {
    if (!padSunApplies(ctx)) return item;
    const linksR = await listLinks(item.ref, { ctx });
    const links = linksR?.ok && Array.isArray(linksR.data) ? linksR.data : [];
    const alreadyLinked = links.some((link) => {
      if (link?.link_type !== 'implements') return false;
      if (link.source_ref && link.source_ref !== item.ref) return false;
      return (link.target_ref || link.target?.ref || link.target_item?.ref) === lesson.id;
    });
    if (alreadyLinked) return item;
    const linkR = await addLink(item.ref, lesson.id, 'implements', { ctx });
    if (!linkR?.ok) console.error('[retro] no pude enlazar la convención a su lección:', linkR?.error || linkR);
  } catch (err) {
    console.error('[retro] no pude enlazar la convención a su lección:', err?.message || err);
  }
  return item;
}

// ===== Destino: CONTRATO verificable (PLAN-1936) =====
// El contrato-hogar por defecto de las lecciones adoptadas como obligación.
// Existe a mano en Pad (parent PLAN-1936) para que su jerarquía y sus links
// cumplan la regla dura 11 sin que el código tenga que fabricar ítems.
export const LESSONS_CONTRACT_REF = 'CONVE-1969';
export const LESSONS_CONTRACT_TITLE = '📚 CONTRATO · Lecciones de Mejora Continua adoptadas como obligación verificable';
const CONTRACT_REF_RE = /^CONVE-\d+$/;

// Campos DECLARADOS en el cuerpo de la lección. No se infieren del texto libre:
// un dato deducido de la prosa hace que la obligación no pueda fallar nunca
// (trampa del trigger circular, PLAN-1955). Si el campo falta, falla cerrado.
const DECLARED_FILES_RE = /^\s*\*\*Archivos:\*\*\s*(.+?)\s*$/m;
const DECLARED_CONTRACT_RE = /^\s*\*\*Contrato:\*\*\s*(CONVE-\d+)\s*$/m;

// Id del check = segundo segmento del marcador `cwc-contract`: SIN barras ni
// espacios, o `markerFor()` no lo puede parsear de vuelta. Se deriva del ref
// (MC-412 → leccion412) para que sea estable aunque el título se reescriba.
export function contractCheckIdFor(lesson) {
  const n = String(lesson?.id || '').match(/^MC-(\d+)$/)?.[1];
  if (!n) throw Object.assign(new Error('La lección no tiene un ref MC-n válido.'), { badRequest: true });
  return `leccion${n}`;
}

// Contrato destino: el explícito de quien promueve, el declarado en el cuerpo
// de la lección, o el contrato-hogar. Los tres son DECLARACIONES, no inferencias.
export function contractRefFor(lesson, explicit) {
  const asked = String(explicit || '').trim();
  if (CONTRACT_REF_RE.test(asked)) return asked;
  const declared = String(lesson?.body || '').match(DECLARED_CONTRACT_RE)?.[1];
  return declared || LESSONS_CONTRACT_REF;
}

// Glob del invariante: el explícito, o el declarado como `**Archivos:** <glob>`
// en el cuerpo. `null` = la lección NO calza con este destino y no se fuerza.
export function invariantMatchFor(lesson, explicit) {
  const asked = String(explicit || '').trim();
  if (asked) return asked;
  const declared = String(lesson?.body || '').match(DECLARED_FILES_RE)?.[1]?.trim();
  return declared || null;
}

function inlineCell(value) {
  return String(value || '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

// Inserta la fila NUMERADA al final de la tabla de obligaciones, sin tocar nada
// más del contrato. La fila-placeholder del contrato recién nacido se retira al
// entrar la primera obligación real.
function withContractRow(content, cells) {
  const lines = String(content || '').split('\n');
  const separator = lines.findIndex((line) => /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line.trim()));
  if (separator === -1) {
    throw Object.assign(new Error('El contrato destino no tiene tabla de obligaciones; no se escribió nada.'), { badRequest: true });
  }
  let last = separator;
  let filled = 0;
  while (last + 1 < lines.length && lines[last + 1].trim().startsWith('|')) {
    last += 1;
    if (!lines[last].includes('(las filas las agrega el destino')) filled += 1;
  }
  const row = `| ${filled + 1} | ${cells.obligation} | \`${cells.check}\` | ${cells.lesson} |`;
  const next = [...lines.slice(0, last + 1), row, ...lines.slice(last + 1)];
  return next.filter((line) => !line.includes('(las filas las agrega el destino')).join('\n');
}

async function promoteToContract(lesson, opts = {}, ctx = null) {
  const contractRef = contractRefFor(lesson, opts.contract);
  const check = contractCheckIdFor(lesson);
  const obligation = inlineCell(opts.obligation || lesson.title);
  if (!obligation) throw Object.assign(new Error('La lección no tiene título: no hay obligación que escribir.'), { badRequest: true });

  const read = await getItem(contractRef, { ctx });
  if (!read.ok) throw Object.assign(new Error(`Pad local (leer contrato ${contractRef}): ${read.error || 'error'}`), { padError: true });
  const content = String(read.data?.content || '');

  // El registro va PRIMERO porque valida la regla: una regla inválida tira ANTES
  // de escribir en Pad. Si después falla la escritura de la fila, el check queda
  // vivo igual y `contractRow()` sintetiza su fila desde la obligación — degrada
  // sin dejar el contrato a medias.
  appendLessonContract({
    lesson: lesson.id,
    check,
    contract: contractRef,
    obligation,
    rule: opts.rule ?? null,
    profile: opts.profile,
  });

  // Idempotente: la fila ya está si el contrato menciona su slug Y su lección.
  if (content.includes(`\`${check}\``) && content.includes(lesson.id)) return { contract: contractRef, check, rowAdded: false };
  const write = await updateItem(contractRef, {
    content: withContractRow(content, { obligation, check, lesson: lesson.id }),
  }, { ctx });
  if (!write.ok) throw Object.assign(new Error(`Pad local (fila de obligación en ${contractRef}): ${write.error || 'error'}`), { padError: true });
  return { contract: contractRef, check, rowAdded: true };
}

// ===== Destino: INVARIANTE del auditor de Salud (PLAN-1936) =====
// Texto del invariante que el auditor inyecta en CADA escaneo de la unidad que
// matchea. Se acota a 400 caracteres A PROPÓSITO como defensa en profundidad:
// el texto entra en el prompt del auditor y un invariante es una regla, no un
// volcado. Se queda con la LECCIÓN accionable y descarta la observación
// anecdótica. BUG-1977 corrigió la dedup en el almacén; este límite ya no es
// necesario para que una promoción repetida sea idempotente.
const INVARIANT_TEXT_MAX = 400;
function invariantTextFor(lesson) {
  const title = String(lesson?.title || '').replace(/\s+/g, ' ').trim();
  const raw = String(lesson?.body || '');
  // El cuerpo canónico es "**Observación:** … \n\n**Lección:** …" (store.js).
  // La parte que sirve como regla es la Lección; la Observación es el caso que
  // la originó y no aporta a la verificación.
  const rule = raw.split(/\*\*Lección:\*\*/)[1] || raw;
  const body = rule.replace(/\*\*(Observación|Lección):\*\*/g, '').replace(/\s+/g, ' ').trim();
  const prefix = `[${lesson.id}] ${title}`;
  if (!body) return prefix.slice(0, INVARIANT_TEXT_MAX);
  const full = `${prefix} — ${body}`;
  if (full.length <= INVARIANT_TEXT_MAX) return full;
  return `${full.slice(0, INVARIANT_TEXT_MAX - 1).trimEnd()}…`;
}

function promoteToInvariant(lesson, opts = {}) {
  // El auditor de Salud solo audita Mi Consola: un invariante nacido de una
  // lección de otro mundo no se verificaría NUNCA, y un lazo que no cierra es
  // peor que no tener ninguno.
  const blocked = targetBlockReason('invariante', lesson, opts.match);
  if (blocked) throw Object.assign(new Error(`No se puede adoptar como invariante: ${blocked}`), { badRequest: true });
  const match = invariantMatchFor(lesson, opts.match);
  appendLearnedInvariant({ match, text: invariantTextFor(lesson) });
  return { match };
}

// Destinos que SOLO valen en Mi Consola: el auditor de Salud, que es quien
// inyecta y verifica los invariantes, no audita el mundo externo.
export const TARGETS_NEED_CONSOLE = ['invariante'];

// Por qué un destino NO calza con una lección (o `null` si calza). Fuente ÚNICA
// de la aplicabilidad: la usan la ruta de promoción (gate del backend) y el
// tablero (para ofrecer solo lo aplicable). Una lección que no es traducible al
// destino NO se fuerza — se queda en los destinos de texto y se dice por qué.
// `explicitMatch` es el glob que pasa quien promueve: sin él, la aplicabilidad
// que ve el tablero se calcula SOLO con lo declarado en el cuerpo (que es lo
// correcto para OFRECER el destino), pero el gate de la promoción sí tiene que
// contarlo — si no, el `match` que forwardea la ruta es código muerto.
export function targetBlockReason(target, lesson, explicitMatch = null) {
  if (!PROMOTE_TARGETS.includes(target)) return `el destino "${target}" no está disponible`;
  if (target === 'contexto') {
    try { contextRouteForProject(lesson?.project); }
    catch (err) { return err?.message || 'el project de la lección no permite decidir su mundo'; }
  }
  if (TARGETS_NEED_DIR.includes(target) && !projectDirFor(lesson?.project)) {
    return `el proyecto "${lesson?.project}" no tiene carpeta propia (solo console/tolkien)`;
  }
  if (TARGETS_NEED_CONSOLE.includes(target) && lesson?.project !== 'console') {
    return 'el auditor de Salud solo audita Mi Consola, así que fuera de `console` el invariante no se verificaría nunca';
  }
  if (target === 'invariante' && !invariantMatchFor(lesson, explicitMatch)) {
    return 'la lección no declara `**Archivos:** <glob>` en su cuerpo: sin patrón de archivos el auditor no sabría dónde inyectarla';
  }
  return null;
}

export function applicableTargetsFor(lesson) {
  return PROMOTE_TARGETS.filter((target) => !targetBlockReason(target, lesson));
}

// Dispatcher. `lesson` ya debe estar marcada promovida (markPromoted corre
// ANTES, así claude-md la incluye al renderizar desde el conjunto). `opts`
// admite kind (contexto), match (invariante) y contract (ref CONVE explícito).
export async function promote(project, target, lesson, opts = {}, ctx = null) {
  if (target === 'memoria') {
    const dir = projectDirFor(project);
    if (!dir) throw Object.assign(new Error(`El proyecto "${project}" no tiene memoria promovible (solo console/tolkien).`), { badRequest: true });
    promoteToMemory(dir, lesson);
  } else if (target === 'claude-md') {
    await promoteToClaudeMd(project, ctx);
  } else if (target === 'contexto') {
    promoteToContext(lesson, opts.kind);
  } else if (target === 'convencion') {
    await promoteToConvention(lesson, ctx);
  } else if (target === 'contrato') {
    await promoteToContract(lesson, opts, ctx);
  } else if (target === 'invariante') {
    promoteToInvariant(lesson, opts);
  } else {
    throw Object.assign(new Error(`Destino "${target}" no está disponible.`), { badRequest: true });
  }
}
