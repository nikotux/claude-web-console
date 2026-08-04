// modules/onboard/smoke.js — pruebas reales y aisladas antes de cerrar el alta.
//
// Ninguna sonda hereda el entorno del server: los procesos parten siempre de
// userRunnerEnv(user), con el HOME y las credenciales de ESE usuario. Las
// respuestas se reducen a estados seguros; nunca se devuelven tokens, rutas
// absolutas ni salida cruda de comandos.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import { config } from '../../core/config.js';
import { PAD_DEFAULT_URL } from '../../core/pad-url.js';
import {
  readUserOauthToken,
  readUserPadToken,
  sanitizeUserId,
  userClaudeDir,
  userPadWorkspace,
  userRunnerEnv,
  userWorkspace,
} from '../../core/user-space.js';

const COMMAND_MAX_BUFFER = 1024 * 1024;
const PAD_URL = PAD_DEFAULT_URL;
const TOLKIEN_JOBS_DIR = path.join(config.home, '.cwc-data', 'tolkien-setup');

function result(id, labelEs, status, detail, fixHint = null) {
  return { id, labelEs, status, detail, fixHint };
}

function runFile(command, args, options) {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      timeout: options.timeoutMs,
      maxBuffer: COMMAND_MAX_BUFFER,
      cwd: options.cwd,
      env: options.env,
    }, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* el callback principal reporta el fallo */ });
      child.stdin.end(options.input);
    }
  });
}

function runPty(command, args, options) {
  return new Promise((resolve) => {
    let proc;
    let timer;
    let settled = false;
    let output = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...value, output });
    };
    try {
      proc = pty.spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        cols: 80,
        rows: 24,
      });
      proc.onData((data) => {
        try { output = (output + String(data || '')).slice(-4096); } catch { /* noop */ }
      });
      proc.onExit((event) => {
        try { finish({ exitCode: event?.exitCode }); } catch { finish({ error: true }); }
      });
      timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ya terminó */ }
        finish({ error: true, timedOut: true });
      }, options.timeoutMs);
    } catch {
      finish({ error: true });
    }
  });
}

function withTimeout(work, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(work), timeout])
    .finally(() => clearTimeout(timer));
}

