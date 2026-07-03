// modules/stats/index.js — estadísticas del sistema y status del server.
//
// HTTP:
//   GET /api/stats  -> { cpu, mem, disk, load, uptime, hostname, server }
//
// La CPU se calcula como delta entre la lectura anterior y la actual de
// os.cpus(); guardamos el último snapshot en memoria del módulo.
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import { config } from '../../core/config.js';

let prevCpu = null; // { idle, total }

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

// % de uso de CPU desde la última llamada (0 en la primera).
function cpuPercent() {
  const cur = cpuSnapshot();
  let pct = 0;
  if (prevCpu) {
    const dIdle = cur.idle - prevCpu.idle;
    const dTotal = cur.total - prevCpu.total;
    if (dTotal > 0) pct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  prevCpu = cur;
  return pct;
}

// Memoria real desde /proc/meminfo (MemAvailable es más fiel que os.freemem).
async function memInfo() {
  try {
    const txt = await fs.readFile('/proc/meminfo', 'utf8');
    const kb = (re) => {
      const m = txt.match(re);
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const total = kb(/MemTotal:\s+(\d+) kB/);
    const avail = kb(/MemAvailable:\s+(\d+) kB/);
    const used = total - avail;
    return { total, used, pct: total ? (used / total) * 100 : 0 };
  } catch {
    const total = os.totalmem();
    const used = total - os.freemem();
    return { total, used, pct: total ? (used / total) * 100 : 0 };
  }
}

async function diskInfo() {
  try {
    const s = await fs.statfs(config.home);
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    const used = total - s.bfree * s.bsize;
    return { total, used, pct: total ? (used / total) * 100 : 0, avail };
  } catch {
    // Mismo shape (el frontend lee disk.pct directo) + flag para distinguir
    // "no se pudo leer el disco" de un 0% real.
    return { total: 0, used: 0, pct: 0, avail: 0, unavailable: true };
  }
}

export default {
  name: 'stats',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', async (req, res) => {
      const [mem, disk] = await Promise.all([memInfo(), diskInfo()]);
      res.json({
        cpu: { pct: cpuPercent(), cores: os.cpus().length },
        mem,
        disk,
        load: os.loadavg(),
        uptime: os.uptime(),
        hostname: os.hostname(),
        server: { uptime: process.uptime(), pid: process.pid },
      });
    });

    router.use('/stats', r);
  },
};
