/**
 * Un runner arma sus MCP al arrancar y no vuelve a leer la configuracion. Si un
 * archivo o una credencial rota despues, el proceso puede seguir vivo pero usando
 * material viejo. Comparar la huella vigente con la observada en el ultimo sondeo
 * OK convierte ese fallo silencioso en una deriva explicita que pide reinicio.
 */

import crypto from 'node:crypto';

function canonico(valor) {
  if (Array.isArray(valor)) return valor.map(canonico);
  if (!valor || typeof valor !== 'object') return valor;
  return Object.fromEntries(
    Object.keys(valor).sort().map((clave) => [clave, canonico(valor[clave])]),
  );
}

export function huellaCredenciales(servidor, inventario) {
  if (!inventario || !Array.isArray(inventario.entradas)) return null;
  const buscadas = new Set([
    ...(servidor?.claves_env ?? []),
    ...(servidor?.cabeceras_claves ?? []),
  ]);
  if (!buscadas.size) return null;

  const coincidencias = inventario.entradas
    .filter((entrada) => entrada && buscadas.has(entrada.clave))
    .map((entrada) => ({
      clave: entrada.clave,
      version: entrada.version ?? entrada.version_actual ?? null,
      actualizado: entrada.actualizado ?? entrada.actualizado_en ?? null,
    }))
    .sort((a, b) => a.clave.localeCompare(b.clave, 'es'));
  if (!coincidencias.length) return null;
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonico(coincidencias)))
    .digest('hex');
}

export function derivaDe(fila, huellaConfigActual, huellaCredActual) {
  if (fila?.huella_config_al_cargar != null && fila.huella_config_al_cargar !== huellaConfigActual) {
    return 'config_rotada';
  }
  if (
    huellaCredActual != null &&
    fila?.huella_cred_al_cargar != null &&
    fila.huella_cred_al_cargar !== huellaCredActual
  ) {
    return 'credencial_rotada';
  }
  return null;
}