function curlQuoted(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function curlProbeConfig(url, headers) {
  return [
    'silent',
    'show-error',
    'output = "/dev/null"',
    'write-out = "%{http_code}"',
    'connect-timeout = 5',
    'max-time = 8',
    `url = ${curlQuoted(url)}`,
    ...headers.map((header) => `header = ${curlQuoted(header)}`),
    '',
  ].join('\n');
}

function readClaudeCredential(user) {
  const setupToken = readUserOauthToken(user);
  if (setupToken) return setupToken;
  try {
    const credentials = JSON.parse(
      fs.readFileSync(path.join(userClaudeDir(user), '.credentials.json'), 'utf8'),
    );
    const accessToken = credentials?.claudeAiOauth?.accessToken;
    return typeof accessToken === 'string' && accessToken ? accessToken : null;
  } catch {
    return null;
  }
}

function isInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

async function checkChat(user) {
  const id = 'chat';
  const label = 'Chat con Claude';
  try {
    return await withTimeout(async () => {
      const credential = readClaudeCredential(user);
      if (!credential) {
        return result(
          id,
          label,
          'fail',
          'Claude no encontró una credencial propia para este usuario.',
          'Volvé al paso de Claude y completá la autorización con la cuenta de este usuario.',
        );
      }
      const execution = await runFile('curl', ['--config', '-'], {
        cwd: userWorkspace(user),
        env: userRunnerEnv(user, { oauthToken: credential }),
        timeoutMs: 10_000,
        input: curlProbeConfig('https://api.anthropic.com/v1/models?limit=1', [
          `Authorization: Bearer ${credential}`,
          'anthropic-version: 2023-06-01',
          'anthropic-beta: oauth-2025-04-20',
        ]),
      });
      const status = Number(execution.stdout.trim());
      if (!execution.error && status >= 200 && status < 300) {
        return result(
          id,
          label,
          'ok',
          'La credencial de Claude fue aceptada. La prueba no generó texto ni consumió tokens.',
        );
      }
      if (execution.error || !Number.isInteger(status) || status === 0) {
        return result(
          id,
          label,
          'fail',
          'No se pudo llegar al servicio de Claude para validar la credencial.',
          'Revisá la conexión de red del servidor y reintentá; si persiste, repetí la autorización de Claude.',
        );
      }
      return result(
        id,
        label,
        'fail',
        `Claude rechazó la credencial${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`,
        'Volvé a conectar Claude con la cuenta de este usuario y reintentá la verificación.',
      );
    }, 11_000, 'La validación de Claude superó el tiempo máximo.');
  } catch {
    return result(
      id,
      label,
      'fail',
      'La validación de Claude no terminó a tiempo.',
      'Revisá la conectividad del servidor y reintentá; si vuelve a fallar, reconectá Claude.',
    );
  }
}

async function checkTerminal(user) {
  const id = 'terminal';
  const label = 'Terminal';
  try {
    return await withTimeout(async () => {
      const workspace = await fs.promises.realpath(userWorkspace(user));
      const execution = await runPty('/bin/pwd', [], {
        cwd: workspace,
        env: userRunnerEnv(user),
        timeoutMs: 5_000,
      });
      if (execution.error || execution.exitCode !== 0) {
        return result(
          id,
          label,
          'fail',
          'No se pudo iniciar un proceso de terminal con el entorno del usuario.',
          'Reintentá la preparación del workspace y verificá que el usuario tenga acceso a su espacio.',
        );
      }
      const reportedCwd = execution.output.replace(/\r/g, '').trim();
      const resolvedCwd = await fs.promises.realpath(reportedCwd);
      if (!isInside(workspace, resolvedCwd)) {
        return result(
          id,
          label,
          'fail',
          'La terminal inició fuera del workspace asignado.',
          'Revisá la resolución del cwd de terminal para que quede confinada al workspace del usuario.',
        );
      }
      return result(id, label, 'ok', 'La terminal inició dentro del workspace del usuario.');
    }, 6_000, 'La prueba de terminal superó el tiempo máximo.');
  } catch {
    return result(
      id,
      label,
      'fail',
      'No se pudo resolver o abrir el workspace de la terminal.',
      'Reintentá la preparación del workspace y comprobá sus permisos antes de volver a probar.',
    );
  }
}

async function checkMcp(user) {
  const id = 'mcp';
  const label = 'MCP de Tolkien';
  try {
    return await withTimeout(async () => {
      const workspace = userWorkspace(user);
      const tolkien = path.join(workspace, 'tolkien');
      const cwd = fs.existsSync(tolkien) ? tolkien : workspace;
      const execution = await runFile('claude', ['mcp', 'list'], {
        cwd,
        env: userRunnerEnv(user, { oauthToken: readClaudeCredential(user) || undefined }),
        timeoutMs: 15_000,
      });
      if (!execution.error && `${execution.stdout}\n${execution.stderr}`.includes('tolkien-mordor')) {
        return result(id, label, 'ok', 'Claude respondió y listó el servidor tolkien-mordor.');
      }
      return result(
        id,
        label,
        'fail',
        'Claude no pudo listar el servidor tolkien-mordor para este usuario.',
        'Reintentá la preparación del MCP de Tolkien y luego abrí una sesión nueva para cargar su configuración.',
      );
    }, 16_000, 'La prueba del MCP superó el tiempo máximo.');
  } catch {
    return result(
      id,
      label,
      'fail',
      'La consulta del MCP no terminó correctamente.',
      'Verificá que Claude esté disponible en el PATH del usuario y reintentá el provisioning del MCP.',
    );
  }
}

async function checkPad(user) {
  const id = 'pad';
  const label = 'Workspace de Pad';
  try {
    return await withTimeout(async () => {
      const token = readUserPadToken(user, PAD_URL);
      const workspace = userPadWorkspace(user);
      if (!token) {
        return result(
          id,
          label,
          'fail',
          'No hay una credencial propia de Pad para este usuario.',
          'Reintentá la preparación de Pad desde el onboarding; la prueba nunca usa la credencial del host como reemplazo.',
        );
      }
      const execution = await runFile('curl', ['--config', '-'], {
        cwd: userWorkspace(user),
        env: userRunnerEnv(user),
        timeoutMs: 10_000,
        input: curlProbeConfig(
          `${PAD_URL}/api/v1/workspaces/${encodeURIComponent(workspace)}/collections`,
          [`Authorization: Bearer ${token}`],
        ),
      });
      const status = Number(execution.stdout.trim());
      if (!execution.error && status >= 200 && status < 300) {
        return result(id, label, 'ok', `El usuario pudo leer su workspace Pad ${workspace}.`);
      }
      if (execution.error || !Number.isInteger(status) || status === 0) {
        return result(
          id,
          label,
          'fail',
          'No se pudo llegar al servicio Pad para comprobar el workspace.',
          'Revisá que el Pad local esté accesible y reintentá; esta sonda es solo de lectura.',
        );
      }
      return result(
        id,
        label,
        'fail',
        `Pad rechazó la lectura del workspace${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`,
        'Reintentá la preparación de Pad para crear o autorizar el workspace propio del usuario.',
      );
    }, 11_000, 'La prueba de Pad superó el tiempo máximo.');
  } catch {
    return result(
      id,
      label,
      'fail',
      'La lectura de Pad no terminó correctamente.',
      'Revisá el servicio Pad y reintentá el provisioning del workspace del usuario.',
    );
  }
}

function safeStepStatus(step) {
  const status = String(step?.status || 'pending');
  return ['pending', 'running', 'done', 'skipped', 'error'].includes(status)
    ? status
    : 'desconocido';
}

async function checkTolkien(user) {
  const id = 'tolkien';
  const label = 'Compilación de Tolkien';
  try {
    return await withTimeout(async () => {
      const jobFile = path.join(TOLKIEN_JOBS_DIR, `${user}.json`);
      let job;
      try {
        job = JSON.parse(await fs.promises.readFile(jobFile, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return result(
            id,
            label,
            'skip',
            'Todavía no existe un job de preparación de Tolkien para este usuario.',
            `Lanzalo con: node bin/cwc-tolkien-setup-runner.js --user ${user}`,
          );
        }
        throw error;
      }
      if (job?.user !== user || !job.steps || typeof job.steps !== 'object') {
        return result(
          id,
          label,
          'fail',
          'El job de Tolkien no tiene un estado válido para este usuario.',
          'Volvé a lanzar el runner de preparación de Tolkien para regenerar su estado.',
        );
      }
      const stepNames = ['store', 'install', 'build', 'typecheck'];
      const steps = stepNames.map((name) => `${name}=${safeStepStatus(job.steps[name])}`);
      const jobStatus = safeStepStatus(job);
      const detail = `Estado ${jobStatus}; pasos: ${steps.join(', ')}.`;
      const failed = jobStatus === 'error'
        || stepNames.some((name) => safeStepStatus(job.steps[name]) === 'error');
      if (failed) {
        return result(
          id,
          label,
          'fail',
          detail,
          `Corregí el paso fallido y reanudá con: node bin/cwc-tolkien-setup-runner.js --user ${user}`,
        );
      }
      const complete = jobStatus === 'done'
        && stepNames.every((name) => ['done', 'skipped'].includes(safeStepStatus(job.steps[name])));
      if (complete) return result(id, label, 'ok', detail);
      return result(
        id,
        label,
        'skip',
        detail,
        'La preparación sigue pendiente o en curso; esperá a que termine y reintentá esta prueba.',
      );
    }, 2_000, 'La lectura del job de Tolkien superó el tiempo máximo.');
  } catch {
    return result(
      id,
      label,
      'fail',
      'No se pudo leer el estado de preparación de Tolkien.',
      `Revisá el job y reanudá con: node bin/cwc-tolkien-setup-runner.js --user ${user}`,
    );
  }
}

export async function runSmokeChecks(user) {
  const id = sanitizeUserId(user);
  return Promise.all([
    checkChat(id),
    checkTerminal(id),
    checkMcp(id),
    checkPad(id),
    checkTolkien(id),
  ]);
}
