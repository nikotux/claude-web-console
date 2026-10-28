#!/usr/bin/env node
// bin/cwc-visado-runner.js — ejecuta una petición de visado ya aprobada en un
// proceso DESACOPLADO del server (regla dura 2). Las operaciones pueden tardar
// de segundos a varios minutos y deben sobrevivir a un reinicio de la web; por
// eso no se ejecutan dentro del request que aprueba el expediente.
//
// El runner no recibe objetos ni datos vivos de la sala: recibe únicamente el
// dataDir resuelto y el id del expediente. Conserva el cwd, pero el server le
// entrega un entorno mínimo por allowlist.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATALOG_CONTRACT_VERSION, getOp, validateParams,
} from '../src/modules/visado/catalog.js';
import {
  ESTADOS, actualizarLatido, computeFingerprint, leerPeticion, transicionar,
  visadosDir,
} from '../src/modules/visado/store.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const HEARTBEAT_MS = 30 * 1000;
const RUNNER_LOCK_STALE_MS = 2 * 60 * 1000;

function parseArgs(argv) {
  if (argv.length !== 4) return null;

  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if ((key !== '--data-dir' && key !== '--id') || !value || Object.hasOwn(parsed, key)) {
      return null;
    }
    parsed[key] = value;
  }

  if (!parsed['--data-dir'] || !parsed['--id']) return null;
  return { dataDir: parsed['--data-dir'], id: parsed['--id'] };
}

function caducar(dataDir, id, error) {
  const resultado = transicionar(
    dataDir,
    id,
    [ESTADOS.APROBADA],
    ESTADOS.CADUCADA,
    { error },
  );
  if (!resultado.ok) {
    log(`no se pudo caducar ${id} (${resultado.code}); otro proceso cambió su estado.`);
    return false;
  }
  log(`cierre ${id}: estado=${ESTADOS.CADUCADA}; error=${error}`);
  return true;
}

function errorDeAprobacion(peticion) {
  const aprobador = typeof peticion?.aprobador?.userId === 'string'
    ? peticion.aprobador.userId.trim()
    : '';
  const solicitante = typeof peticion?.solicitante?.userId === 'string'
    ? peticion.solicitante.userId.trim()
    : '';
  if (!aprobador) return 'La petición no tiene un aprobador válido.';
  if (!solicitante) return 'La petición no tiene un solicitante válido.';
  if (aprobador === solicitante) return 'La petición fue autoaprobada y no se puede ejecutar.';
  return null;
}

function fallarAprobada(dataDir, id, error) {
  const resultado = transicionar(
    dataDir,
    id,
    [ESTADOS.APROBADA],
    ESTADOS.FALLIDA,
    { error, terminadoAt: Date.now() },
  );
  if (!resultado.ok) {
    log(`no se pudo marcar fallida ${id} (${resultado.code}); otro proceso cambió su estado.`);
    return false;
  }
  log(`cierre ${id}: estado=${ESTADOS.FALLIDA}; error=${error}`);
  return true;
}

