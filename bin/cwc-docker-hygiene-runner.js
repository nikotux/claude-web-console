#!/usr/bin/env node
// bin/cwc-docker-hygiene-runner.js — relevamiento y barrido MANUAL de basura
// Docker. Por defecto solo reporta; el borrado exige --prune --yes y nunca toca
// contenedores ni volúmenes asociados por nombre a un proyecto Compose activo.
//
// Es config-free: puede correr desacoplado y persiste un JSON privado para que
// el check rápido de Salud no tenga que consultar el daemon.
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { writeJsonAtomic } from '../src/core/atomic-write.js';
import { runAdaptivePool } from '../src/core/pool.js';

const REPORT_FILE = path.join(os.homedir(), '.cwc-data', 'docker-hygiene', 'report.json');
const DOCKER_TIMEOUT_MS = 15_000;
const log = (...args) => console.log(`[${new Date().toISOString()}]`, '[docker-hygiene]', ...args);
const usage = () => console.error(
  'Uso: node bin/cwc-docker-hygiene-runner.js [--report | --prune [--yes]]',
);

function docker(args) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        error: String(stderr || err?.message || '').trim(),
      });
    });
  });
}

function lines(text) {
  return [...new Set(String(text || '').split('\n').map((line) => line.trim()).filter(Boolean))];
}

function dockerBytes(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*([kmgtpe]?i?b)/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = match[2].toLowerCase();
  const binary = unit.includes('i');
  const power = 'kmgtpe'.indexOf(unit[0]) + 1;
  return Math.round(amount * (power > 0 ? (binary ? 1024 : 1000) ** power : 1));
}

function parseSystemDf(text) {
  const rows = String(text || '').split('\n').map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const find = (type) => rows.find((row) => String(row.Type || '').toLowerCase() === type);
  const volumes = find('local volumes');
  const images = find('images');
  return {
    volumeTotal: Number.parseInt(volumes?.TotalCount, 10) || 0,
    volumeBytes: dockerBytes(volumes?.Reclaimable),
    imageBytes: dockerBytes(images?.Reclaimable),
  };
}

function unavailable(reason) {
  return {
    ts: Date.now(),
    status: 'unavailable',
    volumes: { total: 0, dangling: 0, bytes: 0 },
    images: { dangling: 0, bytes: 0 },
    activeProjects: [],
    note: String(reason || 'Docker no está disponible').slice(0, 300),
  };
}

function saveReport(report) {
  try {
    writeJsonAtomic(REPORT_FILE, report, { mode: 0o600, space: 2 });
    return true;
  } catch (err) {
    log(`no se pudo guardar ${REPORT_FILE}: ${err?.message || err}`);
    return false;
  }
}

async function activeProjects() {
  const result = await docker([
    'ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}',
  ]);
  return { ...result, values: result.ok ? lines(result.out).sort() : [] };
}

async function danglingVolumes() {
  const result = await docker(['volume', 'ls', '-q', '-f', 'dangling=true']);
  return { ...result, values: result.ok ? lines(result.out).sort() : [] };
}

async function danglingImages() {
  const result = await docker(['image', 'ls', '-q', '-f', 'dangling=true']);
  return { ...result, values: result.ok ? lines(result.out).sort() : [] };
}

async function collectReport() {
  const df = await docker(['system', 'df', '--format', '{{json .}}']);
  if (!df.ok) return unavailable(df.error);

  const [volumes, images, projects] = await Promise.all([
    danglingVolumes(),
    danglingImages(),
    activeProjects(),
  ]);
  const failed = [volumes, images, projects].find((result) => !result.ok);
  if (failed) return unavailable(failed.error);

  const sizes = parseSystemDf(df.out);
  return {
    ts: Date.now(),
    status: 'ok',
    volumes: {
      total: sizes.volumeTotal,
      dangling: volumes.values.length,
      bytes: sizes.volumeBytes,
    },
    images: {
      dangling: images.values.length,
      bytes: sizes.imageBytes,
    },
    activeProjects: projects.values,
  };
}

function protectedByProject(volume, projects) {
  return projects.some((project) => project && volume.includes(project));
}

