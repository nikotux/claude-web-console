/**
 * modulos/mcps/src/index.js — censo y estado vivo de servidores MCP.
 *
 * BLUF: descubrir, persistir y sondear son operaciones por item. Una fuente rota o
 * un MCP colgado se convierte en estado propio y nunca corta el resto del censo.
 */

import os from 'node:os';
import path from 'node:path';
import {
  fuentesPorDefecto,
  huellaConfig,
  leerFuente,
  marcarConflictos,
} from './descubrir.js';
import { derivaDe, huellaCredenciales } from './deriva.js';
import { enPool } from './pool.js';
import { sondaHttp, sondaStdio } from './sondas.js';

const CLIENTE_INTERNO = '_interno';
const ESTADOS = ['ok', 'caido', 'timeout', 'requiere_auth', 'no_sondeado', 'desconocido'];

export class FalloDeMcps extends Error {
  constructor(codigo, mensaje, statusCode) {
    super(mensaje);
    this.name = 'FalloDeMcps';
    this.statusCode = statusCode;
    this.codigo = codigo;
  }
}

export function fallo(codigo, mensaje, statusCode = 400) {
  return new FalloDeMcps(codigo, mensaje, statusCode);
}

function entero(valor, defecto, minimo = 1) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= minimo ? numero : defecto;
}

function expandirRuta(ruta) {
  const texto = String(ruta).trim();
  if (texto === '~') return os.homedir();
  if (texto.startsWith('~/')) return path.join(os.homedir(), texto.slice(2));
  return path.resolve(texto);
}

function claseFuente(ruta) {
  return path.basename(ruta) === '.claude.json' ? 'claude-json' : 'mcp-json';
}

function idServidor(fuente, nombre) {
  return `${path.normalize(fuente)}#${String(nombre).trim()}`;
}

