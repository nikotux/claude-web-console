#!/usr/bin/env node

// Materializa como wiki-links las referencias a otros items que ya aparecen en
// la prosa de Pad. El descubrimiento y las escrituras pasan exclusivamente por
// la API REST; sin --apply este CLI es un dry-run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getItem,
  listCollections,
  listItems,
  parseItemFields,
  updateItem,
} from '../src/core/pad-service-client.js';

const DEFAULT_WORKSPACE = 'console';
const MAX_RATE_RETRIES = 6;
const WRITE_PAUSE_MS = 750;

function usage() {
  return [
    'Uso: node bin/cwc-pad-prosa-links.js [--dry-run | --apply] [--workspace <slug>] [--limit N]',
    `Sin flags hace dry-run. Workspace por defecto: ${DEFAULT_WORKSPACE}.`,
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    apply: false,
    dryRun: false,
    help: false,
    limit: null,
    workspace: DEFAULT_WORKSPACE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--workspace') {
      index += 1;
      if (!argv[index]) throw new Error('--workspace requiere un slug');
      options.workspace = argv[index];
    } else if (arg.startsWith('--workspace=')) {
      options.workspace = arg.slice('--workspace='.length);
    } else if (arg === '--limit') {
      index += 1;
      if (!argv[index]) throw new Error('--limit requiere un entero positivo');
      options.limit = Number(argv[index]);
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.slice('--limit='.length));
    } else {
      throw new Error(`argumento desconocido: ${arg}`);
    }
  }

  if (options.apply && options.dryRun) {
    throw new Error('--apply y --dry-run son mutuamente excluyentes');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.workspace)) {
    throw new Error(`workspace inválido: ${options.workspace || '[vacío]'}`);
  }
  if (options.limit !== null && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error(`limit inválido: ${options.limit}`);
  }
  return options;
}

function dataArray(data, key) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.[key]) ? data[key] : [];
}

function parseFieldsForUpdate(item) {
  const raw = item?.fields;
  if (typeof raw === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('fields no es JSON válido; se omite el PATCH para no perder datos');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('fields no contiene un objeto; se omite el PATCH para no perder datos');
    }
  } else if (raw !== undefined && raw !== null
    && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('fields tiene un tipo inesperado; se omite el PATCH para no perder datos');
  }
  return parseItemFields(item);
}

