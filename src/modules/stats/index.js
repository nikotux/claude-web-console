// modules/stats/index.js — estadísticas del sistema y status del server.
//
// HTTP:
//   GET /api/stats  -> { cpu, mem, disk, load, uptime, hostname, server }
//
// La CPU se calcula como delta entre la lectura anterior y la actual de
// os.cpus(); guardamos el último snapshot en memoria del módulo.
//
// `systemSnapshot()` (sin el `server` propio de este proceso) es la FUENTE
// ÚNICA de recursos del sistema — la reusa el dashboard de Salud
// (health/index.js: GET /api/health/scan, sección "Recursos del servidor")
// en vez de reimplementar CPU/mem/disk por su cuenta (convención de
// reuso/fuente-única del proyecto).
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import { config } from '../../core/config.js';
import fss from 'node:fs';
import path from 'node:path';
import { isAdmin } from '../../core/auth.js';
import { manager } from '../chat/index.js';
import { hostUser, userDataDir, userClaudeDir } from '../../core/user-space.js';

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
    // MemAvailable no existe en kernels < 3.14; caer a MemFree y, si tampoco
    // está, al fallback de os.* para no reportar un 100% de uso falso.
    let avail = kb(/MemAvailable:\s+(\d+) kB/);
    if (!avail) avail = kb(/MemFree:\s+(\d+) kB/);
    if (!total || !avail) {
      const t = os.totalmem();
      const u = t - os.freemem();
      return { total: t, used: u, pct: t ? (u / t) * 100 : 0 };
    }
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

// Snapshot de recursos del SISTEMA (sin el `server` propio del proceso que
// hace la llamada) — reusado por /api/stats y por el dashboard de Salud.
export async function systemSnapshot() {
  const [mem, disk] = await Promise.all([memInfo(), diskInfo()]);
  return {
    cpu: { pct: cpuPercent(), cores: os.cpus().length },
    mem,
    disk,
    load: os.loadavg(),
    uptime: os.uptime(),
    hostname: os.hostname(),
  };
}

// ─── Monitoreo PER-USUARIO (SP9-9/TASK-675) ───────────────────────────────────
// Atribución por usuario para operar el multi-tenant: cuántas sesiones/runners
// vivos tiene cada uno, su RSS aproximado y el disco de su espacio. Todo
// best-effort (nunca tira). Reusa el `manager` de chat (owner por conversación)
// + los helpers per-user de user-space.js. El HOST no mide disco (su home entero
// sería carísimo de recorrer) → diskBytes null.
const USERS_ROOT = path.join(config.home, '.cwc-users');
const CHATS_DIR = path.join(config.home, '.cwc-data', 'chats'); // los spawnlock los escribe el server (host) para TODOS los chats

// VmRSS (kB) de un pid, o 0 si no se puede leer.
function rssKbForPid(pid) {
  try {
    const txt = fss.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = txt.match(/VmRSS:\s+(\d+) kB/);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return 0; }
}
// pid del runner de un chat, leído de su spawnlock (0/null si no hay).
function pidForChat(id) {
  try {
    const { pid } = JSON.parse(fss.readFileSync(path.join(CHATS_DIR, `${id}.spawnlock`), 'utf8'));
    return pid && pid > 0 ? pid : null;
  } catch { return null; }
}
// Tamaño en bytes de un dir (recursivo, best-effort, con tope de archivos para
// no dispararse). Un budget compartido corta si el árbol es enorme.
function dirSizeBytes(dir, budget) {
  budget = budget || { files: 0 };
  let total = 0;
  let entries;
  try { entries = fss.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.files > 200000) break; // guard anti-runaway
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSizeBytes(p, budget);
    else if (e.isFile()) {
      budget.files += 1;
      try { total += fss.statSync(p).size; } catch { /* skip */ }
    }
  }
  return total;
}

// Snapshot por-usuario. Contrato: [{ userId, liveSessions, runners, rssMB, diskBytes }].
export async function perUserSnapshot() {
  const host = hostUser();
  const owners = new Map(); // key -> { userId, liveSessions, runners, rssMB, diskBytes, _pids }
  const ensure = (key) => {
    let e = owners.get(key);
    if (!e) { e = { userId: key, liveSessions: 0, runners: 0, rssMB: 0, diskBytes: 0, _pids: [] }; owners.set(key, e); }
    return e;
  };
  // inquilinos con espacio provisionado
  try {
    for (const d of fss.readdirSync(USERS_ROOT, { withFileTypes: true })) {
      if (d.isDirectory()) ensure(d.name);
    }
  } catch { /* aún sin inquilinos */ }
  ensure(host); // el host siempre aparece
  // conversaciones VIVAS por dueño (owner null = host)
  for (const c of manager.chats.values()) {
    if (c.closed || c.archived) continue;
    const e = ensure(c.owner || host);
    e.liveSessions += 1;
    if (c.viewMode !== 'tui') e.runners += 1; // un chat en modo chat tiene runner; una TUI no
    const pid = pidForChat(c.id);
    if (pid) e._pids.push(pid);
  }
  // RSS agregado + disco del espacio (solo inquilinos)
  for (const e of owners.values()) {
    let rssKb = 0;
    for (const pid of e._pids) rssKb += rssKbForPid(pid);
    e.rssMB = Math.round(rssKb / 1024);
    if (e.userId !== host) {
      try { e.diskBytes = dirSizeBytes(userDataDir(e.userId)) + dirSizeBytes(userClaudeDir(e.userId)); } catch { e.diskBytes = 0; }
    } else {
      e.diskBytes = null; // host: home completo, no medido
    }
    delete e._pids;
  }
  return [...owners.values()].sort((a, b) => b.liveSessions - a.liveSessions);
}

export default {
  name: 'stats',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', async (req, res) => {
      try {
        const snap = await systemSnapshot();
        res.json({ ...snap, server: { uptime: process.uptime(), pid: process.pid } });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    r.get('/users', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Solo admin.' });
      try {
        res.json({ users: await perUserSnapshot() });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.use('/stats', r);
  },
};
