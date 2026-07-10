// modules/tolkien/index.js — panel del proyecto principal (git).
//
// Muestra la "versión" (SHA corto + estado vs origin) y permite actualizar
// desde GitHub. El repo puede tener cambios sin commitear, así que la
// actualización usa STASH -> PULL --ff-only -> STASH POP: nunca descarta tu
// trabajo (si algo falla, tus cambios quedan a salvo en el stash).
//
// HTTP:
//   GET  /api/tolkien/status  -> estado local (sin red)
//   POST /api/tolkien/fetch   -> git fetch (red) + estado
//   POST /api/tolkien/update  -> stash/pull/pop + estado
//
// El contexto (CLAUDE.md) y las memorias editables viven en el módulo
// GENÉRICO `projects` (src/modules/projects/), no acá: sirve tanto a este
// proyecto trackeado como a la propia consola. Ver projects/index.js.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { config } from '../../core/config.js';
import { isAdmin } from '../../core/auth.js';
import { findZeroTierIp } from '../../core/zerotier.js';

const CWD = config.projectDir;
const REL = path.relative(config.home, CWD); // ruta relativa al home (para el árbol)
const AUTO_STASH_MSG = 'cwc: auto antes de actualizar';
const DATA_DIR = path.join(config.home, '.cwc-data');
const LASTFETCH_FILE = path.join(DATA_DIR, 'tolkien-lastfetch.json');

// ───────────────── Refresh de la DB LOCAL (importers Zoho → Postgres) ─────────────────
// Botón "Vista fresca": deja la DB LOCAL de dev como un snapshot LIMPIO y
// ACTUAL de Zoho. NO mergea ni preserva ediciones locales — es un server de
// pruebas y la vista debe ser siempre fresca (sin conflictos). Por eso:
//   1) TRUNCATE de las tablas OPERATIVAS (empleados, clientes y todo lo que
//      cuelga por FK: billing, invoices, leave, teams…) → borrón total.
//   2) Reimporta desde cero con los importers de @tolkien/worker.
// Se PRESERVAN login (users), config (app_config), países y holiday_lists:
// no cascadean desde employees/clients (estos apuntan HACIA ellos, no al revés).
// Equivale, por importer, a lo que se hace a mano:
//   infisical run --env prod -- bash -c "DATABASE_URL=<local>; pnpm importer <n> --apply"
// El infisical inyecta las credenciales Zoho; el DATABASE_URL local se exporta
// DESPUÉS para pisar el de prod y garantizar que se escribe solo en local.
// Config leída de ~/tolkien (con override por env), no hardcodeada frágil.
const IMPORTERS = ['clients', 'employees', 'employee-client-links'];
const DEV_DB_PASSWORD = 'tolkien_dev_only'; // password fijo de la DB de dev (ver CLAUDE.md de tolkien)

function readTolkienDbPort() {
  if (process.env.CWC_TOLKIEN_DB_PORT?.trim()) return process.env.CWC_TOLKIEN_DB_PORT.trim();
  try {
    const env = fs.readFileSync(path.join(CWD, '.env'), 'utf8');
    const m = env.match(/^DB_HOST_PORT=(\d+)/m);
    if (m) return m[1];
  } catch { /* usa fallback */ }
  return '5435';
}

function readInfisicalWorkspaceId() {
  if (process.env.CWC_TOLKIEN_INFISICAL_ID?.trim()) return process.env.CWC_TOLKIEN_INFISICAL_ID.trim();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CWD, '.infisical.json'), 'utf8'));
    if (j.workspaceId) return String(j.workspaceId);
  } catch { /* usa fallback */ }
  return '25b6c300-7686-4cf0-b8e3-ed808a529638';
}

const localDbUrl = () =>
  `postgresql://tolkien:${DEV_DB_PASSWORD}@localhost:${readTolkienDbPort()}/tolkien?schema=public`;

function runCmd(cmd, args, { timeout = 120000, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: CWD, timeout, env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          killed: !!(err && (err.killed || err.signal)),
          stdout: stdout || '',
          stderr: stderr || '',
        });
      });
  });
}

