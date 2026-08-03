#!/usr/bin/env node

// La lógica de sesión/navegación vive en bin/cwc-tolkien-nav.js, compartida con
// cwc-tolkien.js; la deuda de console:PLAN-2520 quedó saldada en console:PLAN-2558.

/**
 * Observador read-only y versionado de la superficie de formularios de Tolkien.
 *
 * Este runner sólo navega URLs GET y lee el DOM. Nunca hace submit, nunca hace
 * click y nunca visita una URL de mutación.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../src/core/data-dir.js';
import {
  BASE_URL,
  CliError,
  gotoReadOnly,
  launchContext,
  readIdentity,
  waitForMain,
} from './cwc-tolkien-nav.js';

const ALL_TABS = ['overview', 'estado', 'chat', 'work', 'dev', 'reporte'];
const CLOSE_STATES = ['closed', 'waiting', 'missing_outcome', 'available'];
const NEXT_ACTOR_FILTERS = [
  'all',
  'requester',
  'external_partner',
  'decision_owner',
  'business_team',
  'system',
  'internal_team',
  'scheduled_time',
  'not_recorded',
];
const MAX_AUTO_PROBES = 250;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// PROHIBIDO volver a calcular estas rutas en una constante de módulo: eso
// congela el espacio del HOST y un inquilino terminaría leyendo la sesión de
// Tolkien de otro (Familia B de health/invariants.js · console:BUG-2185 ·
// console:BUG-2472). Se resuelve por invocación, leyendo CWC_DATA_DIR en el
// momento de correr, no al importar el módulo.
function tolkienPaths() {
  const dataDir = path.join(resolveDataDir(), 'tolkien');
  return {
    dataDir,
    sessionFile: path.join(dataDir, 'session.json'),
    whoamiFile: path.join(dataDir, 'whoami.json'),
    censusFile: path.join(dataDir, 'census.json'),
    partialFile: path.join(dataDir, 'census.partial.jsonl'),
    reconcileFile: path.join(dataDir, 'reconcile.json'),
    reconcilePartialFile: path.join(dataDir, 'reconcile.partial.jsonl'),
    schemaFile: path.join(dataDir, 'schema.json'),
    schemaPartialFile: path.join(dataDir, 'schema-partial.jsonl'),
    opsDir: path.join(dataDir, 'ops'),
  };
}

function log(message) {
  process.stderr.write(`[cwc-tolkien] ${message}\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function help() {
  process.stdout.write(`Uso:
  node bin/cwc-tolkien-schema.js scan [--tickets <lista>] [--auto] [--tabs <lista>] [--out <ruta>] [--session <ruta>]
  node bin/cwc-tolkien-schema.js show [--out <ruta>]
  node bin/cwc-tolkien-schema.js help

Subcomandos:
  scan  Observa formularios reales por ticket y pestaña y escribe un esquema versionado.
  show  Lee el esquema y muestra estadísticas, gates de cierre y huecos.
  help  Muestra esta ayuda.

Opciones de scan:
  --tickets <lista>  UUID, WORK-n o URL de ticket separados por comas.
  --auto             Suma muestras del reconcile y del board hasta cubrir gates de cierre.
  --tabs <lista>     Pestañas separadas por comas (default: ${ALL_TABS.join(',')}).
  --out <ruta>       Archivo final (default: <dataDir>/tolkien/schema.json).
  --session <ruta>   Storage state de Tolkien (default: <dataDir>/tolkien/session.json).

Opciones de show:
  --out <ruta>       Esquema a leer (default: <dataDir>/tolkien/schema.json).

Garantía: este runner es de SOLO LECTURA respecto de Tolkien; no envía formularios.
`);
}

function ensureDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
}

function writeFileAtomic(file, contents, dataDir) {
  const parent = path.dirname(file);
  const relativeToData = path.relative(dataDir, parent);
  const insideData = relativeToData === ''
    || (!relativeToData.startsWith('..') && !path.isAbsolute(relativeToData));
  if (insideData) {
    ensureDataDir(dataDir);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.chmodSync(parent, 0o700);
  } else {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function writeJson(file, value, dataDir) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, dataDir);
}

function valueAfter(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CliError(`Falta el valor de ${option}.`);
  }
  return value;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`No se pudo leer ${label} (${file}): ${error.message}`);
  }
}

function parseList(raw, option) {
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new CliError(`${option} no puede estar vacío.`);
  return values;
}

function parseScanArgs(args, paths) {
  const ticketRefs = [];
  let auto = false;
  let tabs = [...ALL_TABS];
  let out = paths.schemaFile;
  let sessionFile = paths.sessionFile;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--tickets') {
      ticketRefs.push(...parseList(valueAfter(args, i, arg), arg));
      i += 1;
    } else if (arg === '--auto') {
      auto = true;
    } else if (arg === '--tabs') {
      tabs = [...new Set(parseList(valueAfter(args, i, arg), arg))];
      i += 1;
    } else if (arg === '--out') {
      out = path.resolve(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--session') {
      sessionFile = path.resolve(valueAfter(args, i, arg));
      i += 1;
    } else {
      throw new CliError(`Opción desconocida para scan: ${arg}`);
    }
  }
  const invalidTabs = tabs.filter((tab) => !ALL_TABS.includes(tab));
  if (invalidTabs.length > 0) {
    throw new CliError(`Tabs inválidas: ${invalidTabs.join(', ')}.`);
  }
  if (!auto && ticketRefs.length === 0) {
    throw new CliError('scan exige --auto, --tickets o ambos.');
  }
  return { ticketRefs, auto, tabs, out, sessionFile };
}

function parseShowArgs(args, paths) {
  let out = paths.schemaFile;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out') {
      out = path.resolve(valueAfter(args, i, arg));
      i += 1;
    } else {
      throw new CliError(`Opción desconocida para show: ${arg}`);
    }
  }
  return { out };
}

async function detectCloseGate(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const mains = [...document.querySelectorAll('main')];
    const forms = mains.flatMap((main) => [...main.querySelectorAll('form')]);
    for (const form of forms) {
      const submits = [...form.querySelectorAll('button[type="submit"], button:not([type])')];
      const label = submits.map((button) => normalize(button.textContent))
        .find((text) => /Reopen in Tolkien/i.test(text));
      if (label) return { state: 'closed', evidence: label.slice(0, 200) };
    }
    for (const form of forms) {
      if (!form.querySelector('textarea[name="evidenceSummary"]')) continue;
      const submits = [...form.querySelectorAll('button[type="submit"], button:not([type])')];
      const label = submits.map((button) => normalize(button.textContent))
        .find((text) => /Verify .* close in Tolkien/i.test(text));
      if (label) return { state: 'available', evidence: label.slice(0, 200) };
    }
    const text = normalize(mains.map((main) => main.textContent ?? '').join('\n'));
    const waiting = 'Resume this work with the actual trigger evidence before closing it.';
    if (text.includes(waiting)) return { state: 'waiting', evidence: waiting };
    const missing = 'Record the observable desired outcome';
    if (text.includes(missing)) return { state: 'missing_outcome', evidence: missing };
    return { state: 'unknown', evidence: '' };
  });
}

async function readPageWorkKey(page) {
  return page.evaluate(() => {
    const text = [...document.querySelectorAll('main')]
      .map((main) => main.textContent ?? '')
      .join('\n');
    return text.match(/\bWORK-\d+\b/)?.[0] ?? null;
  });
}

async function extractForms(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const attribute = (element, name) => {
      if (!element.hasAttribute(name)) return undefined;
      const value = element.getAttribute(name);
      return value === null || value === '' ? undefined : value;
    };
    const labelFor = (control) => {
      const wrapping = control.closest('label');
      const referenced = control.id
        ? [...document.querySelectorAll('label')].find((label) => label.htmlFor === control.id)
        : null;
      const label = wrapping ?? referenced;
      if (!label) return undefined;
      const clone = label.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach((node) => node.remove());
      const text = normalize(clone.textContent).slice(0, 160);
      return text || undefined;
    };
    // Durante la hidratación puede convivir el cascarón con el contenido real, y el
    // primer <main> puede ser el vacío: recolectar de todos es inmune a cuál sea el
    // real y a cuántos haya (console:BUG-2555, console:CONVE-2085).
    const mains = [...document.querySelectorAll('main')];
    if (mains.length === 0) return [];
    const formularios = [...new Set(mains.flatMap((main) => [...main.querySelectorAll('form')]))];
    return formularios.map((form) => {
      const actionInput = [...form.querySelectorAll('input[type="hidden"][name]')]
        .find((input) => input.name.startsWith('$ACTION_ID_'));
      const headingContainer = form.closest('section, div[id]');
      const heading = normalize(headingContainer?.querySelector('h1, h2, h3')?.textContent) || null;
      const anchorId = form.closest('[id]')?.id || null;
      const submit = form.querySelector('button[type="submit"], button:not([type])');
      const fields = [...form.querySelectorAll('input[name], select[name], textarea[name]')]
        .filter((control) => !control.name.startsWith('$ACTION_ID_'))
        .map((control) => {
          const tag = control.tagName.toLowerCase();
          const field = {
            name: control.name,
            tag,
            type: tag === 'input' ? (control.getAttribute('type') || 'text').toLowerCase() : tag,
            required: control.required,
            disabled: control.disabled,
            readOnly: control.readOnly,
            multiple: tag === 'select' ? control.multiple : false,
          };
          const minLength = control.getAttribute('minlength');
          const maxLength = control.getAttribute('maxlength');
          if (minLength !== null && minLength !== '' && Number(minLength) !== -1) field.minLength = Number(minLength);
          if (maxLength !== null && maxLength !== '' && Number(maxLength) !== -1) field.maxLength = Number(maxLength);
          for (const name of ['min', 'max', 'step', 'pattern', 'placeholder']) {
            const value = attribute(control, name);
            if (value !== undefined) field[name] = value;
          }
          if (tag === 'textarea') {
            field.defaultValue = control.textContent ?? '';
          } else if (tag === 'select') {
            const selected = [...control.options].find((option) => option.defaultSelected);
            field.defaultValue = selected?.value ?? null;
            field.options = [...control.options].map((option) => ({
              value: option.value,
              label: normalize(option.textContent),
              disabled: option.disabled,
              selected: option.defaultSelected,
            }));
          } else {
            field.defaultValue = control.getAttribute('value');
          }
          const labelText = labelFor(control);
          if (labelText !== undefined) field.labelText = labelText;
          return field;
        });
      return {
        actionId: actionInput?.name ?? null,
        actionAttr: form.getAttribute('action'),
        method: form.getAttribute('method'),
        heading,
        anchorId,
        submitLabel: normalize(submit?.textContent) || null,
        fields,
      };
    });
  });
}

function ticketIdFromReference(reference) {
  if (UUID_PATTERN.test(reference)) return reference.toLowerCase();
  if (/^https?:\/\//i.test(reference)) {
    let parsed;
    try {
      parsed = new URL(reference);
    } catch {
      throw new CliError(`URL de ticket inválida: ${reference}`);
    }
    const match = parsed.pathname.match(/^\/tickets\/([0-9a-f-]+)\/?$/i);
    if (!match || !UUID_PATTERN.test(match[1])) {
      throw new CliError(`La URL no contiene un ticketWorkflowId válido: ${reference}`);
    }
    return match[1].toLowerCase();
  }
  return null;
}

function censusIndex(paths) {
  const census = readJson(paths.censusFile, 'el censo de Tolkien');
  const byId = new Map();
  const byWorkKey = new Map();
  for (const ticket of census.tickets ?? []) {
    if (!ticket.ticketWorkflowId) continue;
    const normalized = {
      ticketWorkflowId: ticket.ticketWorkflowId.toLowerCase(),
      workKey: ticket.workKey ?? ticket.workNumber ?? null,
      ownTicket: true,
    };
    byId.set(normalized.ticketWorkflowId, normalized);
    if (normalized.workKey) byWorkKey.set(normalized.workKey.toUpperCase(), normalized);
  }
  return { byId, byWorkKey };
}

function resolveExplicitTickets(references, census) {
  return references.map((reference) => {
    if (/^WORK-\d+$/i.test(reference)) {
      const found = census.byWorkKey.get(reference.toUpperCase());
      if (!found) throw new CliError(`No se encontró ${reference} en census.json.`);
      return { ...found };
    }
    const ticketWorkflowId = ticketIdFromReference(reference);
    if (!ticketWorkflowId) {
      throw new CliError(`Referencia de ticket inválida: ${reference}`);
    }
    const known = census.byId.get(ticketWorkflowId);
    return known
      ? { ...known }
      : { ticketWorkflowId, workKey: null, ownTicket: false };
  });
}

function addTicket(target, seen, ticket) {
  const id = ticket.ticketWorkflowId.toLowerCase();
  if (seen.has(id)) {
    const existing = target.find((item) => item.ticketWorkflowId === id);
    if (existing && !existing.workKey && ticket.workKey) existing.workKey = ticket.workKey;
    if (existing && ticket.ownTicket) existing.ownTicket = true;
    return false;
  }
  seen.add(id);
  target.push({
    ticketWorkflowId: id,
    workKey: ticket.workKey ?? null,
    ownTicket: Boolean(ticket.ownTicket),
  });
  return true;
}

function mandatoryAutoTickets(paths, census) {
  const reconcile = readJson(paths.reconcileFile, 'reconcile.json');
  return ['closable', 'realOpen', 'unpaired'].map((stack) => {
    const sample = reconcile[stack]?.[0];
    if (!sample?.ticketWorkflowId) {
      throw new CliError(`reconcile.json no tiene la muestra obligatoria ${stack}[0].`);
    }
    const id = sample.ticketWorkflowId.toLowerCase();
    const own = census.byId.get(id);
    return {
      ticketWorkflowId: id,
      workKey: sample.workKey ?? sample.workNumber ?? own?.workKey ?? null,
      ownTicket: Boolean(own),
    };
  });
}

async function probeGate(page, ticketWorkflowId) {
  await gotoReadOnly(page, `${BASE_URL}/tickets/${ticketWorkflowId}?tab=estado`);
  await waitForMain(page);
  let [closeGate, workKey] = await Promise.all([
    detectCloseGate(page),
    readPageWorkKey(page),
  ]);
  if (closeGate.state === 'unknown') {
    await gotoReadOnly(page, `${BASE_URL}/tickets/${ticketWorkflowId}?tab=estado`);
    await waitForMain(page);
    [closeGate, workKey] = await Promise.all([
      detectCloseGate(page),
      readPageWorkKey(page),
    ]);
  }
  return { closeGate, workKey };
}

async function boardCandidates(page) {
  const sources = [
    {
      filter: 'view=active&focus=overdue',
      url: `${BASE_URL}/tickets?view=active&focus=overdue#queue`,
    },
    {
      filter: 'view=active&focus=unowned',
      url: `${BASE_URL}/tickets?view=active&focus=unowned#queue`,
    },
    ...NEXT_ACTOR_FILTERS
      .filter((actor) => actor !== 'all')
      .map((actor) => ({
        filter: `view=active&actor=${actor}`,
        url: `${BASE_URL}/tickets?view=active&actor=${actor}#queue`,
      })),
    {
      filter: 'view=attention',
      url: `${BASE_URL}/tickets?view=attention#queue`,
    },
    {
      filter: 'view=attention&focus=in_progress',
      url: `${BASE_URL}/tickets?view=attention&focus=in_progress#queue`,
    },
    {
      filter: 'view=resolved',
      url: `${BASE_URL}/tickets?view=resolved#queue`,
    },
    {
      filter: 'view=active&focus=waiting',
      url: `${BASE_URL}/tickets?view=active&focus=waiting#queue`,
    },
    {
      filter: 'view=active&focus=in_progress',
      url: `${BASE_URL}/tickets?view=active&focus=in_progress#queue`,
    },
    {
      filter: 'view=active&focus=all',
      url: `${BASE_URL}/tickets?view=active&focus=all#queue`,
    },
  ];
  const candidates = [];
  const seen = new Set();
  const probeSources = [];
  for (const source of sources) {
    let found = 0;
    let newUnique = 0;
    try {
      await gotoReadOnly(page, source.url);
      await waitForMain(page);
      const rows = await page.evaluate(() => [...document.querySelectorAll('#queue ul > li a[href^="/tickets/"]')]
        .slice(0, 100)
        .map((anchor) => ({ href: anchor.getAttribute('href'), text: anchor.textContent ?? '' })));
      for (const row of rows) {
        const match = row.href?.match(/^\/tickets\/([0-9a-f-]+)/i);
        if (!match || !UUID_PATTERN.test(match[1])) continue;
        found += 1;
        const id = match[1].toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        newUnique += 1;
        candidates.push({
          ticketWorkflowId: id,
          workKey: row.text.match(/\bWORK-\d+\b/)?.[0] ?? null,
        });
      }
    } catch (error) {
      log(`No se pudo leer el board ${source.url}: ${error.message}`);
    }
    probeSources.push({ filter: source.filter, found, newUnique });
  }
  return {
    candidates,
    probeSources,
  };
}

async function selectAutoSamples({ page, paths, census, tickets, seen, gateCache }) {
  const targetStates = new Set();
  const mandatory = mandatoryAutoTickets(paths, census);
  for (const ticket of mandatory) addTicket(tickets, seen, ticket);

  for (const ticket of mandatory) {
    try {
      const probed = await probeGate(page, ticket.ticketWorkflowId);
      gateCache.set(ticket.ticketWorkflowId, probed.closeGate);
      if (!ticket.workKey && probed.workKey) ticket.workKey = probed.workKey;
      if (CLOSE_STATES.includes(probed.closeGate.state)) targetStates.add(probed.closeGate.state);
    } catch (error) {
      log(`Falló el sondeo obligatorio de ${ticket.workKey ?? ticket.ticketWorkflowId}: ${error.message}`);
    }
  }

  const { candidates, probeSources } = await boardCandidates(page);
  let probeCount = 0;
  for (const candidate of candidates) {
    if (targetStates.size === CLOSE_STATES.length || probeCount >= MAX_AUTO_PROBES) break;
    if (seen.has(candidate.ticketWorkflowId)) continue;
    probeCount += 1;
    try {
      const probed = await probeGate(page, candidate.ticketWorkflowId);
      const state = probed.closeGate.state;
      if (!targetStates.has(state) && CLOSE_STATES.includes(state)) {
        targetStates.add(state);
        addTicket(tickets, seen, {
          ticketWorkflowId: candidate.ticketWorkflowId,
          workKey: candidate.workKey ?? probed.workKey,
          ownTicket: census.byId.has(candidate.ticketWorkflowId),
        });
        gateCache.set(candidate.ticketWorkflowId, probed.closeGate);
      }
    } catch (error) {
      log(`Falló el sondeo de ${candidate.workKey ?? candidate.ticketWorkflowId}: ${error.message}`);
    }
  }
  return { probeCount, probeSources };
}

function formSignature(tab, form) {
  const names = form.fields.map((field) => field.name).sort();
  return `${tab}|${form.submitLabel ?? ''}|${names.join('|')}`;
}

function crop(value, length) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, length);
}

function mergeOptions(variants) {
  const byValue = new Map();
  for (const variant of variants) {
    for (const option of variant.options ?? []) {
      let merged = byValue.get(option.value);
      if (!merged) {
        merged = {
          value: option.value,
          label: option.label,
          disabled: option.disabled,
          selected: option.selected,
          labels: new Set([option.label]),
        };
        byValue.set(option.value, merged);
      } else {
        merged.disabled ||= option.disabled;
        merged.selected ||= option.selected;
        merged.labels.add(option.label);
      }
    }
  }
  return [...byValue.values()].map((option) => {
    const result = {
      value: option.value,
      label: option.label,
      disabled: option.disabled,
      selected: option.selected,
    };
    if (option.labels.size > 1) result.labelVariants = [...option.labels];
    return result;
  });
}

function mergeFieldVariants(variants) {
  const field = { ...variants[0] };
  delete field.options;
  const requiredValues = variants.map((variant) => variant.required);
  const requiredCount = requiredValues.filter(Boolean).length;
  field.required = requiredCount > variants.length / 2
    ? true
    : requiredCount < variants.length / 2
      ? false
      : variants[0].required;
  if (new Set(requiredValues).size > 1) field.requiredVaries = true;

  const defaults = new Map();
  for (const variant of variants) {
    defaults.set(JSON.stringify(variant.defaultValue), variant.defaultValue);
  }
  if (defaults.size > 1) {
    delete field.defaultValue;
    field.perTicket = true;
    const example = [...defaults.values()].find((value) => value !== null && value !== undefined);
    if (example !== undefined) field.exampleValue = crop(example, 60);
  }

  if (field.tag === 'select') {
    field.options = mergeOptions(variants);
    if (['assignedToUserId', 'contributorUserId'].includes(field.name) || field.options.length > 25) {
      field.dynamic = true;
      field.optionsAreDynamic = true;
    }
  }
  return field;
}

function mergeFieldLists(fieldLists) {
  const fieldBuckets = new Map();
  for (const fields of fieldLists) {
    const occurrences = new Map();
    for (const field of fields) {
      const base = `${field.tag}:${field.name}`;
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      const key = `${base}:${occurrence}`;
      if (!fieldBuckets.has(key)) fieldBuckets.set(key, []);
      fieldBuckets.get(key).push(field);
    }
  }
  return [...fieldBuckets.values()].map(mergeFieldVariants);
}

function slug(value) {
  const normalized = (value || 'formulario')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'formulario';
}

function mergeForms(observations) {
  const groups = new Map();
  for (const observation of observations) {
    for (const raw of observation.forms) {
      const signature = formSignature(observation.tab, raw);
      let group = groups.get(signature);
      if (!group) {
        group = { signature, tab: observation.tab, entries: [] };
        groups.set(signature, group);
      }
      group.entries.push({ raw, observedOn: observation.observedOn });
    }
  }

  const idCounts = new Map();
  return [...groups.values()].map((group) => {
    const raws = group.entries.map((entry) => entry.raw);
    const first = raws[0];
    const baseId = `${group.tab}/${slug(first.submitLabel ?? first.heading)}`;
    const count = (idCounts.get(baseId) ?? 0) + 1;
    idCounts.set(baseId, count);
    const actionIds = [...new Set(raws.map((raw) => raw.actionId).filter(Boolean))];
    return {
      id: count === 1 ? baseId : `${baseId}-${count}`,
      tab: group.tab,
      signature: group.signature,
      heading: raws.find((raw) => raw.heading)?.heading ?? null,
      anchorId: raws.find((raw) => raw.anchorId)?.anchorId ?? null,
      actionId: actionIds[0] ?? null,
      actionIds,
      actionAttr: raws.find((raw) => raw.actionAttr)?.actionAttr ?? null,
      method: raws.find((raw) => raw.method)?.method ?? null,
      submitLabel: first.submitLabel,
      observedOn: [...new Set(group.entries.map((entry) => entry.observedOn))],
      fields: mergeFieldLists(raws.map((raw) => raw.fields)),
    };
  });
}

function globalFormKey(form) {
  if (!form.actionId) return null;
  const fieldNames = [...new Set(form.fields.map((field) => field.name))].sort();
  return `${form.actionId}|${fieldNames.join('|')}`;
}

function collapseGlobalForms(forms) {
  const groups = new Map();
  for (const form of forms) {
    const key = globalFormKey(form);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(form);
  }
  const globalKeys = new Set(
    [...groups.entries()]
      .filter(([, matches]) => new Set(matches.map((form) => form.tab)).size >= 2)
      .map(([key]) => key),
  );
  const emitted = new Set();
  const idCounts = new Map();
  const result = [];
  for (const form of forms) {
    const key = globalFormKey(form);
    if (!key || !globalKeys.has(key)) {
      result.push(form);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    const matches = groups.get(key);
    const first = matches[0];
    const submitLabelVariants = [...new Set(
      matches.map((match) => match.submitLabel).filter(Boolean),
    )];
    const baseId = `global/${slug(first.submitLabel ?? first.heading)}`;
    const count = (idCounts.get(baseId) ?? 0) + 1;
    idCounts.set(baseId, count);
    result.push({
      ...first,
      id: count === 1 ? baseId : `${baseId}-${count}`,
      tab: '*',
      tabsPresent: [...new Set(matches.map((match) => match.tab))]
        .sort((left, right) => ALL_TABS.indexOf(left) - ALL_TABS.indexOf(right)),
      global: true,
      signature: `*|${key}`,
      actionIds: [...new Set(matches.flatMap((match) => match.actionIds))],
      submitLabelVariants,
      observedOn: [...new Set(matches.flatMap((match) => match.observedOn))],
      fields: mergeFieldLists(matches.map((match) => match.fields)),
    });
  }
  return result;
}

function buildNotes(forms) {
  const byFieldName = new Map();
  for (const form of forms) {
    for (const field of form.fields) {
      if (!Array.isArray(field.options)) continue;
      if (!byFieldName.has(field.name)) byFieldName.set(field.name, new Map());
      const byForm = byFieldName.get(field.name);
      if (!byForm.has(form.id)) byForm.set(form.id, field);
    }
  }
  const notes = [];
  for (const [name, byForm] of [...byFieldName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const entries = [...byForm.entries()].map(([formId, field]) => ({
      formId,
      count: field.options.length,
      signature: JSON.stringify([...new Set(field.options.map((option) => option.value))].sort()),
    }));
    if (entries.length < 2 || new Set(entries.map((entry) => entry.signature)).size < 2) continue;
    const locations = entries
      .sort((left, right) => left.formId.localeCompare(right.formId))
      .map((entry) => `${entry.formId} (${entry.count} opciones)`)
      .join(', ');
    notes.push(
      `El campo "${name}" tiene conjuntos de opciones distintos en ${locations}. `
        + 'El vocabulario de un campo es por FORMULARIO, no por nombre de campo; '
        + 'tratarlo como enum global produciría escrituras inválidas.',
    );
  }
  return notes;
}

function buildStats(forms) {
  const fields = forms.flatMap((form) => form.fields);
  const selects = fields.filter((field) => field.tag === 'select');
  return {
    formCount: forms.length,
    fieldCount: fields.length,
    selectCount: selects.length,
    selectWithOptionsCount: selects.filter((field) => field.options.length > 0).length,
    optionCount: selects.reduce((sum, field) => sum + field.options.length, 0),
  };
}

function buildCloseGate(tickets) {
  const statesObserved = Object.fromEntries(CLOSE_STATES.map((state) => [state, []]));
  for (const ticket of tickets) {
    if (statesObserved[ticket.closeGate.state]) {
      statesObserved[ticket.closeGate.state].push(ticket.workKey ?? ticket.ticketWorkflowId);
    }
  }
  const recipe = ['Abrir el ticket en tab=estado y observar el gate de cierre.'];
  if (statesObserved.waiting.length > 0) {
    recipe.push('Si aparece la espera estructurada, reanudar el trabajo con la evidencia real del disparador antes del cierre.');
  }
  if (statesObserved.missing_outcome.length > 0) {
    recipe.push('Si falta el resultado deseado, registrarlo antes de que Tolkien pueda renderizar el formulario de cierre.');
  }
  if (statesObserved.available.length > 0) {
    recipe.push('Cuando el gate está disponible, elegir verificationKind y completar evidenceSummary con la evidencia observada.');
  }
  if (statesObserved.closed.length > 0) {
    recipe.push('El estado cerrado se reconoce por el formulario “Reopen in Tolkien”; no requiere ningún paso adicional de cierre.');
  }
  return {
    documented: 'El formulario de cierre vive en tab=estado y sólo se renderiza cuando el ticket NO está cerrado, NO tiene espera estructurada activa y TIENE desiredOutcome.',
    statesObserved,
    recipe,
  };
}

function buildGaps(forms, closeGate, probeCount, probeSources) {
  const gaps = [];
  for (const state of CLOSE_STATES) {
    if (closeGate.statesObserved[state].length > 0) continue;
    if (state === 'available') {
      gaps.push({
        what: `No se observó el gate available tras sondear ${probeCount} candidatos únicos de ${probeSources.length} colas: el select verificationKind no pudo capturarse por observación.`,
        why: 'Sin un ticket abierto, sin espera y con desiredOutcome el DOM no renderiza ese gate; obtenerlo de manera determinista exigiría escribir desiredOutcome o mutar el estado de un ticket, lo que viola el contrato de sólo lectura.',
        needsHuman: true,
        unverifiedHint: {
          source: 'code',
          path: 'apps/console/lib/tickets/completion-verification.ts',
          values: ['requester_confirmation', 'objective_check', 'operator_attestation'],
          warning: 'NO OBSERVADO en el DOM desplegado. Proviene del repo local de Tolkien, que YA demostró estar desfasado respecto de la instancia viva: nextActorKind declara 10 valores en el código y el DOM sirve 11. Tratar estos valores como confirmados es exactamente el error que este esquema existe para evitar. Verificar contra el DOM antes de usarlos para escribir.',
        },
      });
    } else {
      gaps.push({
        what: `No se observó el estado de gate ${state}.`,
        why: 'Ninguna de las muestras read-only sondeadas renderizó esa rama del DOM.',
        needsHuman: false,
      });
    }
  }
  for (const form of forms) {
    for (const field of form.fields) {
      if (field.tag !== 'select' || field.options.length > 0) continue;
      gaps.push({
        what: `El select ${field.name} de ${form.id} quedó sin opciones.`,
        why: 'El DOM observado no expuso ninguna option para este select.',
        needsHuman: false,
      });
    }
  }
  return gaps;
}

function resetPartial(paths) {
  writeFileAtomic(paths.schemaPartialFile, '', paths.dataDir);
}

function appendPartial(paths, value) {
  fs.appendFileSync(paths.schemaPartialFile, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(paths.schemaPartialFile, 0o600);
}

async function scan(options, paths) {
  const census = censusIndex(paths);
  const tickets = [];
  const seen = new Set();
  const gateCache = new Map();
  for (const ticket of resolveExplicitTickets(options.ticketRefs, census)) {
    addTicket(tickets, seen, ticket);
  }
  resetPartial(paths);
  const { browser, context } = await launchContext(options.sessionFile);
  const page = await context.newPage();
  const observations = [];
  const errors = [];
  let probeCount = 0;
  let probeSources = [];
  let viewerEmail = null;
  try {
    await gotoReadOnly(page, BASE_URL);
    await waitForMain(page);
    viewerEmail = (await readIdentity(page)).email;
    if (options.auto) {
      const autoSamples = await selectAutoSamples({
        page,
        paths,
        census,
        tickets,
        seen,
        gateCache,
      });
      probeCount = autoSamples.probeCount;
      probeSources = autoSamples.probeSources;
    }

    for (const ticket of tickets) {
      const tabsScanned = [];
      let closeGate = gateCache.get(ticket.ticketWorkflowId) ?? { state: 'unknown', evidence: '' };
      for (const tab of options.tabs) {
        try {
          await gotoReadOnly(page, `${BASE_URL}/tickets/${ticket.ticketWorkflowId}?tab=${tab}`);
          await waitForMain(page);
          let forms = await extractForms(page);
          if (!ticket.workKey) ticket.workKey = await readPageWorkKey(page);
          let observedGate = tab === 'estado' ? await detectCloseGate(page) : null;
          // La hidratación se reintenta cuando faltan formularios o cuando el gate
          // de estado todavía no se pudo observar (console:BUG-2555).
          const needsHydrationRetry = forms.length === 0
            || (tab === 'estado' && observedGate.state === 'unknown');
          if (needsHydrationRetry) {
            await gotoReadOnly(page, `${BASE_URL}/tickets/${ticket.ticketWorkflowId}?tab=${tab}`);
            await waitForMain(page);
            forms = await extractForms(page);
            if (tab === 'estado') observedGate = await detectCloseGate(page);
          }
          if (tab === 'estado') {
            if (observedGate.state !== 'unknown' || closeGate.state === 'unknown') {
              closeGate = observedGate;
            }
          }
          tabsScanned.push(tab);
          const partial = {
            ticketWorkflowId: ticket.ticketWorkflowId,
            workKey: ticket.workKey,
            tab,
            closeGate: tab === 'estado' ? closeGate : undefined,
            forms,
          };
          appendPartial(paths, partial);
          observations.push({
            tab,
            ticketWorkflowId: ticket.ticketWorkflowId,
            observedOn: ticket.ticketWorkflowId,
            forms,
          });
        } catch (error) {
          errors.push({
            ticketWorkflowId: ticket.ticketWorkflowId,
            tab,
            message: error.message,
          });
          log(`Error en ${ticket.workKey ?? ticket.ticketWorkflowId} tab=${tab}: ${error.message}`);
        }
      }
      ticket.closeGate = closeGate;
      ticket.tabsScanned = tabsScanned;
    }
  } finally {
    await browser.close();
  }

  const workKeysById = new Map(tickets.map((ticket) => [
    ticket.ticketWorkflowId,
    ticket.workKey ?? ticket.ticketWorkflowId,
  ]));
  for (const observation of observations) {
    observation.observedOn = workKeysById.get(observation.ticketWorkflowId)
      ?? observation.ticketWorkflowId;
  }
  const forms = collapseGlobalForms(mergeForms(observations));
  const ticketRows = tickets.map((ticket) => ({
    ticketWorkflowId: ticket.ticketWorkflowId,
    workKey: ticket.workKey,
    url: `${BASE_URL}/tickets/${ticket.ticketWorkflowId}`,
    ownTicket: ticket.ownTicket,
    closeGate: ticket.closeGate,
    tabsScanned: ticket.tabsScanned,
  }));
  const closeGate = buildCloseGate(ticketRows);
  const notes = buildNotes(forms);
  const schema = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    viewerEmail,
    tabs: options.tabs,
    tickets: ticketRows,
    probeCount,
    probeSources,
    forms,
    closeGate,
    gaps: buildGaps(forms, closeGate, probeCount, probeSources),
    notes,
    stats: buildStats(forms),
    errors,
  };
  writeJson(options.out, schema, paths.dataDir);
  printJson({ ok: true, out: options.out, tickets: ticketRows.length, ...schema.stats });
}

function show(options) {
  const schema = readJson(options.out, 'el esquema de Tolkien');
  const stats = schema.stats ?? {};
  const lines = [
    `Esquema Tolkien v${schema.schemaVersion} — ${schema.generatedAt}`,
    `Formularios: ${stats.formCount ?? 0}`,
    `Campos: ${stats.fieldCount ?? 0}`,
    `Selects con opciones: ${stats.selectWithOptionsCount ?? 0} de ${stats.selectCount ?? 0}`,
    `Opciones observadas: ${stats.optionCount ?? 0}`,
    `Tickets escaneados: ${(schema.tickets ?? []).length}`,
    `Candidatos sondeados por --auto: ${schema.probeCount ?? 0}`,
    `Colas sondeadas por --auto: ${(schema.probeSources ?? []).length}`,
    'Aporte por cola (found/newUnique):',
  ];
  for (const source of schema.probeSources ?? []) {
    lines.push(`  - ${source.filter}: ${source.found}/${source.newUnique}`);
  }
  lines.push('Detalle de formularios:');
  for (const form of schema.forms ?? []) {
    const tabsPresent = form.tabsPresent?.length > 0
      ? ` — tabsPresent: [${form.tabsPresent.join(', ')}]`
      : '';
    const variants = form.submitLabelVariants?.length > 0
      ? ` — submitLabelVariants: [${form.submitLabelVariants.join(' | ')}]`
      : '';
    lines.push(
      `  - ${form.id} — tab: "${form.tab}" — submit: ${form.submitLabel ?? '(sin label)'}${tabsPresent}${variants}`,
    );
  }
  lines.push('Gate de cierre por ticket:');
  for (const ticket of schema.tickets ?? []) {
    const label = ticket.workKey ?? ticket.ticketWorkflowId;
    const evidence = ticket.closeGate?.evidence ? ` — ${ticket.closeGate.evidence}` : '';
    lines.push(`  - ${label}: ${ticket.closeGate?.state ?? 'unknown'}${evidence}`);
  }
  lines.push(`Huecos: ${(schema.gaps ?? []).length}`);
  for (const gap of schema.gaps ?? []) {
    lines.push(`  - ${gap.what} ${gap.why} [needsHuman=${Boolean(gap.needsHuman)}]`);
  }
  lines.push(`Notas: ${(schema.notes ?? []).length}`);
  for (const note of schema.notes ?? []) {
    lines.push(`  - ${note}`);
  }
  if ((schema.errors ?? []).length > 0) {
    lines.push(`Errores: ${schema.errors.length}`);
    for (const error of schema.errors) {
      lines.push(`  - ${error.ticketWorkflowId} tab=${error.tab}: ${error.message}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const paths = tolkienPaths();
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }
  if (command === 'scan') {
    await scan(parseScanArgs(args, paths), paths);
    return;
  }
  if (command === 'show') {
    show(parseShowArgs(args, paths));
    return;
  }
  throw new CliError(`Comando desconocido: ${command}`);
}

main().catch((error) => {
  log(error.stack ?? error.message);
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
