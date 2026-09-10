// profile.js — fuente única de la visibilidad por perfil en el frontend.
//
// Este recorte es de EXPERIENCIA, NO una barrera de seguridad. Ocultar o no
// montar una superficie nunca autoriza sus endpoints: los gates reales siguen
// siendo isAdmin y el ownership por usuario en el backend.

export function isSponsored(me) {
  return me?.profile === 'sponsored';
}

export const HIDDEN_FOR_SPONSORED = new Set([
  'tolkien', // ciclo de desarrollo del repo de la empresa
  'tickets', // ciclo de desarrollo del repo de la empresa
  'visado', // flujo de salas de Aduana
  'retro', // Mejora Continua del propio desarrollo
  'stats', // telemetría del host, ajena a este perfil
]);

export const HIDDEN_SYSTEM_PANELS_FOR_SPONSORED = new Set([
  'skills', // herramientas del entorno de desarrollo
  'interfono', // coordinación entre sesiones de desarrollo
]);

const EMPTY = new Set();
const PROFILE_VISIBILITY = new Map([
  ['full', {
    hiddenModules: EMPTY,
    hiddenSystemPanels: EMPTY,
  }],
  ['sponsored', {
    hiddenModules: HIDDEN_FOR_SPONSORED,
    hiddenSystemPanels: HIDDEN_SYSTEM_PANELS_FOR_SPONSORED,
  }],
]);

export function allowModule(me, name) {
  const visibility = PROFILE_VISIBILITY.get(me?.profile);
  // FAIL-OPEN deliberado: identidad ausente o perfil desconocido muestra la
  // consola completa. Esto es UX, no seguridad; un bug de carga no debe dejar
  // a nadie sin herramientas (los gates del backend sí son fail-closed).
  if (!visibility) return true;
  return !visibility.hiddenModules.has(name);
}

// Superficies que OBSERVAN contenido del host (no solo lo propio): se muestran
// únicamente a quien tenga la capacidad `oversight`. Es recorte de EXPERIENCIA,
// igual que el resto de este archivo — el gate real vive en el backend de esos
// endpoints. A diferencia de allowModule (fail-open a propósito), acá el default
// es NO mostrar: si whoami no resolvió todavía, el botón queda oculto y aparece
// cuando la identidad llega, que es lo correcto para una superficie de supervisión.
export function allowOversightSurface(me) {
  return !!me?.oversight;
}
