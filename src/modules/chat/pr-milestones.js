// Hitos de PR por sesión: lógica pura compartida por el enlace, watcher y UI.
// Presupuesto duro: un GraphQL + un run-list por minuto como máximo; compares
// solo por pares inmutables nuevos; cero red sin links activos; el backfill
// streamea cada transcript una sola vez y /api/chat/list expone solo prBadge.

const REPO_URL = 'https://github.com/Mordor-Staffing/tolkien';
const PR_URL_RE = /https:\/\/github\.com\/Mordor-Staffing\/tolkien\/pull\/(\d+)/i;
const PR_COMMAND_RE = /\bgh\s+pr\s+(create|edit)\b/;
const ACK_KEY_RE = /^(approved|merged|deployed):(\d+)$/;
const KINDS = ['approved', 'merged', 'deployed'];
export const MAX_PR_LINKS = 10;

export function isTolkienPrCommand(name, input) {
  if (name !== 'Bash') return false;
  const command = typeof input === 'string' ? input : input?.command;
  return typeof command === 'string' && PR_COMMAND_RE.test(command);
}

export function extractTolkienPrLink(output) {
  const match = typeof output === 'string' ? output.match(PR_URL_RE) : null;
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0
    ? { number, url: `${REPO_URL}/pull/${number}` }
    : null;
}

export function prLinkFromCommand({ command, output, exitCode } = {}) {
  if (typeof command !== 'string' || !PR_COMMAND_RE.test(command) || exitCode !== 0) return null;
  return extractTolkienPrLink(output);
}

export function prLinkFromCodexEvent(ev, now = new Date().toISOString()) {
  if (ev?.type !== 'item.completed' || ev.item?.type !== 'command_execution') return null;
  const link = prLinkFromCommand({
    command: ev.item.command,
    output: ev.item.aggregated_output,
    exitCode: ev.item.exit_code,
  });
  const at = validDate(now);
  return link && at ? { ...link, at } : null;
}

export function normalizeCodexPrLinks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const links = [];
  for (const raw of value) {
    const number = Number(raw?.number);
    const at = validDate(raw?.at);
    if (!Number.isSafeInteger(number) || number <= 0 || !at || seen.has(number)) continue;
    seen.add(number);
    links.push({ number, url: `${REPO_URL}/pull/${number}`, at });
    if (links.length === MAX_PR_LINKS) break;
  }
  return links;
}

export function normalizePrLinks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const links = [];
  for (const raw of value) {
    const number = Number(raw?.number);
    if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    const pending = Array.isArray(raw.pending)
      ? [...new Set(raw.pending.filter((kind) => KINDS.includes(kind)))]
      : [];
    links.push({
      number,
      linkedAt: validDate(raw.linkedAt) || new Date().toISOString(),
      title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : null,
      url: typeof raw.url === 'string' && PR_URL_RE.test(raw.url)
        ? `${REPO_URL}/pull/${number}`
        : `${REPO_URL}/pull/${number}`,
      approvedAt: validDate(raw.approvedAt),
      mergedAt: validDate(raw.mergedAt),
      mergeSha: validSha(raw.mergeSha),
      deployedAt: validDate(raw.deployedAt),
      deploySha: validSha(raw.deploySha),
      closed: raw.closed === true,
      baseline: raw.baseline === true,
      pending,
    });
    if (links.length === MAX_PR_LINKS) break;
  }
  return links;
}

export function buildPrGraphqlQuery(numbers) {
  const unique = [...new Set((Array.isArray(numbers) ? numbers : [])
    .map(Number)
    .filter((number) => Number.isSafeInteger(number) && number > 0))].slice(0, 50);
  const pulls = unique.map((number) => (
    `p${number}: pullRequest(number:${number}){ number title url state reviewDecision mergedAt mergeCommit{oid} headRefOid commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:60){totalCount nodes{__typename ... on CheckRun{name status conclusion startedAt completedAt detailsUrl} ... on StatusContext{context state createdAt targetUrl}}}}}}} }`
  )).join('\n');
  return `query { repository(owner:"Mordor-Staffing",name:"tolkien"){\n${pulls}\n} }`;
}

