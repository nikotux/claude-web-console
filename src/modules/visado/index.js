import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { isAdmin, principalOf } from '../../core/auth.js';
import { hostUser, userDataDir } from '../../core/user-space.js';
import { manager } from '../chat/index.js';
import { status as tolkienStatus, opBranches } from '../tolkien/index.js';
import { readRefreshJob, refreshStatus } from '../tolkien/refresh-shared.js';
import { listEnvs, getEnv, getEnvByChat, isEnvAlive } from '../tolkien/env-store.js';
import {
  CATALOG_CONTRACT_VERSION, getOp, listOpIds, resolveOptions, validateParams,
} from './catalog.js';
import {
  ESTADOS, crearPeticion, leerPeticion, listarPeticiones, transicionar,
  caducarVencidas, caducarEjecutandoVencidas,
} from './store.js';
import { salaChat, salaVisiblePara } from './sala-access.js';

// Enriquece un expediente con lo que la UI necesita para MOSTRAR la operación
// exacta, calculado SIEMPRE en el servidor desde el catálogo. El frontend nunca
// compone una orden: si lo hiciera, quien aprueba estaría viendo una
// reconstrucción del navegador y no la operación que se va a ejecutar (C5).
function conRender(peticion) {
  if (!peticion) return peticion;
  const op = getOp(peticion.opId);
  if (!op) return { ...peticion, operacion: null, label: null, advertencias: [] };

  let operacion = null;
  try {
    operacion = op.render(peticion.params || {});
  } catch {
    operacion = null; // un render que falla NO puede tumbar el listado
  }

  // Las advertencias salen de las opciones que se le MOSTRARON al solicitante,
  // no de una lista aparte: así el texto que ve quien aprueba es exactamente el
  // que declaró el catálogo para ese valor.
  const advertencias = [];
  for (const [name, opciones] of Object.entries(peticion.opcionesMostradas || {})) {
    if (!Array.isArray(opciones)) continue;
    const elegida = opciones.find((o) => o?.value === peticion.params?.[name]);
    if (elegida?.warn) advertencias.push(elegida.warn);
  }

  return { ...peticion, label: op.label, operacion, advertencias };
}

const RUNNER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'bin',
  'cwc-visado-runner.js',
);

// Dispara la ejecución en un proceso DESACOPLADO (regla dura 2): la operación
// puede tardar minutos y debe sobrevivir a un reinicio de la web. Si el spawn
// falla, la petición queda `aprobada` — nunca a medio ejecutar — y se puede
// reintentar; por eso el fallo se loguea y no rompe la respuesta HTTP.
function spawnVisadoRunner(dataDir, id) {
  const logFile = path.join(dataDir, 'visado-runner.log');
  let logFd;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    logFd = fs.openSync(logFile, 'a');
    const child = spawn(
      process.execPath,
      [RUNNER, '--data-dir', dataDir, '--id', id],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
      },
    );
    child.on('error', (err) => {
      try {
        fs.appendFileSync(
          logFile,
          `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`,
        );
      } catch { /* noop */ }
    });
    child.unref();
  } catch (err) {
    try {
      fs.appendFileSync(
        logFile,
        `[${new Date().toISOString()}] spawn THROW: ${err?.message || err}\n`,
      );
    } catch { /* noop */ }
  } finally {
    if (logFd !== undefined) {
      try { fs.closeSync(logFd); } catch { /* noop */ }
    }
  }
}

// El usuario que hace el request. null = token maestro => se trata como host.
function userOf(req) {
  return principalOf(req)?.username || hostUser();
}

// El expediente vive en el dataDir del DUEÑO de la sala, no en el del que
// pregunta: la cola de aprobaciones es suya y debe seguir siendo suya aunque
// la petición la emita un invitado.
function dataDirDeLaSala(chat) {
  return userDataDir(chat.owner || hostUser());
}

function responderError(res, status, error, code, detail) {
  const body = { error, code };
  if (detail !== undefined) body.detail = detail;
  return res.status(status).json(body);
}

// Express 4 no propaga automáticamente los rechazos de handlers async. Este
// wrapper conserva el contrato JSON también para errores inesperados.
function rutaAsync(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error('[visado] Error HTTP:', err);
      if (!res.headersSent) {
        responderError(res, 500, 'No se pudo procesar la solicitud.', 'error_interno');
      }
    });
  };
}

