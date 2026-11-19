// Proyecciones puras del estado durable de Codex para chat y sidebar.

const LIVE_FINISHED_MS = 90_000;

function time(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteDuration(job) {
  const started = time(job?.startedAt);
  const finished = time(job?.finishedAt);
  return started && finished >= started ? finished - started : null;
}

function workFor(job) {
  if (Array.isArray(job?.files) && job.files.length) return 'untouched';
  if (Number(job?.progress?.counts?.files) > 0) return 'partial';
  return 'untouched';
}

function problemDetail(job, report, firstLine, kind) {
  const parts = [];
  const error = String(job?.error || '').trim();
  if (error) parts.push(error);

  if (kind === 'conflict' || kind === 'isolation') {
    const blocks = report.trim().split(/\n\s*\n/).filter(Boolean);
    if (blocks[0]) parts.push(blocks[0].trim());
    const exact = blocks.find((block) => /^(?:Motivo exacto|stderr de git apply)\s*:/i.test(block.trim()));
    if (exact) parts.push(exact.trim());
  } else if (firstLine && firstLine !== error) {
    parts.push(firstLine);
  }

  const detail = parts.join('\n\n');
  return detail.length > 600 ? `${detail.slice(0, 599)}…` : detail;
}

export function describeCodexProblem(job) {
  if (!job || job.status === 'pending' || job.status === 'running') return null;
  const status = String(job.status || '');
  if (job.isError !== true && !['error', 'killed', 'orphaned'].includes(status)) return null;

  const report = String(job.report || '');
  const firstLine = report.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  const text = `${String(job.error || '')}\n${firstLine}`;
  const trimmedReport = report.trimStart();
  let kind = 'unknown';
  let ball = 'claude';
  let work = 'unknown';

  if (trimmedReport.startsWith('⚠️ CONFLICTO')) {
    kind = 'conflict'; ball = 'claude'; work = 'saved';
  } else if (trimmedReport.startsWith('⛔ DELEGACIÓN NO EJECUTADA')) {
    kind = 'isolation'; ball = 'claude'; work = 'untouched';
  } else if (text.includes('no está autenticado')) {
    kind = 'auth'; ball = 'you'; work = 'untouched';
  } else if (text.includes('no está en el PATH') || text.includes('No se pudo lanzar el runner')) {
    kind = 'missing'; ball = 'support'; work = 'untouched';
  } else if (/timeout tras|superó el tope/i.test(text)) {
    kind = 'timeout'; ball = 'claude'; work = workFor(job);
  } else if (status === 'killed' || /SIGTERM|SIGINT/.test(text)) {
    kind = 'restart'; ball = 'system'; work = workFor(job);
  } else if (status === 'orphaned' && text.includes('ya no existe')) {
    kind = 'crash'; ball = 'system'; work = workFor(job);
  } else if (status === 'orphaned' || /heartbeat/i.test(text)) {
    kind = 'silent'; ball = 'system'; work = workFor(job);
  }

  return { kind, ball, work, detail: problemDetail(job, report, firstLine, kind) };
}

export function codexLiveForChat(jobs, chatId, now = Date.now()) {
  const clock = time(now) || Date.now();
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => {
      if (!job || String(job.chatId || '') !== String(chatId || '')) return false;
      if (job.status === 'pending' || job.status === 'running') return true;
      const finished = time(job.finishedAt);
      return finished > 0 && clock - finished <= LIVE_FINISHED_MS;
    })
    .map((job) => ({
      id: String(job.id || ''),
      label: String(job.label || job.task || '').slice(0, 120),
      status: String(job.status || ''),
      isError: job.isError === true,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      heartbeatAt: job.heartbeatAt || null,
      progress: job.progress && typeof job.progress === 'object' ? job.progress : null,
      problem: describeCodexProblem(job),
    }))
    .sort((a, b) => time(a.startedAt) - time(b.startedAt) || a.id.localeCompare(b.id));
}

export function codexTypical(jobs) {
  const durations = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.status === 'done' && job.isError !== true)
    .map(finiteDuration)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (durations.length < 10) return null;
  const percentile = (p) => durations[Math.ceil(durations.length * p) - 1];
  const middle = Math.floor(durations.length / 2);
  const medianMs = durations.length % 2
    ? durations[middle]
    : Math.round((durations[middle - 1] + durations[middle]) / 2);
  return { medianMs, p90Ms: percentile(.9), n: durations.length };
}

export function codexBadge(live) {
  const running = (Array.isArray(live) ? live : [])
    .find((job) => job?.status === 'pending' || job?.status === 'running');
  if (!running) return null;
  const steps = Array.isArray(running.progress?.steps) ? running.progress.steps : [];
  return { running: true, done: steps.filter((step) => step?.done === true).length, total: steps.length };
}

export function liveKey(value) {
  return JSON.stringify(value ?? null);
}
