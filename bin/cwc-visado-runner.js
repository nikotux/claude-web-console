#!/usr/bin/env node
// bin/cwc-visado-runner.js — ejecuta una petición de visado ya aprobada en un
// proceso DESACOPLADO del server (regla dura 2). Las operaciones pueden tardar
// de segundos a varios minutos y deben sobrevivir a un reinicio de la web; por
// eso no se ejecutan dentro del request que aprueba el expediente.
//
// El runner no recibe objetos ni datos vivos de la sala: recibe únicamente el
// dataDir resuelto y el id del expediente. Conserva el cwd y el entorno del
// proceso que lo spawnea, que son también los que usa la operación aprobada.
import {
  CATALOG_CONTRACT_VERSION, getOp, validateParams,
} from '../src/modules/visado/catalog.js';
import {
  ESTADOS, computeFingerprint, leerPeticion, transicionar,
} from '../src/modules/visado/store.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

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

  // Esta re-validación es el corazón del runner. Entre que el invitado pidió y
  // el dueño aprobó pudo pasar media hora, y el entorno elegido pudo haberse
  // destruido. Sin re-validar, la lista cerrada de opciones sería una foto vieja
  // disfrazada de garantía.
  if (peticion.v !== CATALOG_CONTRACT_VERSION) {
    caducar(
      dataDir,
      id,
      `El contrato del catálogo cambió desde que se pidió (v${peticion.v} vs v${CATALOG_CONTRACT_VERSION}). Volvé a pedirla.`,
    );
    return 0;
  }

  const op = getOp(peticion.opId);
  if (!op) {
    caducar(dataDir, id, 'La operación ya no existe en el catálogo. Volvé a pedirla.');
    return 0;
  }

  const validado = await validateParams(
    peticion.opId,
    peticion.params,
    { salaId: peticion.salaId },
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
    fingerprint = computeFingerprint(peticion.opId, peticion.params);
  } catch {
    fingerprint = null;
  }
  if (fingerprint !== peticion.fingerprint) {
    const error = 'La huella del expediente no coincide: fue alterado.';
    // La máquina de estados no admite aprobada→fallida directamente. Se toma el
    // expediente con el mismo candado aprobado→ejecutando y se lo cierra como
    // fallido, sin invocar la operación.
    const tomada = transicionar(
      dataDir,
      id,
      [ESTADOS.APROBADA],
      ESTADOS.EJECUTANDO,
      { iniciadoAt: Date.now() },
    );
    if (!tomada.ok) {
      log(`petición ${id} ya fue tomada por otro proceso; no se ejecuta.`);
      return 0;
    }
    guardarFallo(dataDir, id, { error, terminadoAt: Date.now() });
    log(`cierre ${id}: estado=${ESTADOS.FALLIDA}; error=${error}`);
    return 1;
  }

  // Esta transición persistente es el candado de "1 aprobación = 1 ejecución".
  // Si otro runner llegó primero, este sale sin ejecutar y sin lockfile aparte.
  const tomada = transicionar(
    dataDir,
    id,
    [ESTADOS.APROBADA],
    ESTADOS.EJECUTANDO,
    { iniciadoAt: Date.now() },
  );
  if (!tomada.ok) {
    log(`petición ${id} ya fue tomada por otro proceso; no se ejecuta.`);
    return 0;
  }

  let resultado;
  try {
    resultado = await op.run(
      peticion.params,
      { salaId: peticion.salaId, aprobador: peticion.aprobador },
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
    const guardada = transicionar(
      dataDir,
      id,
      [ESTADOS.EJECUTANDO],
      ESTADOS.EJECUTADA,
      { resultado, terminadoAt },
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
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    log('FALLO inesperado del runner:', err?.message || err);
    process.exitCode = 1;
  });
