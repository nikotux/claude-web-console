// modules/folders/index.js — carpetas manuales de la barra de Sesiones.
//
// Es un módulo propio porque organiza dos dominios distintos: conversaciones
// del SDK de chat y sesiones de terminal tmux. Por eso no pertenece a chat/:
// solo persiste carpetas y referencias, nunca modifica los ítems agrupados.
//
// HTTP:
//   GET  /api/folders/list                         -> { folders, items, order }
//   POST /api/folders/create {name, world, parentId?} -> { folder }
//   POST /api/folders/rename {id, name}             -> { folder }
//   POST /api/folders/delete {id}                   -> { ok, freed }
//   POST /api/folders/assign {key, folderId}         -> { ok }
//   POST /api/folders/reorder {container, keys}      -> { ok }
// Validación responde 400; una carpeta propia inexistente responde 404.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { principalOf } from '../../core/auth.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { hostUser, userDataDir } from '../../core/user-space.js';

const FOLDER_ID_RE = /^f_[0-9a-f]{10}$/;
const WORLD_RE = /^[a-z0-9_-]{1,40}$/i;
const ITEM_KEY_RE = /^(chat:[A-Za-z0-9_-]{1,64}|tmux:[A-Za-z0-9_.-]{1,40}:[A-Za-z0-9_.-]{1,80})$/;
const WORLD_CONTAINER_RE = /^world:[a-z0-9_-]{1,40}$/i;
const FOLDER_CONTAINER_RE = /^folder:f_[0-9a-f]{10}$/;
const MAX_FOLDERS = 50;
const MAX_ITEMS = 2000;
const MAX_ORDER_CONTAINERS = 100;
const MAX_ORDER_KEYS = 300;

function emptyStore() {
  return { version: 1, folders: [], items: {}, order: {} };
}

// Invariante multi-tenant: se invoca con el dueño de CADA operación. Nunca
// congelar esta ruta en una constante de módulo (console:BUG-2185).
function storeFile(owner) {
  return path.join(userDataDir(owner), 'session-folders.json');
}

function ownerOf(req) {
  const owner = principalOf(req).username || hostUser();
  return owner;
}

function cleanName(value) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').trim();
}

function validName(name) {
  const length = [...name].length;
  return length >= 1 && length <= 40;
}

function validFolderShape(folder) {
  return folder
    && typeof folder === 'object'
    && !Array.isArray(folder)
    && typeof folder.id === 'string'
    && FOLDER_ID_RE.test(folder.id)
    && typeof folder.name === 'string'
    && cleanName(folder.name) === folder.name
    && validName(folder.name)
    && typeof folder.world === 'string'
    && WORLD_RE.test(folder.world)
    && (folder.parentId === null || (typeof folder.parentId === 'string' && FOLDER_ID_RE.test(folder.parentId)))
    && Number.isSafeInteger(folder.order)
    && folder.order >= 0
    && Number.isSafeInteger(folder.createdAt)
    && folder.createdAt >= 0;
}

function validContainer(container) {
  return typeof container === 'string'
    && (WORLD_CONTAINER_RE.test(container) || FOLDER_CONTAINER_RE.test(container));
}

