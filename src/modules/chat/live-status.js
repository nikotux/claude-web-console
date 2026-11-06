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
