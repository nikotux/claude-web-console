// modules/tickets/pad-client.js — cliente MCP HTTP a Pad (mcp.getpad.dev) para
// traer los items (TASK/PLAN/BUG/…) que un PR referencia. Reusa el OAuth de
// Claude Code (~/.claude/.credentials.json → mcpOAuth/pad), leído FRESCO en cada
// conexión (así toma el token que Claude Code refresca).
//
// LIMITACIÓN CONOCIDA (2026-07-07): el accessToken dura ~1h y lo refresca Claude
// Code, NO la consola. Cuando expira, getPadItems falla y el refresher CONSERVA
// los últimos items buenos del snapshot (persistente en disco) — no se pierden.
// PENDIENTE: refresh OAuth propio de la consola (refreshToken → app.getpad.dev)
// para autonomía total. Anotado en el tablero de pendientes.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const CALL_TIMEOUT_MS = 15_000;
const PAD_REF_RE = /\b(TASK|PLAN|BUG|IDEA|DOC)-\d+\b/gi;

// Refs de Pad que un PR menciona (título + rama + body). Determinístico.
export function extractPadRefs(pr) {
  const text = `${pr?.title || ''} ${pr?.headRefName || pr?.branch || ''} ${pr?.body || ''}`;
  return [...new Set((text.match(PAD_REF_RE) || []).map((r) => r.toUpperCase()))];
}

function readPadToken() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const entry = Object.entries(c.mcpOAuth || {}).find(([k]) => k.startsWith('pad'));
    if (!entry) return null;
    const v = entry[1];
    return { token: v.accessToken, url: v.serverUrl, expiresAt: v.expiresAt };
  } catch { return null; }
}

let liveClient = null;    // Client conectado, o null si no hay conexión viva
let liveToken = null;     // token con el que se conectó liveClient (se reconecta si cambia)
let clientPromise = null; // promesa de (re)conexión en vuelo — evita doble arranque en carreras

async function connectClient(t) {
  const transport = new StreamableHTTPClientTransport(new URL(t.url), {
    requestInit: { headers: { Authorization: `Bearer ${t.token}` } },
  });
  const c = new Client({ name: 'cwc-tickets-pad', version: '1.0.0' }, { capabilities: {} });
  // Si el transport muere, soltamos la referencia para reconectar en la próxima
  // llamada en vez de quedar con un client zombi (patrón desk-mcp-client.js).
  transport.onclose = () => { if (liveClient === c) { liveClient = null; liveToken = null; } };
  transport.onerror = () => { if (liveClient === c) { liveClient = null; liveToken = null; } };
  await c.connect(transport);
  liveClient = c; liveToken = t.token;
  return c;
}

// Devuelve el Client conectado. Reusa el singleton vivo SOLO si el token no
// cambió. Si dos llamadas concurrentes piden reconectar (token nuevo o sin
// cliente), COMPARTEN la misma promesa en vuelo — antes ambas entraban al
// bloque de close+reconnect y se pisaban `client`/`clientToken`, dejando un
// transport huérfano (fix B1 2026-07-11).
async function getClient() {
  const t = readPadToken();
  if (!t?.token) throw new Error('Pad: sin token OAuth (reautenticá pad en Claude Code).');
  if (t.expiresAt && Date.now() > t.expiresAt) throw new Error('Pad: token expirado (se renueva al usar pad en Claude Code).');
  if (liveClient && liveToken === t.token) return liveClient;
  if (!clientPromise) {
    const stale = liveClient;
    liveClient = null; liveToken = null;
    clientPromise = (async () => {
      if (stale) { try { await stale.close(); } catch { /* noop */ } }
      return connectClient(t);
    })().finally(() => { clientPromise = null; });
  }
  return clientPromise;
}