// El saneo es por ítem porque rechazar el documento entero convertiría un dato
// dudoso en la pérdida total de la organización del usuario en la próxima escritura.
function sanitizeStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return emptyStore();

  const seenIds = new Set();
  let folders = (Array.isArray(raw.folders) ? raw.folders : []).filter((folder) => {
    if (!validFolderShape(folder) || seenIds.has(folder.id)) return false;
    seenIds.add(folder.id);
    return true;
  });
  if (folders.length > MAX_FOLDERS) {
    folders = folders
      .slice()
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      .slice(0, MAX_FOLDERS);
  }

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  folders = folders.map((folder) => {
    if (folder.parentId === null) return folder;
    const parent = byId.get(folder.parentId);
    if (parent && parent.world === folder.world && parent.parentId === null) return folder;
    return { ...folder, parentId: null };
  });

  const itemEntries = raw.items
    && typeof raw.items === 'object'
    && !Array.isArray(raw.items)
    ? Object.entries(raw.items).filter(([key, folderId]) => (
      ITEM_KEY_RE.test(key) && typeof folderId === 'string' && byId.has(folderId)
    ))
    : [];
  const items = Object.fromEntries(itemEntries.slice(0, MAX_ITEMS));

  const rawOrderPrototype = raw.order && typeof raw.order === 'object'
    ? Object.getPrototypeOf(raw.order)
    : undefined;
  const orderEntries = raw.order
    && typeof raw.order === 'object'
    && !Array.isArray(raw.order)
    && (rawOrderPrototype === Object.prototype || rawOrderPrototype === null)
    ? Object.entries(raw.order)
    : [];
  const order = {};
  for (const [container, rawKeys] of orderEntries) {
    if (Object.keys(order).length >= MAX_ORDER_CONTAINERS) break;
    if (!validContainer(container) || !Array.isArray(rawKeys)) continue;
    if (FOLDER_CONTAINER_RE.test(container) && !byId.has(container.slice('folder:'.length))) continue;

    const seenKeys = new Set();
    const keys = [];
    for (const key of rawKeys) {
      if (typeof key !== 'string' || !ITEM_KEY_RE.test(key) || seenKeys.has(key)) continue;
      seenKeys.add(key);
      keys.push(key);
      if (keys.length >= MAX_ORDER_KEYS) break;
    }
    if (keys.length > 0) order[container] = keys;
  }

  return { version: 1, folders, items, order };
}

function readStore(owner) {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(owner), 'utf8'));
    return sanitizeStore(raw);
  } catch {
    return emptyStore();
  }
}

function saveStore(owner, store) {
  writeJsonAtomic(storeFile(owner), store, { space: 2 });
}

function invalid(res, error) {
  return res.status(400).json({ error });
}

function missing(res) {
  return res.status(404).json({ error: 'carpeta inexistente' });
}

function writeFailed(res) {
  return res.status(500).json({ error: 'no se pudo guardar' });
}

