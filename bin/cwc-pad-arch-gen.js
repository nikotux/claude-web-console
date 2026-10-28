#!/usr/bin/env node
import { listItems, createItem, updateItem, getItem, setParent, listLinks } from '../src/core/pad-service-client.js';
import { generateInventory, readInventory } from '../src/core/inventory.js';

const COLLECTION = 'arquitectura';
const ROOT = { uid: 'root:mi-consola', title: '🖥️ Mi Consola', kind: 'raiz' };
const SUBSYSTEMS = [
  { slug: 'nucleo', title: 'Núcleo', modules: ['admin', 'interfono'] },
  { slug: 'chat-modelos', title: 'Chat & modelos', modules: ['chat'] },
  { slug: 'terminal', title: 'Terminal / tmux', modules: ['terminal', 'tmux'] },
  { slug: 'tickets', title: 'Ciclo de tickets', modules: ['tickets', 'comms'] },
  { slug: 'salud', title: 'Salud / Sistema Nervioso', modules: ['health'] },
  { slug: 'conocimiento', title: 'Banco de conocimiento', modules: ['retro'] },
  { slug: 'tokens-uso', title: 'Tokens & Uso', modules: ['tokens', 'stats'] },
  { slug: 'red', title: 'Infra de red', modules: ['unifi'] },
  { slug: 'conexiones', title: 'Conexiones & terceros', modules: ['connections', 'mcps', 'skills', 'updates', 'env-vars'] },
  { slug: 'proyectos', title: 'Proyectos & contexto', modules: ['projects', 'tolkien'] },
  { slug: 'archivos', title: 'Archivos & explorador', modules: ['files'] },
  { slug: 'multitenant', title: 'Multi-tenant / onboarding', modules: ['onboard'] },
  { slug: 'backup', title: 'Backup & deploy', modules: ['backup'] },
  { slug: 'frontend', title: 'Frontend', modules: [] },
  { slug: 'runners', title: 'Runners & CLIs', modules: [] },
  { slug: 'otros', title: 'Otros', modules: [] },
];
const RUNNER_MODULE_OVERRIDES = {
  'cwc-healthfix-runner': 'health',
  'cwc-optimize-runner': 'health',
  'cwc-coherence-runner': 'health',
  'cwc-commitmsg-runner': 'backup',
  'cwc-ticket-context-runner': 'tickets',
  'cwc-mcp-login-runner': 'mcps',
  'cwc-infisical-login-runner': 'mcps',
};
const GENERATED_UID_RE = /^(?:root:|sub:|mod:|fe:|run:|file:|endpoint:)/;

const args = process.argv.slice(2);
const dryRun = args.some((arg) => arg === '--dry-run' || arg === '-n');
const prune = args.includes('--prune');
const includeFiles = !args.includes('--no-files');
const includeEndpoints = !args.includes('--no-endpoints');
const forceInventory = args.includes('--force-inventory');

const stats = {
  created: 0,
  adopted: 0,
  updated: 0,
  unchanged: 0,
  parented: 0,
  parentOk: 0,
  wouldParent: 0,
  leftover: 0,
  retired: 0,
  errors: 0,
};

function itemsArray(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
}

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

function basename(relPath) {
  return String(relPath || '').split('/').filter(Boolean).pop() || '';
}

function stripJs(relPath) {
  return basename(relPath).replace(/\.js$/i, '');
}

