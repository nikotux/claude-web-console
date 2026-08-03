#!/usr/bin/env node

/**
 * Canario read-only de la estructura que usa el motor de Tolkien.
 *
 * Hace una muestra chica mediante el escáner de esquema, compara únicamente
 * el contrato del motor y deja un reporte auditable antes de operar tickets.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../src/core/data-dir.js';
import { openStore, recordSchemaSnapshot } from './cwc-tolkien-store.js';

const VERDICT_EXIT = { ok: 0, info: 10, block: 20, error: 1 };
const CONTRACT_ELEMENTS = ['work-context', 'close-form', 'closed-recognition'];
const DEFAULT_NEXT_ACTOR = 'external_system';
const DEFAULT_TABS = ['estado'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Este contrato se extrajo LEYENDO bin/cwc-tolkien.js (no se importa a
// propósito, para no acoplarse a un archivo que otra sesión edita):
// submitDesiredOutcome() localiza el formulario con select[name="mode"] y
// manda textarea[name="desiredOutcome"] + mode='working' +
// nextActorKind=<valor>; submitClose() lo localiza con
// select[name="verificationKind"] y manda verificationKind='objective_check'
// + textarea[name="evidenceSummary"]; inspectTicketState() reconoce un ticket
// cerrado por la AUSENCIA de select[name="verificationKind"]. Si el motor
// cambia lo que manda, este contrato se actualiza acá.
export const CONTRACT = [
  {
    element: 'work-context',
    tab: 'estado',
    anchorField: { name: 'mode', tag: 'select' },
    // El motor sólo submitea este formulario cuando el ticket no tiene
    // desiredOutcome. En ese estado Tolkien usa el gate missing_outcome y
    // renderiza textarea[name="desiredOutcome"]; con gate available el mismo
    // campo es input hidden y compararlo contra la unión del baseline daría un
    // falso field-kind-changed.
    expectedGates: ['missing_outcome'],
    fields: [
      { name: 'desiredOutcome', tag: 'textarea' },
      { name: 'mode', tag: 'select', sentValues: ['working'] },
      { name: 'nextActorKind', tag: 'select', sentValues: [] },
    ],
    filledByEngine: ['ticketWorkflowId', 'desiredOutcome', 'mode', 'nextActorKind'],
  },
  {
    element: 'close-form',
    tab: 'estado',
    anchorField: { name: 'verificationKind', tag: 'select' },
    expectedGates: ['available'],
    fields: [
      { name: 'verificationKind', tag: 'select', sentValues: ['objective_check'] },
      { name: 'evidenceSummary', tag: 'textarea' },
    ],
    filledByEngine: ['ticketWorkflowId', 'verificationKind', 'evidenceSummary'],
  },
  {
    element: 'closed-recognition',
    tab: 'estado',
    expectedGates: ['closed'],
    // No tiene formulario propio: se verifica que en un ticket cerrado NO exista
    // el campo verificationKind (de eso depende showsClosedBlock del motor) y,
    // como evidencia secundaria, que exista el formulario "Reopen in Tolkien".
    absentField: { name: 'verificationKind' },
    reopenLabel: /Reopen in Tolkien/i,
  },
];

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function canaryPaths() {
  const dataDir = path.join(resolveDataDir(), 'tolkien');
  return {
    dataDir,
    sessionFile: path.join(dataDir, 'session.json'),
    censusFile: path.join(dataDir, 'census.json'),
    reconcileFile: path.join(dataDir, 'reconcile.json'),
    schemaFile: path.join(dataDir, 'schema.json'),
    dbFile: path.join(dataDir, 'state.db'),
    canaryDir: path.join(dataDir, 'canary'),
    reportFile: path.join(dataDir, 'canary', 'last-check.json'),
    historyFile: path.join(dataDir, 'canary', 'history.jsonl'),
    schemaCli: path.join(path.dirname(fileURLToPath(import.meta.url)), 'cwc-tolkien-schema.js'),
  };
}

function formsForTicket(schema, ticketKey, tab) {
  return (schema.forms ?? []).filter(
    (form) => form.tab === tab && (form.observedOn ?? []).includes(ticketKey),
  );
}

function ticketKeyOf(ticketRow) {
  return ticketRow.workKey ?? ticketRow.ticketWorkflowId;
}

function fieldOf(form, { name, tag }) {
  return (form?.fields ?? []).find((field) => field.name === name && field.tag === tag);
}

function findAnchored(forms, anchorField) {
  return forms.find((form) => fieldOf(form, anchorField));
}

function optionValues(field) {
  return (field?.options ?? []).map((option) => option.value);
}

function finding(severity, kind, element, ticket, field, expected, observed, detail) {
  return {
    severity,
    kind,
    element,
    ticket: ticket ?? null,
    field: field ?? null,
    expected: expected ?? null,
    observed: observed ?? null,
    detail,
  };
}

function eligibleTickets(schema, contract) {
  return (schema.tickets ?? []).filter(
    (ticket) => contract.expectedGates.includes(ticket.closeGate?.state),
  );
}

function baselineElement(schema, contract) {
  for (const ticket of eligibleTickets(schema, contract)) {
    const forms = formsForTicket(schema, ticketKeyOf(ticket), contract.tab);
    if (!contract.anchorField) return { ticket, forms, form: null };
    const form = findAnchored(forms, contract.anchorField);
    if (form) return { ticket, forms, form };
  }
  return null;
}

function stateDriftReason(contract, baselineRef, fresh) {
  if (baselineRef?.ticket) {
    const baselineTicket = baselineRef.ticket;
    const freshTicket = (fresh.tickets ?? []).find((ticket) => (
      ticket.ticketWorkflowId === baselineTicket.ticketWorkflowId
      || (baselineTicket.workKey && ticket.workKey === baselineTicket.workKey)
    ));
    if (freshTicket) {
      const label = ticketKeyOf(freshTicket);
      const before = baselineTicket.closeGate?.state ?? 'desconocido';
      const after = freshTicket.closeGate?.state ?? 'desconocido';
      if (before !== after) {
        return `el ticket de muestra ${label} pasó de "${before}" a "${after}": `
          + 'es un cambio de ESTADO, no de estructura';
      }
    }
  }
  return `ningún ticket fresco tuvo un gate apto para verificar ${contract.element} `
    + `(${contract.expectedGates.join(', ')})`;
}

function canonicalField(field) {
  return {
    name: field.name,
    tag: field.tag,
    type: field.type ?? null,
    required: field.required === true,
    options: [...new Set(optionValues(field))].sort((left, right) => left.localeCompare(right)),
  };
}

function canonicalProjection(observedForms, verifiedClosed) {
  const projected = [];
  for (const contract of CONTRACT) {
    const form = observedForms.get(contract.element);
    if (form) {
      projected.push({
        element: contract.element,
        fields: (form.fields ?? [])
          .map(canonicalField)
          .sort((left, right) => `${left.name}|${left.tag}`.localeCompare(`${right.name}|${right.tag}`)),
      });
    } else if (contract.element === 'closed-recognition' && verifiedClosed) {
      projected.push({ element: contract.element, fields: [] });
    }
  }
  return projected.sort((left, right) => left.element.localeCompare(right.element));
}

function inspectFormContract({ contract, ticket, freshForm, baselineForm, findings }) {
  const label = ticketKeyOf(ticket);
  const runtimeFields = contract.fields.map((field) => (
    field.name === 'nextActorKind'
      ? { ...field, sentValues: [...(field.sentValues ?? [])] }
      : field
  ));

  for (const expectedField of runtimeFields) {
    const freshField = fieldOf(freshForm, expectedField);
    const baselineField = fieldOf(baselineForm, expectedField);
    if (!freshField) {
      const sameName = (freshForm.fields ?? []).find((field) => field.name === expectedField.name);
      if (sameName) {
        findings.push(finding(
          'block',
          'field-kind-changed',
          contract.element,
          label,
          expectedField.name,
          baselineField ? { tag: baselineField.tag, type: baselineField.type ?? null } : expectedField,
          { tag: sameName.tag, type: sameName.type ?? null },
          `El campo ${expectedField.name} cambió de clase; el motor busca `
            + `${expectedField.tag}[name="${expectedField.name}"].`,
        ));
      } else {
        findings.push(finding(
          'block',
          'field-missing',
          contract.element,
          label,
          expectedField.name,
          expectedField,
          null,
          `Falta el campo ${expectedField.tag}[name="${expectedField.name}"] que llena el motor.`,
        ));
      }
      continue;
    }

    if (baselineField
      && (freshField.tag !== baselineField.tag || (freshField.type ?? null) !== (baselineField.type ?? null))) {
      findings.push(finding(
        'block',
        'field-kind-changed',
        contract.element,
        label,
        expectedField.name,
        { tag: baselineField.tag, type: baselineField.type ?? null },
        { tag: freshField.tag, type: freshField.type ?? null },
        `El campo ${expectedField.name} cambió de tag o type respecto del esquema base.`,
      ));
    }

    const sentValues = expectedField.name === 'nextActorKind'
      ? [...new Set([...(expectedField.sentValues ?? []), contract.nextActorKind])]
      : (expectedField.sentValues ?? []);
    const freshOptions = optionValues(freshField);
    for (const sentValue of sentValues) {
      if (!freshOptions.includes(sentValue)) {
        findings.push(finding(
          'block',
          'option-missing',
          contract.element,
          label,
          expectedField.name,
          sentValue,
          freshOptions,
          `El motor manda "${sentValue}" en ${expectedField.name}, pero la muestra ofrece `
            + `${freshOptions.length > 0 ? freshOptions.map((value) => `"${value}"`).join(', ') : 'ninguna opción'}.`,
        ));
      }
    }
  }

  for (const freshField of freshForm.fields ?? []) {
    const baselineField = fieldOf(baselineForm, freshField);
    const fieldName = `${freshField.name} (${freshField.tag})`;
    if (!baselineField) {
      const sameName = (baselineForm.fields ?? []).find((field) => field.name === freshField.name);
      if (sameName) continue;
      if (freshField.required === true
        && !contract.filledByEngine.includes(freshField.name)
        && freshField.type !== 'hidden'
        && freshField.disabled !== true
        && freshField.readOnly !== true) {
        findings.push(finding(
          'block',
          'new-required-field',
          contract.element,
          label,
          freshField.name,
          { required: false },
          { required: true, tag: freshField.tag, type: freshField.type ?? null },
          `Apareció el campo obligatorio ${fieldName} y el motor no lo llena; el submit fallaría en silencio.`,
        ));
      } else if (freshField.required !== true) {
        findings.push(finding(
          'info',
          'field-added',
          contract.element,
          label,
          freshField.name,
          null,
          { tag: freshField.tag, type: freshField.type ?? null, required: false },
          `Apareció el campo no obligatorio ${fieldName}.`,
        ));
      }
      continue;
    }

    if (freshField.required === true
      && baselineField.required !== true
      && !contract.filledByEngine.includes(freshField.name)
      && freshField.type !== 'hidden'
      && freshField.disabled !== true
      && freshField.readOnly !== true) {
      findings.push(finding(
        'block',
        'new-required-field',
        contract.element,
        label,
        freshField.name,
        { required: baselineField.required === true },
        { required: true },
        `El campo ${fieldName} ahora es obligatorio y el motor no lo llena; el submit fallaría en silencio.`,
      ));
    }

    const baselineOptions = optionValues(baselineField);
    const freshOptions = optionValues(freshField);
    for (const value of freshOptions.filter((option) => !baselineOptions.includes(option))) {
      findings.push(finding(
        'info',
        'option-added',
        contract.element,
        label,
        freshField.name,
        baselineOptions,
        freshOptions,
        `La opción "${value}" apareció en ${freshField.name}.`,
      ));
    }
    const sentValues = freshField.name === 'nextActorKind'
      ? [contract.nextActorKind]
      : (contract.fields.find((field) => field.name === freshField.name && field.tag === freshField.tag)?.sentValues ?? []);
    for (const value of baselineOptions.filter(
      (option) => !freshOptions.includes(option) && !sentValues.includes(option),
    )) {
      findings.push(finding(
        'info',
        'option-absent-in-sample',
        contract.element,
        label,
        freshField.name,
        baselineOptions,
        freshOptions,
        `La opción "${value}" no apareció en esta muestra, que es más chica que el baseline; `
          + 'puede ser muestreo y no un retiro real.',
      ));
    }
  }
}

export function evaluateContract({
  baseline,
  fresh,
  nextActorKind = DEFAULT_NEXT_ACTOR,
  required = [],
}) {
  const findings = [];
  const unverified = [];
  const verifiedOn = new Map(CONTRACT_ELEMENTS.map((element) => [element, []]));
  const observedForms = new Map();
  const observedTicketKeys = new Set(
    (fresh.forms ?? []).flatMap((form) => form.observedOn ?? []),
  );
  const failedObservationKeys = new Set(
    (fresh.tickets ?? [])
      .map(ticketKeyOf)
      .filter((key) => !observedTicketKeys.has(key)),
  );
  let verifiedClosed = false;

  for (const originalContract of CONTRACT) {
    const contract = { ...originalContract, nextActorKind };
    const baselineRef = baselineElement(baseline, contract);
    if (!baselineRef) {
      const reason = `el baseline no contiene una muestra apta de ${contract.element}`;
      findings.push(finding(
        'info',
        'baseline-sin-elemento',
        contract.element,
        null,
        null,
        contract.expectedGates,
        null,
        `No se puede comparar ${contract.element}: ${reason}.`,
      ));
      unverified.push({ element: contract.element, reason });
      continue;
    }

    const gateEligibleTickets = eligibleTickets(fresh, contract);
    const freshTickets = gateEligibleTickets.filter(
      (ticket) => !failedObservationKeys.has(ticketKeyOf(ticket)),
    );
    if (freshTickets.length === 0) {
      const baselineTicketInFresh = (fresh.tickets ?? []).find((ticket) => (
        ticket.ticketWorkflowId === baselineRef.ticket.ticketWorkflowId
        || (baselineRef.ticket.workKey && ticket.workKey === baselineRef.ticket.workKey)
      ));
      const failedTicket = (
        baselineTicketInFresh && failedObservationKeys.has(ticketKeyOf(baselineTicketInFresh))
          ? baselineTicketInFresh
          : gateEligibleTickets.find((ticket) => failedObservationKeys.has(ticketKeyOf(ticket)))
      );
      unverified.push({
        element: contract.element,
        reason: failedTicket
          ? `la observación de ${ticketKeyOf(failedTicket)} falló: el escaneo no capturó ningún formulario para ese ticket (carrera de hidratación), no es un cambio de estructura`
          : stateDriftReason(contract, baselineRef, fresh),
      });
      continue;
    }

    for (const ticket of freshTickets) {
      const label = ticketKeyOf(ticket);
      const forms = formsForTicket(fresh, label, contract.tab);
      verifiedOn.get(contract.element).push(label);
      if (contract.element === 'closed-recognition') {
        verifiedClosed = true;
        const forbidden = forms.find((form) => (
          (form.fields ?? []).some((field) => field.name === contract.absentField.name)
        ));
        if (forbidden) {
          findings.push(finding(
            'block',
            'close-form-on-closed-ticket',
            contract.element,
            label,
            contract.absentField.name,
            'ausente',
            'presente',
            'Un ticket cerrado volvió a renderizar verificationKind; la regla de reconocimiento del motor dejó de ser segura.',
          ));
        }
        if (!forms.some((form) => contract.reopenLabel.test(form.submitLabel ?? ''))) {
          findings.push(finding(
            'info',
            'reopen-form-missing',
            contract.element,
            label,
            null,
            'Reopen in Tolkien',
            null,
            'No apareció el formulario de reapertura; es evidencia secundaria y el motor no lo usa.',
          ));
        }
        continue;
      }

      const freshForm = findAnchored(forms, contract.anchorField);
      if (!freshForm) {
        findings.push(finding(
          'block',
          'form-missing',
          contract.element,
          label,
          contract.anchorField.name,
          contract.anchorField,
          null,
          `El gate "${ticket.closeGate?.state}" debía renderizar ${contract.element}, pero no apareció su formulario anclado.`,
        ));
        continue;
      }
      if (!observedForms.has(contract.element)) observedForms.set(contract.element, freshForm);
      inspectFormContract({ contract, ticket, freshForm, baselineForm: baselineRef.form, findings });
    }
  }

  // Fuera del contrato sólo interesan altas: el canario observa una muestra
  // deliberadamente menor al baseline, por lo que reportar bajas produciría
  // ruido falso cada vez que un formulario no estuviera representado.
  const baselineSignatures = new Set((baseline.forms ?? []).map((form) => form.signature));
  const reportedNew = new Set();
  for (const form of fresh.forms ?? []) {
    if (baselineSignatures.has(form.signature) || reportedNew.has(form.signature)) continue;
    reportedNew.add(form.signature);
    findings.push(finding(
      'info',
      'form-new',
      'fuera-del-contrato',
      form.observedOn?.[0] ?? null,
      null,
      null,
      form.signature,
      `Apareció un formulario con firma nueva: ${form.signature}.`,
    ));
  }

  for (const element of required) {
    const missing = unverified.find((entry) => entry.element === element);
    if (!missing) continue;
    findings.push(finding(
      'block',
      'unverified-required',
      element,
      null,
      null,
      'verificado',
      'no verificado',
      `${element} es obligatorio para esta corrida, pero ${missing.reason}.`,
    ));
  }

  const elements = CONTRACT.map(({ element }) => {
    const missing = unverified.find((entry) => entry.element === element);
    const related = findings.filter((entry) => entry.element === element);
    return {
      element,
      status: missing ? 'unverified' : related.length > 0 ? 'changed' : 'ok',
      verifiedOn: [...new Set(verifiedOn.get(element))],
      reason: missing?.reason ?? null,
    };
  });
  const verdict = findings.some((entry) => entry.severity === 'block')
    ? 'block'
    : findings.length > 0 || unverified.length > 0
      ? 'info'
      : 'ok';

  return {
    verdict,
    findings,
    elements,
    unverified,
    projection: canonicalProjection(observedForms, verifiedClosed),
  };
}

export function verdictExitCode(verdict) {
  return VERDICT_EXIT[verdict] ?? VERDICT_EXIT.error;
}

function reconcileTicket(value) {
  if (!value) return null;
  if (typeof value === 'string') return { ticketWorkflowId: value, workKey: null };
  return {
    ticketWorkflowId: value.ticketWorkflowId,
    workKey: value.workKey ?? value.workNumber ?? null,
  };
}

function matchingBaselineTicket(baseline, candidate) {
  return (baseline.tickets ?? []).find((ticket) => (
    ticket.ticketWorkflowId === candidate.ticketWorkflowId
    || (candidate.workKey && ticket.workKey === candidate.workKey)
  ));
}

export function pickSample({ baseline, reconcile, explicitTickets = [] }) {
  const sample = [];
  const add = (candidate, role, expectedGate = undefined) => {
    if (!candidate?.ticketWorkflowId) return;
    if (sample.some((entry) => entry.ticketWorkflowId === candidate.ticketWorkflowId)) return;
    const baselineTicket = matchingBaselineTicket(baseline, candidate);
    sample.push({
      ticketWorkflowId: candidate.ticketWorkflowId,
      workKey: candidate.workKey ?? baselineTicket?.workKey ?? null,
      role,
      expectedGate: expectedGate === undefined
        ? (baselineTicket?.closeGate?.state ?? null)
        : expectedGate,
    });
  };

  if (explicitTickets.length > 0) {
    for (const explicit of explicitTickets) {
      const raw = typeof explicit === 'string'
        ? { ticketWorkflowId: explicit, workKey: null }
        : explicit;
      const baselineTicket = matchingBaselineTicket(baseline, raw);
      add({
        ticketWorkflowId: raw.ticketWorkflowId,
        workKey: raw.workKey ?? baselineTicket?.workKey ?? null,
      }, 'explicit', raw.expectedGate ?? baselineTicket?.closeGate?.state ?? null);
    }
    return sample;
  }

  // Se toman DOS tickets de closable a propósito: son los que la corrida va a
  // escribir de verdad, y con dos hay chance real de observar uno available y
  // otro missing_outcome para cubrir el contrato entero.
  for (const value of (reconcile.closable ?? []).slice(0, 2)) {
    add(reconcileTicket(value), 'closable');
  }
  for (const value of reconcile.realOpen ?? []) {
    if (sample.length >= 2) break;
    add(reconcileTicket(value), 'realOpen');
  }
  for (const ticket of baseline.tickets ?? []) {
    if (sample.length >= 2) break;
    if (ticket.closeGate?.state !== 'closed') add(ticket, 'baseline');
  }

  const closed = (baseline.tickets ?? []).find((ticket) => ticket.closeGate?.state === 'closed');
  if (closed) add(closed, 'closed');
  return sample;
}

function operationalError(reason, detail, statusCode = null) {
  return { reason, detail, statusCode };
}

function requireCopySource(file, kind) {
  if (fs.existsSync(file)) return null;
  if (kind === 'session') {
    return operationalError(
      'session-missing',
      'No hay sesión guardada de Tolkien; corré `node bin/cwc-tolkien.js login --cookie <valor>`.',
    );
  }
  return operationalError(
    `${kind}-missing`,
    `Falta ${path.basename(file)}; corré \`${kind === 'census' ? 'node bin/cwc-tolkien.js census' : 'node bin/cwc-tolkien.js reconcile'}\` primero.`,
  );
}

export function runScan({ paths, tickets, tabs, sessionFile, keepScratch }) {
  const startedAt = Date.now();
  fs.mkdirSync(paths.canaryDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.canaryDir, 0o700);
  // El finally no corre ante SIGKILL, y el scratch contiene una copia de la
  // cookie de sesión; por eso limpiamos los scratch de procesos ya muertos.
  let removedScratch = 0;
  try {
    for (const entry of fs.readdirSync(paths.canaryDir)) {
      const match = entry.match(/^scratch-(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if (error.code !== 'ESRCH') continue;
      }
      try {
        fs.rmSync(path.join(paths.canaryDir, entry), { recursive: true, force: true });
        removedScratch += 1;
      } catch {
        // El barrido es sólo de higiene y nunca debe tumbar la corrida.
      }
    }
  } catch {
    // El barrido es sólo de higiene y nunca debe tumbar la corrida.
  }
  if (removedScratch > 0) {
    log(`Limpié ${removedScratch} scratch huérfano(s) de corridas anteriores.`);
  }
  const scratch = path.join(paths.canaryDir, `scratch-${process.pid}`);
  const scratchTolkien = path.join(scratch, 'tolkien');
  // El scratch vive bajo ~/.cwc-data y no en /tmp: writeFileAtomic del hijo
  // renombra desde un temporal vecino y cruzar filesystems produciría EXDEV.
  fs.mkdirSync(scratchTolkien, { recursive: true, mode: 0o700 });
  fs.chmodSync(scratch, 0o700);
  fs.chmodSync(scratchTolkien, 0o700);
  try {
    const sources = [
      { source: sessionFile, target: 'session.json', kind: 'session' },
      { source: paths.censusFile, target: 'census.json', kind: 'census' },
      { source: paths.reconcileFile, target: 'reconcile.json', kind: 'reconcile' },
    ];
    for (const item of sources) {
      const missing = requireCopySource(item.source, item.kind);
      if (missing) return { schema: null, durationMs: Date.now() - startedAt, error: missing, scratch };
      const target = path.join(scratchTolkien, item.target);
      fs.copyFileSync(item.source, target);
      fs.chmodSync(target, 0o600);
    }

    const ids = tickets.map((ticket) => ticket.ticketWorkflowId);
    const outFile = path.join(scratchTolkien, 'canary-scan.json');
    // CWC_DATA_DIR es imprescindible: cwc-tolkien-schema.js scan reinicia
    // <dataDir>/tolkien/schema-partial.jsonl en cada corrida y esa ruta se
    // resuelve por tolkienPaths(), NO por --out. Sin este scratch, el canario
    // borraría el rastro de reanudación de un escaneo completo en curso.
    const status = spawnSync(process.execPath, [
      paths.schemaCli,
      'scan',
      '--tickets',
      ids.join(','),
      '--tabs',
      tabs.join(','),
      '--out',
      outFile,
    ], {
      env: { ...process.env, CWC_DATA_DIR: scratch },
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (status.status !== 0) {
      const code = status.status ?? null;
      const stderr = (status.stderr ?? status.error?.message ?? '').slice(0, 2000);
      const reason = code === 2 ? 'session-expired' : 'scan-failed';
      const remedy = code === 2
        ? ' Volvé a loguearte con `node bin/cwc-tolkien.js login --cookie <valor>`.'
        : '';
      return {
        schema: null,
        durationMs: Date.now() - startedAt,
        error: operationalError(
          reason,
          `El escaneo hijo terminó con código ${code ?? 'desconocido'}: ${stderr || '(sin stderr)'}.${remedy}`,
          code,
        ),
        scratch,
      };
    }
    try {
      return {
        schema: JSON.parse(fs.readFileSync(outFile, 'utf8')),
        durationMs: Date.now() - startedAt,
        error: null,
        scratch,
      };
    } catch (error) {
      return {
        schema: null,
        durationMs: Date.now() - startedAt,
        error: operationalError('scan-output-invalid', `No se pudo leer ${outFile}: ${error.message}`),
        scratch,
      };
    }
  } finally {
    if (!keepScratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`No se pudo leer ${label} (${file}): ${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function appendHistory(file, value) {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function displayPath(file) {
  const home = os.homedir();
  return file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

function log(message) {
  process.stderr.write(`[cwc-tolkien-canary] ${message}\n`);
}

function valueAfter(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new CliError(`Falta el valor de ${option}.`, 2);
  return value;
}

function parseList(raw, option) {
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new CliError(`${option} no puede estar vacío.`, 2);
  return values;
}

function resolveExplicitTickets(values, baseline) {
  return values.map((value) => {
    let ticketWorkflowId = value;
    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        ticketWorkflowId = parsed.pathname.match(/^\/tickets\/([0-9a-f-]+)\/?$/i)?.[1] ?? '';
      } catch {
        ticketWorkflowId = '';
      }
    }
    const known = (baseline.tickets ?? []).find((ticket) => (
      ticket.ticketWorkflowId === ticketWorkflowId || ticket.workKey === value
    ));
    if (known) return known.ticketWorkflowId;
    if (!UUID_PATTERN.test(ticketWorkflowId)) {
      throw new CliError(
        `Ticket inválido o ausente del baseline: ${value}. El escaneo hijo siempre recibe UUID.`,
        2,
      );
    }
    return ticketWorkflowId.toLowerCase();
  });
}

function parseCheckArgs(args, paths) {
  let tickets = [];
  let tabs = [...DEFAULT_TABS];
  let nextActorKind = DEFAULT_NEXT_ACTOR;
  let required = [];
  let baselineFile = paths.schemaFile;
  let sessionFile = paths.sessionFile;
  let json = false;
  let keepScratch = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--tickets') {
      tickets = parseList(valueAfter(args, index, arg), arg);
      index += 1;
    } else if (arg === '--tabs') {
      tabs = [...new Set(parseList(valueAfter(args, index, arg), arg))];
      index += 1;
    } else if (arg === '--next-actor') {
      nextActorKind = valueAfter(args, index, arg);
      index += 1;
    } else if (arg === '--require') {
      required = [...new Set(parseList(valueAfter(args, index, arg), arg))];
      index += 1;
    } else if (arg === '--baseline') {
      baselineFile = path.resolve(valueAfter(args, index, arg));
      index += 1;
    } else if (arg === '--session') {
      sessionFile = path.resolve(valueAfter(args, index, arg));
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--keep-scratch') {
      keepScratch = true;
    } else if (arg === '--help') {
      return { help: true };
    } else {
      throw new CliError(`Opción desconocida para check: ${arg}`, 2);
    }
  }
  const invalid = required.filter((element) => !CONTRACT_ELEMENTS.includes(element));
  if (invalid.length > 0) {
    throw new CliError(
      `Elementos inválidos en --require: ${invalid.join(', ')}. Válidos: ${CONTRACT_ELEMENTS.join(', ')}.`,
      2,
    );
  }
  return { tickets, tabs, nextActorKind, required, baselineFile, sessionFile, json, keepScratch };
}

function parseShowArgs(args, paths) {
  let reportFile = paths.reportFile;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--report') {
      reportFile = path.resolve(valueAfter(args, index, arg));
      index += 1;
    } else if (arg === '--help') {
      return { help: true };
    } else {
      throw new CliError(`Opción desconocida para show: ${arg}`, 2);
    }
  }
  return { reportFile };
}

function help() {
  process.stdout.write(`Uso:
  node bin/cwc-tolkien-canary.js check [opciones]
  node bin/cwc-tolkien-canary.js show [--report <ruta>]
  node bin/cwc-tolkien-canary.js help

Opciones de check:
  --tickets <lista>      UUID, WORK-n conocido o URL separados por comas.
                         Sin esta opción toma hasta 3: dos operables y uno cerrado.
  --tabs <lista>         Pestañas separadas por comas (default: estado).
  --next-actor <valor>   Valor que enviará el motor (default: external_system).
  --require <lista>      Elementos que deben quedar verificados.
  --baseline <ruta>      Esquema base (default: <dataDir>/tolkien/schema.json).
  --session <ruta>       Sesión a copiar al scratch aislado.
  --json                 Imprime el reporte JSON exacto.
  --keep-scratch         Conserva el scratch para diagnóstico.
  --help                 Muestra esta ayuda.

Exit codes: 0 ok · 10 info · 20 block · 1 error operativo · 2 uso incorrecto.

Garantía: este canario es de SOLO LECTURA respecto de Tolkien: solo navega URLs GET a través de cwc-tolkien-schema.js, nunca hace submit ni click.
`);
}

const VERDICT_ICON = { ok: '✅', info: '⚠️', block: '⛔', error: '💥' };
const STATUS_LABEL = { ok: 'ok', changed: 'cambió', unverified: 'no verificado' };

export function renderHuman(report) {
  const fingerprint = report.snapshot?.fingerprint?.slice(0, 12) ?? 'sin snapshot';
  const lines = [
    `${VERDICT_ICON[report.verdict] ?? '💥'} ${report.verdict} · `
      + `${report.findings?.length ?? 0} hallazgo(s) · ${fingerprint}`,
  ];
  if ((report.elements ?? []).length > 0) {
    lines.push('', 'Elemento · estado · verificado en');
    for (const element of report.elements) {
      lines.push(
        `${element.element} · ${STATUS_LABEL[element.status] ?? element.status} · `
          + `${element.verifiedOn?.length > 0 ? element.verifiedOn.join(', ') : '—'}`,
      );
    }
  }
  for (const severity of ['block', 'info']) {
    const matches = (report.findings ?? []).filter((entry) => entry.severity === severity);
    if (matches.length === 0) continue;
    lines.push('', severity === 'block' ? 'Bloqueos:' : 'Avisos:');
    for (const entry of matches) {
      const where = [entry.element, entry.ticket].filter(Boolean).join('/');
      lines.push(`  ${severity === 'block' ? '⛔' : '⚠️'} [${entry.kind}] ${where} — ${entry.detail}`);
    }
  }
  if ((report.unverified ?? []).length > 0) {
    lines.push('', 'No verificado:');
    for (const entry of report.unverified) lines.push(`  ⚠️ ${entry.element} — ${entry.reason}`);
  }
  lines.push('');
  if (report.verdict === 'block') {
    lines.push('No operes: corré `node bin/cwc-tolkien-schema.js scan --auto` para regenerar el esquema y revisá qué cambió antes de escribir.');
  } else if (report.verdict === 'info') {
    lines.push('Podés operar; revisá los avisos.');
  } else if (report.verdict === 'error') {
    lines.push(report.error?.detail ?? 'Corregí el error operativo y volvé a correr el canario.');
  } else {
    lines.push('Podés operar: el contrato observado coincide con el baseline.');
  }
  return `${lines.join('\n')}\n`;
}

function storeSnapshot(paths, fresh, projection) {
  let db = null;
  try {
    db = openStore(paths.dbFile);
    return recordSchemaSnapshot(db, {
      source: 'canary',
      schemaVersion: fresh.schemaVersion ?? null,
      snapshot: projection,
    });
  } catch (error) {
    log(`Aviso: la base local no pudo registrar el snapshot: ${error.message}`);
    return null;
  } finally {
    try { db?.close?.(); } catch { /* la base ya estaba cerrada */ }
  }
}