function printPlan(volumes, images, projects) {
  const protectedVolumes = volumes.filter((name) => protectedByProject(name, projects));
  const removableVolumes = volumes.filter((name) => !protectedByProject(name, projects));
  log(`HARÍA: borrar ${removableVolumes.length} volumen(es) dangling y ${images.length} imagen(es) dangling.`);
  for (const name of removableVolumes) log(`HARÍA volumen: ${name}`);
  for (const name of protectedVolumes) log(`PROTEGIDO por proyecto Compose activo: ${name}`);
  for (const id of images) log(`HARÍA imagen: ${id}`);
  log('Simulación solamente: no se borró nada. Para ejecutar hace falta --prune --yes.');
}

async function removeEach(kind, command, values) {
  let failed = 0;
  // Node serializa los incrementos de failed; las líneas de auditoría sí pueden intercalarse.
  await runAdaptivePool(values, async (value) => {
    let result;
    try {
      result = await docker([...command, value]);
    } catch (err) {
      result = { ok: false, error: err?.message || String(err) };
    }
    if (result.ok) log(`borrado ${kind}: ${value}`);
    else {
      failed += 1;
      log(`no se pudo borrar ${kind} ${value}: ${result.error || 'sin detalle'}`);
    }
  }, {
    min: 2,
    start: 3,
    // Techo bajo para no saturar el daemon de Docker.
    max: 3,
  });
  return failed;
}

async function runReport() {
  const report = await collectReport();
  const saved = saveReport(report);
  if (report.status === 'unavailable') {
    log(`Docker no disponible; estado unavailable${saved ? ' guardado' : ' no persistido'} (${report.note}).`);
    if (!saved) console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!saved) throw new Error('no se pudo persistir el reporte de higiene Docker');
  log(`reporte guardado: ${report.volumes.dangling} volumen(es) y ${report.images.dangling} imagen(es) dangling.`);
}

async function runPrune(confirmed) {
  const report = await collectReport();
  const saved = saveReport(report);
  if (report.status === 'unavailable') {
    log(`Docker no disponible; no hay nada que borrar y el estado unavailable${saved ? ' quedó guardado' : ' no pudo persistirse'} (${report.note}).`);
    if (!saved) console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!saved) throw new Error('no se pudo persistir el reporte previo al barrido');

  const initialVolumes = await danglingVolumes();
  const initialImages = await danglingImages();
  if (!initialVolumes.ok || !initialImages.ok) {
    log(`Docker dejó de responder; no hay nada que borrar (${initialVolumes.error || initialImages.error}).`);
    return;
  }
  if (!confirmed) {
    printPlan(initialVolumes.values, initialImages.values, report.activeProjects);
    return;
  }

  // GUARD DURO: inmediatamente antes de borrar se recalculan proyectos y
  // candidatos. Si cualquiera de las lecturas falla, se aborta sin borrar.
  const [projects, volumes, images] = await Promise.all([
    activeProjects(),
    danglingVolumes(),
    danglingImages(),
  ]);
  const failedRead = [projects, volumes, images].find((result) => !result.ok);
  if (failedRead) {
    log(`No se pudo revalidar el estado de Docker; barrido abortado (${failedRead.error || 'sin detalle'}).`);
    return;
  }
  const removableVolumes = volumes.values.filter(
    (name) => !protectedByProject(name, projects.values),
  );
  const protectedVolumes = volumes.values.filter(
    (name) => protectedByProject(name, projects.values),
  );
  for (const name of protectedVolumes) log(`PROTEGIDO por proyecto Compose activo: ${name}`);

  const volumeFailures = await removeEach('volumen', ['volume', 'rm', '--'], removableVolumes);
  const imageFailures = await removeEach('imagen', ['image', 'rm'], images.values);
  const refreshed = await collectReport();
  saveReport(refreshed);
  log(`barrido terminado: ${removableVolumes.length - volumeFailures} volumen(es) y ${images.values.length - imageFailures} imagen(es) borrados.`);
  if (volumeFailures || imageFailures) process.exitCode = 1;
}

const args = process.argv.slice(2);
const known = new Set(['--report', '--prune', '--yes']);
const invalid = args.filter((arg) => !known.has(arg));
const wantsReport = args.includes('--report');
const wantsPrune = args.includes('--prune');
const confirmed = args.includes('--yes');

if (invalid.length || (wantsReport && wantsPrune) || (confirmed && !wantsPrune)) {
  usage();
  process.exitCode = 2;
} else {
  try {
    if (wantsPrune) await runPrune(confirmed);
    else await runReport();
  } catch (err) {
    log(`FALLO: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
