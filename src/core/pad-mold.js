// core/pad-mold.js — molde declarativo y versionado de los workspaces Pad
// tenant-*. Los schemas son strings crudos congelados desde la DB de `console`:
// no parsearlos ni re-serializarlos antes de enviarlos a la API (DOC-633).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { writeJsonAtomic } from './atomic-write.js';

export const MOLD_VERSION = 5;

// `prefix` es parte del contrato: forma el ref visible de cada ítem (PEND-387).
export const MOLD = [
  {
    slug: 'pendientes',
    name: 'Pendientes',
    icon: '📋',
    prefix: 'PEND',
    schema: "{\"fields\":[{\"key\":\"status\",\"label\":\"Status\",\"type\":\"select\",\"options\":[\"pendiente\",\"en-progreso\",\"hecha\"],\"terminal_options\":[\"hecha\"],\"default\":\"pendiente\",\"required\":true},{\"key\":\"priority\",\"label\":\"Priority\",\"type\":\"select\",\"options\":[\"alta\",\"media\",\"baja\"],\"default\":\"media\"},{\"key\":\"type\",\"label\":\"Type\",\"type\":\"select\",\"options\":[\"task\",\"idea\",\"nota\",\"feature\"],\"default\":\"task\"},{\"key\":\"owner\",\"label\":\"Owner\",\"type\":\"text\"},{\"key\":\"estimate\",\"label\":\"Estimate\",\"type\":\"text\"},{\"key\":\"dueDate\",\"label\":\"Due date\",\"type\":\"text\"},{\"key\":\"source\",\"label\":\"Source\",\"type\":\"text\"},{\"key\":\"sourceRef\",\"label\":\"Source ref\",\"type\":\"text\"},{\"key\":\"doneAt\",\"label\":\"Completada (ts)\",\"type\":\"text\"},{\"key\":\"decision_log\",\"label\":\"Decisiones registradas\",\"type\":\"json\"},{\"key\":\"implementation_notes\",\"label\":\"Notas de implementación\",\"type\":\"json\"},{\"key\":\"phase\",\"label\":\"Phase\",\"type\":\"text\"},{\"key\":\"model\",\"label\":\"Modelo Claude propuesto\",\"type\":\"select\",\"options\":[\"haiku\",\"sonnet\",\"opus\",\"fable\"]},{\"key\":\"effort\",\"label\":\"Esfuerzo propuesto\",\"type\":\"select\",\"options\":[\"low\",\"medium\",\"high\",\"xhigh\",\"max\"]},{\"key\":\"executor\",\"label\":\"Ejecutor propuesto (Tándem)\",\"type\":\"select\",\"options\":[\"claude\",\"tandem\",\"codex\"]}]}",
  },
  {
    slug: 'planes',
    name: 'Planes',
    icon: '🗂️',
    prefix: 'PLAN',
    schema: "{\"fields\":[{\"key\":\"status\",\"label\":\"Status\",\"type\":\"select\",\"options\":[\"active\",\"proposed\",\"done\",\"cancelled\"],\"terminal_options\":[\"done\",\"cancelled\"],\"default\":\"active\",\"required\":true},{\"key\":\"priority\",\"label\":\"Prioridad\",\"type\":\"select\",\"options\":[\"alta\",\"media\",\"baja\"],\"default\":\"media\"},{\"key\":\"owner\",\"label\":\"Owner\",\"type\":\"text\"},{\"key\":\"phase\",\"label\":\"Phase\",\"type\":\"text\"},{\"key\":\"targetDate\",\"label\":\"Target date\",\"type\":\"text\"},{\"key\":\"decision_log\",\"label\":\"Decisiones registradas\",\"type\":\"json\"},{\"key\":\"implementation_notes\",\"label\":\"Notas de implementación\",\"type\":\"json\"}]}",
  },
  {
    slug: 'temas-de-aprendizaje',
    name: 'Temas de aprendizaje',
    icon: '🎓',
    prefix: 'TDA',
    schema: "{\"fields\":[{\"key\":\"status\",\"label\":\"Status\",\"type\":\"select\",\"options\":[\"por-aprender\",\"reforzando\",\"dominado\"],\"terminal_options\":[\"dominado\"],\"default\":\"por-aprender\",\"required\":true},{\"key\":\"priority\",\"label\":\"Priority\",\"type\":\"select\",\"options\":[\"alta\",\"media\",\"baja\"],\"default\":\"media\"},{\"key\":\"area\",\"label\":\"Area\",\"type\":\"text\"},{\"key\":\"scope\",\"label\":\"Scope\",\"type\":\"select\",\"options\":[\"console\",\"tolkien\"],\"default\":\"console\"},{\"key\":\"question\",\"label\":\"Question\",\"type\":\"text\"},{\"key\":\"source\",\"label\":\"Source\",\"type\":\"text\"},{\"key\":\"contextoEntradas\",\"label\":\"Contexto adicional (entradas)\",\"type\":\"json\"},{\"key\":\"explanation\",\"label\":\"Explicación guiada (texto + metadata)\",\"type\":\"json\"}]}",
  },
  {
    slug: 'rutas-de-aprendizaje',
    name: 'Rutas de aprendizaje',
    icon: '🗺️',
    prefix: 'RDA',
    schema: "{\"fields\":[{\"key\":\"status\",\"label\":\"Status\",\"type\":\"select\",\"options\":[\"activa\",\"propuesta\",\"completada\",\"archivada\"],\"terminal_options\":[\"completada\",\"archivada\"],\"default\":\"activa\",\"required\":true}]}",
  },
  {
    slug: 'mejora-continua',
    name: 'Mejora Continua',
    icon: '🔄',
    prefix: 'MC',
    schema: "{\"fields\":[{\"key\":\"status\",\"label\":\"Status\",\"type\":\"select\",\"options\":[\"propuesta\",\"aprobada\",\"promovida\",\"descartada\"],\"terminal_options\":[\"promovida\",\"descartada\"],\"default\":\"propuesta\",\"required\":true},{\"key\":\"category\",\"label\":\"Categoría\",\"type\":\"select\",\"options\":[\"regla\",\"convencion\",\"metodologia\",\"procedimiento\",\"herramienta\",\"nota\",\"feedback-cliente\"],\"default\":\"nota\"},{\"key\":\"project\",\"label\":\"Proyecto\",\"type\":\"select\",\"options\":[\"console\",\"tolkien\",\"otros\"],\"default\":\"console\"},{\"key\":\"destination\",\"label\":\"Destino sugerido\",\"type\":\"select\",\"options\":[\"memoria\",\"claude-md\",\"contexto\",\"convencion\",\"playbook\",\"registro\",\"contrato\",\"invariante\"],\"default\":\"registro\"},{\"key\":\"recurrence\",\"label\":\"Recurrencia\",\"type\":\"text\",\"default\":\"1\"},{\"key\":\"confidence\",\"label\":\"Confianza\",\"type\":\"select\",\"options\":[\"alta\",\"media\",\"baja\"],\"default\":\"media\"},{\"key\":\"fingerprint\",\"label\":\"Fingerprint\",\"type\":\"text\"},{\"key\":\"sourceChats\",\"label\":\"Chats de origen\",\"type\":\"json\"},{\"key\":\"sourceRefs\",\"label\":\"Tickets/PRs vinculados (feedback)\",\"type\":\"json\"},{\"key\":\"promotedTo\",\"label\":\"Promovida a\",\"type\":\"select\",\"options\":[\"ninguno\",\"memoria\",\"claude-md\",\"contexto\",\"convencion\",\"playbook\",\"contrato\",\"invariante\"],\"default\":\"ninguno\"},{\"key\":\"promotedAt\",\"label\":\"Promovida (ts)\",\"type\":\"text\"},{\"key\":\"recurrenceAtPromotion\",\"label\":\"Recurrencia al promover\",\"type\":\"text\"}]}",
  },
  {
    slug: 'contexto-de-tickets',
    name: 'Contexto de tickets',
    icon: '🎫',
    prefix: 'CDT',
    schema: "{\"fields\":[{\"key\":\"status\",\"label\":\"Status\",\"type\":\"select\",\"options\":[\"active\",\"archived\"],\"terminal_options\":[\"archived\"],\"default\":\"active\",\"required\":true},{\"key\":\"ticketKey\",\"label\":\"Ticket/PR key\",\"type\":\"text\"},{\"key\":\"contexto\",\"label\":\"Contexto adicional (texto + fecha)\",\"type\":\"json\"},{\"key\":\"historico\",\"label\":\"Histórico del trabajo (entradas)\",\"type\":\"json\"}]}",
  },
  {
    slug: 'bugs',
    name: 'Bugs',
    icon: '🐛',
    prefix: 'BUG',
    schema: "{\"fields\":[{\"key\":\"status\",\"label\":\"Status\",\"type\":\"select\",\"options\":[\"open\",\"verifying\",\"fixed\",\"wontfix\"],\"terminal_options\":[\"fixed\",\"wontfix\"],\"default\":\"open\",\"required\":true},{\"key\":\"severity\",\"label\":\"Severity\",\"type\":\"select\",\"options\":[\"alta\",\"media\",\"baja\",\"cosmetico\"],\"default\":\"media\"},{\"key\":\"priority\",\"label\":\"Prioridad\",\"type\":\"select\",\"options\":[\"alta\",\"media\",\"baja\"],\"default\":\"media\"},{\"key\":\"module\",\"label\":\"Module\",\"type\":\"text\"},{\"key\":\"codex\",\"label\":\"Codex seal\",\"type\":\"select\",\"options\":[\"pending\",\"sealed\",\"na\"],\"default\":\"pending\"},{\"key\":\"decision_log\",\"label\":\"Decisiones registradas\",\"type\":\"json\"},{\"key\":\"implementation_notes\",\"label\":\"Notas de implementación\",\"type\":\"json\"}]}",
  },
  {
    slug: 'arquitectura',
    name: 'Arquitectura',
    icon: '🗺️',
    prefix: 'ARQUI',
    schema: "{\"fields\":[{\"key\":\"kind\",\"label\":\"Nivel\",\"type\":\"select\",\"options\":[\"raiz\",\"subsistema\",\"grupo\",\"modulo\",\"archivo\",\"endpoint\"],\"default\":\"modulo\",\"required\":true},{\"key\":\"status\",\"label\":\"Estado\",\"type\":\"select\",\"options\":[\"vigente\",\"retirado\"],\"terminal_options\":[\"retirado\"],\"default\":\"vigente\",\"required\":true},{\"key\":\"uid\",\"label\":\"UID estable\",\"type\":\"text\"},{\"key\":\"plano\",\"label\":\"Plano\",\"type\":\"select\",\"options\":[\"central\",\"usuario\",\"mixto\"]},{\"key\":\"audiencia\",\"label\":\"Audiencia\",\"type\":\"select\",\"options\":[\"super-admin\",\"admin\",\"usuario\",\"invitado\",\"todos\"]},{\"key\":\"perfil\",\"label\":\"Perfil\",\"type\":\"text\"},{\"key\":\"faceta_fuente\",\"label\":\"Origen de la faceta\",\"type\":\"select\",\"options\":[\"derivada\",\"heredada\",\"manual\"]}]}",
  },
  {
    slug: 'docs',
    name: 'Docs',
    icon: '📄',
    prefix: 'DOC',
    schema: "{\"fields\":[{\"key\":\"status\",\"label\":\"Status\",\"type\":\"select\",\"options\":[\"draft\",\"published\",\"archived\"],\"terminal_options\":[\"published\",\"archived\"],\"default\":\"draft\",\"required\":true},{\"key\":\"category\",\"label\":\"Category\",\"type\":\"text\"},{\"key\":\"decision_log\",\"label\":\"Decisiones registradas\",\"type\":\"json\"},{\"key\":\"implementation_notes\",\"label\":\"Notas de implementación\",\"type\":\"json\"}]}",
  },
  // NOTA (2026-07-29, console:PEND-2286): la colección `tasks` SALIÓ del molde en
  // la v5. Sus 245 ítems se fusionaron en `pendientes`, que es la colección
  // canónica de trabajo (console:CONVE-2278). Retirar una entrada del molde NO es
  // una orden de borrado retroactivo: los workspaces `tenant-*` provisionados con
  // v4 conservan su colección `tasks` intacta — verificado en bin/cwc-pad-mold.js,
  // cuyas tres funciones de comparación (missingCollections, prefixDivergences,
  // schemaDivergences) iteran MOLD y nunca `present`, así que una colección
  // presente en el tenant y ausente del molde le es invisible. No existe camino
  // de borrado en ese CLI.
];

export const MOLD_STATE_PATH = path.join(config.home, '.cwc-data', 'pad-mold-state.json');

export function readMoldState() {
  try {
    const state = JSON.parse(fs.readFileSync(MOLD_STATE_PATH, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

export function recordMoldVersion(workspaceSlug) {
  const state = readMoldState();
  state[workspaceSlug] = { version: MOLD_VERSION, ts: new Date().toISOString() };
  writeJsonAtomic(MOLD_STATE_PATH, state, { mode: 0o600, space: 2 });
  return state[workspaceSlug];
}
