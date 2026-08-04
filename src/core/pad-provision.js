// core/pad-provision.js — provisiona el Pad PROPIO de un inquilino (B2, DOC-633):
// registra su cuenta (admin-mediado), crea su workspace aislado y aplica el
// molde declarativo versionado. Best-effort: nunca tira. El token del inquilino
// queda en su espacio (~/.cwc-users/<u>/.pad), invisible para Niko a nivel app-Pad.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { MOLD, recordMoldVersion } from './pad-mold.js';
import { PAD_DEFAULT_URL } from './pad-url.js';
import {
  ensureUserSpace,
  hostUser,
  readUserPadToken,
  sanitizeUserId,
  userPadDir,
  userPadWorkspace,
  userSpace,
  writeUserPadToken,
} from './user-space.js';

const PAD_URL = PAD_DEFAULT_URL;
// Pozo COMÚN de Mejora Continua (console:PLAN-2222): workspace neutral donde
// las lecciones de `project: tolkien` de TODOS los usuarios se agregan y suman
// recurrencia entre personas. No es de nadie: ni `console` ni un `tenant-*`.
export const SHARED_WORKSPACE = process.env.CWC_PAD_SHARED_WORKSPACE || 'comunidad';
const SHARED_COLLECTION = 'mejora-continua';
const SLEEP_MS = 400; // espaciar llamadas (rate-limit del Pad)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token ADMIN de Niko (dueño del Pad local), leído fresco de ~/.pad/credentials.json.
function readAdminToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.home, '.pad', 'credentials.json'), 'utf8'));
    return raw?.credentials?.[PAD_URL]?.token || null;
  } catch { return null; }
}

export function readHostPadToken() {
  return readAdminToken();
}