// Extrae {creates,updates,softDeletes,failed} del log pino de un importer.
function parseImporterOutput(name, out) {
  const lines = (out || '').split('\n');
  let done = null;
  let failed = false;
  let failMsg = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj.msg === 'import done') done = obj;
    if (obj.msg === 'import failed') {
      failed = true;
      failMsg = obj?.err?.meta?.driverAdapterError?.cause?.originalMessage || obj?.err?.message || 'import failed';
    }
  }
  return {
    importer: name,
    creates: done?.creates ?? 0,
    updates: done?.updates ?? 0,
    softDeletes: done?.softDeletes ?? 0,
    failed: failed || !done,
    error: failed ? failMsg.split('\n')[0].slice(0, 200) : (done ? '' : 'no completó (sin "import done")'),
  };
}

async function refreshLocalData() {
  const started = Date.now();
  const url = localDbUrl();
  const wsId = readInfisicalWorkspaceId();
  const steps = [];

  // 1) Borrón limpio de la data operativa + defensivo del índice único.
  //    - DROP INDEX clients_name_key: Zoho tiene nombres de Customer duplicados
  //      (p.ej. "San Francisco Bay Real Estate LLC" ×2); el índice único los
  //      rechaza. En la DB LOCAL lo soltamos (idempotente) para no caernos por
  //      un dato sucio de origen.
  //    - TRUNCATE employees, clients RESTART IDENTITY CASCADE: vacía esas dos
  //      tablas y TODO lo que cuelga por FK (billing, invoices, payments, leave,
  //      team_members, overtime, requests, caches). NO toca users/app_config/
  //      countries/holiday_lists (employees/clients apuntan hacia ellas). Así la
  //      recarga es un snapshot fresco, sin restos ni ediciones locales previas.
  const reset = await runCmd('psql', [
    '-h', 'localhost', '-p', readTolkienDbPort(), '-U', 'tolkien', '-d', 'tolkien',
    '-v', 'ON_ERROR_STOP=1',
    '-c', 'DROP INDEX IF EXISTS clients_name_key; TRUNCATE employees, clients RESTART IDENTITY CASCADE;',
  ], { timeout: 30000, env: { ...process.env, PGPASSWORD: DEV_DB_PASSWORD } });
  steps.push({ importer: 'reset (drop-index + truncate operativas)', creates: 0, updates: 0, softDeletes: 0, failed: reset.code !== 0, error: reset.code !== 0 ? (reset.stderr.split('\n')[0] || 'psql falló') : '' });
  // Si el borrón falló, no reimportamos: abortamos para no dejar la DB a medias.
  if (reset.code !== 0) {
    return { ok: false, steps, durationMs: Date.now() - started };
  }

  // 2) Importers en orden: clients → employees → employee-client-links.
  for (const name of IMPORTERS) {
    const inner = `export DATABASE_URL='${url}'; pnpm --filter @tolkien/worker importer ${name} --apply`;
    const res = await runCmd('infisical', [
      'run', '--projectId', wsId, '--env', 'prod', '--', 'bash', '-c', inner,
    ], { timeout: 180000 });
    const parsed = parseImporterOutput(name, `${res.stdout}\n${res.stderr}`);
    if (res.killed) { parsed.failed = true; parsed.error = 'timeout (excedió 180s)'; }
    steps.push(parsed);
  }

  return {
    ok: steps.every((s) => !s.failed),
    steps,
    durationMs: Date.now() - started,
  };
}

function git(args, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', CWD, ...args], { timeout, env: process.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Un `err` con exit code NUMÉRICO es git devolviendo un error normal
        // (ej. pull rechazado, push conflict): eso se resuelve como {code}.
        // Timeout (kill), señales, o fallos de spawn (ENOENT/EACCES) son
        // fallos de SISTEMA, no del comando git — ahí rechazamos en vez de
        // ocultarlos detrás de un {code} inventado.
        if (err && (err.killed || err.signal || typeof err.code !== 'number')) {
          return reject(err);
        }
        resolve({ code: err ? err.code : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      });
  });
}

// Timestamp del último fetch/pull exitoso (freshness del "N detrás"). Se
// persiste en DATA_DIR (CLAUDE.md regla 2: estado detectable tras reinicio
// sin depender solo de variables en memoria) y se cachea acá para no pegarle
// al disco en cada GET /status.
function loadLastFetchAt() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LASTFETCH_FILE, 'utf8'));
    return typeof parsed.lastFetchAt === 'number' ? parsed.lastFetchAt : null;
  } catch {
    return null; // no existe todavía (primer arranque) o está corrupto
  }
}

async function saveLastFetchAt(ts) {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(LASTFETCH_FILE, JSON.stringify({ lastFetchAt: ts }), 'utf8');
  } catch (err) {
    console.error('[tolkien] No se pudo persistir lastFetchAt:', err.message);
  }
}