function isRateLimitError(result) {
  const message = String(result?.error || '').toLowerCase();
  return result?.status === 429
    || message.includes('429')
    || message.includes('too many requests')
    || message.includes('rate limit');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateRetry(operation, label) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation();
    if (!isRateLimitError(result) || attempt >= MAX_RATE_RETRIES) return result;
    const waitMs = Math.min(1000 * (2 ** attempt), 15000);
    console.error(
      `[rate-limit] ${label}: reintento ${attempt + 1}/${MAX_RATE_RETRIES} en ${waitMs}ms`,
    );
    await sleep(waitMs);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createRefRegex(prefixes) {
  const alternatives = [...prefixes]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(escapeRegExp)
    .join('|');
  if (!alternatives) throw new Error('el workspace no tiene prefijos de colección');
  return new RegExp(
    `(?<![A-Za-z0-9_-])(?:([A-Za-z0-9][A-Za-z0-9-]*):)?((?:${alternatives})-\\d+)(?![A-Za-z0-9_-])`,
    'g',
  );
}

function lineEnd(content, start) {
  const newline = content.indexOf('\n', start);
  return newline === -1 ? content.length : newline;
}

function lineAfter(content, end) {
  return end < content.length ? end + 1 : end;
}

function fenceAtLineStart(content, start, openingFence = null) {
  const end = lineEnd(content, start);
  let cursor = start;
  let indentation = 0;
  while (cursor < end && content[cursor] === ' ' && indentation < 4) {
    cursor += 1;
    indentation += 1;
  }
  if (indentation > 3) return null;

  const marker = content[cursor];
  if (openingFence && marker !== openingFence.marker) return null;
  if (!openingFence && marker !== '`' && marker !== '~') return null;

  let markerEnd = cursor;
  while (markerEnd < end && content[markerEnd] === marker) markerEnd += 1;
  const length = markerEnd - cursor;
  if (length < 3 || (openingFence && length < openingFence.length)) return null;

  const remainder = content.slice(markerEnd, end).replace(/\r$/, '');
  if (openingFence) {
    if (!/^[ \t]*$/.test(remainder)) return null;
  } else if (marker === '`' && remainder.includes('`')) {
    return null;
  }
  return { marker, length, end };
}

function pushSegment(segments, type, content) {
  if (!content) return;
  const previous = segments.at(-1);
  if (previous?.type === type) previous.content += content;
  else segments.push({ type, content });
}

function tokenizeMarkdownCode(content) {
  const segments = [];
  let cursor = 0;
  let plainStart = 0;
  let codeStart = null;
  let fence = null;
  let inlineTicks = null;

  while (cursor < content.length) {
    const atLineStart = cursor === 0 || content[cursor - 1] === '\n';
    if (fence) {
      const closing = atLineStart ? fenceAtLineStart(content, cursor, fence) : null;
      if (closing) {
        cursor = lineAfter(content, closing.end);
        pushSegment(segments, 'code', content.slice(codeStart, cursor));
        codeStart = null;
        fence = null;
        plainStart = cursor;
      } else {
        cursor = lineAfter(content, lineEnd(content, cursor));
      }
      continue;
    }

    if (inlineTicks === null && atLineStart) {
      const opening = fenceAtLineStart(content, cursor);
      if (opening) {
        pushSegment(segments, 'plain', content.slice(plainStart, cursor));
        codeStart = cursor;
        fence = opening;
        cursor = lineAfter(content, opening.end);
        continue;
      }
    }

    // Un link Markdown o wiki-link puede contener backticks en su texto
    // visible. Mantenerlo en un único segmento permite proteger la estructura
    // completa en la segunda pasada, en vez de convertir una parte del label.
    if (inlineTicks === null && content.startsWith('[[', cursor)) {
      const closing = content.indexOf(']]', cursor + 2);
      if (closing !== -1) {
        cursor = closing + 2;
        continue;
      }
    }
    if (inlineTicks === null
      && (content[cursor] === '[' || (content[cursor] === '!' && content[cursor + 1] === '['))) {
      const linkEnd = markdownLinkEnd(content, cursor);
      if (linkEnd !== null) {
        cursor = linkEnd;
        continue;
      }
    }

    if (content[cursor] !== '`') {
      cursor += 1;
      continue;
    }

    let runEnd = cursor;
    while (runEnd < content.length && content[runEnd] === '`') runEnd += 1;
    const runLength = runEnd - cursor;
    if (inlineTicks === null) {
      pushSegment(segments, 'plain', content.slice(plainStart, cursor));
      codeStart = cursor;
      inlineTicks = runLength;
    } else if (runLength === inlineTicks) {
      pushSegment(segments, 'code', content.slice(codeStart, runEnd));
      codeStart = null;
      inlineTicks = null;
      plainStart = runEnd;
    }
    cursor = runEnd;
  }

  if (fence) pushSegment(segments, 'code', content.slice(codeStart));
  else if (inlineTicks !== null) pushSegment(segments, 'plain', content.slice(codeStart));
  else pushSegment(segments, 'plain', content.slice(plainStart));
  return segments;
}

function markdownLinkEnd(content, start) {
  const labelStart = content[start] === '!' ? start + 1 : start;
  if (content[labelStart] !== '[' || content[labelStart + 1] === '[') return null;

  let cursor = labelStart + 1;
  let brackets = 1;
  for (; cursor < content.length && brackets > 0; cursor += 1) {
    if (content[cursor] === '\\') cursor += 1;
    else if (content[cursor] === '[') brackets += 1;
    else if (content[cursor] === ']') brackets -= 1;
  }
  if (brackets !== 0) return null;
  while (content[cursor] === ' ' || content[cursor] === '\t') cursor += 1;
  if (content[cursor] !== '(') return null;

  let parentheses = 1;
  cursor += 1;
  for (; cursor < content.length && parentheses > 0; cursor += 1) {
    if (content[cursor] === '\\') cursor += 1;
    else if (content[cursor] === '(') parentheses += 1;
    else if (content[cursor] === ')') parentheses -= 1;
  }
  return parentheses === 0 ? cursor : null;
}

function protectedPlainSegments(content) {
  const segments = [];
  let cursor = 0;
  let plainStart = 0;

  const protect = (end, type) => {
    if (cursor > plainStart) segments.push({ type: 'plain', content: content.slice(plainStart, cursor) });
    segments.push({ type, content: content.slice(cursor, end) });
    cursor = end;
    plainStart = end;
  };

  while (cursor < content.length) {
    if (content.startsWith('[[', cursor)) {
      const closing = content.indexOf(']]', cursor + 2);
      if (closing !== -1) {
        protect(closing + 2, 'wikilink');
        continue;
      }
    }

    if (content[cursor] === '[' || (content[cursor] === '!' && content[cursor + 1] === '[')) {
      const end = markdownLinkEnd(content, cursor);
      if (end !== null) {
        protect(end, 'markdown-link');
        continue;
      }
    }

    const url = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s<>]+/i
      .exec(content.slice(cursor));
    if (url) {
      protect(cursor + url[0].length, 'url');
      continue;
    }
    cursor += 1;
  }

  if (plainStart < content.length) {
    segments.push({ type: 'plain', content: content.slice(plainStart) });
  }
  return segments;
}

