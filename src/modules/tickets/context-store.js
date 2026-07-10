// modules/tickets/context-store.js — contextos de prompt EDITABLES ('work'/'pr')
// que se inyectan en cada "Trabajar en el chat". Migrado de v1 (bugfixes) al
// coronar Tickets & Features como oficial (2026-07-07). Usa los MISMOS archivos
// en ~/.cwc-data (bugfix-context.md / bugfix-pr-context.md) para no perder lo
// ya editado. Los lee el panel de contextos (system/project-context-panel).
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../core/atomic-write.js';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const CONTEXT_FILES = {
  work: path.join(DATA_DIR, 'bugfix-context.md'),
  pr: path.join(DATA_DIR, 'bugfix-pr-context.md'),
};

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
    'Trabajá SIEMPRE directamente sobre ~/tolkien. NUNCA envíes el PR desde el',
    'chat (nada de git push / gh pr create): el PR se sube desde la consola.',
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

export function saveContext(kind, text) {
  if (!CONTEXT_FILES[kind]) throw new Error(`Contexto desconocido: ${kind}`);
  // Atómico (tmp+rename): editar el contexto desde el panel no puede dejar el
  // .md a medias si algo falla justo ahí (lo lee cada chat de trabajo).
  writeFileAtomic(CONTEXT_FILES[kind], String(text).slice(0, 20000));
}
