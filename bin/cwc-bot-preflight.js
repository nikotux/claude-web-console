#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXPECTED_REPO = 'Mordor-Staffing/tolkien';
export const DEFAULT_BOT_URL = 'https://pr-review.tolkien.mordorstaffing.com';
export const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
export const REQUEST_OVERHEAD_BYTES = 64 * 1024;
export const MAX_BUNDLE_BYTES = Math.floor((MAX_REQUEST_BYTES - REQUEST_OVERHEAD_BYTES) * 3 / 4);
export const DEFAULT_TIMEOUT_MIN = 20;
export const DEFAULT_INTERVAL_S = 15;

const EXIT_REVIEW_OK = 0;
const EXIT_REVIEW_NOT_OK = 1;
const EXIT_LOCAL_ERROR = 2;
const EXIT_NOT_AVAILABLE = 3;
const EXIT_RUN_FAILED = 4;
const COMPLETED = 'completed';
const FAILED = 'failed';

class CliError extends Error {
  constructor(message, exitCode = EXIT_LOCAL_ERROR) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return [
    'Uso: node bin/cwc-bot-preflight.js [opciones]',
    '',
    '  --repo <path>       Repo de Tolkien (default: cwd)',
    '  --json              Salida JSON',
    '  --no-wait           Envía la revisión e imprime el id',
    '  --id <id>           Espera una revisión ya enviada',
    `  --timeout-min <n>   Timeout en minutos (default: ${DEFAULT_TIMEOUT_MIN})`,
    `  --interval-s <n>    Intervalo de consulta en segundos (default: ${DEFAULT_INTERVAL_S})`,
  ].join('\n');
}

export function parseArgs(argv) {
  const options = {
    repo: process.cwd(),
    json: false,
    noWait: false,
    id: null,
    timeoutMin: DEFAULT_TIMEOUT_MIN,
    intervalS: DEFAULT_INTERVAL_S,
    help: false,
  };
  const valueFlags = new Map([
    ['--repo', 'repo'],
    ['--id', 'id'],
    ['--timeout-min', 'timeoutMin'],
    ['--interval-s', 'intervalS'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--no-wait') options.noWait = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      const equalsAt = arg.indexOf('=');
      const flag = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
      const key = valueFlags.get(flag);
      if (!key) throw new CliError(`Opción desconocida: ${arg}`);
      const value = equalsAt === -1 ? argv[index + 1] : arg.slice(equalsAt + 1);
      if (equalsAt === -1) index += 1;
      if (!value || value.startsWith('--')) throw new CliError(`Falta el valor de ${flag}.`);
      options[key] = value;
    }
  }

  options.timeoutMin = Number(options.timeoutMin);
  options.intervalS = Number(options.intervalS);
  if (!Number.isFinite(options.timeoutMin) || options.timeoutMin <= 0) {
    throw new CliError('--timeout-min debe ser un número mayor que cero.');
  }
  if (!Number.isFinite(options.intervalS) || options.intervalS <= 0) {
    throw new CliError('--interval-s debe ser un número mayor que cero.');
  }
  if (options.noWait && options.id) throw new CliError('--no-wait y --id no se pueden usar juntos.');
  options.repo = path.resolve(options.repo);
  return options;
}

export function parseOriginUrl(originUrl) {
  const value = String(originUrl || '').trim();
  let repoPath = null;

  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'ssh:' && parsed.hostname.toLowerCase() !== 'github.com') return null;
      repoPath = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const scpLike = value.match(/^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/);
    if (!scpLike) return null;
    repoPath = scpLike[1];
  }

  const normalized = repoPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const parts = normalized.split('/');
  if (parts.length !== 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

export function buildRequestBody({ branch, headSha, baseSha, bundleB64 }) {
  return {
    repo: EXPECTED_REPO,
    branch,
    head_sha: headSha,
    base_sha: baseSha,
    bundle_b64: bundleB64,
  };
}

export function mapErrorCode(code, payload = {}) {
  const messages = {
    invalid_request: 'El pedido de preflight no es válido.',
    invalid_token: 'El token de GitHub no es válido; corré gh auth login.',
    not_a_writer: 'Tu usuario de GitHub no tiene permisos de escritura en Tolkien.',
    base_unknown: 'El bot no reconoce la base de esta rama. Actualizá origin/main y volvé a intentar.',
    body_too_large: 'El bundle supera el tamaño aceptado por el bot.',
    daily_cap_reached: 'Se alcanzó el límite diario de revisiones del bot.',
    unavailable: 'El bot de revisión no está disponible en este momento.',
  };
  let message = messages[code] || 'El bot rechazó el pedido de preflight.';
  if (code === 'daily_cap_reached' && Number.isFinite(Number(payload.retry_after_s))) {
    message += ` Reintentá en ${Number(payload.retry_after_s)} segundos.`;
  }
  return message;
}

export function summarizeFindings(findings = []) {
  return findings.reduce((counts, finding) => {
    const severity = String(finding?.severity || 'unknown').toLowerCase();
    counts[severity] = (counts[severity] || 0) + 1;
    return counts;
  }, {});
}

export function decideExitCode(result) {
  if (!result || result.status === FAILED) return EXIT_RUN_FAILED;
  if (result.status !== COMPLETED) return EXIT_RUN_FAILED;
  return result.verdict?.decision === 'approve' ? EXIT_REVIEW_OK : EXIT_REVIEW_NOT_OK;
}

function run(command, args, cwd, failureMessage) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new CliError(failureMessage);
  }
}

