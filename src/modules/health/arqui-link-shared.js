// Enlace best-effort Salud -> ARQUI: crea links implements idempotentes sin
// romper el escaneo si no existe el nodo de arquitectura. Regla de oro.
import * as padLocal from '../../core/pad-service-client.js';

function parseFieldsSafe(item) {
  const f = item?.fields;
  if (f && typeof f === 'object') return f;
  if (typeof f === 'string') {
    try { return JSON.parse(f); } catch { return {}; }
  }
  return {};
}

export function normFindingLike(f) {
  const file = f?.file || f?.archivo || (Array.isArray(f?.archivos) ? f.archivos[0] : '') || '';
  const moduleHint = f?.module || f?.motor || f?.foco || f?.unit || '';
  return { file: String(file || ''), moduleHint: String(moduleHint || '') };
}

export function normRelPath(file) {
  let rel = String(file || '').replace(/\\/g, '/').trim();
  while (rel.startsWith('./')) rel = rel.slice(2);
  if (/^(?:[a-z]:)?\//i.test(rel) && rel.includes('claude-web-console/')) {
    const m = rel.match(/((?:src|bin|public)\/.*)$/i);
    if (m) rel = m[1];
  }
  return rel;
}

export function moduleKeyOf({ file, moduleHint }) {
  const rel = String(file || '');
  const m = rel.match(/src\/modules\/([a-z0-9-]+)/i) || rel.match(/(?:^|\/)(core|bin)\b/i);
  if (m) return m[1].toLowerCase();
  const mm = String(moduleHint || '').match(/([a-z0-9-]+)\s*$/i);
  return mm ? mm[1].toLowerCase() : '';
}

export function arquiCandidateUids(findingLike) {
  const norm = normFindingLike(findingLike);
  const out = [];
  if (norm.file) {
    const rel = normRelPath(norm.file);
    if (/^bin\/.+\.js$/i.test(rel)) {
      const basename = rel.split('/').pop().replace(/\.js$/i, '');
      out.push(`run:${basename}`);
    }
    out.push(`file:${rel}`);
  }
  const mod = moduleKeyOf(norm);
  if (mod) {
    out.push(`mod:${mod}`);
    out.push(`fe:${mod}`);
  }
  return [...new Set(out)];
}

export async function loadArquiIndex() {
  const map = new Map();
  try {
    const r = await padLocal.listItems('arquitectura', { workspace: 'console' });
    let items = (r && (r.data || r.items || r)) || [];
    if (!Array.isArray(items)) items = [];
    for (const item of items) {
      const fields = parseFieldsSafe(item);
      if (fields.uid && item.ref && !map.has(fields.uid)) map.set(fields.uid, item.ref);
    }
  } catch (err) {
    console.error('[arqui-link] no pude cargar indice ARQUI:', err?.message || err);
  }
  return map;
}

export async function linkItemToArqui(itemRef, findingLike, arquiIndex) {
  if (!itemRef || !(arquiIndex instanceof Map)) return { linked: false, reason: 'sin-indice' };
  const candidatos = arquiCandidateUids(findingLike);
  let arquiRef = null;
  let uidUsado = null;
  for (const uid of candidatos) {
    if (arquiIndex.has(uid)) {
      arquiRef = arquiIndex.get(uid);
      uidUsado = uid;
      break;
    }
  }
  if (!arquiRef) return { linked: false, reason: 'no-arqui-node' };
  try {
    const lk = await padLocal.listLinks(itemRef);
    const links = (lk && lk.ok && Array.isArray(lk.data)) ? lk.data : [];
    const targetId = await padLocal.resolveId(arquiRef, { workspace: 'console' });
    if (links.some((link) => link.link_type === 'implements' && (link.target_ref === arquiRef || (targetId && link.target_id === targetId)))) {
      return { linked: true, uid: uidUsado, arquiRef, already: true };
    }
    const w = await padLocal.addLink(itemRef, arquiRef, 'implements', { workspace: 'console' });
    if (w && w.ok) return { linked: true, uid: uidUsado, arquiRef };
    console.error('[arqui-link] addLink fallo:', w?.error || w);
    return { linked: false, reason: (w && w.error) || 'addLink-fallo', uid: uidUsado, arquiRef };
  } catch (err) {
    console.error(`[arqui-link] ${itemRef}: ${err?.message || err}`);
    return { linked: false, reason: 'excepcion' };
  }
}