function resumenEntorno(env) {
  return {
    id: env.id,
    status: env.status,
    port: env.port,
    branch: env.branch,
    base: env.base,
    createdAt: env.createdAt,
  };
}

function buscarPeticionParticipante(id, user) {
  const porDataDir = new Map();
  for (const chat of manager.chats.values()) {
    try {
      if (!chat.isSala() || !chat.isParticipant(user)) continue;
      const salaId = chat._salaId();
      const dataDir = dataDirDeLaSala(chat);
      if (!porDataDir.has(dataDir)) porDataDir.set(dataDir, leerPeticion(dataDir, id));
      const peticion = porDataDir.get(dataDir);
      if (peticion?.salaId === salaId) return { dataDir, peticion };
    } catch { /* una sala a medio construir no rompe la búsqueda */ }
  }
  return null;
}

export default {
  name: 'visado',

  registerHttp(router) {
    const r = express.Router();

    // Estas lecturas no aflojan los gates de Tolkien: la autorización distinta
    // vive en visado y exige ser participante de la sala Aduana indicada.
    r.get('/lecturas/estado', rutaAsync(async (req, res) => {
      const salaId = req.query.sala;
      const user = userOf(req);
      if (!salaVisiblePara(salaId, user)) {
        return responderError(res, 404, 'Sala no encontrada.', 'sala_no_existe');
      }
      return res.json(await tolkienStatus());
    }));

    r.get('/lecturas/refresh', (req, res) => {
      const salaId = req.query.sala;
      const user = userOf(req);
      if (!salaVisiblePara(salaId, user)) {
        return responderError(res, 404, 'Sala no encontrada.', 'sala_no_existe');
      }
      return res.json(refreshStatus(readRefreshJob()));
    });

    r.get('/lecturas/preview', (req, res) => {
      const salaId = req.query.sala;
      const user = userOf(req);
      if (!salaVisiblePara(salaId, user)) {
        return responderError(res, 404, 'Sala no encontrada.', 'sala_no_existe');
      }
      const rec = getEnvByChat(salaId);
      if (!rec) return res.json({ env: null });
      return res.json({
        env: {
          id: rec.id,
          port: rec.port,
          status: rec.status,
          branch: rec.branch,
          alive: isEnvAlive(rec),
          enterUrl: `/api/tolkien/local-enter?port=${encodeURIComponent(rec.port)}`,
        },
      });
    });

    r.get('/lecturas/entornos', (req, res) => {
      const salaId = req.query.sala;
      const user = userOf(req);
      if (!salaVisiblePara(salaId, user)) {
        return responderError(res, 404, 'Sala no encontrada.', 'sala_no_existe');
      }
      // Es la diferencia entre «te dejo ver la lista para que elijas» y «te doy
      // el mapa de mi disco». El invitado necesita el id y algo que lo identifique
      // (puerto, estado) para elegir en un formulario; no necesita saber en qué
      // ruta vive el worktree ni cómo se llama la unidad systemd.
      return res.json(listEnvs().map(resumenEntorno));
    });

    r.get('/lecturas/entornos/:id', (req, res) => {
      const salaId = req.query.sala;
      const user = userOf(req);
      if (!salaVisiblePara(salaId, user)) {
        return responderError(res, 404, 'Sala no encontrada.', 'sala_no_existe');
      }
      const id = String(req.params.id || '');
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        return responderError(res, 400, 'Id de entorno inválido.', 'id_invalido');
      }
      const env = getEnv(id);
      if (!env) {
        return responderError(res, 404, 'Entorno no encontrado.', 'entorno_no_existe');
      }
      return res.json(resumenEntorno(env));
    });

    r.get('/lecturas/ramas', rutaAsync(async (req, res) => {
      const salaId = req.query.sala;
      const user = userOf(req);
      if (!salaVisiblePara(salaId, user)) {
        return responderError(res, 404, 'Sala no encontrada.', 'sala_no_existe');
      }
      const r2 = await opBranches();
      return res.status(r2.status).json(r2.body);
    }));

    r.get('/catalogo', rutaAsync(async (req, res) => {
      const salaId = req.query.sala;
      const user = userOf(req);
      const chat = salaVisiblePara(salaId, user);
      if (!chat) {
        return responderError(res, 404, 'Sala no encontrada.', 'sala_no_existe');
      }

      const ops = await Promise.all(listOpIds().map(async (opId) => {
        const op = getOp(opId);
        const opciones = await resolveOptions(opId, { salaId });
        const params = op.params.map((spec) => ({
          name: spec.name,
          label: spec.label,
          options: opciones[spec.name],
        }));
        return {
          opId,
          label: op.label,
          world: op.world,
          params,
          pedible: params.every((param) => param.options.length > 0),
        };
      }));

      return res.json({ v: CATALOG_CONTRACT_VERSION, ops });
    }));

    r.post('/peticiones', rutaAsync(async (req, res) => {
      const { salaId, opId, params } = req.body || {};
      const user = userOf(req);
      const chat = salaVisiblePara(salaId, user);
      if (!chat) {
        return responderError(res, 404, 'Sala no encontrada.', 'sala_no_existe');
      }
      if (!getOp(opId)) {
        return responderError(res, 400, 'Operación desconocida.', 'op_desconocida');
      }

      const validado = await validateParams(opId, params, { salaId });
      if (!validado.ok) {
        return responderError(
          res,
          400,
          'Los parámetros de la operación no son válidos.',
          validado.code,
          validado.detail,
        );
      }

      // El motivo es solo texto para mostrar: no participa de gates, despacho,
      // renderizado de comandos ni ninguna otra decisión de seguridad.
      const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.slice(0, 2000) : '';
      const dataDir = dataDirDeLaSala(chat);
      const peticion = crearPeticion(dataDir, {
        salaId,
        opId,
        params: validado.params,
        motivo,
        solicitante: { userId: user, nombre: user },
        opcionesMostradas: await resolveOptions(opId, { salaId }),
        v: CATALOG_CONTRACT_VERSION,
      });
      // label, operacion y advertencias son derivados de catálogo solo al servir:
      // el expediente persistido conserva opId + params + fingerprint como verdad.
      return res.status(201).json(conRender(peticion));
    }));

    r.get('/peticiones', rutaAsync(async (req, res) => {
      const salaId = req.query.sala;
      const user = userOf(req);

      if (salaId !== undefined) {
        const chat = salaVisiblePara(salaId, user);
        if (!chat) {
          return responderError(res, 404, 'Sala no encontrada.', 'sala_no_existe');
        }
        const dataDir = dataDirDeLaSala(chat);
        caducarVencidas(dataDir);
        caducarEjecutandoVencidas(dataDir);
        return res.json(listarPeticiones(dataDir, { salaId }).map(conRender));
      }

      const salasPorDataDir = new Map();
      for (const chat of manager.chats.values()) {
        try {
          if (!chat.isSala() || (chat.owner || hostUser()) !== user) continue;
          const dataDir = dataDirDeLaSala(chat);
          if (!salasPorDataDir.has(dataDir)) salasPorDataDir.set(dataDir, new Set());
          salasPorDataDir.get(dataDir).add(chat._salaId());
        } catch { /* una sala a medio construir no rompe la cola */ }
      }

      const peticiones = [];
      for (const [dataDir, salas] of salasPorDataDir) {
        caducarVencidas(dataDir);
        caducarEjecutandoVencidas(dataDir);
        peticiones.push(...listarPeticiones(dataDir).filter((peticion) => salas.has(peticion.salaId)));
      }
      peticiones.sort((a, b) => (Number(b.creadoAt) || 0) - (Number(a.creadoAt) || 0));
      return res.json(peticiones.map(conRender));
    }));

    r.post('/peticiones/:id/aprobar', rutaAsync(async (req, res) => {
      const user = userOf(req);
      const dataDir = userDataDir(user);
      const peticion = leerPeticion(dataDir, req.params.id);
      if (!peticion) {
        return responderError(res, 404, 'Petición no encontrada.', 'no_existe');
      }
      if (peticion.estado !== ESTADOS.PENDIENTE) {
        return responderError(res, 409, 'La petición ya no está pendiente.', 'estado_invalido');
      }
      if (peticion.solicitante?.userId === user) {
        return responderError(res, 403, 'No podés aprobar tu propia petición.', 'autoaprobacion');
      }

      const chat = salaChat(peticion.salaId);
      if (!chat || (chat.owner || hostUser()) !== user) {
        return responderError(res, 403, 'Solo el dueño de la sala puede decidir la petición.', 'no_sos_duenio');
      }
      if (req.body?.fingerprint !== peticion.fingerprint) {
        return responderError(
          res,
          409,
          'La petición cambió desde que la viste. Volvé a abrirla.',
          'huella_no_coincide',
        );
      }

      const op = getOp(peticion.opId);
      if (!op) {
        return responderError(res, 409, 'La operación ya no existe en el catálogo.', 'op_desconocida');
      }
      // El visado presta la autoridad del aprobador, no la eleva: el dueño debe
      // poder ejecutar por sí mismo exactamente la operación que está aprobando.
      if (!op.gate(req)) {
        return responderError(
          res,
          403,
          'No tenés autoridad para ejecutar esta operación.',
          'sin_autoridad',
        );
      }

      const validado = await validateParams(
        peticion.opId,
        peticion.params,
        { salaId: peticion.salaId },
      );
      if (!validado.ok) {
        const explicacion = `La opción elegida dejó de estar disponible (${validado.code}: ${validado.detail}).`;
        const caducada = transicionar(
          dataDir,
          peticion.id,
          [ESTADOS.PENDIENTE],
          ESTADOS.CADUCADA,
          { error: explicacion },
        );
        if (!caducada.ok) {
          return responderError(res, 409, 'La petición ya no está pendiente.', 'estado_invalido');
        }
        return responderError(
          res,
          409,
          'La opción elegida ya no está disponible.',
          'opcion_desaparecida',
        );
      }

      const resultado = transicionar(
        dataDir,
        peticion.id,
        [ESTADOS.PENDIENTE],
        ESTADOS.APROBADA,
        {
          aprobador: { userId: user, nombre: user },
          decididoAt: Date.now(),
        },
      );
      if (!resultado.ok) {
        return responderError(res, 409, 'La petición ya no está pendiente.', 'estado_invalido');
      }
      spawnVisadoRunner(dataDir, peticion.id);
      return res.json(conRender(resultado.peticion));
    }));

    r.post('/peticiones/:id/rechazar', (req, res) => {
      const user = userOf(req);
      const dataDir = userDataDir(user);
      const peticion = leerPeticion(dataDir, req.params.id);
      if (!peticion) {
        return responderError(res, 404, 'Petición no encontrada.', 'no_existe');
      }
      if (peticion.estado !== ESTADOS.PENDIENTE) {
        return responderError(res, 409, 'La petición ya no está pendiente.', 'estado_invalido');
      }

      const chat = salaChat(peticion.salaId);
      if (!chat || (chat.owner || hostUser()) !== user) {
        return responderError(res, 403, 'Solo el dueño de la sala puede decidir la petición.', 'no_sos_duenio');
      }

      const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo : '';
      const resultado = transicionar(
        dataDir,
        peticion.id,
        [ESTADOS.PENDIENTE],
        ESTADOS.RECHAZADA,
        {
          aprobador: { userId: user, nombre: user },
          decididoAt: Date.now(),
          error: motivo || null,
        },
      );
      if (!resultado.ok) {
        return responderError(res, 409, 'La petición ya no está pendiente.', 'estado_invalido');
      }
      return res.json(conRender(resultado.peticion));
    });

    r.post('/peticiones/:id/cancelar', (req, res) => {
      const user = userOf(req);
      const encontrada = buscarPeticionParticipante(req.params.id, user);
      if (!encontrada) {
        return responderError(res, 404, 'Petición no encontrada.', 'no_existe');
      }
      if (encontrada.peticion.solicitante?.userId !== user) {
        return responderError(
          res,
          403,
          'Solo el solicitante puede cancelar la petición.',
          'no_sos_solicitante',
        );
      }

      const resultado = transicionar(
        encontrada.dataDir,
        encontrada.peticion.id,
        [ESTADOS.PENDIENTE],
        ESTADOS.CANCELADA,
      );
      if (!resultado.ok) {
        return responderError(res, 409, 'La petición ya no está pendiente.', 'estado_invalido');
      }
      return res.json(conRender(resultado.peticion));
    });

    router.use('/visado', r);
  },
};
