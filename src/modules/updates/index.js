// modules/updates/index.js — pestaña "🔄 Actualizaciones" de ⚙ Sistema →
// 🩺 Diagnóstico. Censo centralizado de versiones de terceros (Agent SDK,
// librerías npm, Claude Code CLI, Pad local, apt/SO) + APLICADO reversible con
// verificación posterior. Nace porque no había NINGÚN mecanismo que avisara
// cuándo salían updates de lo que la consola depende de afuera.
//
// Filosofía (decisión de Niko 2026-07-21, ver PLAN-779):
//   · Botón "Actualizar" SOLO en lo reversible: librerías npm (revertibles con
//     git checkout de package.json/lock) y el Claude Code CLI (updater propio).
//   · apt/SO → SOLO informativo (comando para copiar; no lo tocamos desde la
//     web: se mezcla con docker/systemd, mayor radio de impacto).
//   · El Agent SDK se actualiza como cualquier lib PERO tomar el cambio exige
//     reiniciar el servicio — eso es un botón APARTE ("Reiniciar y verificar"),
//     nunca dentro de "Actualizar", para que Niko elija el momento sin cortar
//     sesiones a mitad de un turno.
//   · Vigiladas SIN botón: Baileys (rompió una vez), endpoints no oficiales.
//
// Verificación tras aplicar: node --check (syntaxCheck de shared.js) — y el
// FRONT además re-consulta GET /api/health/checks (que ya existe) para el
// semáforo completo. Reversión: git checkout -- package.json package-lock.json
// && npm install (todo versionado → siempre reversible).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { isAdmin } from '../../core/auth.js';
import { resolveDataDir } from '../../core/data-dir.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import fs from 'node:fs';
import {
  buildUpdatesCensus, syntaxCheck, readPackageJson, run, ROOT,
} from './shared.js';
import {
  readJob, writeJob, isRunning, effectiveStatus, spawnUpdatesRunner, applyAuditFix, spawnAnalyzeRunner,
  buildPlan, planActionCount,
} from './orchestrate-shared.js';
import {
  readRisk, writeRisk, isRiskRunning, effectiveRisk,
} from './analyze-shared.js';
import { buildUpdateBriefing } from './session-shared.js';

