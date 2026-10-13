// El dev-login de Tolkien sólo acepta usuarios existentes y activos. Como la DB
// local puede recrearse vacía (ocurrió el 2026-08-15), reponemos esas identidades
// automáticamente. Los roles elevados son exclusivos del desarrollo local: nunca
// se escriben en producción.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { listUsers } from '../../core/users.js';
import {
  hasInfisicalCreds,
  hostUser,
  readInfisicalAccountEmail,
  sanitizeUserId,
  userDataDir,
} from '../../core/user-space.js';
import { DEV_DB_PASSWORD, readTolkienDbPort, runCmd } from './refresh-shared.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GENERIC_MAILBOXES = new Set([
  'dev', 'admin', 'it', 'info', 'soporte', 'support', 'noreply', 'no-reply',
]);

function validEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function hostLoginEmail() {
  return validEmail(process.env.CWC_TOLKIEN_LOGIN_EMAIL?.trim() || config.instance.identity.email);
}

export function resolveTolkienLoginEmail(username) {
  let id;
  try { id = sanitizeUserId(username); }
  catch { return null; }

  if (id === hostUser()) return hostLoginEmail();

  const instance = readJson(path.join(userDataDir(id), 'instance.json'));
  let email = validEmail(instance?.identity?.email);

  if (!email) {
    const job = readJson(path.join(
      config.home,
      '.cwc-data',
      'tolkien-login-jobs',
      `${sanitizeUserId(id)}.json`,
    ));
    if (job?.status === 'ok') email = validEmail(job.account);
  }

  if (!email && hasInfisicalCreds(id)) {
    const infisicalEmail = validEmail(readInfisicalAccountEmail(id));
    // Una casilla compartida como dev@mordorstaffing.com identifica una sesión de Infisical, no a una persona.
    if (!GENERIC_MAILBOXES.has(infisicalEmail?.split('@')[0])) email = infisicalEmail;
  }

  return email && email !== hostLoginEmail() ? email : null;
}

export function localTolkienPeople() {
  const seen = new Set();
  const people = [];
  for (const user of listUsers().filter((candidate) => candidate.admin)) {
    const email = resolveTolkienLoginEmail(user.username);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    people.push({
      username: user.username,
      email,
      displayName: user.username === hostUser()
        ? (config.instance.identity.name || user.username)
        : user.username,
    });
  }
  return people;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function firstLine(value, fallback) {
  return String(value || fallback).trim().split('\n')[0] || fallback;
}

export async function ensureLocalUsers(dbName, people = localTolkienPeople()) {
  if (typeof dbName !== 'string' || !/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`nombre de DB Tolkien inválido: ${dbName || '(vacío)'}`);
  }
  if (people.length === 0) return { ok: true, upserted: 0 };

  const statements = people.map(({ email, displayName }) =>
    `INSERT INTO users (id, email, display_name, roles, is_active, created_at, updated_at) VALUES (gen_random_uuid(), ${quoteLiteral(email)}, ${quoteLiteral(displayName)}, ARRAY['superadmin','admin'], true, now(), now()) ON CONFLICT (email) DO UPDATE SET is_active = true, roles = ARRAY(SELECT DISTINCT unnest(coalesce(users.roles,'{}') || ARRAY['superadmin','admin'])), updated_at = now();`);
  const sql = `BEGIN;\n${statements.join('\n')}\nCOMMIT;`;
  const url = `postgresql://tolkien:${DEV_DB_PASSWORD}@localhost:${readTolkienDbPort()}/${dbName}`;

  try {
    const result = await runCmd('psql', [url, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
    if (result.code !== 0) {
      return { ok: false, upserted: 0, detail: firstLine(result.stderr, 'psql falló') };
    }
    return { ok: true, upserted: people.length, detail: '' };
  } catch (err) {
    return { ok: false, upserted: 0, detail: firstLine(err?.message, 'psql no ejecutó') };
  }
}