export default {
  name: 'folders',

  init(ctx) { // eslint-disable-line no-unused-vars -- interfaz estándar, no usado por este módulo
    return Promise.resolve();
  },

  registerHttp(router, ctx) { // eslint-disable-line no-unused-vars -- interfaz estándar, no usado por este módulo
    const r = express.Router();

    r.get('/list', (req, res) => {
      const owner = ownerOf(req);
      const store = readStore(owner);
      res.json({ folders: store.folders, items: store.items, order: store.order });
    });

    r.post('/create', (req, res) => {
      const name = cleanName(req.body?.name);
      const world = req.body?.world;
      const requestedParentId = req.body?.parentId;
      const requestedOrder = req.body?.order;
      if (!validName(name)) return invalid(res, 'nombre inválido');
      if (typeof world !== 'string' || !WORLD_RE.test(world)) return invalid(res, 'mundo inválido');
      if (requestedParentId !== undefined && requestedParentId !== null
        && (typeof requestedParentId !== 'string' || !FOLDER_ID_RE.test(requestedParentId))) {
        return invalid(res, 'carpeta padre inválida');
      }
      if (requestedOrder !== undefined && (!Number.isSafeInteger(requestedOrder) || requestedOrder < 0)) {
        return invalid(res, 'orden inválido');
      }

      const owner = ownerOf(req);
      const store = readStore(owner);
      if (store.folders.length >= MAX_FOLDERS) return invalid(res, 'límite de carpetas alcanzado');

      const parentId = requestedParentId ?? null;
      if (parentId !== null) {
        const parent = store.folders.find((folder) => folder.id === parentId);
        if (!parent) return missing(res);
        if (parent.world !== world || parent.parentId !== null) return invalid(res, 'carpeta padre inválida');
      }

      const folder = {
        id: `f_${crypto.randomBytes(5).toString('hex')}`,
        name,
        world,
        parentId,
        order: requestedOrder ?? store.folders.filter((item) => item.world === world).length,
        createdAt: Date.now(),
      };
      store.folders.push(folder);
      try {
        saveStore(owner, store);
        return res.json({ folder });
      } catch {
        return writeFailed(res);
      }
    });

    r.post('/rename', (req, res) => {
      const id = req.body?.id;
      const name = cleanName(req.body?.name);
      if (typeof id !== 'string' || !FOLDER_ID_RE.test(id)) return invalid(res, 'id inválido');
      if (!validName(name)) return invalid(res, 'nombre inválido');

      const owner = ownerOf(req);
      const store = readStore(owner);
      const folder = store.folders.find((item) => item.id === id);
      if (!folder) return missing(res);
      folder.name = name;
      try {
        saveStore(owner, store);
        return res.json({ folder });
      } catch {
        return writeFailed(res);
      }
    });

    r.post('/delete', (req, res) => {
      const id = req.body?.id;
      if (typeof id !== 'string' || !FOLDER_ID_RE.test(id)) return invalid(res, 'id inválido');

      const owner = ownerOf(req);
      const store = readStore(owner);
      if (!store.folders.some((folder) => folder.id === id)) return missing(res);

      const deletedIds = new Set(
        store.folders
          .filter((folder) => folder.id === id || folder.parentId === id)
          .map((folder) => folder.id),
      );
      store.folders = store.folders.filter((folder) => !deletedIds.has(folder.id));
      let freed = 0;
      for (const [key, folderId] of Object.entries(store.items)) {
        if (!deletedIds.has(folderId)) continue;
        delete store.items[key];
        freed++;
      }
      for (const folderId of deletedIds) {
        delete store.order[`folder:${folderId}`];
      }
      try {
        saveStore(owner, store);
        return res.json({ ok: true, freed });
      } catch {
        return writeFailed(res);
      }
    });

    r.post('/assign', (req, res) => {
      const key = req.body?.key;
      const folderId = req.body?.folderId;
      if (typeof key !== 'string' || !ITEM_KEY_RE.test(key)) return invalid(res, 'clave inválida');
      if (folderId !== null && folderId !== '' && (typeof folderId !== 'string' || !FOLDER_ID_RE.test(folderId))) {
        return invalid(res, 'id inválido');
      }

      const owner = ownerOf(req);
      const store = readStore(owner);
      if (folderId === null || folderId === '') {
        delete store.items[key];
      } else {
        if (!store.folders.some((folder) => folder.id === folderId)) return missing(res);
        if (!Object.prototype.hasOwnProperty.call(store.items, key) && Object.keys(store.items).length >= MAX_ITEMS) {
          return invalid(res, 'límite de asignaciones alcanzado');
        }
        store.items[key] = folderId;
      }
      try {
        saveStore(owner, store);
        return res.json({ ok: true });
      } catch {
        return writeFailed(res);
      }
    });

    r.post('/reorder', (req, res) => {
      const container = req.body?.container;
      const keys = req.body?.keys;
      if (!validContainer(container)) return invalid(res, 'contenedor inválido');
      if (!Array.isArray(keys)) return invalid(res, 'claves inválidas');
      if (keys.length > MAX_ORDER_KEYS) return invalid(res, 'demasiadas claves');

      const seenKeys = new Set();
      for (const key of keys) {
        if (typeof key !== 'string' || !ITEM_KEY_RE.test(key)) return invalid(res, 'clave inválida');
        if (seenKeys.has(key)) return invalid(res, 'claves duplicadas');
        seenKeys.add(key);
      }

      const owner = ownerOf(req);
      const store = readStore(owner);
      if (FOLDER_CONTAINER_RE.test(container)) {
        const folderId = container.slice('folder:'.length);
        if (!store.folders.some((folder) => folder.id === folderId)) return missing(res);
      }
      if (keys.length > 0
        && !Object.prototype.hasOwnProperty.call(store.order, container)
        && Object.keys(store.order).length >= MAX_ORDER_CONTAINERS) {
        return invalid(res, 'demasiados contenedores');
      }

      if (keys.length === 0) {
        delete store.order[container];
      } else {
        store.order[container] = keys;
      }
      try {
        saveStore(owner, store);
        return res.json({ ok: true });
      } catch {
        return writeFailed(res);
      }
    });

    router.use('/folders', r);
  },
};