function adquirirCandado(dataDir, id) {
  const file = path.join(visadosDir(dataDir), `${id}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  for (let intento = 0; intento < 3; intento += 1) {
    const token = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, `${token}\n`, 'utf8');
      return { fd, file, token };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(file).mtimeMs > RUNNER_LOCK_STALE_MS;
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') continue;
        throw statErr;
      }
      if (!stale) return null;
      try {
        fs.unlinkSync(file);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  return null;
}

function renovarCandado(candado) {
  const now = new Date();
  try { fs.futimesSync(candado.fd, now, now); } catch { /* el finally lo limpiará */ }
}

function liberarCandado(candado) {
  try { fs.closeSync(candado.fd); } catch { /* noop */ }
  try {
    if (fs.readFileSync(candado.file, 'utf8').trim() === candado.token) {
      fs.unlinkSync(candado.file);
    }
  } catch { /* ausente o reemplazado por otro runner */ }
}

function guardarFallo(dataDir, id, patch) {
  const resultado = transicionar(
    dataDir,
    id,
    [ESTADOS.EJECUTANDO],
    ESTADOS.FALLIDA,
    patch,
  );
  if (!resultado.ok) {
    throw new Error(`no se pudo guardar el fallo de ${id}: ${resultado.code}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    log('uso: cwc-visado-runner.js --data-dir <ruta> --id <peticionId>');
    return 2;
  }

  const { dataDir, id } = args;
  const peticion = leerPeticion(dataDir, id);
  if (!peticion) {
    log(`petición ${id} inexistente o caducada; salgo.`);
    return 0;
  }
  if (peticion.estado !== ESTADOS.APROBADA) {
    log(`petición ${id} en estado=${peticion.estado}; no se ejecuta.`);
    return 0;
  }

  // La aprobación se valida ANTES del candado: un expediente adulterado no
  // puede reservar siquiera la capacidad de ejecución.
  const errorAprobacion = errorDeAprobacion(peticion);
  if (errorAprobacion) {
    fallarAprobada(dataDir, id, errorAprobacion);
    return 1;
  }

  // transicionar() hace read+write y no es CAS entre procesos. Este lockfile
  // renovable es la garantía de que dos runners del mismo id no ejecuten la
  // operación dos veces; si uno muere, el barrido puede relanzar tras el stale.
  const candado = adquirirCandado(dataDir, id);
  if (!candado) {
    log(`petición ${id} ya tiene un runner activo; no se ejecuta.`);
    return 0;
  }

  let ejecutando = false;
  const heartbeat = setInterval(() => {
    renovarCandado(candado);
    if (ejecutando && !actualizarLatido(dataDir, id)) {
      log(`latido ${id}: el expediente ya no está en ejecución.`);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  try {
    const vigente = leerPeticion(dataDir, id);
    if (!vigente || vigente.estado !== ESTADOS.APROBADA) {
      log(`petición ${id} cambió antes de tomarla; no se ejecuta.`);
      return 0;
    }
    const errorAprobacionVigente = errorDeAprobacion(vigente);
    if (errorAprobacionVigente) {
      fallarAprobada(dataDir, id, errorAprobacionVigente);
      return 1;
    }

    // Esta re-validación es el corazón del runner. Entre que el invitado pidió y
    // el dueño aprobó pudo pasar media hora, y el entorno elegido pudo haberse
    // destruido. Sin re-validar, la lista cerrada de opciones sería una foto vieja
    // disfrazada de garantía.
    if (vigente.v !== CATALOG_CONTRACT_VERSION) {
      caducar(
        dataDir,
        id,
        `El contrato del catálogo cambió desde que se pidió (v${vigente.v} vs v${CATALOG_CONTRACT_VERSION}). Volvé a pedirla.`,
      );
      return 0;
    }

    const op = getOp(vigente.opId);
    if (!op) {
      caducar(dataDir, id, 'La operación ya no existe en el catálogo. Volvé a pedirla.');
      return 0;
    }

    const validado = await validateParams(
      vigente.opId,
      vigente.params,
      { salaId: vigente.salaId },
    );
    if (!validado.ok) {
      caducar(
        dataDir,
        id,
        `La opción elegida ya no existe: ${validado.detail}. Volvé a pedirla.`,
      );
      return 0;
    }

    // El expediente es un archivo: la huella es la única garantía de que lo que
    // se ejecutará coincide exactamente con lo aprobado.
    let fingerprint;
    try {
      fingerprint = computeFingerprint(vigente.opId, vigente.params);
    } catch {
      fingerprint = null;
    }
    if (fingerprint !== vigente.fingerprint) {
      const error = 'La huella del expediente no coincide: fue alterado.';
      fallarAprobada(dataDir, id, error);
      return 1;
    }

    const iniciadoAt = Date.now();
    const tomada = transicionar(
      dataDir,
      id,
      [ESTADOS.APROBADA],
      ESTADOS.EJECUTANDO,
      { iniciadoAt, latidoAt: iniciadoAt },
    );
    if (!tomada.ok) {
      log(`petición ${id} ya fue tomada por otro proceso; no se ejecuta.`);
      return 0;
    }
    ejecutando = true;

    let resultado;
    try {
      resultado = await op.run(
        vigente.params,
        { salaId: vigente.salaId, aprobador: vigente.aprobador },
      );
    } catch (err) {
      const error = String(err?.message || err);
      guardarFallo(dataDir, id, { error, terminadoAt: Date.now() });
      log(`cierre ${id}: estado=${ESTADOS.FALLIDA}; error=${error}`);
      return 0;
    }

    const terminadoAt = Date.now();
    const status = resultado?.status;
    if (typeof status === 'number' && status < 400) {
      // `resultado` del expediente es el cuerpo útil de la operación, no el
      // envoltorio HTTP interno. Así provision conserva {id,status,port} y push
      // conserva también {id,branch,pushed,prUrl} para mostrar/enlazar el PR.
      const resultadoPersistido = resultado?.body && typeof resultado.body === 'object'
        && !Array.isArray(resultado.body)
        ? { ...resultado.body }
        : resultado;
      const guardada = transicionar(
        dataDir,
        id,
        [ESTADOS.EJECUTANDO],
        ESTADOS.EJECUTADA,
        { resultado: resultadoPersistido, terminadoAt },
      );
      if (!guardada.ok) {
        throw new Error(`no se pudo guardar el resultado de ${id}: ${guardada.code}`);
      }
      log(`cierre ${id}: estado=${ESTADOS.EJECUTADA}`);
      return 0;
    }

    const error = resultado?.body?.error || 'La operación devolvió un error.';
    guardarFallo(dataDir, id, { resultado, error, terminadoAt });
    log(`cierre ${id}: estado=${ESTADOS.FALLIDA}; error=${error}`);
    return 0;
  } finally {
    clearInterval(heartbeat);
    liberarCandado(candado);
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    log('FALLO inesperado del runner:', err?.message || err);
    process.exitCode = 1;
  });
