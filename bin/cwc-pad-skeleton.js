#!/usr/bin/env node
import { addLink, createItem, findItemByTitle, listLinks } from '../src/core/pad-service-client.js';

const COLLECTION = 'arquitectura';
const TREE = { title: '🖥️ Mi Consola', children: [
  { title: 'Núcleo', children: [
    { title: 'config / instance-config' },
    { title: 'auth / users' },
    { title: 'bus / interfono' },
    { title: 'pad-service-client / pad-context' },
    { title: 'tool-policy / sdk-settings' },
    { title: 'inventory' },
    { title: 'tls / zerotier / paths' },
  ]},
  { title: 'Chat & modelos', children: [
    { title: 'chat (index/runner-link/shared)' },
    { title: 'cwc-chat-runner' },
    { title: 'model-router (AutoTux)' },
    { title: 'Tándem (codex-tool)' },
    { title: 'permisos & adjuntos' },
  ]},
  { title: 'Terminal / tmux' },
  { title: 'Ciclo de tickets', children: [
    { title: 'tickets' },
    { title: 'bugs (triage)' },
    { title: 'bugfixes (motor de PRs)' },
    { title: 'comms' },
    { title: 'seguimientos / Limbo' },
  ]},
  { title: 'Salud / Sistema Nervioso', children: [
    { title: 'health' },
    { title: 'coherence' },
    { title: 'optimize' },
    { title: 'invariants & escaneo unificado' },
  ]},
  { title: 'Banco de conocimiento', children: [
    { title: 'pendientes & planes (tasks)' },
    { title: 'learning' },
    { title: 'retro / mejora continua' },
    { title: 'audio' },
  ]},
  { title: 'Tokens & Uso', children: [
    { title: 'tokens' },
    { title: 'flow & stream' },
    { title: 'usage & router-metrics' },
  ]},
  { title: 'Infra de red', children: [
    { title: 'unifi (UDM Pro)' },
  ]},
  { title: 'Conexiones & terceros', children: [
    { title: 'connections' },
    { title: 'mcps' },
    { title: 'skills' },
    { title: 'updates' },
    { title: 'env-vars' },
  ]},
  { title: 'Multi-tenant / espacios' },
  { title: 'Frontend', children: [
    { title: 'ui (dialog/icons/markdown/pacman)' },
    { title: 'módulos front' },
    { title: 'raw view' },
  ]},
  { title: 'Runners desacoplados' },
  { title: 'Backup & deploy' },
]};

const stats = {
  created: 0,
  existed: 0,
  linked: 0,
  errors: 0,
};
const visited = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(result) {
  const msg = String(result?.error || '').toLowerCase();
  return result?.status === 429 || msg.includes('429') || msg.includes('too many') || msg.includes('rate');
}

async function withRateRetry(operation) {
  const first = await operation();
  if (first?.ok === false && isRateLimitError(first)) {
    await sleep(500);
    return operation();
  }
  return first;
}

function kindForDepth(depth) {
  if (depth === 0) return 'raiz';
  if (depth === 1) return 'subsistema';
  return 'modulo';
}

async function ensureItem(title, depth) {
  const found = await findItemByTitle(COLLECTION, title);
  if (found) return { ref: found.ref, created: false };

  const w = await withRateRetry(() => createItem(COLLECTION, {
    title,
    fields: { kind: kindForDepth(depth), status: 'vigente' },
  }));
  if (w.ok) return { ref: w.data?.ref, created: true };

  stats.errors += 1;
  console.error(`[${COLLECTION}] No se pudo crear item "${title}": ${w.error || 'error desconocido'}`);
  return { ref: null, created: false };
}

async function ensureLink(childRef, parentRef) {
  if (!childRef || !parentRef) return;

  const lk = await withRateRetry(() => listLinks(childRef));
  if (lk.ok && Array.isArray(lk.data)) {
    for (const link of lk.data) {
      if (link?.target_ref === parentRef || link?.source_ref === parentRef) return;
    }
  } else if (!lk.ok) {
    stats.errors += 1;
    console.error(`[${COLLECTION}] ${childRef}: no se pudieron listar links: ${lk.error || 'error desconocido'}`);
  }

  const w = await withRateRetry(() => addLink(childRef, parentRef, 'implements'));
  if (w.ok) {
    stats.linked += 1;
  } else {
    stats.errors += 1;
    console.error(`[${COLLECTION}] ${childRef} -> ${parentRef}: ${w.error || 'error desconocido'}`);
  }
}

async function walk(node, depth, parentRef) {
  const { ref, created } = await ensureItem(node.title, depth);
  if (created) {
    stats.created += 1;
  } else if (ref) {
    stats.existed += 1;
  }
  visited.push({ depth, ref, title: node.title });

  if (ref && parentRef) await ensureLink(ref, parentRef);

  for (const child of node.children || []) {
    await walk(child, depth + 1, ref);
  }
}

try {
  await walk(TREE, 0, null);

  for (const item of visited) {
    console.log(`${'  '.repeat(item.depth)}• ${item.ref} ${item.title}`);
  }
  console.log(`RESUMEN ${JSON.stringify(stats)}`);
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-skeleton falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