let lastFetchAt = loadLastFetchAt();

async function status() {
  // Las 6 lecturas de git son INDEPENDIENTES entre sí (ninguna usa el
  // resultado de otra) y son SOLO LECTURA → se disparan en paralelo con
  // Promise.all (regla de oro del proyecto: "paralelo lo que LEE, serial lo
  // que ESCRIBE"). Baja la latencia de GET /status, que el pie persistente de
  // Tolkien consulta seguido. Los chequeos de error/derivación quedan idénticos
  // (mismo orden, mismos mensajes): solo cambia el momento de ejecución, no la
  // lógica. Un fallo de SISTEMA en cualquiera (git rechaza la Promise) propaga
  // igual que antes; los code!==0 se evalúan en orden abajo.
  const [branchRes, headRes, lastRes, porcelainRes, abRes, stashRes] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-parse', '--short', 'HEAD']),
    // Último commit: fecha ISO + autor + asunto (para el "pulso" del repo).
    git(['log', '-1', '--format=%cI%x09%an%x09%s']),
    git(['status', '--porcelain']),
    // ahead/behind vs origin/main (usa lo ya fetchado; no toca la red).
    git(['rev-list', '--left-right', '--count', 'origin/main...HEAD']),
    git(['stash', 'list']),
  ]);

  if (branchRes.code !== 0) throw new Error(`git rev-parse HEAD falló: ${branchRes.stderr || 'código ' + branchRes.code}`);
  const branch = branchRes.stdout || 'HEAD';

  if (headRes.code !== 0) throw new Error(`git rev-parse --short HEAD falló: ${headRes.stderr || 'código ' + headRes.code}`);
  const head = headRes.stdout;

  if (lastRes.code !== 0) throw new Error(`git log falló: ${lastRes.stderr || 'código ' + lastRes.code}`);
  const [date, author, subject] = lastRes.stdout.split('\t');

  if (porcelainRes.code !== 0) throw new Error(`git status falló: ${porcelainRes.stderr || 'código ' + porcelainRes.code}`);
  const porcelain = porcelainRes.stdout;
  const dirtyCount = porcelain ? porcelain.split('\n').length : 0;

  // La ÚNICA pregunta de este panel es "¿mi copia local coincide con main?",
  // así que se compara SIEMPRE contra origin/main, sin importar en qué rama
  // esté parado HEAD (el detalle de PRs/ramas vive en la sección Tickets).
  //   behind = versiones nuevas en main que todavía no tengo → accionable (pull)
  //   ahead  = commits míos fuera de main → NO se muestra acá, es de Tickets
  // Nota: esta llamada puede fallar legítimamente (sin remoto "origin", main
  // todavía no fetchado, etc.) — no es indicio de repo roto, así que no se
  // propaga como error; se deja en 0/0 como antes.
  let behind = 0;
  let ahead = 0;
  if (abRes.code === 0 && abRes.stdout) {
    const [l, r] = abRes.stdout.split(/\s+/);
    behind = parseInt(l, 10) || 0;
    ahead = parseInt(r, 10) || 0;
  }
  // Si el proceso (o el host) murió a mitad de un stash->pull->pop, el stash
  // automático queda intacto en el repo (git lo persiste solo, no hace falta
  // estado propio) pero nadie lo señala tras un reinicio de la interfaz — se
  // detecta acá para que sobreviva al reinicio (CLAUDE.md regla 2).
  // Igual que abRes: un fallo acá (repo raro, permisos, etc.) no debe tirar
  // abajo /status. Se trata como "no hay stash pendiente" en vez de propagar
  // el error — fallback razonable, no un bug silencioso.
  const pendingAutoStash = stashRes.code === 0 && stashRes.stdout
    ? stashRes.stdout.split('\n').some((l) => l.includes(AUTO_STASH_MSG))
    : false;

  return {
    name: config.projectName, rel: REL, branch, head,
    subject: subject || '', author: author || '', date: date || '',
    dirty: dirtyCount > 0, dirtyCount, behind, ahead,
    lastFetch: lastFetchAt,
    pendingAutoStash,
  };
}

let busy = false;

// Estado del job de refresh de data. Es una operación larga (~20-40s): mantener
// la request HTTP abierta todo ese tiempo la hace frágil sobre el túnel ZeroTier
// (la conexión se corta y el fetch del navegador rechaza → falso "error de red").
// Por eso: POST arranca el job en background y vuelve YA; el frontend consulta
// GET /refresh-data/status hasta que termina. Sin requests largas.
let dataJob = { running: false, result: null, error: null, startedAt: null, finishedAt: null };