function jsonLista(valor) {
  if (Array.isArray(valor)) return valor;
  if (!valor) return [];
  try {
    const lista = JSON.parse(valor);
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

function metadataCredencial(entrada) {
  return {
    clave: entrada.clave,
    modulo: entrada.modulo ?? null,
    proposito: entrada.proposito ?? null,
    obligatoria: entrada.obligatoria ?? null,
    estado: entrada.estado ?? null,
    version: entrada.version ?? entrada.version_actual ?? null,
    actualizado: entrada.actualizado ?? entrada.actualizado_en ?? null,
  };
}

function credencialesDe(servidor, inventario) {
  if (!inventario?.entradas) return [];
  const claves = new Set([
    ...(servidor?.claves_env ?? []),
    ...(servidor?.cabeceras_claves ?? []),
  ]);
  return inventario.entradas
    .filter((entrada) => claves.has(entrada?.clave))
    .map(metadataCredencial);
}

function emitirSeguro(estado, nombre, carga) {
  try {
    estado.nucleo.eventos.emitir(nombre, carga);
  } catch (error) {
    estado.nucleo.log.error(`no se pudo emitir ${nombre}: ${error.message}`, { error });
  }
}

async function pedirInventario(estado) {
  try {
    const modulo = await estado.nucleo.modulos.usar('credenciales');
    if (!modulo || typeof modulo.inventario !== 'function') throw new Error('modulo no disponible');
    const inventario = await modulo.inventario();
    if (!inventario || !Array.isArray(inventario.entradas)) throw new Error('inventario sin entradas');
    estado.inventario = inventario;
    estado.credencialesDisponibles = true;
    return inventario;
  } catch (error) {
    estado.inventario = null;
    estado.credencialesDisponibles = false;
    estado.nucleo.log.warn(`inventario de credenciales no disponible: ${error.message}`);
    return null;
  }
}

function definicionesFuentes(estado) {
  const declaradas = String(estado.config.fuentes ?? '')
    .split(',')
    .map((ruta) => ruta.trim())
    .filter(Boolean);
  if (!declaradas.length) return fuentesPorDefecto(estado.raizTaller);
  return declaradas.map((ruta) => {
    const resuelta = expandirRuta(ruta);
    return { ruta: resuelta, clase: claseFuente(resuelta) };
  });
}

function actualizarTransicionesDeDeriva(estado, filas) {
  const ids = new Set(filas.map((fila) => fila.id));
  for (const id of estado.derivasPrevias.keys()) {
    if (!ids.has(id)) estado.derivasPrevias.delete(id);
  }
  for (const fila of filas) {
    const deriva = derivaDe(fila, fila.huella_config, fila.huella_cred);
    const previa = estado.derivasPrevias.get(fila.id) ?? null;
    if (deriva && deriva !== previa) {
      emitirSeguro(estado, 'mcps.credencial.rotada', {
        servidor: fila.id,
        nombre: fila.nombre,
        fuente: fila.fuente,
        deriva,
        ts: estado.nucleo.reloj.ahora(),
      });
    }
    estado.derivasPrevias.set(fila.id, deriva);
  }
}

async function refrescarDescubrimiento(estado) {
  const generado = estado.nucleo.reloj.ahora();
  const inventario = await pedirInventario(estado);
  const fuentes = marcarConflictos(definicionesFuentes(estado).map(
    ({ ruta, clase }) => leerFuente(ruta, clase),
  ));
  const actuales = new Map();
  const upsert = estado.db.prepare(`
    INSERT INTO servidores (
      id, nombre, fuente, ambito, transporte, comando, argumentos, url, claves_env,
      huella_config, huella_cred, visto_en, cliente
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      nombre = excluded.nombre,
      fuente = excluded.fuente,
      ambito = excluded.ambito,
      transporte = excluded.transporte,
      comando = excluded.comando,
      argumentos = excluded.argumentos,
      url = excluded.url,
      claves_env = excluded.claves_env,
      huella_config = excluded.huella_config,
      huella_cred = excluded.huella_cred,
      visto_en = excluded.visto_en,
      cliente = excluded.cliente
  `);

  for (const fuente of fuentes) {
    for (const descubierto of fuente.servidores) {
      const huella_config = huellaConfig(descubierto);
      // El spread descarta a proposito el material secreto no enumerable usado por la huella.
      const servidor = {
        ...descubierto,
        fuente: fuente.ruta,
        id: idServidor(fuente.ruta, descubierto.nombre),
        huella_config,
      };
      servidor.huella_cred = huellaCredenciales(servidor, inventario);
      actuales.set(servidor.id, servidor);
      upsert.run(
        servidor.id,
        servidor.nombre,
        servidor.fuente,
        servidor.ambito,
        servidor.transporte,
        servidor.comando,
        JSON.stringify(servidor.argumentos),
        servidor.url,
        JSON.stringify(servidor.claves_env),
        servidor.huella_config,
        servidor.huella_cred,
        generado,
        CLIENTE_INTERNO,
      );
    }
  }

  estado.servidoresActuales = actuales;
  estado.fuentes = fuentes.map((fuente) => ({
    ruta: fuente.ruta,
    existe: fuente.existe,
    legible: fuente.legible,
    error: fuente.error,
    servidores: fuente.servidores.length,
  }));
  estado.generado = generado;
  const filas = estado.db.prepare('SELECT * FROM servidores ORDER BY nombre, fuente').all();
  actualizarTransicionesDeDeriva(estado, filas);
  return { generado, fuentes: estado.fuentes };
}

function filaPublica(estado, fila, ahoraMs = Date.now()) {
  const actual = estado.servidoresActuales.get(fila.id);
  const servidor = {
    ...fila,
    argumentos: jsonLista(fila.argumentos),
    claves_env: jsonLista(fila.claves_env),
    cabeceras_claves: actual?.cabeceras_claves ?? [],
    conflicto: actual?.conflicto === true,
    presente: Boolean(actual),
  };
  servidor.deriva = derivaDe(fila, fila.huella_config, fila.huella_cred);
  const sondeadoMs = fila.sondeado_en ? Date.parse(fila.sondeado_en) : Number.NaN;
  servidor.rancio = !Number.isFinite(sondeadoMs) || ahoraMs - sondeadoMs > estado.config.sondeoMs;
  servidor.credenciales_disponibles = estado.credencialesDisponibles;
  return servidor;
}

function resumenDe(entradas) {
  const resumen = Object.fromEntries(ESTADOS.map((estado) => [estado, 0]));
  resumen.con_deriva = 0;
  for (const entrada of entradas) {
    const estado = ESTADOS.includes(entrada.estado) ? entrada.estado : 'desconocido';
    resumen[estado] += 1;
    if (entrada.deriva) resumen.con_deriva += 1;
  }
  return resumen;
}

function leerCenso(estado) {
  const filas = estado.db.prepare('SELECT * FROM servidores ORDER BY nombre, fuente').all();
  const todas = filas.map((fila) => filaPublica(estado, fila));
  const entradas = todas.slice(0, estado.config.topeEntradas);
  return {
    generado: estado.generado ?? estado.nucleo.reloj.ahora(),
    fuentes: estado.fuentes,
    resumen: resumenDe(todas),
    entradas,
    tope: estado.config.topeEntradas,
    truncado: todas.length > entradas.length,
  };
}

function registrarCancelacion(estado, cancelar) {
  estado.canceladores.add(cancelar);
  return () => estado.canceladores.delete(cancelar);
}

async function guardarResultado(estado, servidor, resultado) {
  if (!estado.vivo) return;
  const ts = estado.nucleo.reloj.ahora();
  if (resultado.estado === 'ok') {
    estado.db.prepare(`
      UPDATE servidores SET estado = ?, motivo = ?, ms = ?, sondeado_en = ?,
        huella_config_al_cargar = huella_config,
        huella_cred_al_cargar = huella_cred
      WHERE id = ?
    `).run(resultado.estado, resultado.motivo, resultado.ms, ts, servidor.id);
  } else {
    estado.db.prepare(
      'UPDATE servidores SET estado = ?, motivo = ?, ms = ?, sondeado_en = ? WHERE id = ?',
    ).run(resultado.estado, resultado.motivo, resultado.ms, ts, servidor.id);
  }
  estado.db.prepare(
    'INSERT INTO sondeos (servidor, ts, estado, ms, motivo, cliente) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(servidor.id, ts, resultado.estado, resultado.ms, resultado.motivo, CLIENTE_INTERNO);
  emitirSeguro(estado, 'mcps.servidor.sondeado', {
    servidor: servidor.id,
    nombre: servidor.nombre,
    fuente: servidor.fuente,
    transporte: servidor.transporte,
    estado: resultado.estado,
    ms: resultado.ms,
    motivo: resultado.motivo,
    ts,
  });
}

async function sondearTodos(estado, filtro = {}) {
  if (!estado.vivo) return { sondeados: 0, resultados: [] };
  const servidores = [...estado.servidoresActuales.values()].filter((servidor) =>
    (!filtro.nombre || servidor.nombre === filtro.nombre) &&
    (!filtro.fuente || servidor.fuente === filtro.fuente)
  );
  const corridas = await enPool(servidores, estado.config.concurrencia, async (servidor) => {
    let resultado;
    if (servidor.transporte === 'stdio') {
      resultado = await sondaStdio({
        servidor,
        timeoutMs: estado.config.timeoutMs,
        proceso: estado.nucleo.proceso,
        permitido: estado.config.sondeoStdio,
        registrarCancelacion: (cancelar) => registrarCancelacion(estado, cancelar),
      });
    } else {
      resultado = await sondaHttp({
        servidor,
        timeoutMs: estado.config.timeoutMs,
        pedir: estado.nucleo.http.pedir,
        ahora: Date.now,
        registrarCancelacion: (cancelar) => registrarCancelacion(estado, cancelar),
      });
    }
    await guardarResultado(estado, servidor, resultado);
    return { servidor: servidor.id, nombre: servidor.nombre, fuente: servidor.fuente, ...resultado };
  });
  const resultados = corridas.map((corrida, indice) => {
    if (corrida.ok) return corrida.valor;
    const servidor = servidores[indice];
    return {
      servidor: servidor.id,
      nombre: servidor.nombre,
      fuente: servidor.fuente,
      estado: 'caido',
      ms: null,
      motivo: corrida.error?.message ?? 'fallo inesperado de sonda',
    };
  });
  if (!estado.vivo) return { sondeados: resultados.length, resultados };
  const filas = estado.db.prepare('SELECT * FROM servidores ORDER BY nombre, fuente').all();
  actualizarTransicionesDeDeriva(estado, filas);
  return { sondeados: resultados.length, resultados };
}

function seguirEnVuelo(estado, operacion) {
  const promesa = Promise.resolve().then(operacion);
  estado.enVuelo.add(promesa);
  promesa.then(
    () => estado.enVuelo.delete(promesa),
    () => estado.enVuelo.delete(promesa),
  );
  return promesa;
}

function programarSondeo(estado, filtro = {}) {
  const promesa = estado.colaSondeos
    .catch(() => {})
    .then(() => sondearTodos(estado, filtro));
  estado.colaSondeos = promesa;
  estado.enVuelo.add(promesa);
  promesa.then(
    () => estado.enVuelo.delete(promesa),
    () => estado.enVuelo.delete(promesa),
  );
  return promesa;
}

export async function instalar(nucleo, { primeraVez }) {
  nucleo.log.info(`preparando el censo MCP${primeraVez ? ' por primera vez' : ''}`);
  return { ok: true };
}

export async function arrancar(nucleo) {
  const config = nucleo.config;
  const estado = {
    nucleo,
    db: nucleo.datos.abrir(),
    raizTaller: process.cwd(),
    config: {
      fuentes: config.NTUX_MCPS_FUENTES ?? '',
      timeoutMs: entero(config.NTUX_MCPS_TIMEOUT_MS, 8_000),
      concurrencia: entero(config.NTUX_MCPS_CONCURRENCIA, 4),
      sondeoMs: entero(config.NTUX_MCPS_SONDEO_MS, 300_000),
      sondeoStdio: String(config.NTUX_MCPS_SONDEO_STDIO ?? 'true').toLowerCase() !== 'false',
      topeEntradas: entero(config.NTUX_MCPS_TOPE_ENTRADAS, 200),
    },
    vivo: true,
    fuentes: [],
    generado: null,
    inventario: null,
    credencialesDisponibles: false,
    servidoresActuales: new Map(),
    derivasPrevias: new Map(),
    canceladores: new Set(),
    enVuelo: new Set(),
    colaSondeos: Promise.resolve(),
  };

  const manija = {
    async censo({ consulta = {} } = {}) {
      return nucleo.log.op('mcps.censo', async () => {
        await refrescarDescubrimiento(estado);
        if (consulta.esperar === '1') {
          await programarSondeo(estado);
          return leerCenso(estado);
        }
        const respuesta = leerCenso(estado);
        programarSondeo(estado).catch((error) => {
          nucleo.log.error(`barrido MCP en segundo plano fallido: ${error.message}`, { error });
        });
        return respuesta;
      });
    },

    async detalle({ consulta = {} } = {}) {
      return nucleo.log.op('mcps.detalle', async () => {
        if (!consulta.nombre) throw fallo('nombre_obligatorio', 'falta el parametro nombre', 400);
        const parametros = [consulta.nombre];
        let sql = 'SELECT * FROM servidores WHERE nombre = ?';
        if (consulta.fuente) {
          sql += ' AND fuente = ?';
          parametros.push(consulta.fuente);
        }
        const filas = estado.db.prepare(`${sql} ORDER BY fuente`).all(...parametros);
        if (!filas.length) throw fallo('servidor_inexistente', 'el servidor MCP no existe', 404);
        if (filas.length > 1) {
          throw fallo('fuente_ambigua', 'el nombre aparece en mas de una fuente; indique fuente', 409);
        }
        const servidor = filaPublica(estado, filas[0]);
        const sondeos = estado.db.prepare(
          'SELECT ts, estado, ms, motivo, cliente FROM sondeos WHERE servidor = ? ORDER BY ts DESC LIMIT 100',
        ).all(servidor.id);
        return {
          servidor,
          sondeos,
          credenciales: {
            disponibles: estado.credencialesDisponibles,
            entradas: credencialesDe(servidor, estado.inventario),
          },
        };
      });
    },

    async alertas() {
      return nucleo.log.op('mcps.alertas', async () => {
        const entradas = estado.db.prepare('SELECT * FROM servidores ORDER BY nombre, fuente')
          .all()
          .map((fila) => filaPublica(estado, fila))
          .filter((entrada) => entrada.estado !== 'ok' || entrada.deriva);
        return { entradas, generado: estado.nucleo.reloj.ahora() };
      });
    },

    async sondear({ cuerpo = {} } = {}) {
      return nucleo.log.op('mcps.sondear', async () => {
        await refrescarDescubrimiento(estado);
        return programarSondeo(estado, {
          nombre: cuerpo.nombre,
          fuente: cuerpo.fuente ? expandirRuta(cuerpo.fuente) : undefined,
        });
      });
    },

    _estado: estado,
  };

  await refrescarDescubrimiento(estado);
  manija._valeBarrido = nucleo.reloj.intervalo(estado.config.sondeoMs, () => {
    seguirEnVuelo(estado, async () => {
      await refrescarDescubrimiento(estado);
      return programarSondeo(estado);
    }).catch((error) => {
      nucleo.log.error(`barrido periodico MCP fallido: ${error.message}`, { error });
    });
  }, { nombre: 'barrido-de-sondeo' });

  manija._devolverTodo = async () => {
    if (!estado.vivo) return;
    estado.vivo = false;
    if (manija._valeBarrido) {
      nucleo.reloj.cancelar(manija._valeBarrido);
      manija._valeBarrido = null;
    }
    for (const cancelar of [...estado.canceladores]) {
      try { cancelar(); } catch { /* El drenaje continua con los otros recursos. */ }
    }
    await Promise.allSettled([...estado.enVuelo]);
  };

  return manija;
}

export async function detener(manija, { motivo }) {
  await manija?._devolverTodo?.();
  return { ok: true, drenados: 0, motivo };
}

export async function desinstalar(nucleo, { conservarDatos }) {
  nucleo.log.warn(`desinstalando mcps${conservarDatos ? ' conservando el censo' : ''}`);
  return { ok: true };
}

/** Coste cero: consulta exclusivamente la SQLite ya abierta. */
export async function salud(manija) {
  if (!manija?._estado?.db) {
    return { ok: false, servidores: 0, caidos: 0, con_deriva: 0, fuentes: 0, motivo: 'sin manija' };
  }
  const db = manija._estado.db;
  const fila = db.prepare(`
    SELECT
      COUNT(*) AS servidores,
      SUM(CASE WHEN estado = 'caido' THEN 1 ELSE 0 END) AS caidos,
      SUM(CASE
        WHEN huella_config_al_cargar IS NOT NULL AND huella_config_al_cargar <> huella_config THEN 1
        WHEN huella_cred IS NOT NULL AND huella_cred_al_cargar IS NOT NULL
          AND huella_cred_al_cargar <> huella_cred THEN 1
        ELSE 0
      END) AS con_deriva,
      COUNT(DISTINCT fuente) AS fuentes
    FROM servidores
  `).get();
  return {
    ok: true,
    servidores: fila.servidores,
    caidos: fila.caidos ?? 0,
    con_deriva: fila.con_deriva ?? 0,
    fuentes: fila.fuentes,
  };
}