export function summarizePrCi(observed, options = {}) {
  try {
    if (!observed || typeof observed !== 'object' || observed.state !== 'OPEN') return null;
    const number = Number(observed.number);
    if (!Number.isSafeInteger(number) || number <= 0
      || typeof observed.title !== 'string' || typeof observed.url !== 'string') return null;
    const { now = Date.now() } = options && typeof options === 'object' ? options : {};
    // `now` queda en el contrato para que el caller pueda fijar el reloj sin
    // convertir timestamps ausentes en datos inventados.
    void now;
    const commit = observed.commits?.nodes?.[0]?.commit;
    const nodes = commit?.statusCheckRollup?.contexts?.nodes;
    if (!Array.isArray(nodes)) return null;

    const newestByName = new Map();
    for (const node of nodes) {
      const check = normalizeCiCheck(node);
      if (!check) continue;
      const previous = newestByName.get(check.name);
      if (!previous || check.freshAt >= previous.freshAt) newestByName.set(check.name, check);
    }
    const checks = [...newestByName.values()];
    if (!checks.length) return null;

    const runningChecks = checks.filter((check) => check.result === 'running');
    const failedChecks = checks.filter((check) => check.result === 'failed');
    // Una sola falla ya define el resultado (fail-fast): el despertador avisa
    // sin esperar a las revisiones que siguen corriendo.
    const state = failedChecks.length ? 'failed' : runningChecks.length ? 'running' : 'passed';
    const startedTimes = checks.map((check) => check.startedAt).filter(Number.isFinite);
    const completedTimes = checks.map((check) => check.completedAt).filter(Number.isFinite);
    return {
      number,
      title: observed.title.slice(0, 160),
      url: observed.url,
      sha: validSha(commit?.oid) || validSha(observed.headRefOid),
      state,
      total: checks.length,
      done: checks.length - runningChecks.length,
      failed: failedChecks.length,
      running: runningChecks.slice(0, 8).map((check) => check.name),
      failedNames: failedChecks.slice(0, 8).map((check) => check.name),
      startedAt: startedTimes.length ? Math.min(...startedTimes) : null,
      finishedAt: state !== 'running' && completedTimes.length ? Math.max(...completedTimes) : null,
    };
  } catch {
    return null;
  }
}

// Solo la transición observada running → terminado despierta; un `failed` que
// sigue recibiendo revisiones no vuelve a sonar.
export function ciWakeOutcome(previousCi, ci) {
  if (previousCi?.state !== 'running' || !ci || ci.state === 'running') return null;
  return ci.state === 'passed' ? 'pasó' : `falló: ${ci.failedNames.join(', ') || 'sin detalle'}`;
}

export function prCiBadge(ciList) {
  if (!Array.isArray(ciList)) return null;
  const valid = ciList.filter(validCiSummary);
  const selected = newestCi(valid, 'running')
    || newestCi(valid, 'failed')
    || newestCi(valid, 'passed');
  return selected ? {
    number: selected.number,
    state: selected.state,
    done: selected.done,
    total: selected.total,
    failed: selected.failed,
  } : null;
}

export function sameCi(a, b) {
  return ciKey(a) === ciKey(b);
}

function ciKey(summary) {
  if (!validCiSummary(summary)) return null;
  return JSON.stringify({
    state: summary.state,
    done: summary.done,
    total: summary.total,
    failed: summary.failed,
    running: normalizedNames(summary.running),
    failedNames: normalizedNames(summary.failedNames),
    sha: validSha(summary.sha),
  });
}

function normalizeCiCheck(node) {
  if (!node || typeof node !== 'object') return null;
  const isRun = node.__typename === 'CheckRun';
  const isStatus = node.__typename === 'StatusContext';
  if (!isRun && !isStatus) return null;
  const name = ciName(isRun ? node.name : node.context);
  if (!name) return null;
  const startedAt = ciTime(isRun ? node.startedAt : node.createdAt);
  let result = null;
  if (isRun && node.status !== 'COMPLETED') result = 'running';
  else if (isRun && ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(node.conclusion)) result = 'failed';
  else if (isRun && ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE'].includes(node.conclusion)) result = 'ok';
  else if (isStatus && ['PENDING', 'EXPECTED'].includes(node.state)) result = 'running';
  else if (isStatus && ['FAILURE', 'ERROR'].includes(node.state)) result = 'failed';
  else if (isStatus && node.state === 'SUCCESS') result = 'ok';
  if (!result) return null;
  return {
    name,
    result,
    startedAt,
    completedAt: isRun ? ciTime(node.completedAt) : null,
    freshAt: startedAt ?? Number.NEGATIVE_INFINITY,
  };
}

function ciName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 80).trim() : '';
}