function git(args, repo, failureMessage) {
  return run('git', args, repo, failureMessage);
}

function inspectCheckout(repo, { fetchMain }) {
  let inside;
  try {
    inside = git(['rev-parse', '--is-inside-work-tree'], repo, 'La ruta indicada no es un checkout de git.');
  } catch {
    throw new CliError('La ruta indicada no es un checkout de git.');
  }
  if (inside !== 'true') throw new CliError('La ruta indicada no es un checkout de git.');

  const origin = git(['remote', 'get-url', 'origin'], repo, 'El checkout no tiene un remote origin válido.');
  // Exclusivo para el mock end-to-end: permite que origin sea un bare repo local.
  if (process.env.CWC_BOT_SKIP_ORIGIN_CHECK !== '1' && parseOriginUrl(origin) !== EXPECTED_REPO) {
    throw new CliError('El remote origin no apunta a Mordor-Staffing/tolkien.');
  }

  const branch = git(
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    repo,
    'HEAD está detached; cambiá a una rama antes de correr el preflight.',
  );
  if (fetchMain) {
    git(['fetch', 'origin', 'main'], repo, 'No se pudo actualizar origin/main.');
  }
  const headSha = git(['rev-parse', 'HEAD'], repo, 'No se pudo resolver HEAD.');
  return { branch, headSha };
}

