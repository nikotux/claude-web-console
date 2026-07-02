// core/registry.js — monta los módulos siguiendo una interfaz estándar.
//
// PATRÓN REPETIBLE (esto es lo que replicás para agregar un módulo nuevo):
// cada módulo exporta un objeto por default con:
//   { name, registerHttp(router, ctx), registerWs(wss, ctx), init(ctx) }
// Para sumar "docker" o "logs": creá src/modules/<nombre>/index.js con esa
// misma forma y agregalo al array de abajo. Cero cambios en lo existente.
import terminal from '../modules/terminal/index.js';
import files from '../modules/files/index.js';
import stats from '../modules/stats/index.js';
import tokens from '../modules/tokens/index.js';
import tmux from '../modules/tmux/index.js';
import admin from '../modules/admin/index.js';
import tolkien from '../modules/tolkien/index.js';
import backup from '../modules/backup/index.js';
import chat from '../modules/chat/index.js';
import tickets from '../modules/tickets/index.js';
import health from '../modules/health/index.js';
import bugfixes from '../modules/bugfixes/index.js';

const MODULES = [terminal, files, stats, tokens, tmux, admin, tolkien, backup, chat, tickets, health, bugfixes];

export function registerModules({ app, apiRouter, wss, ctx }) {
  for (const mod of MODULES) {
    if (typeof mod.init === 'function') mod.init(ctx);
    if (typeof mod.registerHttp === 'function') mod.registerHttp(apiRouter, ctx);
    if (typeof mod.registerWs === 'function') mod.registerWs(wss, ctx);
    console.log(`[registry] Módulo montado: ${mod.name}`);
  }
}

export { MODULES };