async function padFetch(method, urlPath, { token, body } = {}) {
  const res = await fetch(PAD_URL + urlPath, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

// Genera un password aleatorio (se guarda en el espacio del inquilino por si el
// token vence y hay que re-loguear).
function randomPassword() {
  return 'Cwc-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6).toUpperCase() + '9!';
}

// Garantiza el workspace neutral y su colección canónica. Todo el flujo usa la
// credencial admin porque el espacio no pertenece a ningún inquilino; cualquier
// falla se devuelve como dato para que el pozo jamás bloquee el alta principal.
export async function ensureSharedWorkspace() {
  try {
    const admin = readAdminToken();
    if (!admin) return { ok: false, workspace: SHARED_WORKSPACE, error: 'Sin token admin del Pad local' };

    const wsList = await padFetch('GET', '/api/v1/workspaces', { token: admin });
    if (wsList.status !== 200) {
      return { ok: false, workspace: SHARED_WORKSPACE, error: `listar workspaces falló: ${wsList.status} ${JSON.stringify(wsList.data).slice(0, 120)}` };
    }
    const workspaces = Array.isArray(wsList.data) ? wsList.data : (wsList.data?.workspaces || []);
    if (!workspaces.some((w) => w.slug === SHARED_WORKSPACE)) {
      await sleep(SLEEP_MS);
      const created = await padFetch('POST', '/api/v1/workspaces', {
        token: admin,
        body: { name: 'Comunidad', slug: SHARED_WORKSPACE, template: 'blank' },
      });
      if (created.status !== 201) {
        return { ok: false, workspace: SHARED_WORKSPACE, error: `workspace compartido falló: ${created.status} ${JSON.stringify(created.data).slice(0, 120)}` };
      }
    }
    await sleep(SLEEP_MS);

    const srcCols = await padFetch('GET', '/api/v1/workspaces/console/collections', { token: admin });
    if (srcCols.status !== 200) {
      return { ok: false, workspace: SHARED_WORKSPACE, error: `colección fuente falló: ${srcCols.status} ${JSON.stringify(srcCols.data).slice(0, 120)}` };
    }
    const src = Array.isArray(srcCols.data) ? srcCols.data : (srcCols.data?.collections || []);
    const sourceCollection = src.find((c) => c.slug === SHARED_COLLECTION);
    if (!sourceCollection) {
      return { ok: false, workspace: SHARED_WORKSPACE, error: `No existe la colección fuente ${SHARED_COLLECTION}` };
    }
    await sleep(SLEEP_MS);

    const existing = await padFetch('GET', `/api/v1/workspaces/${SHARED_WORKSPACE}/collections`, { token: admin });
    if (existing.status !== 200) {
      return { ok: false, workspace: SHARED_WORKSPACE, error: `listar colecciones compartidas falló: ${existing.status} ${JSON.stringify(existing.data).slice(0, 120)}` };
    }
    const collections = Array.isArray(existing.data) ? existing.data : (existing.data?.collections || []);
    if (!collections.some((c) => c.slug === SHARED_COLLECTION)) {
      await sleep(SLEEP_MS);
      // schema TAL CUAL (string crudo del GET; re-encode lo rompe — DOC-633).
      const created = await padFetch('POST', `/api/v1/workspaces/${SHARED_WORKSPACE}/collections`, {
        token: admin,
        body: {
          name: sourceCollection.name,
          slug: sourceCollection.slug,
          icon: sourceCollection.icon,
          prefix: sourceCollection.prefix,
          schema: sourceCollection.schema,
        },
      });
      if (created.status !== 201) {
        return { ok: false, workspace: SHARED_WORKSPACE, error: `colección compartida falló: ${created.status} ${JSON.stringify(created.data).slice(0, 120)}` };
      }
    }

    return { ok: true, workspace: SHARED_WORKSPACE };
  } catch (e) {
    return { ok: false, workspace: SHARED_WORKSPACE, error: String(e?.message || e).slice(0, 200) };
  }
}

// La API no permite revocar invitaciones pendientes: consultar miembros E
// invitaciones antes del POST es la barrera que evita duplicados irreversibles.
export async function inviteUserToSharedWorkspace(userId) {
  try {
    // BUG-2233: no invitar cuentas borradas o cuyo alta ya no tiene espacio vivo.
    if (!fs.existsSync(userSpace(userId))) return { ok: false, error: 'usuario sin espacio en disco' };

    const admin = readAdminToken();
    if (!admin) return { ok: false, invited: false, error: 'Sin token admin del Pad local' };
    const email = userId + '@console.local';
    const current = await padFetch('GET', `/api/v1/workspaces/${SHARED_WORKSPACE}/members`, { token: admin });
    if (current.status !== 200) {
      return { ok: false, invited: false, error: `listar membresía compartida falló: ${current.status} ${JSON.stringify(current.data).slice(0, 120)}` };
    }
    const members = Array.isArray(current.data?.members) ? current.data.members : [];
    const invitations = Array.isArray(current.data?.invitations) ? current.data.invitations : [];
    if (members.some((m) => m.user_email === email) || invitations.some((i) => i.email === email)) {
      return { ok: true, invited: false };
    }
    await sleep(SLEEP_MS);

    const invited = await padFetch('POST', `/api/v1/workspaces/${SHARED_WORKSPACE}/members/invite`, {
      token: admin,
      body: { email, role: 'editor' },
    });
    if (invited.status !== 201) {
      return { ok: false, invited: false, error: `invitación compartida falló: ${invited.status} ${JSON.stringify(invited.data).slice(0, 120)}` };
    }
    return { ok: true, invited: true };
  } catch (e) {
    return { ok: false, invited: false, error: String(e?.message || e).slice(0, 200) };
  }
}

// Provisiona (idempotente) el Pad del inquilino. Devuelve {ok, workspace, error?, alreadyProvisioned?}.
export async function provisionUserPad(userId, { name } = {}) {
  try {
    // El HOST usa su propio Pad (`~/.pad` + workspace `console`): provisionarlo
    // le crearía un `tenant-<host>` fantasma. Simétrico a provisionUserWorkspace.
    if (sanitizeUserId(userId) === hostUser()) return { ok: true, skipped: 'host' };
    ensureUserSpace(userId);
    const admin = readAdminToken();
    if (!admin) return { ok: false, error: 'Sin token admin del Pad local (Niko)' };

    const wsSlug = userPadWorkspace(userId);
    const email = userId + '@console.local';

    // 1) TOKEN del inquilino: si ya lo tenemos, reusar; si no, registrar (admin).
    let token = readUserPadToken(userId, PAD_URL);
    if (!token) {
      const password = randomPassword();
      const reg = await padFetch('POST', '/api/v1/auth/register', { token: admin, body: { email, name: name || userId, password } });
      if (reg.status === 201 && reg.data?.token) {
        token = reg.data.token;
        writeUserPadToken(userId, PAD_URL, token);
        // guardar el password (mode 600) para un re-login futuro si el token vence
        try { fs.writeFileSync(path.join(userPadDir(userId), 'password'), password, { mode: 0o600 }); } catch { /* best-effort */ }
      } else if (reg.status === 409 || /exist/i.test(JSON.stringify(reg.data))) {
        // la cuenta ya existe: intentar login con el password guardado
        let pw = null; try { pw = fs.readFileSync(path.join(userPadDir(userId), 'password'), 'utf8').trim(); } catch { /* noop */ }
        if (pw) {
          const login = await padFetch('POST', '/api/v1/auth/login', { body: { email, password: pw } });
          if (login.status === 200 && login.data?.token) { token = login.data.token; writeUserPadToken(userId, PAD_URL, token); }
        }
        if (!token) return { ok: false, error: 'La cuenta Pad ya existe pero no se pudo obtener token (sin password guardado)' };
      } else {
        return { ok: false, error: `register falló: ${reg.status} ${JSON.stringify(reg.data).slice(0, 120)}` };
      }
    }
    await sleep(SLEEP_MS);

    // 2) WORKSPACE del inquilino (idempotente): crear si no existe.
    const wsList = await padFetch('GET', '/api/v1/workspaces', { token });
    const has = Array.isArray(wsList.data) && wsList.data.some((w) => w.slug === wsSlug);
    if (!has) {
      const ws = await padFetch('POST', '/api/v1/workspaces', { token, body: { name: 'Espacio de ' + (name || userId), slug: wsSlug, template: 'blank' } });
      if (ws.status !== 201) return { ok: false, error: `workspace falló: ${ws.status} ${JSON.stringify(ws.data).slice(0, 120)}` };
    }
    await sleep(SLEEP_MS);

    // 3) COLECCIONES: aplicar el molde versionado (schema STRING crudo, DOC-633).
    const existing = await padFetch('GET', `/api/v1/workspaces/${wsSlug}/collections`, { token });
    if (existing.status !== 200) {
      return { ok: false, error: `listar colecciones falló: ${existing.status} ${JSON.stringify(existing.data).slice(0, 120)}` };
    }
    const existSlugs = new Set((Array.isArray(existing.data) ? existing.data : (existing.data?.collections || [])).map((c) => c.slug));
    for (const col of MOLD) {
      if (existSlugs.has(col.slug)) continue;
      // schema TAL CUAL (string crudo del molde; re-encode lo rompe — DOC-633).
      const created = await padFetch('POST', `/api/v1/workspaces/${wsSlug}/collections`, {
        token,
        body: { name: col.name, slug: col.slug, icon: col.icon, prefix: col.prefix, schema: col.schema },
      });
      if (created.status !== 201) {
        return { ok: false, error: `colección ${col.slug} falló: ${created.status} ${JSON.stringify(created.data).slice(0, 120)}` };
      }
      await sleep(SLEEP_MS);
    }
    recordMoldVersion(wsSlug);

    // El pozo es accesorio: sus dos pasos quedan aislados para que ni crear el
    // espacio común ni sumar membresía puedan convertir un alta válida en error.
    const shared = {};
    try {
      shared.workspace = await ensureSharedWorkspace();
    } catch (e) {
      shared.workspace = { ok: false, workspace: SHARED_WORKSPACE, error: String(e?.message || e).slice(0, 200) };
    }
    try {
      shared.membership = await inviteUserToSharedWorkspace(userId);
    } catch (e) {
      shared.membership = { ok: false, invited: false, error: String(e?.message || e).slice(0, 200) };
    }

    return { ok: true, workspace: wsSlug, shared };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