function prepareSubmission(repo) {
  const checkout = inspectCheckout(repo, { fetchMain: true });
  const baseSha = git(
    ['merge-base', 'origin/main', 'HEAD'],
    repo,
    'No se pudo calcular la base común con origin/main.',
  );
  const commitCount = Number(git(
    ['rev-list', '--count', 'origin/main..HEAD'],
    repo,
    'No se pudo comparar HEAD con origin/main.',
  ));
  if (!commitCount) throw new CliError('No hay commits para revisar.');

  const dirty = git(['status', '--porcelain'], repo, 'No se pudo revisar el estado del checkout.');
  if (dirty) {
    console.error('WARNING: hay cambios sin commit; el bot revisará únicamente el HEAD confirmado.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-bot-preflight-'));
  try {
    const bundlePath = path.join(tempDir, 'pf.bundle');
    git(
      ['bundle', 'create', bundlePath, 'origin/main..HEAD'],
      repo,
      'No se pudo crear el bundle para el preflight.',
    );
    const bundle = fs.readFileSync(bundlePath);
    if (bundle.byteLength > MAX_BUNDLE_BYTES) {
      throw new CliError(`El bundle supera el límite local de ${(MAX_BUNDLE_BYTES / 1024 / 1024).toFixed(1)} MiB.`);
    }
    return {
      ...checkout,
      body: buildRequestBody({
        branch: checkout.branch,
        headSha: checkout.headSha,
        baseSha,
        bundleB64: bundle.toString('base64'),
      }),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function githubToken() {
  let token;
  try {
    token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new CliError('No hay una sesión válida de GitHub; corré gh auth login.');
  }
  if (!token) throw new CliError('No hay una sesión válida de GitHub; corré gh auth login.');
  return token;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function apiError(response, payload) {
  if (response.status === 404) {
    return new CliError(
      'El bot todavía no tiene el modo preflight desplegado (Desk #1510).',
      EXIT_NOT_AVAILABLE,
    );
  }
  const code = payload?.error;
  const exitCode = response.status === 503 || code === 'unavailable'
    ? EXIT_NOT_AVAILABLE
    : EXIT_LOCAL_ERROR;
  return new CliError(mapErrorCode(code, payload), exitCode);
}

async function apiRequest(url, token, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new CliError('No se pudo conectar con el bot de revisión.', EXIT_NOT_AVAILABLE);
  }
  const payload = await readJson(response);
  if (!response.ok) throw apiError(response, payload);
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollRun({ baseUrl, id, token, timeoutMin, intervalS }) {
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  const encodedId = encodeURIComponent(id);
  while (true) {
    const result = await apiRequest(`${baseUrl}/preflight/${encodedId}`, token);
    if (result.status === COMPLETED || result.status === FAILED) return result;
    if (Date.now() >= deadline) {
      throw new CliError(`El preflight superó el timeout de ${timeoutMin} minutos.`, EXIT_RUN_FAILED);
    }
    await sleep(intervalS * 1000);
  }
}

const PRIMARY_SEVERITIES = ['blocking', 'P2', 'P3'];

function compareSeverities(left, right) {
  const leftRank = PRIMARY_SEVERITIES.indexOf(left);
  const rightRank = PRIMARY_SEVERITIES.indexOf(right);
  if (leftRank !== -1 || rightRank !== -1) {
    return (leftRank === -1 ? PRIMARY_SEVERITIES.length : leftRank)
      - (rightRank === -1 ? PRIMARY_SEVERITIES.length : rightRank);
  }
  return left.localeCompare(right);
}

export function humanSummary(result) {
  if (result.status === FAILED) {
    return `Preflight fallido${result.reason ? `: ${result.reason}` : '.'}`;
  }
  const decision = result.verdict?.decision || 'sin veredicto';
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const counts = findings.reduce((severityCounts, finding) => {
    const severity = String(finding?.severity || 'unknown');
    severityCounts[severity] = (severityCounts[severity] || 0) + 1;
    return severityCounts;
  }, {});
  const countParts = Object.keys(counts)
    .sort(compareSeverities)
    .map((severity) => `${severity}: ${counts[severity]}`);
  const lines = [
    `Veredicto: ${decision}`,
    `Hallazgos: ${findings.length}${countParts.length ? ` (${countParts.join(', ')})` : ''}`,
  ];
  const sortedFindings = findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => {
      const severityOrder = compareSeverities(
        String(left.finding?.severity || 'unknown'),
        String(right.finding?.severity || 'unknown'),
      );
      return severityOrder || left.index - right.index;
    })
    .map(({ finding }) => finding);
  for (const finding of sortedFindings) {
    const severity = finding.severity || 'unknown';
    const id = finding.id || 'F?';
    const file = finding.file || '(sin archivo)';
    const location = finding.line == null ? file : `${file}:${finding.line}`;
    lines.push(`[${severity}] ${id} ${location} — ${finding.title || '(sin título)'}`);
  }
  return lines.join('\n');
}

function printResult(result, context, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ ...result, branch: context.branch, head_sha: result.head_sha || context.headSha }, null, 2));
  } else {
    console.log(humanSummary(result));
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return EXIT_REVIEW_OK;
  }

  const baseUrl = (process.env.CWC_BOT_URL || DEFAULT_BOT_URL).replace(/\/+$/, '');
  let context;
  let id = options.id;
  let token;

  if (id) {
    context = inspectCheckout(options.repo, { fetchMain: false });
    token = githubToken();
  } else {
    context = prepareSubmission(options.repo);
    const requestBody = JSON.stringify(context.body);
    if (Buffer.byteLength(requestBody, 'utf8') > MAX_REQUEST_BYTES) {
      throw new CliError(`El pedido supera el límite local de ${(MAX_REQUEST_BYTES / 1024 / 1024).toFixed(1)} MiB.`);
    }
    token = githubToken();
    const submitted = await apiRequest(`${baseUrl}/preflight`, token, {
      method: 'POST',
      body: requestBody,
    });
    if (!submitted.id) throw new CliError('El bot respondió sin un id de preflight.', EXIT_RUN_FAILED);
    id = submitted.id;
    if (options.noWait) {
      if (options.json) {
        console.log(JSON.stringify({ ...submitted, branch: context.branch, head_sha: context.headSha }, null, 2));
      } else {
        console.log(id);
      }
      return EXIT_REVIEW_OK;
    }
  }

  const result = await pollRun({
    baseUrl,
    id,
    token,
    timeoutMin: options.timeoutMin,
    intervalS: options.intervalS,
  });
  printResult(result, context, options.json);
  return decideExitCode(result);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      const safeError = error instanceof CliError
        ? error
        : new CliError('El preflight falló por un error inesperado.', EXIT_RUN_FAILED);
      console.error(safeError.message);
      process.exitCode = safeError.exitCode;
    },
  );
}
