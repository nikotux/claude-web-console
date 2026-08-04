/**
 * Descubrimiento tolerante de configuraciones MCP.
 *
 * Los valores de `env` y `headers` viven solamente en una propiedad no enumerable
 * mientras se calcula la huella. Nunca salen en JSON, logs ni filas de SQLite: la
 * superficie normalizada expone exclusivamente sus nombres.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MATERIAL_HUELLA = Symbol('material-huella-mcp');

function canonico(valor) {
  if (Array.isArray(valor)) return valor.map(canonico);
  if (!valor || typeof valor !== 'object') return valor;
  return Object.fromEntries(
    Object.keys(valor).sort().map((clave) => [clave, canonico(valor[clave])]),
  );
}

function hash(valor) {
  return crypto.createHash('sha256').update(JSON.stringify(canonico(valor))).digest('hex');
}

function expandirInicio(ruta) {
  if (ruta === '~') return os.homedir();
  if (ruta.startsWith('~/')) return path.join(os.homedir(), ruta.slice(2));
  return ruta;
}

function claseInferida(ruta) {
  return path.basename(ruta) === '.claude.json' ? 'claude-json' : 'mcp-json';
}

function objetoPlano(valor) {
  return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
}

function normalizar(nombre, entrada, ambito) {
  const cruda = objetoPlano(entrada);
  const env = objetoPlano(cruda.env);
  const headers = objetoPlano(cruda.headers);
  const argumentos = Array.isArray(cruda.args) ? cruda.args.map((arg) => String(arg)) : [];
  const url = typeof cruda.url === 'string' && cruda.url.trim() ? cruda.url.trim() : null;
  const servidor = {
    nombre: String(nombre),
    ambito,
    transporte: url ? (cruda.type === 'sse' ? 'sse' : 'http') : 'stdio',
    comando: typeof cruda.command === 'string' && cruda.command.trim() ? cruda.command : null,
    argumentos,
    url,
    claves_env: Object.keys(env).sort(),
    cabeceras_claves: Object.keys(headers).sort(),
  };

  Object.defineProperty(servidor, MATERIAL_HUELLA, {
    enumerable: false,
    configurable: false,
    value: {
      ...servidor,
      env: canonico(env),
      headers: canonico(headers),
    },
  });
  return servidor;
}

function extraerMapa(mapa, ambito) {
  return Object.entries(objetoPlano(mapa)).map(([nombre, entrada]) => normalizar(nombre, entrada, ambito));
}

export function fuentesPorDefecto(raizTaller) {
  return [
    { ruta: path.join(os.homedir(), '.claude.json'), clase: 'claude-json' },
    { ruta: path.join(path.resolve(raizTaller), '.mcp.json'), clase: 'mcp-json' },
  ];
}

/** Una fuente defectuosa se vuelve un dato del censo; nunca corta las demas. */
export function leerFuente(ruta, clase = claseInferida(ruta)) {
  const resuelta = path.resolve(expandirInicio(String(ruta)));
  const salida = { ruta: resuelta, existe: false, legible: false, error: null, servidores: [] };
  try {
    if (!fs.existsSync(resuelta)) {
      salida.error = 'la fuente no existe';
      return salida;
    }
    salida.existe = true;
    let contenido;
    try {
      contenido = fs.readFileSync(resuelta, 'utf8');
    } catch (error) {
      salida.error = `la fuente no es legible: ${error.message}`;
      return salida;
    }

    let documento;
    try {
      documento = JSON.parse(contenido);
    } catch (error) {
      salida.error = `JSON invalido: ${error.message}`;
      return salida;
    }

    salida.legible = true;
    const ambitoRaiz = clase === 'claude-json' ? 'usuario' : 'proyecto';
    salida.servidores.push(...extraerMapa(documento?.mcpServers, ambitoRaiz));
    if (clase === 'claude-json') {
      for (const [rutaProyecto, proyecto] of Object.entries(objetoPlano(documento?.projects))) {
        salida.servidores.push(...extraerMapa(proyecto?.mcpServers, `proyecto:${rutaProyecto}`));
      }
    }
    return salida;
  } catch (error) {
    salida.error = `no se pudo leer la fuente: ${error.message}`;
    salida.legible = false;
    return salida;
  }
}

export function huellaConfig(servidor) {
  return hash(servidor?.[MATERIAL_HUELLA] ?? servidor);
}

/**
 * El conflicto se calcula despues de leer todas las fuentes: decidir un ganador
 * ocultaria precisamente la ambiguedad que el censo tiene que hacer visible.
 */
export function marcarConflictos(fuentes) {
  const porNombre = new Map();
  for (const fuente of fuentes) {
    for (const servidor of fuente.servidores) {
      const lista = porNombre.get(servidor.nombre) ?? [];
      lista.push({ servidor, huella: huellaConfig(servidor), fuente: fuente.ruta });
      porNombre.set(servidor.nombre, lista);
    }
  }
  for (const lista of porNombre.values()) {
    const conflicto = new Set(lista.map((entrada) => entrada.huella)).size > 1 &&
      new Set(lista.map((entrada) => entrada.fuente)).size > 1;
    for (const entrada of lista) entrada.servidor.conflicto = conflicto;
  }
  return fuentes;
}
