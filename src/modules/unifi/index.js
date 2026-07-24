// modules/unifi/index.js — puente HTTP de solo lectura a UniFi + scan a Pad.
import express from 'express';
import { isAdmin } from '../../core/auth.js';
import {
  getDevices,
  getClients,
  getHealth,
  findClient,
} from './client.js';
import { getRadios, getWan, buildVoiceAudit, snapshotToPad } from './audit-shared.js';
import { scanToPad } from './inventory-shared.js';

function errorMessage(err) {
  return String(err?.message || err);
}

function send502(res, err) {
  res.status(502).json({ error: errorMessage(err) });
}

export default {
  name: 'unifi',

  registerHttp(router) {
    const r = express.Router();

    r.get('/devices', async (req, res) => {
      try { res.json(await getDevices()); }
      catch (err) { send502(res, err); }
    });

    r.get('/clients', async (req, res) => {
      try { res.json(await getClients()); }
      catch (err) { send502(res, err); }
    });

    r.get('/health', async (req, res) => {
      try { res.json(await getHealth()); }
      catch (err) { send502(res, err); }
    });

    r.get('/radios', async (req, res) => {
      try { res.json(await getRadios()); }
      catch (err) { send502(res, err); }
    });

    r.get('/wan', async (req, res) => {
      try { res.json(await getWan()); }
      catch (err) { send502(res, err); }
    });

    r.get('/audit', async (req, res) => {
      try { res.json(await buildVoiceAudit()); }
      catch (err) { send502(res, err); }
    });

    r.get('/client', async (req, res) => {
      try { res.json(await findClient(req.query.q || '')); }
      catch (err) { send502(res, err); }
    });

    r.post('/scan', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try { res.json(await scanToPad()); }
      catch (err) { send502(res, err); }
    });

    r.post('/audit-snapshot', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try { res.json(await snapshotToPad()); }
      catch (err) { send502(res, err); }
    });

    router.use('/unifi', r);
  },
};
