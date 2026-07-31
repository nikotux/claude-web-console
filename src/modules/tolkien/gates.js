// Este archivo es la fuente ÚNICA de los gates de autorización del módulo tolkien.
// isHostAdmin protege las 6 rutas de infraestructura (refresh de datos y entornos
// efímeros) porque isAdmin NO implica ser el host. El módulo visado/ importa esta
// MISMA función para no duplicar la condición.
import { isAdmin } from '../../core/auth.js';
import { systemScopeFor } from '../../core/system-scope.js';

export function isHostAdmin(req) {
  try {
    return isAdmin(req) && systemScopeFor(req).isHost;
  } catch {
    return false;
  }
}

export const HOST_ONLY_MSG = 'Esta operación es del anfitrión de la consola.';