function baseReport({
  checkedAt,
  baselineFile,
  baseline,
  sample,
  tabs,
  durationMs,
  rescans,
  required,
  nextActorKind,
}) {
  return {
    canaryVersion: 1,
    verdict: 'error',
    exitCode: VERDICT_EXIT.error,
    checkedAt,
    baseline: {
      file: baselineFile,
      schemaVersion: baseline.schemaVersion ?? null,
      generatedAt: baseline.generatedAt ?? null,
    },
    sample: { tickets: sample, tabs, durationMs, rescans },
    elements: [],
    findings: [],
    unverified: [],
    required,
    nextActorKind,
    snapshot: null,
    error: null,
  };
}

async function checkCommand(options, paths) {
  const checkedAt = new Date().toISOString();
  const baseline = readJson(options.baselineFile, 'el esquema baseline');
  const reconcile = readJson(paths.reconcileFile, 'reconcile.json');
  const explicit = resolveExplicitTickets(options.tickets, baseline);
  const picked = pickSample({ baseline, reconcile, explicitTickets: explicit });
  if (picked.length === 0) throw new CliError('No hay tickets disponibles para construir la muestra.');
  let scan = runScan({
    paths,
    tickets: picked,
    tabs: options.tabs,
    sessionFile: options.sessionFile,
    keepScratch: options.keepScratch,
  });
  let rescans = 0;
  if (!scan.error) {
    const observedOn = new Set(
      (scan.schema?.forms ?? []).flatMap((form) => form.observedOn ?? []),
    );
    const missing = picked.filter((ticket) => {
      const scannedTicket = (scan.schema?.tickets ?? []).find(
        (entry) => entry.ticketWorkflowId === ticket.ticketWorkflowId,
      );
      return !observedOn.has(ticketKeyOf(scannedTicket ?? ticket));
    });
    if (missing.length > 0) {
      log(`El primer escaneo no capturó formularios para ${missing.map(ticketKeyOf).join(', ')}; reintentando una vez la muestra completa.`);
      const retry = runScan({
        paths,
        tickets: picked,
        tabs: options.tabs,
        sessionFile: options.sessionFile,
        keepScratch: options.keepScratch,
      });
      retry.durationMs += scan.durationMs;
      scan = retry;
      rescans = 1;
    }
  }
  const observedTickets = new Map((scan.schema?.tickets ?? []).map((ticket) => [
    ticket.ticketWorkflowId,
    ticket.closeGate?.state ?? null,
  ]));
  const reportSample = picked.map((ticket) => ({
    ...ticket,
    observedGate: observedTickets.get(ticket.ticketWorkflowId) ?? null,
  }));
  const report = baseReport({
    checkedAt,
    baselineFile: options.baselineFile,
    baseline,
    sample: reportSample,
    tabs: options.tabs,
    durationMs: scan.durationMs,
    rescans,
    required: options.required,
    nextActorKind: options.nextActorKind,
  });

  if (scan.error) {
    report.error = { reason: scan.error.reason, detail: scan.error.detail };
  } else {
    const result = evaluateContract({
      baseline,
      fresh: scan.schema,
      nextActorKind: options.nextActorKind,
      required: options.required,
    });
    report.verdict = result.verdict;
    report.exitCode = verdictExitCode(result.verdict);
    report.elements = result.elements;
    report.findings = result.findings;
    report.unverified = result.unverified;
    report.snapshot = storeSnapshot(paths, scan.schema, result.projection);
  }

  writeJsonAtomic(paths.reportFile, report);
  appendHistory(paths.historyFile, {
    checkedAt,
    verdict: report.verdict,
    fingerprint: report.snapshot?.fingerprint ?? null,
    findings: report.findings.length,
    unverified: report.unverified.map((entry) => entry.element),
  });
  if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stdout.write(renderHuman(report));
  process.exitCode = report.exitCode;
}

function showCommand(options) {
  const report = readJson(options.reportFile, 'el último reporte del canario');
  process.stdout.write(renderHuman(report));
  process.exitCode = verdictExitCode(report.verdict);
}

async function main() {
  const paths = canaryPaths();
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help') {
    help();
    return;
  }
  if (command === 'check') {
    const options = parseCheckArgs(args, paths);
    if (options.help) help();
    else await checkCommand(options, paths);
    return;
  }
  if (command === 'show') {
    const options = parseShowArgs(args, paths);
    if (options.help) help();
    else showCommand(options);
    return;
  }
  throw new CliError(`Comando desconocido: ${command}`, 2);
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    log(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}