function ciTime(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validCiSummary(value) {
  return value && typeof value === 'object'
    && Number.isSafeInteger(value.number) && value.number > 0
    && ['running', 'failed', 'passed'].includes(value.state)
    && [value.done, value.total, value.failed].every((count) => Number.isSafeInteger(count) && count >= 0);
}

function ciRecency(summary) {
  return Number.isFinite(summary.finishedAt) ? summary.finishedAt
    : Number.isFinite(summary.startedAt) ? summary.startedAt : Number.NEGATIVE_INFINITY;
}

function newestCi(ciList, state) {
  return ciList.filter((ci) => ci.state === state).sort((a, b) => ciRecency(b) - ciRecency(a))[0];
}

function normalizedNames(value) {
  return Array.isArray(value)
    ? value.filter((name) => typeof name === 'string').map((name) => name.trim()).sort()
    : [];
}

export function applyPrTransitions(current, observed, { now = new Date().toISOString(), firstObservation = false } = {}) {
  const link = normalizePrLinks([current])[0];
  if (!link || !observed) return { link: current, milestones: [] };
  const milestones = [];
  link.title = typeof observed.title === 'string' ? observed.title.slice(0, 300) : link.title;
  link.url = extractTolkienPrLink(observed.url)?.url || link.url;

  const approvedNow = observed.reviewDecision === 'APPROVED' && !link.approvedAt;
  const mergedNow = observed.state === 'MERGED' && !link.mergedAt;
  if (approvedNow) link.approvedAt = now;
  if (mergedNow) {
    link.mergedAt = validDate(observed.mergedAt) || now;
  }
  if (observed.state === 'MERGED') link.mergeSha = validSha(observed.mergeCommit?.oid) || link.mergeSha;
  if (observed.state === 'CLOSED' && !observed.mergedAt && !observed.mergeCommit?.oid) link.closed = true;

  const linkedMs = Date.parse(link.linkedAt);
  const mergePredatesLink = mergedNow && Date.parse(link.mergedAt) < linkedMs;
  if (!firstObservation && approvedNow && !mergedNow) milestones.push('approved');
  if (mergedNow && !mergePredatesLink && !firstObservation) milestones.push('merged');
  // Si ambos aparecen juntos, el merge contiene la señal de aprobación.
  if (approvedNow && mergedNow && milestones.includes('approved')) milestones.splice(milestones.indexOf('approved'), 1);
  for (const kind of milestones) if (!link.pending.includes(kind)) link.pending.push(kind);
  return { link, milestones };
}

export function applyDeployment(current, { deploySha, deployedAt, firstObservation = false } = {}) {
  const link = normalizePrLinks([current])[0];
  if (!link || link.deployedAt || !validSha(deploySha)) return { link: current, milestones: [] };
  link.deployedAt = validDate(deployedAt) || new Date().toISOString();
  link.deploySha = deploySha.toLowerCase();
  const predatesLink = Date.parse(link.deployedAt) < Date.parse(link.linkedAt);
  const milestones = firstObservation || predatesLink ? [] : ['deployed'];
  if (milestones.length && !link.pending.includes('deployed')) link.pending.push('deployed');
  return { link, milestones };
}

export function applyPrObservation(current, observed, deployInfo = null, { now = new Date().toISOString() } = {}) {
  const normalized = normalizePrLinks([current])[0];
  if (!normalized || !observed) return { link: current, milestones: [] };
  const firstObservation = normalized.baseline === true;
  const transition = applyPrTransitions(normalized, observed, { now, firstObservation });
  let link = transition.link;
  const milestones = [...transition.milestones];
  if (deployInfo?.deployed) {
    const deployment = applyDeployment(link, {
      deploySha: deployInfo.deploySha,
      deployedAt: deployInfo.deployedAt,
      firstObservation,
    });
    link = deployment.link;
    milestones.push(...deployment.milestones);
  }
  // El baseline durable se consume incluso si GitHub no reportó cambios.
  link.baseline = false;
  return { link, milestones };
}

export function parseKamalProductionTitle(title) {
  const match = typeof title === 'string'
    ? title.match(/^Deploy Kamal deploy production sha-([0-9a-f]{40})$/)
    : null;
  return match ? match[1] : null;
}

export function isDeployedCompareStatus(status) {
  return status === 'ahead' || status === 'identical';
}

export function validMilestoneKeys(keys) {
  return Array.isArray(keys) && keys.length <= 20
    && keys.every((key) => typeof key === 'string' && ACK_KEY_RE.test(key));
}

export function pendingMilestones(links) {
  const out = [];
  for (const link of normalizePrLinks(links)) {
    for (const kind of link.pending) {
      const at = kind === 'approved' ? link.approvedAt : kind === 'merged' ? link.mergedAt : link.deployedAt;
      out.push({
        key: `${kind}:${link.number}`,
        kind,
        number: link.number,
        title: link.title,
        url: link.url,
        at,
        approvedAt: link.approvedAt,
        mergedAt: link.mergedAt,
        deployedAt: link.deployedAt,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
}

export function newestPrBadge(links) {
  const newest = pendingMilestones(links).at(-1);
  return newest ? { number: newest.number, kind: newest.kind } : null;
}

export function acknowledgeMilestones(links, keys) {
  const wanted = new Set(keys);
  return normalizePrLinks(links).map((link) => ({
    ...link,
    pending: link.pending.filter((kind) => !wanted.has(`${kind}:${link.number}`)),
  }));
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}
