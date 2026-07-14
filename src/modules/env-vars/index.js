// modules/env-vars/index.js — panel "Variables de entorno" de ⚙ Sistema.
//
// UI de la capa de CONFIG DE INSTANCIA (identidad + cliente) que separa este
// refactor de identidad (PLAN-476/PEND-377): permite editar, sin tocar el
// código ni el .env a mano, quién sos (email/GitHub/firma) y los datos del
// cliente/proyecto (departamentos Zoho, nombre del MCP, reviewer de
// referencia). NUNCA expone la capa de SECRETOS (CWC_TOKEN, credenciales) —
// esa sigue siendo exclusivamente archivo local (.env / ~/.claude), fuera del
// alcance de este panel a propósito.
//
// Admin-gating igual al panel de Proyectos: GET abierto a cualquier
// autenticado (para que se vea la config activa), POST solo admin.
//
// HTTP:
//   GET  /api/env-vars          -> { identity, client } (valores activos)
//   POST /api/env-vars {patch}  -> guarda (deep-merge), admin
import express from 'express';
import { isAdmin } from '../../core/auth.js';
import { loadInstance, saveInstance, instanceFilePath } from '../../core/instance-config.js';

// Campos EDITABLES desde el panel — allowlist explícita: aunque instance.json
// solo contiene identidad/cliente (nunca secretos), esta allowlist es la
// defensa en profundidad de qué puede escribir un POST de este endpoint.
const EDITABLE = {
  identity: ['name', 'email', 'github', 'signature'],
  client: ['mcpServerId', 'infisicalProjectId'],
};

function pickAllowed(patch) {
  const out = {};
  for (const [section, fields] of Object.entries(EDITABLE)) {
    if (!patch?.[section] || typeof patch[section] !== 'object') continue;
    const clean = {};
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(patch[section], f)) {
        clean[f] = String(patch[section][f] ?? '').trim().slice(0, 200);
      }
    }
    if (Object.keys(clean).length) out[section] = clean;
  }
  // zohoDepartments y reviewer son objetos anidados con claves libres — se
  // aceptan aparte, saneando valores a string corto (nunca objetos/arrays).
  if (patch?.client?.zohoDepartments && typeof patch.client.zohoDepartments === 'object') {
    const deps = {};
    for (const [k, v] of Object.entries(patch.client.zohoDepartments)) {
      const key = String(k).slice(0, 40);
      if (key) deps[key] = String(v ?? '').trim().slice(0, 60);
    }
    out.client = { ...out.client, zohoDepartments: deps };
  }
  if (patch?.client?.reviewer && typeof patch.client.reviewer === 'object') {
    const rev = {};
    for (const f of ['name', 'github', 'contactId']) {
      if (Object.prototype.hasOwnProperty.call(patch.client.reviewer, f)) {
        rev[f] = String(patch.client.reviewer[f] ?? '').trim().slice(0, 60);
      }
    }
    if (Object.keys(rev).length) out.client = { ...out.client, reviewer: rev };
  }
  return out;
}

export default {
  name: 'env-vars',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      try {
        const inst = loadInstance();
        res.json({ identity: inst.identity, client: inst.client, needsRestart: false });
      } catch {
        res.status(500).json({ error: 'No se pudo leer la config de instancia.' });
      }
    });

    r.post('/', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        const patch = pickAllowed(req.body || {});
        const next = saveInstance(patch);
        // La mayoría de estos valores se leen al importar los módulos (arriba
        // del archivo, como config.instance.client.mcpServerId en
        // desk-mcp-client.js) — un cambio recién se aplica del todo tras
        // reiniciar el servicio. Avisamos, no reiniciamos solos (regla 9: sin
        // acciones riesgosas sin pedirlas).
        res.json({ ok: true, identity: next.identity, client: next.client, needsRestart: true });
      } catch (e) {
        res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
      }
    });

    r.get('/file', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      res.json({ path: instanceFilePath() });
    });

    router.use('/env-vars', r);
  },
};
