// core/pad-provision.js — provisiona el Pad PROPIO de un inquilino (B2, DOC-633):
// registra su cuenta (admin-mediado), crea su workspace aislado y clona las
// colecciones de 'console'. Best-effort: nunca tira. El token del inquilino
// queda en su espacio (~/.cwc-users/<u>/.pad), invisible para Niko a nivel app-Pad.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { userPadWorkspace, writeUserPadToken, readUserPadToken, userPadDir, ensureUserSpace } from './user-space.js';

const PAD_URL = process.env.CWC_PAD_URL || 'http://10.213.222.62:7777';
// Las 6 colecciones que los módulos de inquilino usan (se clonan de 'console').
const TENANT_COLLECTIONS = ['pendientes', 'planes', 'temas-de-aprendizaje', 'rutas-de-aprendizaje', 'mejora-continua', 'contexto-de-tickets'];
const SLEEP_MS = 400; // espaciar llamadas (rate-limit del Pad)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token ADMIN de Niko (dueño del Pad local), leído fresco de ~/.pad/credentials.json.
function readAdminToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.home, '.pad', 'credentials.json'), 'utf8'));
    return raw?.credentials?.[PAD_URL]?.token || null;
  } catch { return null; }
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

// Provisiona (idempotente) el Pad del inquilino. Devuelve {ok, workspace, error?, alreadyProvisioned?}.
export async function provisionUserPad(userId, { name } = {}) {
  try {
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

    // 3) COLECCIONES: clonar las 6 de 'console' (schema STRING crudo, DOC-633).
    const srcCols = await padFetch('GET', '/api/v1/workspaces/console/collections', { token: admin });
    const src = Array.isArray(srcCols.data) ? srcCols.data : (srcCols.data?.collections || []);
    const existing = await padFetch('GET', `/api/v1/workspaces/${wsSlug}/collections`, { token });
    const existSlugs = new Set((Array.isArray(existing.data) ? existing.data : (existing.data?.collections || [])).map((c) => c.slug));
    for (const slug of TENANT_COLLECTIONS) {
      if (existSlugs.has(slug)) continue;
      const col = src.find((c) => c.slug === slug);
      if (!col) continue;
      // schema TAL CUAL (string crudo del GET; re-encode lo rompe — DOC-633).
      await padFetch('POST', `/api/v1/workspaces/${wsSlug}/collections`, { token, body: { name: col.name, slug: col.slug, icon: col.icon, schema: col.schema } });
      await sleep(SLEEP_MS);
    }

    return { ok: true, workspace: wsSlug };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