async function callTool(name, args) {
  const c = await getClient();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout Pad: ${name}`)), CALL_TIMEOUT_MS); });
  let r;
  try { r = await Promise.race([c.callTool({ name, arguments: args }), timeout]); }
  finally { clearTimeout(timer); }
  // Error explícito de la tool MCP (isError): lanzar en vez de intentar parsear
  // el content de error como si fuera un item (fix B1 2026-07-11, paridad con
  // desk-mcp-client.js). Lo captura getPadItemsForPr → { items, error }.
  if (r.isError) throw new Error(r.content?.[0]?.text || `Error de la tool Pad: ${name}`);
  const text = r.content?.find((x) => x.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
}

const PAD_WORKSPACE = 'tolkien';

// Normaliza el item COMPLETO de pad_item get (trae content/fields/parent/fechas,
// a diferencia del pad_search recortado que dejaba el status vacío).
// OJO (2026-07-07): `fields` llega como STRING JSON doble-codificado
// (`"{\"status\":\"in_progress\"}"`), no como objeto — hay que parsearlo o el
// status/priority salen undefined (ese era el bug del [?]).
function parseFields(f) {
  if (f && typeof f === 'object') return f;
  if (typeof f === 'string' && f.trim()) { try { return JSON.parse(f); } catch { /* deja {} */ } }
  return {};
}
function mapItem(it) {
  const f = parseFields(it.fields);
  return {
    ref: it.ref || null,
    itemNumber: it.item_number ?? null,
    title: String(it.title || '').slice(0, 200),
    status: f.status || it.status || null,
    priority: f.priority || null,
    fields: f,                                   // todos los campos por si sirven
    collection: it.collection_name || null,
    parentRef: it.parent_ref || null,
    parentTitle: it.parent_title ? String(it.parent_title).slice(0, 140) : null,
    content: String(it.content || '').slice(0, 3000),
    tags: Array.isArray(it.tags) ? it.tags.slice(0, 12) : [],
    createdAt: it.created_at || null,
    updatedAt: it.updated_at || null,
  };
}

// Match por TÍTULO — conservador (2026-07-07). pad_search por título del PR trae
// mucho ruido (playbooks/planes genéricos), así que solo aceptamos un candidato si
// (a) es TASK/PLAN/BUG y (b) su título comparte ≥2 tokens DISTINTIVOS con el título
// del PR. Recupera casos como #251→TASK-569 ("dashboard aggregates") sin colar los
// falsos positivos de PRs de docs (#210 "approval convention" → playbooks genéricos).
const TITLE_ACCEPT_RE = /^(TASK|PLAN|BUG)-\d+$/i;
const TITLE_STOP = new Set([
  'feat', 'fix', 'docs', 'doc', 'chore', 'refactor', 'test', 'build', 'perf',
  'style', 'revert', 'wip', 'merge', 'into', 'from', 'with', 'that', 'this',
  'have', 'were', 'will', 'add', 'adds', 'added', 'update', 'phase',
]);
// Palabras significativas del título, en orden y sin prefijo conventional-commit.
// Sin singularizar (para que el search de Pad indexe/stemée bien).
function titleWords(s) {
  return [...new Set(String(s || '')
    .replace(/^[a-z]+(\([^)]*\))?:/i, '')     // saca el prefijo conventional-commit
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !TITLE_STOP.has(w)))];
}
// Query de búsqueda: el título completo satura el search (devuelve 0), así que
// mandamos solo las primeras N palabras distintivas (n=5 recupera bien y no ensucia).
function titleSearchQuery(s) { return titleWords(s).slice(0, 5).join(' '); }
// Para el MATCH sí singularizamos (tickets→ticket) para comparar tokens.
function titleTokens(s) { return titleWords(s).map((w) => w.replace(/s$/, '')); }
function titleMatchRefs(prTitle, results) {
  const prTok = new Set(titleTokens(prTitle));
  if (prTok.size < 2) return [];
  const out = [];
  for (const x of (results || [])) {
    const ref = x.item?.ref ? String(x.item.ref).toUpperCase() : null;
    if (!ref || !TITLE_ACCEPT_RE.test(ref)) continue;
    const shared = titleTokens(x.item.title).filter((t) => prTok.has(t)).length;
    if (shared >= 2) out.push(ref);
  }
  return out;
}

// Trae los items de Pad de un PR en TRES direcciones (2026-07-07):
//   1. PR→Pad: refs (TASK/PLAN-N) que el PR menciona en título/rama/body.
//   2. Pad→PR (branch): items de Pad cuyo texto menciona el BRANCH del PR (así
//      aparecen los TASK que referencian el PR aunque el PR no los cite — ej.
//      #250 no menciona TASK-568, pero TASK-568 menciona el branch).
//   3. Pad→PR (título, conservador): TASK/PLAN/BUG cuyo título comparte ≥2 tokens
//      distintivos con el título del PR (recupera #251→TASK-569 sin falsos positivos).
// Descubre los refs por las tres vías y luego trae el DETALLE COMPLETO (pad_item get)
// de cada uno. Dedup por ref. Best-effort: si el token expiró, error != null.
export async function getPadItemsForPr(pr) {
  const refs = new Set(extractPadRefs(pr));
  const branch = pr?.headRefName || pr?.branch || '';
  const items = [];
  try {
    // Descubrir refs adicionales que citan el branch del PR (Pad→PR).
    if (branch && branch !== 'main' && branch.length > 4) {
      const r = await callTool('pad_search', { action: 'query', query: branch });
      for (const x of (r?.results || [])) if (x.item?.ref) refs.add(String(x.item.ref).toUpperCase());
    }
    // Descubrir por título del PR (conservador: TASK/PLAN/BUG + ≥2 tokens).
    const tq = titleSearchQuery(pr?.title);
    if (tq) {
      const r = await callTool('pad_search', { action: 'query', query: tq });
      for (const ref of titleMatchRefs(pr.title, r?.results)) refs.add(ref);
    }
    // Detalle COMPLETO de cada ref.
    for (const ref of refs) {
      const it = await callTool('pad_item', { action: 'get', ref, workspace: PAD_WORKSPACE });
      if (it && !it.error && it.ref) items.push(mapItem(it));
    }
    return { items, error: null };
  } catch (err) {
    return { items, error: String(err?.message || err).slice(0, 160) };
  }
}