function countMatches(content, refRegex) {
  refRegex.lastIndex = 0;
  return [...content.matchAll(refRegex)].length;
}

function emptyStats() {
  return {
    refs_convertidas: 0,
    ya_wikilink: 0,
    en_codigo_saltadas: 0,
    refs_inexistentes: 0,
    cross_mundo_saltadas: 0,
  };
}

function addStats(target, source) {
  for (const key of Object.keys(emptyStats())) target[key] += source[key];
}

export function transformContent(content, { workspace, itemRef, liveRefs, prefixes }) {
  const before = String(content ?? '');
  const refRegex = createRefRegex(prefixes);
  const stats = emptyStats();
  const convertedRefs = new Set();

  const after = tokenizeMarkdownCode(before).map((codeSegment) => {
    if (codeSegment.type === 'code') {
      stats.en_codigo_saltadas += countMatches(codeSegment.content, refRegex);
      return codeSegment.content;
    }

    return protectedPlainSegments(codeSegment.content).map((segment) => {
      if (segment.type === 'wikilink') {
        if (countMatches(segment.content, refRegex) > 0) stats.ya_wikilink += 1;
        return segment.content;
      }
      if (segment.type !== 'plain') return segment.content;

      refRegex.lastIndex = 0;
      return segment.content.replace(refRegex, (match, world, ref) => {
        if (world && world !== workspace) {
          stats.cross_mundo_saltadas += 1;
          return match;
        }
        if (ref === itemRef) return match;
        if (!liveRefs.has(ref)) {
          stats.refs_inexistentes += 1;
          return match;
        }

        stats.refs_convertidas += 1;
        convertedRefs.add(ref);
        return world ? `[[${ref}|${world}:${ref}]]` : `[[${ref}]]`;
      });
    }).join('');
  }).join('');

  return {
    content: after,
    changed: after !== before,
    convertedRefs: [...convertedRefs],
    stats,
  };
}

function compareItems(left, right) {
  const matchLeft = /^(.+)-(\d+)$/.exec(left.ref);
  const matchRight = /^(.+)-(\d+)$/.exec(right.ref);
  const prefixOrder = matchLeft?.[1].localeCompare(matchRight?.[1] || '') || 0;
  if (prefixOrder !== 0) return prefixOrder;
  return Number(matchLeft?.[2]) - Number(matchRight?.[2]);
}

async function loadInventory(workspace) {
  const opts = { workspace };
  const collectionsResult = await withRateRetry(
    () => listCollections(opts),
    `listCollections ${workspace}`,
  );
  if (!collectionsResult?.ok) {
    throw new Error(collectionsResult?.error || 'no se pudieron listar las colecciones');
  }

  const collections = dataArray(collectionsResult.data, 'collections')
    .filter((collection) => collection?.slug && collection?.prefix);
  if (collections.length === 0) throw new Error('el workspace no tiene colecciones utilizables');

  const items = [];
  for (const collection of collections) {
    const listed = await withRateRetry(
      () => listItems(collection.slug, opts),
      `listItems ${collection.slug}`,
    );
    if (!listed?.ok) {
      throw new Error(
        `colección ${collection.slug}: ${listed?.error || 'respuesta vacía'}; `
        + 'inventario incompleto, se aborta sin escribir',
      );
    }

    for (const item of dataArray(listed.data, 'items')) {
      if (!item?.ref || item.deleted_at) continue;
      items.push({
        ref: item.ref,
        content: item.content,
        fields: parseItemFields(item),
      });
    }
  }

  return {
    items: items.sort(compareItems),
    liveRefs: new Set(items.map((item) => item.ref)),
    prefixes: new Set(collections.map((collection) => collection.prefix)),
  };
}