const CACHE_FILE = path.join(resolveDataDir(), 'updates-census.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — esto cambia lento; no hace falta más

let mem = null;
let memAt = 0;
let inFlight = null;

function readPersisted() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

// Tras un update, el censo cacheado (memoria Y disco) quedó viejo — un
// census(false) posterior serviría la foto vieja (por eso el panel seguía
// mostrando la versión anterior). invalidate() tira ambas capas para que la
// próxima lectura re-corra npm outdated de verdad.
function invalidate() {
  mem = null;
  memAt = 0;
  try { fs.rmSync(CACHE_FILE, { force: true }); } catch { /* best-effort */ }
}

async function census({ fresh }) {
  if (!fresh && mem && Date.now() - memAt < CACHE_TTL_MS) return mem;
  if (!fresh) {
    // Sin caché en memoria (reinicio del server) → servir el último snapshot en
    // disco si es fresco, sin re-correr los npm outdated/audit (lentos).
    const disk = readPersisted();
    if (disk && Date.now() - (disk.generatedAt || 0) < CACHE_TTL_MS) { mem = disk; memAt = disk.generatedAt; return disk; }
  }
  if (inFlight) return inFlight; // dedup de censos concurrentes
  inFlight = buildUpdatesCensus();
  try {
    mem = await inFlight;
    memAt = Date.now();
    try { writeJsonAtomic(CACHE_FILE, mem); } catch { /* best-effort */ }
    return mem;
  } finally {
    inFlight = null;
  }
}

// Whitelist de aplicado npm: SOLO un paquete declarado en package.json, con una
// versión con forma semver, y que NO sea una dependencia vigilada (baileys). El
// nombre de paquete se valida contra un patrón estricto para que nunca llegue un
// argumento arbitrario a npm install.
const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NEVER_UPDATE = new Set(['baileys']);

function npmUpdatable(name) {
  const pkg = readPackageJson();
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Object.prototype.hasOwnProperty.call(declared, name) && !NEVER_UPDATE.has(name);
}

export default {
  name: 'updates',

  registerHttp(router) {
    // Censo (autenticados; no expone secretos, solo versiones).
    router.get('/updates', async (req, res) => {
      try { res.json(await census({ fresh: req.query.fresh === '1' })); }
      catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
    });

    // Re-escanear (admin — cuesta CPU/red: corre npm outdated/audit).
    router.post('/updates/refresh', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      try { res.json(await census({ fresh: true })); }
      catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
    });

    // Aplicar update de UNA librería npm (admin). Reversible con git. Valida
    // nombre + versión + que esté declarada + que no sea vigilada. Tras instalar
    // corre node --check; si la sintaxis falla, avisa (el usuario revierte).
    router.post('/updates/npm', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      const { pkg, version } = req.body || {};
      const name = String(pkg || '').trim();
      const ver = String(version || '').trim();
      if (!PKG_NAME_RE.test(name)) return res.status(400).json({ error: 'nombre de paquete inválido' });
      if (!VERSION_RE.test(ver)) return res.status(400).json({ error: 'versión inválida' });
      if (!npmUpdatable(name)) return res.status(400).json({ error: 'paquete no actualizable desde acá (no declarado o vigilado)' });
      try {
        const inst = await run('npm', ['install', `${name}@${ver}`, '--save-exact=false'], { timeout: 180_000 });
        if (inst.failed || (!inst.ok && /npm error|ERR!/.test(inst.stderr))) {
          return res.status(500).json({ error: (inst.stderr || 'npm install falló').trim().slice(0, 400) });
        }
        invalidate(); // el censo cambió — tirar memoria Y disco
        const syntax = await syntaxCheck();
        res.json({
          ok: true,
          pkg: name,
          version: ver,
          syntax,
          needsRestart: name === '@anthropic-ai/claude-agent-sdk',
          revertHint: 'git checkout -- package.json package-lock.json && npm install',
        });
      } catch (e) {
        res.status(500).json({ error: String(e.message || e).slice(0, 400) });
      }
    });

    // Actualizar el Claude Code CLI con su propio updater (admin).
    router.post('/updates/claude-cli', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      try {
        const r = await run('claude', ['update'], { timeout: 180_000 });
        invalidate();
        res.json({ ok: r.ok, output: (r.stdout || r.stderr || '').trim().slice(0, 600) });
      } catch (e) {
        res.status(500).json({ error: String(e.message || e).slice(0, 400) });
      }
    });

    // Verificación de sintaxis a demanda (node --check) — el semáforo de Salud
    // completo lo trae el front de GET /api/health/checks aparte.
    router.get('/updates/verify', async (req, res) => {
      try { res.json(await syntaxCheck()); }
      catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
    });

    // Briefing determinístico para abrir una sesión de chat que conduce el
    // update con Bash. No aplica nada: censa fresco y arma prompt + plan.
    router.post('/updates/session-briefing', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      try {
        const currentCensus = await census({ fresh: true });
        const risk = readRisk();
        const verdicts = (risk || {}).verdicts || {};
        const plan = buildPlan(currentCensus, { apt: true }, [], verdicts);
        const { prompt, title } = buildUpdateBriefing({ census: currentCensus, plan, risk });
        res.json({ ok: true, prompt, title, cwd: 'claude-web-console', actions: planActionCount(plan) });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || 'error' });
      }
    });

    // --- BOTÓN ÚNICO: actualización orquestada (admin) ---
    // Reserva el job y spawnea el runner desacoplado. Responde YA (patrón
    // health/tolkien-refresh). El runner hace censo→plan→drenar→aplicar→verificar
    // →reiniciar→reanudar; sobrevive el reinicio que él mismo dispara.
    router.post('/updates/run', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      const existing = readJob();
      if (isRunning(existing)) return res.status(409).json({ error: 'ya hay una actualización en curso', job: effectiveStatus(existing) });
      // Alcance: apt incluido por decisión (PLAN-779). El body puede forzar
      // {apt:false} para el modo "solo app" a futuro.
      const scope = { apt: req.body?.scope?.apt !== false };
      // Saltos MAYORES que el usuario tildó para forzar (opt-in). Validados:
      // nombre válido + declarado en package.json + no vigilado (baileys).
      const includeMajors = Array.isArray(req.body?.includeMajors)
        ? req.body.includeMajors.map(String).filter((n) => PKG_NAME_RE.test(n) && npmUpdatable(n)).slice(0, 40)
        : [];
      const job = { running: true, phase: 'queued', scope, includeMajors, startedAt: Date.now(), heartbeat: Date.now(), steps: [], plan: null, log: [], error: null };
      writeJob(job);
      try {
        spawnUpdatesRunner();
        res.json({ ok: true, job });
      } catch (e) {
        writeJob({ ...job, running: false, phase: 'error', error: 'No se pudo iniciar el runner.' });
        res.status(500).json({ error: String(e.message || e).slice(0, 300) });
      }
    });

    // Estado del job orquestado (0 tokens, solo lee disco; status EFECTIVO).
    router.get('/updates/run-status', (req, res) => {
      res.json(effectiveStatus(readJob()));
    });

    // --- Fase B: ANÁLISIS DE RIESGO IA de los saltos mayores (admin, tokens) ---
    router.post('/updates/analyze', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      const existing = readRisk();
      if (isRiskRunning(existing)) return res.status(409).json({ error: 'ya hay un análisis en curso', risk: effectiveRisk(existing) });
      // Conservar veredictos previos como base (se re-analiza y sobreescribe).
      writeRisk({ running: true, phase: 'queued', startedAt: Date.now(), heartbeat: Date.now(), verdicts: existing?.verdicts || {}, error: null });
      try { spawnAnalyzeRunner(); res.json({ ok: true }); }
      catch (e) { writeRisk({ running: false, phase: 'error', error: 'No se pudo iniciar el análisis.' }); res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
    });
    // Veredictos de riesgo (0 tokens, solo lee disco).
    router.get('/updates/risk', (req, res) => { res.json(effectiveRisk(readRisk())); });

    // Arreglar SOLO las vulnerabilidades (npm audit fix seguro, sin reiniciar).
    // Reversible con git. Corre node --check después.
    router.post('/updates/audit-fix', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      try {
        const r = await applyAuditFix();
        mem = null;
        const syntax = await syntaxCheck();
        res.json({ ok: r.ok, detail: r.detail, syntax, revertHint: 'git checkout -- package.json package-lock.json && npm install' });
      } catch (e) {
        res.status(500).json({ error: String(e.message || e).slice(0, 300) });
      }
    });

    // Reiniciar el servicio y verificar (admin, confirm fuerte en el front).
    // OJO: reiniciar corta las sesiones activas un momento — por eso es un botón
    // SEPARADO que el usuario aprieta cuando quiere. Respondemos ANTES de
    // reiniciar (el propio proceso muere) y dejamos que el front reconsulte
    // /api/health/checks cuando el server vuelva.
    router.post('/updates/restart', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'admin' });
      res.json({ ok: true, restarting: true });
      // Diferido para que la respuesta salga antes de que systemd nos mate.
      setTimeout(() => {
        execFile('systemctl', ['--user', 'restart', 'claude-web-console'], { timeout: 30_000 }, () => {});
      }, 300);
    });
  },
};

export { ROOT };
