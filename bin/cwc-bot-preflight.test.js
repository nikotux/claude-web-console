import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_REPO,
  MAX_BUNDLE_BYTES,
  MAX_REQUEST_BYTES,
  REQUEST_OVERHEAD_BYTES,
  buildRequestBody,
  decideExitCode,
  humanSummary,
  mapErrorCode,
  parseArgs,
  parseOriginUrl,
  summarizeFindings,
} from './cwc-bot-preflight.js';

const TEST_TOKEN = 'sentinel-secret-gh-token';
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(TEST_DIR, 'cwc-bot-preflight.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeGitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-bot-test-'));
  const bare = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(fakeBin);
  git(['init', '--bare', '--initial-branch=main', bare], root);
  git(['init', '--initial-branch=main'], repo);
  git(['config', 'user.name', 'Preflight Test'], repo);
  git(['config', 'user.email', 'preflight@example.test'], repo);
  fs.writeFileSync(path.join(repo, 'fixture.txt'), 'base\n');
  git(['add', 'fixture.txt'], repo);
  git(['commit', '-m', 'base'], repo);
  git(['remote', 'add', 'origin', bare], repo);
  git(['push', '-u', 'origin', 'main'], repo);
  git(['switch', '-c', 'feature/preflight'], repo);
  fs.appendFileSync(path.join(repo, 'fixture.txt'), 'feature\n');
  git(['add', 'fixture.txt'], repo);
  git(['commit', '-m', 'feature'], repo);

  const ghPath = path.join(fakeBin, 'gh');
  fs.writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' '${TEST_TOKEN}'\n`);
  fs.chmodSync(ghPath, 0o755);
  return { root, repo, fakeBin };
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function fixtureEnv(fixture, url) {
  return {
    PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH}`,
    CWC_BOT_URL: url,
    CWC_BOT_SKIP_ORIGIN_CHECK: '1',
  };
}

test('parseOriginUrl reconoce HTTPS, SSH y aliases SSH', () => {
  assert.equal(parseOriginUrl('https://github.com/Mordor-Staffing/tolkien.git'), EXPECTED_REPO);
  assert.equal(parseOriginUrl('git@github.com:Mordor-Staffing/tolkien.git'), EXPECTED_REPO);
  assert.equal(parseOriginUrl('git@github-nico:Mordor-Staffing/tolkien.git'), EXPECTED_REPO);
  assert.equal(parseOriginUrl('ssh://git@github-nico/Mordor-Staffing/tolkien.git'), EXPECTED_REPO);
  assert.equal(parseOriginUrl('https://github.com/otro/tolkien.git'), 'otro/tolkien');
  assert.equal(parseOriginUrl('/tmp/tolkien'), null);
});

test('parseArgs aplica defaults y valida opciones incompatibles', () => {
  const parsed = parseArgs(['--repo', '.', '--json', '--timeout-min=2.5', '--interval-s', '1']);
  assert.equal(parsed.json, true);
  assert.equal(parsed.timeoutMin, 2.5);
  assert.equal(parsed.intervalS, 1);
  assert.throws(() => parseArgs(['--id', 'abc', '--no-wait']), /no se pueden usar juntos/);
  assert.throws(() => parseArgs(['--timeout-min', '0']), /mayor que cero/);
});

test('buildRequestBody produce exactamente el contrato del POST', () => {
  assert.deepEqual(buildRequestBody({
    branch: 'feature/test',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    bundleB64: 'YnVuZGxl',
  }), {
    repo: EXPECTED_REPO,
    branch: 'feature/test',
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    bundle_b64: 'YnVuZGxl',
  });
  assert.equal(
    MAX_BUNDLE_BYTES,
    Math.floor((MAX_REQUEST_BYTES - REQUEST_OVERHEAD_BYTES) * 3 / 4),
  );
});

test('un bundle máximo codificado cabe en el límite del pedido', () => {
  const body = buildRequestBody({
    branch: 'feature/preflight-con-un-nombre-realista',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    bundleB64: Buffer.alloc(MAX_BUNDLE_BYTES).toString('base64'),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_REQUEST_BYTES);
});

test('mapErrorCode cubre los errores del contrato', () => {
  const codes = [
    'invalid_request',
    'invalid_token',
    'not_a_writer',
    'base_unknown',
    'body_too_large',
    'daily_cap_reached',
    'unavailable',
  ];
  for (const code of codes) assert.ok(mapErrorCode(code).length > 10, code);
  assert.match(mapErrorCode('daily_cap_reached', { retry_after_s: 90 }), /90 segundos/);
});

test('summarizeFindings y decideExitCode condensan el resultado', () => {
  assert.deepEqual(summarizeFindings([
    { severity: 'high' },
    { severity: 'HIGH' },
    { severity: 'low' },
  ]), { high: 2, low: 1 });
  assert.equal(decideExitCode({ status: 'completed', verdict: { decision: 'approve' } }), 0);
  assert.equal(decideExitCode({ status: 'completed', verdict: { decision: 'block' } }), 1);
  assert.equal(decideExitCode({ status: 'completed', verdict: { decision: 'ambiguous' } }), 1);
  assert.equal(decideExitCode({ status: 'failed' }), 4);
});

test('humanSummary prioriza blocking, P2 y P3 y conserva su escritura', () => {
  const summary = humanSummary({
    status: 'completed',
    verdict: { decision: 'block' },
    findings: [
      { id: 'F3', severity: 'P3', file: 'src/p3.js', line: 3, title: 'Mejora P3' },
      { id: 'FL', severity: 'low', file: 'src/low.js', line: 5, title: 'Mejora low' },
      { id: 'FB', severity: 'blocking', file: 'src/blocking.js', line: 1, title: 'Bloqueante' },
      { id: 'F2', severity: 'P2', file: 'src/p2.js', line: 2, title: 'Mejora P2' },
      { id: 'FH', severity: 'high', file: 'src/high.js', line: 4, title: 'Mejora high' },
    ],
  });

  assert.match(summary, /Hallazgos: 5 \(blocking: 1, P2: 1, P3: 1, high: 1, low: 1\)/);
  assert.deepEqual(
    summary.split('\n').slice(2).map((line) => line.match(/^\[([^\]]+)\]/)?.[1]),
    ['blocking', 'P2', 'P3', 'high', 'low'],
  );
});

test('end-to-end: envía bundle y espera queued → running → completed', async (t) => {
  const fixture = makeGitFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let pollCount = 0;
  let submittedBody;
  const { server, url } = await listen((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${TEST_TOKEN}`);
    if (request.method === 'POST' && request.url === '/preflight') {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        submittedBody = JSON.parse(raw);
        jsonResponse(response, 202, { id: 'pf-e2e', status: 'queued' });
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/preflight/pf-e2e') {
      pollCount += 1;
      if (pollCount === 1) return jsonResponse(response, 200, { id: 'pf-e2e', status: 'queued' });
      if (pollCount === 2) return jsonResponse(response, 200, { id: 'pf-e2e', status: 'running' });
      return jsonResponse(response, 200, {
        id: 'pf-e2e',
        status: 'completed',
        head_sha: submittedBody.head_sha,
        mode: 'full',
        verdict: { decision: 'block' },
        findings: [
          { id: 'F1', severity: 'high', category: 'bug', file: 'src/a.js', line: 8, title: 'Falla A', scenario: 'A', status: 'open' },
          { id: 'F2', severity: 'low', category: 'style', file: 'src/b.js', line: 3, title: 'Falla B', scenario: 'B', status: 'open' },
        ],
        suggestions: [],
        reason: null,
      });
    }
    jsonResponse(response, 404, { error: 'not_found' });
  });
  t.after(() => closeServer(server));

  const result = await runCli([
    '--repo', fixture.repo,
    '--json',
    '--interval-s', '0.01',
    '--timeout-min', '1',
  ], fixtureEnv(fixture, url));

  assert.equal(result.signal, null);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(pollCount, 3);
  assert.equal(submittedBody.repo, EXPECTED_REPO);
  assert.equal(submittedBody.branch, 'feature/preflight');
  assert.match(submittedBody.head_sha, /^[0-9a-f]{40}$/);
  assert.match(submittedBody.base_sha, /^[0-9a-f]{40}$/);
  assert.ok(Buffer.from(submittedBody.bundle_b64, 'base64').byteLength > 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.verdict.decision, 'block');
  assert.equal(output.findings.length, 2);
  assert.equal(output.branch, 'feature/preflight');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN));
});

test('POST 404 sale con código 3 y explica que Desk #1510 no está desplegado', async (t) => {
  const fixture = makeGitFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const { server, url } = await listen((request, response) => {
    request.resume();
    jsonResponse(response, 404, { error: 'not_found' });
  });
  t.after(() => closeServer(server));

  const result = await runCli(['--repo', fixture.repo], fixtureEnv(fixture, url));
  assert.equal(result.code, 3);
  assert.match(result.stderr, /todavía no tiene el modo preflight desplegado \(Desk #1510\)/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN));
});

test('POST 429 muestra el límite y jamás filtra el token', async (t) => {
  const fixture = makeGitFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const { server, url } = await listen((request, response) => {
    request.resume();
    jsonResponse(response, 429, { error: 'daily_cap_reached', retry_after_s: 120 });
  });
  t.after(() => closeServer(server));

  const result = await runCli(['--repo', fixture.repo], fixtureEnv(fixture, url));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /límite diario/);
  assert.match(result.stderr, /120 segundos/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN));
});