function scanInventory(inventory, workspace, limit, summary) {
  const candidates = [];
  for (const item of inventory.items) {
    const change = transformContent(item.content, {
      workspace,
      itemRef: item.ref,
      liveRefs: inventory.liveRefs,
      prefixes: inventory.prefixes,
    });
    addStats(summary, change.stats);
    if (!change.changed) continue;
    candidates.push({ ref: item.ref, change });
    if (limit !== null && candidates.length >= limit) break;
  }
  summary.items_con_cambios = candidates.length;
  return candidates;
}

function printCandidate(candidate) {
  console.log(
    `ITEM ${candidate.ref} menciones=${candidate.change.stats.refs_convertidas} `
    + `refs=${candidate.change.convertedRefs.join(',')}`,
  );
}

async function applyCandidates(candidates, inventory, workspace, summary) {
  const opts = { workspace };
  const appliedStats = emptyStats();
  let itemsChanged = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const fresh = await withRateRetry(
        () => getItem(candidate.ref, opts),
        `getItem ${candidate.ref}`,
      );
      if (!fresh?.ok || !fresh.data) {
        throw new Error(fresh?.error || 'respuesta vacía al releer el ítem');
      }

      const fields = parseFieldsForUpdate(fresh.data);
      const change = transformContent(fresh.data.content, {
        workspace,
        itemRef: candidate.ref,
        liveRefs: inventory.liveRefs,
        prefixes: inventory.prefixes,
      });
      if (!change.changed) {
        addStats(appliedStats, change.stats);
        console.log(`[skip] ${candidate.ref}: ya no requiere cambios`);
        continue;
      }
      if (!fresh.data.updated_at) {
        throw new Error('el GET fresco no devolvió updated_at; se omite el PATCH');
      }

      const updated = await withRateRetry(
        () => updateItem(candidate.ref, {
          content: change.content,
          fields: { ...fields },
          expected_updated_at: fresh.data.updated_at,
        }, opts),
        `updateItem ${candidate.ref}`,
      );
      if (!updated?.ok) throw new Error(updated?.error || 'error desconocido al actualizar');

      itemsChanged += 1;
      addStats(appliedStats, change.stats);
      console.log(
        `[actualizado ${index + 1}/${candidates.length}] ${candidate.ref} `
        + `menciones=${change.stats.refs_convertidas} refs=${change.convertedRefs.join(',')}`,
      );
    } catch (error) {
      summary.errores += 1;
      console.error(`[error] ${candidate.ref}: ${error?.message || error}`);
    }

    if (index < candidates.length - 1) await sleep(WRITE_PAUSE_MS);
  }

  summary.items_con_cambios = itemsChanged;
  for (const key of Object.keys(appliedStats)) summary[key] = appliedStats[key];
}

function newSummary() {
  return {
    items_con_cambios: 0,
    refs_convertidas: 0,
    ya_wikilink: 0,
    en_codigo_saltadas: 0,
    refs_inexistentes: 0,
    cross_mundo_saltadas: 0,
    errores: 0,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 1;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  const summary = newSummary();
  try {
    console.log(
      `MODO ${options.apply ? 'APPLY' : 'DRY-RUN'} workspace=${options.workspace}`
      + (options.limit === null ? '' : ` limit=${options.limit}`),
    );
    const inventory = await loadInventory(options.workspace);
    const candidates = scanInventory(
      inventory,
      options.workspace,
      options.limit,
      summary,
    );
    for (const candidate of candidates) printCandidate(candidate);
    if (options.apply) {
      await applyCandidates(candidates, inventory, options.workspace, summary);
    }
  } catch (error) {
    summary.errores += 1;
    console.error(`[error] ${error?.message || error}`);
  }

  console.log(`RESUMEN ${JSON.stringify(summary)}`);
  return summary.errores > 0 ? 1 : 0;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