function parseFields(item) {
  const raw = item?.fields;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function titleKindKey(title, kind) {
  return `${title} ${kind}`;
}

function sameFields(a, b) {
  return a?.kind === b.kind && a?.status === b.status && a?.uid === b.uid;
}

function subsystemForModule(name) {
  for (const subsystem of SUBSYSTEMS) {
    if (subsystem.modules.includes(name)) return subsystem.slug;
  }
  return 'otros';
}

function runnerOwner(base, moduleNames) {
  if (RUNNER_MODULE_OVERRIDES[base]) return `mod:${RUNNER_MODULE_OVERRIDES[base]}`;
  const stripped = base.replace(/^cwc-/, '');
  const sorted = [...moduleNames].sort((a, b) => b.length - a.length);
  for (const mod of sorted) {
    if (stripped === mod || stripped.startsWith(`${mod}-`)) return `mod:${mod}`;
  }
  return 'sub:runners';
}

function addDesired(map, node) {
  if (!map.has(node.uid)) map.set(node.uid, node);
}

function backendContent(mod) {
  return [
    'Backend module',
    `purpose: ${mod.purpose || ''}`,
    `registrado: ${mod.registered ? 'si' : 'no'}`,
    `archivos: ${Array.isArray(mod.files) ? mod.files.length : 0}`,
    `endpoints: ${Array.isArray(mod.endpoints) ? mod.endpoints.length : 0}`,
    `fingerprint: ${mod.fingerprint || ''}`,
  ].join('\n');
}

function frontendContent(front) {
  return [
    'Frontend module',
    `dir: ${front.dir || ''}`,
    `montado: ${front.mounted ? 'si' : 'no'}`,
    `archivos: ${Array.isArray(front.files) ? front.files.length : 0}`,
  ].join('\n');
}

function buildDesired(inv) {
  const out = new Map();
  addDesired(out, {
    uid: ROOT.uid,
    title: ROOT.title,
    kind: 'raiz',
    parentUid: null,
    content: 'Raiz del arbol de arquitectura de Mi Consola. Generado por bin/cwc-pad-arch-gen.js desde core/inventory.js.',
  });

  for (const subsystem of SUBSYSTEMS) {
    addDesired(out, {
      uid: `sub:${subsystem.slug}`,
      title: subsystem.title,
      kind: 'subsistema',
      parentUid: ROOT.uid,
      content: 'Subsistema.',
    });
  }

  const modules = Array.isArray(inv.modules) ? inv.modules : [];
  const moduleNames = modules.map((m) => m.name).filter(Boolean);
  for (const mod of modules) {
    addDesired(out, {
      uid: `mod:${mod.name}`,
      title: mod.name,
      kind: 'modulo',
      parentUid: `sub:${subsystemForModule(mod.name)}`,
      content: backendContent(mod),
    });

    if (includeFiles) {
      for (const file of Array.isArray(mod.files) ? mod.files : []) {
        addDesired(out, {
          uid: `file:${file}`,
          title: basename(file),
          kind: 'archivo',
          parentUid: `mod:${mod.name}`,
          content: `Archivo ${file}`,
        });
      }
    }

    if (includeEndpoints) {
      for (const endpoint of Array.isArray(mod.endpoints) ? mod.endpoints : []) {
        addDesired(out, {
          uid: `endpoint:${endpoint}`,
          title: endpoint,
          kind: 'endpoint',
          parentUid: `mod:${mod.name}`,
          content: `Endpoint ${endpoint}`,
        });
      }
    }
  }

  for (const front of Array.isArray(inv.frontend) ? inv.frontend : []) {
    addDesired(out, {
      uid: `fe:${front.name}`,
      title: `${front.name} (frontend)`,
      kind: 'modulo',
      parentUid: 'sub:frontend',
      content: frontendContent(front),
    });

    if (includeFiles) {
      for (const file of Array.isArray(front.files) ? front.files : []) {
        addDesired(out, {
          uid: `file:${file}`,
          title: basename(file),
          kind: 'archivo',
          parentUid: `fe:${front.name}`,
          content: `Archivo ${file}`,
        });
      }
    }
  }

  for (const runner of Array.isArray(inv.runners) ? inv.runners : []) {
    const base = stripJs(runner.file);
    addDesired(out, {
      uid: `run:${base}`,
      title: base,
      kind: 'archivo',
      parentUid: runnerOwner(base, moduleNames),
      content: `Runner desacoplado ${runner.file} — ${runner.purpose || ''}`,
    });
  }

  return [...out.values()];
}

function loadInventory() {
  if (forceInventory) return generateInventory({ force: true }).inventory;
  const cached = readInventory();
  if (cached) return cached;
  return generateInventory().inventory;
}

function logDry(action, detail) {
  if (dryRun) console.log(`[dry] ${action} ${detail}`);
}

async function ensureDesiredItem(node, byUid, byTitleKind, uidToRef) {
  const wantContent = node.content;

  try {
    if (byUid.has(node.uid)) {
      const item = byUid.get(node.uid);
      const fields = parseFields(item);
      // El PATCH reemplaza `fields`: un literal borraría las facetas de CONVE-2279.
      const wantFields = { ...fields, kind: node.kind, status: 'vigente', uid: node.uid };
      uidToRef.set(node.uid, item.ref);
      if ((item.content || '') !== wantContent || item.title !== node.title || !sameFields(fields, wantFields)) {
        if (dryRun) {
          logDry('update', `${node.uid} ${item.ref} "${node.title}"`);
        } else {
          const w = await withRateRetry(() => updateItem(item.ref, { title: node.title, content: wantContent, fields: wantFields }));
          if (!w.ok) {
            stats.errors += 1;
            console.error(`[${COLLECTION}] No se pudo actualizar ${item.ref} (${node.uid}): ${w.error || 'error desconocido'}`);
            return;
          }
        }
        stats.updated += 1;
      } else {
        stats.unchanged += 1;
      }
      return;
    }

    const adoptKey = titleKindKey(node.title, node.kind);
    if (byTitleKind.has(adoptKey)) {
      const item = byTitleKind.get(adoptKey);
      const fields = parseFields(item);
      // El PATCH reemplaza `fields`: un literal borraría las facetas de CONVE-2279.
      const wantFields = { ...fields, kind: node.kind, status: 'vigente', uid: node.uid };
      byTitleKind.delete(adoptKey);
      uidToRef.set(node.uid, item.ref);
      if (dryRun) {
        logDry('adopt', `${node.uid} ${item.ref} "${node.title}"`);
      } else {
        const w = await withRateRetry(() => updateItem(item.ref, { title: node.title, content: wantContent, fields: wantFields }));
        if (!w.ok) {
          stats.errors += 1;
          console.error(`[${COLLECTION}] No se pudo adoptar ${item.ref} (${node.uid}): ${w.error || 'error desconocido'}`);
          return;
        }
      }
      stats.adopted += 1;
      return;
    }

    if (dryRun) {
      logDry('create', `${node.uid} "${node.title}"`);
      stats.created += 1;
      return;
    }

    const w = await withRateRetry(() => createItem(COLLECTION, {
      title: node.title,
      content: wantContent,
      tags: [],
      fields: { kind: node.kind, status: 'vigente', uid: node.uid },
    }));
    if (w.ok && w.data?.ref) {
      uidToRef.set(node.uid, w.data.ref);
      stats.created += 1;
    } else {
      stats.errors += 1;
      console.error(`[${COLLECTION}] No se pudo crear ${node.uid} "${node.title}": ${w.error || 'error desconocido'}`);
    }
  } catch (err) {
    stats.errors += 1;
    console.error(`[${COLLECTION}] ${node.uid}: ${err?.message || err}`);
  }
}

async function ensureParent(node, uidToRef) {
  if (!node.parentUid) return;

  const childRef = uidToRef.get(node.uid);
  const parentRef = uidToRef.get(node.parentUid);
  if (!childRef || !parentRef) {
    if (dryRun) {
      logDry('parent', `${node.uid} -> ${node.parentUid}`);
      stats.wouldParent += 1;
    } else {
      stats.errors += 1;
      console.error(`[${COLLECTION}] No se pudo parentear ${node.uid} -> ${node.parentUid}: falta ref`);
    }
    return;
  }

  try {
    const lk = await withRateRetry(() => listLinks(childRef));
    if (!lk.ok) {
      stats.errors += 1;
      console.error(`[${COLLECTION}] ${childRef}: no se pudieron listar links: ${lk.error || 'error desconocido'}`);
      return;
    }

    if (Array.isArray(lk.data) && lk.data.some((link) => link?.link_type === 'parent' && link?.target_ref === parentRef)) {
      stats.parentOk += 1;
      return;
    }

    if (dryRun) {
      logDry('parent', `${node.uid} -> ${node.parentUid}`);
      stats.wouldParent += 1;
      return;
    }

    const w = await withRateRetry(() => setParent(childRef, parentRef));
    if (w.ok) {
      stats.parented += 1;
    } else {
      stats.errors += 1;
      console.error(`[${COLLECTION}] No se pudo parentear ${childRef} -> ${parentRef}: ${w.error || 'error desconocido'}`);
    }
  } catch (err) {
    stats.errors += 1;
    console.error(`[${COLLECTION}] parent ${node.uid} -> ${node.parentUid}: ${err?.message || err}`);
  }
}

function printLeftovers(leftovers, desiredUids) {
  const generatedGone = [];
  const uidless = [];
  const otherUid = [];

  for (const item of leftovers) {
    const fields = parseFields(item);
    const uid = fields.uid || '';
    if (uid && GENERATED_UID_RE.test(uid) && !desiredUids.has(uid)) {
      generatedGone.push(item);
    } else if (!uid) {
      uidless.push(item);
    } else {
      otherUid.push(item);
    }
  }

  console.log('=== SOBRANTES ===');
  console.log('Generados que desaparecieron:');
  for (const item of generatedGone) console.log(`- ${item.ref} ${item.title}`);
  console.log('Sin uid / v1:');
  for (const item of uidless) console.log(`- ${item.ref} ${item.title}`);
  if (otherUid.length) {
    console.log('Con uid externo:');
    for (const item of otherUid) console.log(`- ${item.ref} ${item.title}`);
  }
}

function pruneDepth(item) {
  const fields = parseFields(item);
  if (!fields.uid) return -1;
  if (fields.kind === 'endpoint' || fields.kind === 'archivo') return 3;
  if (fields.kind === 'modulo') return 2;
  if (fields.kind === 'subsistema') return 1;
  if (fields.kind === 'raiz') return 0;
  return 0;
}

async function retireLeftovers(leftovers) {
  const ordered = [...leftovers].sort((a, b) => pruneDepth(b) - pruneDepth(a));
  for (const item of ordered) {
    try {
      if (dryRun) {
        logDry('retire', `${item.ref} "${item.title}"`);
        stats.retired += 1;
        continue;
      }

      const fresh = await withRateRetry(() => getItem(item.ref));
      if (!fresh.ok) {
        stats.errors += 1;
        console.error(`[${COLLECTION}] No se pudo leer ${item.ref} para retirar: ${fresh.error || 'error desconocido'}`);
        continue;
      }

      const fields = parseFields(fresh.data);
      const merged = { ...fields, status: 'retirado' };
      const w = await withRateRetry(() => updateItem(item.ref, { fields: merged }));
      if (w.ok) {
        stats.retired += 1;
      } else {
        stats.errors += 1;
        console.error(`[${COLLECTION}] No se pudo retirar ${item.ref}: ${w.error || 'error desconocido'}`);
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`[${COLLECTION}] retire ${item.ref}: ${err?.message || err}`);
    }
  }
}

try {
  const inv = loadInventory();
  const desired = buildDesired(inv || {});
  const desiredUids = new Set(desired.map((node) => node.uid));
  const uidToRef = new Map();

  const listed = await withRateRetry(() => listItems(COLLECTION));
  if (!listed.ok) {
    console.error(`[${COLLECTION}] No se pudieron listar items: ${listed.error || 'error desconocido'}`);
    process.exit(1);
  }

  const existing = itemsArray(listed.data);
  const byUid = new Map();
  const byTitleKind = new Map();

  for (const item of existing) {
    const fields = parseFields(item);
    if (fields.uid) {
      if (!byUid.has(fields.uid)) byUid.set(fields.uid, item);
    } else if (fields.kind) {
      const key = titleKindKey(item.title, fields.kind);
      if (!byTitleKind.has(key)) byTitleKind.set(key, item);
    }
  }

  for (const node of desired) {
    await ensureDesiredItem(node, byUid, byTitleKind, uidToRef);
  }

  for (const node of desired) {
    await ensureParent(node, uidToRef);
  }

  const refsInTree = new Set(uidToRef.values());
  const leftovers = existing.filter((item) => !refsInTree.has(item.ref));
  stats.leftover = leftovers.length;
  printLeftovers(leftovers, desiredUids);

  if (prune) await retireLeftovers(leftovers);

  console.log(`RESUMEN ${JSON.stringify(stats)}`);
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-arch-gen falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
