// modules/onboard/tolkien-mcp-shared.js — provisioning del MCP HTTP de Tolkien.
//
// El .mcp.json del repo exige un bearer per-dev que el inquilino no hereda. El
// host no lo necesita: usa su MCP stdio de scope local bajo `infisical run`,
// que pisa esa declaración. Por eso este flujo actúa solo sobre inquilinos.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import {
  hasTolkienMcpToken,
  hostUser,
  readUserTolkienMcpToken,
  sanitizeUserId,
  userRunnerEnv,
  userSpace,
  userTolkienMcpTokenPath,
  userWorkspace,
} from '../../core/user-space.js';

const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

function redact(s) {
  return String(s || '')
    .replace(/mcp_[A-Za-z0-9_-]+/g, 'mcp_****')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-****');
}

function cloneDir(userId) {
  return path.join(userWorkspace(userId), 'tolkien');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function declaredServer(userId) {
  const decl = readJson(path.join(cloneDir(userId), '.mcp.json'))
    ?.mcpServers?.['tolkien-mordor'];
  return decl && typeof decl === 'object' ? decl : null;
}

function isRegistered(userId) {
  const clone = cloneDir(userId);
  const cliConfig = readJson(path.join(userSpace(userId), '.claude.json'));
  return !!cliConfig?.projects?.[clone]?.mcpServers?.['tolkien-mordor'];
}

function runFile(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      ...options,
    }, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function commandError(result, fallback) {
  if (result.error?.code === 'ENOENT') return fallback;
  const detail = result.stderr || result.error?.message || result.stdout;
  return redact(detail).trim().slice(0, 500) || fallback;
}

function mintTokenFrom(response) {
  const candidates = [
    response?.token,
    response?.mcpToken,
    response?.data?.token,
  ];
  return candidates.find((value) => typeof value === 'string' && value.startsWith('mcp_')) || null;
}

export function tolkienMcpStatus(userId) {
  const status = { hasToken: false, registered: false, url: null };
  try {
    const id = sanitizeUserId(userId);
    status.hasToken = hasTolkienMcpToken(id);
    status.registered = isRegistered(id);
    const url = declaredServer(id)?.url;
    status.url = typeof url === 'string' && url.trim() ? url.trim() : null;
  } catch {
    // Best-effort: el checklist nunca debe romper por config/FS inesperados.
  }
  return status;
}

export async function provisionTolkienMcp(userId, { force = false } = {}) {
  try {
    const id = sanitizeUserId(userId);
    if (id === hostUser()) return { ok: true, skipped: true, reason: 'host' };

    if (!force && isRegistered(id)) {
      return { ok: true, skipped: true, reason: 'ya-registrado' };
    }

    const server = declaredServer(id);
    const authorization = server?.headers?.Authorization;
    const url = typeof server?.url === 'string' ? server.url.trim() : '';
    if (
      server?.type !== 'http'
      || !url
      || typeof authorization !== 'string'
      || !authorization.includes('${TOLKIEN_MCP_TOKEN}')
    ) {
      return { ok: false, reason: 'mcp-json-inesperado' };
    }

    let token = !force ? readUserTolkienMcpToken(id) : null;
    if (!token) {
      const projectId = config.instance.client.infisicalProjectId;
      if (!projectId) return { ok: false, error: 'Falta infisicalProjectId en la configuración de instancia.' };

      const mintScript = `curl -s -X POST "$TOLKIEN_API_BASE/internal/mcp/tokens" -H "X-Tolkien-API-Key: $TOLKIEN_INTERNAL_API_KEY" -H "Content-Type: application/json" -d '{"label":"${id}-console","actor":"${id}"}'`;
      const minted = await runFile('infisical', [
        'run',
        '--projectId', projectId,
        '--env', 'prod',
        '--',
        'sh', '-c', mintScript,
      ], {
        cwd: config.projectDir || config.home,
        env: { ...process.env, HOME: config.home },
      });
      if (minted.error) {
        return {
          ok: false,
          error: commandError(minted, 'No se pudo acuñar el token MCP con Infisical.'),
        };
      }

      let payload;
      try {
        payload = JSON.parse(minted.stdout);
      } catch {
        return { ok: false, error: 'La API de Tolkien devolvió una respuesta JSON inválida.' };
      }
      token = mintTokenFrom(payload);
      if (!token) return { ok: false, error: 'La API de Tolkien no devolvió un token MCP válido.' };
    }

    const tokenPath = userTolkienMcpTokenPath(id);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);

    const registered = await runFile('claude', [
      'mcp',
      'add',
      '--scope', 'local',
      '--transport', 'http',
      'tolkien-mordor',
      url,
      '--header', `Authorization: Bearer ${token}`,
    ], {
      cwd: cloneDir(id),
      env: { ...userRunnerEnv(id), HOME: userSpace(id) },
    });
    if (registered.error) {
      return {
        ok: false,
        error: commandError(registered, 'El binario claude no está disponible en PATH.'),
      };
    }

    if (!isRegistered(id)) {
      return { ok: false, error: 'Claude no registró tolkien-mordor en el scope local del inquilino.' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: redact(error?.message || error).slice(0, 500) };
  }
}
