// modules/retro/promote-shared.js — ROUTER de PROMOCIÓN de MEJORA CONTINUA
// (ROAD-256, Fase 2). Una lección aprobada se "promueve" a un DESTINO donde
// realmente cambia el comportamiento futuro. Cada destino tiene su mecánica:
//
//   memoria   → nota mejora-continua.md en la carpeta memory/ del proyecto
//               (append; la próxima sesión la auto-carga). [Fase 1, movido acá]
//   claude-md → SECCIÓN GESTIONADA dedicada con marcadores en el CLAUDE.md del
//               proyecto (console) o en CLAUDE.local.md (tolkien, NO versionado
//               → nunca se filtra al repo del equipo). Se RENDERIZA desde el
//               conjunto de lecciones promovidas (idempotente); NUNCA toca lo
//               que está fuera de los marcadores (Reglas duras/Convenciones a
//               mano). Patrón syncToTolkien de tickets/context-store.js.
//   contexto  → Fase 3 (bugfix-work/pr + espejo Tolkien).  [pendiente]
//   playbook  → Fase 4 (colección playbooks de Pad).        [pendiente]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { writeFileAtomic } from '../../core/atomic-write.js';
import { readNote, writeNote, readIndex, writeIndex, hashOf } from '../projects/memory.js';
import { getContext, saveContext } from '../tickets/context-store.js';
import { createItem } from '../../core/pad-service-client.js';
import { listLessons } from './store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MEMORY_NOTE = 'mejora-continua.md';
const MARK_START = '<!-- cwc:mejora-continua:start -->';
const MARK_END = '<!-- cwc:mejora-continua:end -->';

// Destinos cableados. memoria+claude-md (Fase 2) · contexto (Fase 3) · playbook (Fase 4).
export const PROMOTE_TARGETS = ['memoria', 'claude-md', 'contexto', 'playbook'];
// Destinos que necesitan un directorio de proyecto (escriben al filesystem del
// repo). contexto (global, ~/.cwc-data + espejo Tolkien) y playbook (Pad) NO.
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
function renderManagedBlock(lessons) {
  const body = lessons.length
    ? lessons.map((l) => `### ${stripMarkers(l.title)}\n_${l.category} · confianza ${l.confidence} · recurrencia x${l.recurrence}_\n\n${stripMarkers(l.body)}`).join('\n\n')
    : '_(sin lecciones promovidas todavía)_';
  return `${MARK_START}\n## Mejora Continua (auto)\n<!-- Gestionado por el módulo Mejora Continua de Mi Consola (ROAD-256). NO editar a mano DENTRO de los marcadores: se regenera al promover. Lo de AFUERA (Reglas duras, Convenciones, etc.) queda intacto. -->\n\n${body}\n${MARK_END}`;
}

async function promoteToClaudeMd(project, ctx = null) {
  const file = claudeFileFor(project);
  if (!file) throw Object.assign(new Error(`El proyecto "${project}" no tiene CLAUDE.md promovible (solo console/tolkien).`), { badRequest: true });
  const { lessons } = await listLessons(ctx);
  const mine = lessons.filter((l) => l.project === project && l.promotedTo === 'claude-md' && l.status === 'promovida');
  const block = renderManagedBlock(mine);
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
function promoteToContext(lesson, kind) {
  const k = kind === 'pr' ? 'pr' : 'work';
  const cur = getContext(k) || '';
  if (cur.includes(lesson.id)) return; // ya está
  const entry = `\n\n### 🔄 Lección de Mejora Continua (${lesson.id}) — ${lesson.title}\n_${lesson.category} · confianza ${lesson.confidence}_\n\n${lesson.body}\n`;
  saveContext(k, `${cur}${entry}`);
}

// ===== Destino: PLAYBOOK de Pad (Fase 4) =====
// Crea un item DRAFT en la colección 'playbooks' del workspace console. El
// cuerpo del playbook nace de la lección; queda para que un humano lo refine y
// le ponga invocation_slug en Pad.
async function promoteToPlaybook(lesson, ctx = null) {
  const content = `> Borrador generado desde la lección de Mejora Continua ${lesson.id}. Refiná los pasos y, si aplica, asignale un invocation_slug en Pad.\n\n## Cuándo\n_${lesson.category}_\n\n## Procedimiento\n${lesson.body}`;
  const r = await createItem('playbooks', {
    title: lesson.title,
    content,
    fields: { status: 'draft', trigger: 'manual', scope: 'all' },
  }, { ctx });
  if (!r.ok) throw Object.assign(new Error(`Pad local (crear playbook): ${r.error || 'error'}`), { padError: true });
}

// Dispatcher. `lesson` ya debe estar marcada promovida (markPromoted corre
// ANTES, así claude-md la incluye al renderizar desde el conjunto).
export async function promote(project, target, lesson, opts = {}, ctx = null) {
  if (target === 'memoria') {
    const dir = projectDirFor(project);
    if (!dir) throw Object.assign(new Error(`El proyecto "${project}" no tiene memoria promovible (solo console/tolkien).`), { badRequest: true });
    promoteToMemory(dir, lesson);
  } else if (target === 'claude-md') {
    await promoteToClaudeMd(project, ctx);
  } else if (target === 'contexto') {
    promoteToContext(lesson, opts.kind);
  } else if (target === 'playbook') {
    await promoteToPlaybook(lesson, ctx);
  } else {
    throw Object.assign(new Error(`Destino "${target}" no está disponible.`), { badRequest: true });
  }
}