export default {
  name: 'tolkien',

  registerHttp(router) {
    const r = express.Router();

    // Arranca el refresh en background (idempotente si ya corre). Vuelve al toque.
    r.post('/refresh-data', (req, res) => {
      if (dataJob.running) return res.json({ started: false, running: true });
      dataJob = { running: true, result: null, error: null, startedAt: Date.now(), finishedAt: null };
      // No await: corre en background; el estado se consulta por GET /status.
      refreshLocalData()
        .then((result) => { dataJob.result = result; })
        .catch((err) => { dataJob.error = err?.message || 'error desconocido'; })
        .finally(() => { dataJob.running = false; dataJob.finishedAt = Date.now(); });
      res.json({ started: true, running: true });
    });

    // Estado del último/actual refresh (para el polling del frontend).
    r.get('/refresh-data/status', (req, res) => {
      res.json({
        running: dataJob.running,
        result: dataJob.result,
        error: dataJob.error,
        startedAt: dataJob.startedAt,
        finishedAt: dataJob.finishedAt,
      });
    });

    r.get('/status', async (req, res) => {
      try { res.json(await status()); }
      catch { res.status(500).json({ error: 'No se pudo leer el estado del repo.' }); }
    });

    r.post('/fetch', async (req, res) => {
      // Comparte el flag `busy` con /update: un fetch y un pull simultáneos
      // sobre el mismo .git contienden por locks de git y fallan espurio.
      if (busy) return res.status(409).json({ error: 'Ya hay una operación git en curso.' });
      busy = true;
      try {
        const f = await git(['fetch', '--prune', 'origin']);
        if (f.code === 0) { lastFetchAt = Date.now(); await saveLastFetchAt(lastFetchAt); }
        res.json({ ok: f.code === 0, error: f.code === 0 ? undefined : (f.stderr || 'fetch falló'), status: await status() });
      } catch {
        res.status(500).json({ error: 'No se pudo leer el estado del repo.' });
      } finally {
        busy = false;
      }
    });

    r.post('/update', async (req, res) => {
      if (busy) return res.status(409).json({ error: 'Ya hay una actualización en curso.' });
      busy = true;
      const log = [];
      try {
        const dirtyRes = await git(['status', '--porcelain']);
        if (dirtyRes.code !== 0) throw new Error(`git status falló: ${dirtyRes.stderr || 'código ' + dirtyRes.code}`);
        const dirty = dirtyRes.stdout.length > 0;

        let stashed = false;
        if (dirty) {
          const s = await git(['stash', 'push', '-u', '-m', AUTO_STASH_MSG]);
          log.push({ step: 'stash', code: s.code, out: s.stdout || s.stderr });
          const noLocalChanges = /No local changes/i.test(s.stdout + s.stderr);
          if (s.code !== 0 && !noLocalChanges) {
            // El stash falló de verdad (lock tomado, permisos, disco lleno, etc.)
            // y NO es el caso benigno de "no había nada que stashear": abortamos
            // ANTES del pull para no arriesgar los cambios locales sin respaldo.
            const st = await status();
            return res.status(409).json({
              ok: false,
              stashFailed: true,
              log,
              status: st,
              error: 'No se pudo guardar los cambios locales (git stash) antes de actualizar: se abortó antes del pull para no arriesgar tu trabajo sin respaldo. Revisá el error y volvé a intentar.',
            });
          }
          stashed = s.code === 0 && !noLocalChanges;
        }

        // SHA de HEAD ANTES del pull: si después hay que revertir, se vuelve a
        // este punto EXACTO. No se usa @{1} del reflog porque solo es "el
        // estado previo al pull" cuando el pull de verdad movió la rama; si el
        // pull falló (o fue no-op "Already up to date") @{1} apunta a un
        // movimiento de HEAD anterior y AJENO — un reset --hard ahí
        // descartaría trabajo real (hallazgo de salud 2026-07-05).
        const headBefore = await git(['rev-parse', 'HEAD']);

        const pull = await git(['pull', '--ff-only', 'origin']);
        log.push({ step: 'pull', code: pull.code, out: pull.stdout || pull.stderr });
        if (pull.code === 0) { lastFetchAt = Date.now(); await saveLastFetchAt(lastFetchAt); } // pull incluye fetch

        let popConflict = false;
        if (stashed) {
          const pop = await git(['stash', 'pop']);
          log.push({ step: 'stash-pop', code: pop.code, out: pop.stdout || pop.stderr });
          popConflict = pop.code !== 0; // conflicto al reaplicar: queda en el stash
          if (popConflict) {
            // El stash no se pudo reaplicar limpio. Revertir el avance del
            // pull SOLO si el pull fue exitoso Y movió HEAD de verdad: con
            // pull fallido (rama divergida, red) o no-op, HEAD no se movió y
            // no hay nada que revertir — resetear igual pisaría estados
            // legítimos anteriores. El stash NO se toca en ningún caso:
            // sigue intacto para reintentar a mano.
            const headNow = await git(['rev-parse', 'HEAD']);
            const pullMovedHead = pull.code === 0
              && headBefore.code === 0 && headNow.code === 0
              && headBefore.stdout && headBefore.stdout !== headNow.stdout;

            let resetFailed = false;
            if (pullMovedHead) {
              const reset = await git(['reset', '--hard', headBefore.stdout]);
              log.push({ step: 'reset-rollback', code: reset.code, out: reset.stdout || reset.stderr });
              resetFailed = reset.code !== 0;
            } else {
              log.push({ step: 'reset-rollback', code: 0, out: 'omitido: el pull no movió HEAD, no hay avance que revertir' });
            }
            const st = await status();
            return res.status(409).json({
              ok: false,
              popConflict: true,
              resetFailed,
              stashed,
              log,
              status: st,
              error: resetFailed
                ? 'No se pudieron reaplicar los cambios locales (stash) tras el pull y ADEMÁS falló el intento de revertir el avance del pull (git reset --hard): la rama puede haber quedado adelantada a mitad de camino. Tus cambios siguen en el stash — revisá el estado del repo manualmente antes de continuar.'
                : pullMovedHead
                  ? 'No se pudieron reaplicar los cambios locales (stash) tras el pull: se revirtió la actualización para no dejar el repo a mitad de camino. Tus cambios siguen a salvo en el stash — resolvelo a mano (git stash pop).'
                  : 'El pull no avanzó la rama y encima los cambios locales (stash) no se pudieron reaplicar limpios. No se revirtió nada (HEAD no se movió). Tus cambios siguen a salvo en el stash — resolvelo a mano (git stash pop).',
            });
          }
        }

        const st = await status();
        const ok = pull.code === 0 && !popConflict;
        res.json({ ok, popConflict, stashed, log, status: st });
      } catch {
        res.status(500).json({ error: 'Falló la actualización.', log });
      } finally {
        busy = false;
      }
    });

    // ───────── Acceso "un clic" al Tolkien local (inyección de sesión) ─────────
    // Problema: el server de Tolkien corre con NEXTAUTH_URL=http://localhost:3003
    // (su default de dev). Desde un dispositivo por ZeroTier el login se rompe
    // (callback a localhost, host no confiable en Auth.js v5) y la landing sólo
    // ofrece Microsoft SSO (cuyo callback de Azure no incluye la IP ZeroTier) +
    // magic-link. El dev-login (Credentials, activo con DEV_AUTH_ENABLED=1) NO
    // tiene botón en la landing y sufriría el mismo problema de host.
    //
    // Solución (SIN tocar Tolkien, sobrevive a sus updates): la CONSOLA — ya
    // autenticada y servida por ZeroTier — hace el dev-login CONTRA localhost
    // (donde el host SÍ coincide con NEXTAUTH_URL, así Auth.js no rechaza),
    // captura la cookie de sesión `tolkien.session` (un JWT auto-validable, no
    // atado a host) y redirige el navegador a la IP ZeroTier INSTALANDO esa
    // cookie. Como las cookies van por HOST y no por puerto, la que setea la
    // consola (:8092) vale para Tolkien (:3003) del mismo host. Un clic → adentro.
    //
    // Seguridad: admin-only (entra con una identidad REAL de Tolkien). Sólo
    // funciona mientras dev-login esté activo en Tolkien. Modelo de confianza de
    // la consola: todos los usuarios son del dueño (ver CLAUDE.md).
    r.get('/local-enter', async (req, res) => {
      if (!isAdmin(req)) {
        res.status(403).type('html').send(localEnterErrPage(
          'Acceso denegado',
          'Sólo un administrador puede entrar al Tolkien local desde la consola.',
        ));
        return;
      }
      const port = (process.env.CWC_TOLKIEN_LOCAL_PORT?.trim() || '3003');
      const email = (process.env.CWC_TOLKIEN_LOGIN_EMAIL?.trim() || 'nmosquera@mordorstaffing.com');
      const base = `http://localhost:${port}`;
      // Acumula Set-Cookie en un "jar" dedupeando POR NOMBRE (última ocurrencia
      // gana, como un browser/curl). Imprescindible: /api/auth/csrf devuelve DOS
      // cookies `authjs.csrf-token` con valores distintos; re-enviar ambas hace
      // que Auth.js rechace con MissingCSRF. El jar deja una sola.
      const jar = {};
      const addCookies = (setCookies) => {
        for (const c of (setCookies || [])) {
          const nv = c.split(';')[0];
          const eq = nv.indexOf('=');
          if (eq > 0) jar[nv.slice(0, eq)] = nv.slice(eq + 1);
        }
      };
      const cookieHeaderOf = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      try {
        // 1) CSRF: tomamos el token de la COOKIE (no del JSON) para garantizar
        // que coincide con la cookie que enviamos — la cookie es "token|hash".
        const csrfRes = await fetch(`${base}/api/auth/csrf`, { headers: { accept: 'application/json' } });
        if (!csrfRes.ok) throw new Error(`csrf HTTP ${csrfRes.status}`);
        addCookies(csrfRes.headers.getSetCookie?.());
        const csrfToken = decodeURIComponent(jar['authjs.csrf-token'] || '').split('|')[0];
        if (!csrfToken) throw new Error('no se obtuvo el csrfToken de Tolkien');

        // 2) dev-login callback: email de un usuario EXISTENTE activo de la DB.
        const body = new URLSearchParams({
          email, csrfToken, callbackUrl: `${base}/welcome`, json: 'true',
        });
        const loginRes = await fetch(`${base}/api/auth/callback/dev-login`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeaderOf() },
          body,
        });
        const sessionCookieRaw = (loginRes.headers.getSetCookie?.() || [])
          .find((c) => /^tolkien\.session=/.test(c));
        if (!sessionCookieRaw) {
          // Sin cookie de sesión = el login no prosperó. Causas típicas:
          // dev-login apagado (DEV_AUTH_ENABLED≠1), email inexistente/inactivo.
          throw new Error(
            `el dev-login no devolvió sesión para "${email}". `
            + 'Verificá que DEV_AUTH_ENABLED=1 en el server de Tolkien y que ese '
            + 'email exista como usuario activo (o cambiá CWC_TOLKIEN_LOGIN_EMAIL).',
          );
        }

        // 3) Redirigir a la IP ZeroTier INSTALANDO la sesión. La cookie es
        // host-only (sin Domain) → el navegador la asocia al host de la consola
        // y, como las cookies ignoran el puerto, la envía también a :3003. Sin
        // `Secure` porque Tolkien dev sirve por HTTP. Cookie de sesión (sin
        // Expires): se limpia al cerrar el navegador — un clic la repone.
        const ztIp = (findZeroTierIp()?.ip) || req.hostname;
        const nameValue = sessionCookieRaw.split(';')[0]; // "tolkien.session=<jwt>"
        res.setHeader('Set-Cookie', `${nameValue}; Path=/; HttpOnly; SameSite=Lax`);
        res.redirect(302, `http://${ztIp}:${port}/welcome`);
      } catch (err) {
        const isConn = /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(err?.message || '');
        res.status(isConn ? 502 : 500).type('html').send(localEnterErrPage(
          'No se pudo entrar al Tolkien local',
          isConn
            ? `El server de Tolkien no responde en localhost:${port}. ¿Está corriendo? `
              + '(next dev). Si usa otro puerto, seteá CWC_TOLKIEN_LOCAL_PORT.'
            : (err?.message || 'Error desconocido en el flujo de login.'),
        ));
      }
    });

    router.use('/tolkien', r);
  },
};

// Página de error mínima para /local-enter (se abre en pestaña nueva, así que
// un JSON crudo sería inútil: el usuario necesita ver qué pasó).
function localEnterErrPage(title, detail) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title>`
    + `<style>body{font-family:system-ui,sans-serif;background:#1a1512;color:#e8e0d8;`
    + `display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:1.5rem}`
    + `.c{max-width:32rem}h1{color:#d97757;font-size:1.2rem}p{line-height:1.5;color:#c8bcb0}`
    + `code{background:#2a2018;padding:.1rem .3rem;border-radius:4px}</style></head>`
    + `<body><div class="c"><h1>⚠️ ${esc(title)}</h1><p>${esc(detail)}</p></div></body></html>`;
}
