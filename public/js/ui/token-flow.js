// ui/token-flow.js — store + director DOM para el caudal de tokens.
// Un solo rAF anima todas las celdas .cwc-flow-cell presentes en el documento.

export const MAX_TPS = 8000;
export const POLL_MS = 400;

export let latest = {
  claude: { tps: 0, tokens60: 0, lastTs: null },
  codex: { tps: 0, tokens60: 0, lastTs: null },
  bySession: {},
  byCwd: {},
  updatedAt: null,
};

let subscribers = 0;
let pollTimer = null;
let polling = false;
let visibilityBound = false;
let directorStarted = false;
let lastNumAt = 0;
let lastPruneAt = 0;

const smooth = new Map();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function pressureFromTps(tps) {
  return clamp((Math.max(0, Number(tps) || 0) / MAX_TPS) ** 0.5, 0, 1);
}

export async function pollFlow() {
  if (!subscribers || document.hidden || polling) return;
  polling = true;
  try {
    const res = await fetch('/api/tokens/flow');
    if (res.ok) latest = await res.json();
  } catch {
    // Error transitorio: mantenemos el último snapshot bueno.
  } finally {
    polling = false;
  }
}

function ensureVisibilityListener() {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && subscribers) {
      pollFlow();
      startPoller();
    }
  });
}

export function startPoller() {
  ensureVisibilityListener();
  if (pollTimer || document.hidden) return;
  pollFlow();
  pollTimer = setInterval(() => {
    if (document.hidden) {
      stopPoller();
      return;
    }
    pollFlow();
  }, POLL_MS);
}

export function stopPoller() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

export function subscribeFlow() {
  subscribers += 1;
  if (subscribers === 1) startPoller();
}

export function unsubscribeFlow() {
  subscribers = Math.max(0, subscribers - 1);
  if (!subscribers) stopPoller();
}

export function getLatestFlow() {
  return latest;
}

function fmtTps(tps) {
  const n = Math.max(0, Number(tps) || 0);
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function escAttr(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function flowBarHtml(opts = {}) {
  const engine = opts.engine === 'codex' ? 'codex' : opts.engine === 'claude' ? 'claude' : null;
  if (!engine) return '';

  const session = opts.session != null ? String(opts.session) : '';
  const cwd = opts.cwd != null ? String(opts.cwd) : '';
  const compact = !!opts.compact;
  const key = `${engine}:${session || cwd || 'global'}`;
  const dot = opts.dot !== false;
  const label = opts.label != null && opts.label !== '' ? String(opts.label) : '';

  return `<span class="cwc-flow-cell${compact ? ' cwc-flow-cell--compact' : ''}" data-flow-engine="${engine}"${session ? ` data-flow-session="${escAttr(session)}"` : ''}${cwd ? ` data-flow-cwd="${escAttr(cwd)}"` : ''} data-flow-key="${escAttr(key)}">
      ${dot ? `<span class="cwc-flow-dot cwc-flow-dot--${engine}"></span>` : ''}
      ${label ? `<span class="cwc-flow-label">${escAttr(label)}</span>` : ''}
      <span class="cwc-flow-bar"><span class="cwc-flow-mask"></span></span>
      <span class="cwc-flow-num" data-flow-num>0</span>
      ${opts.total ? '<span class="cwc-flow-total" data-flow-total title="tokens acumulados en la sesión (aprox.)">0</span>' : ''}
    </span>`;
}

export function ensureFlowDirector() {
  if (directorStarted) return;
  directorStarted = true;
  subscribeFlow();

  function frame(now) {
    const flow = getLatestFlow();
    const cells = document.querySelectorAll('.cwc-flow-cell');
    const updateNums = now - lastNumAt >= 200;

    if (updateNums) lastNumAt = now;

    for (const el of cells) {
      const eng = el.dataset.flowEngine;
      const session = el.dataset.flowSession;
      const cwd = el.dataset.flowCwd;
      const key = el.dataset.flowKey || `${eng || 'unknown'}:${session || cwd || 'global'}`;
      let tps = 0;
      let total = null;

      if (session && eng === 'claude') {
        const b = flow?.bySession?.[session];
        tps = b?.tps || 0;
        total = b?.total ?? 0;
      } else if (cwd && eng === 'codex') {
        const b = flow?.byCwd?.[cwd];
        tps = b?.tps || 0;
        total = b?.total ?? 0;
      } else {
        tps = flow?.[eng]?.tps || 0;
      }

      const prev = smooth.get(key) || 0;
      const target = pressureFromTps(tps) * 100;
      const disp = prev + (target - prev) * 0.15;
      smooth.set(key, disp);

      const mask = el.querySelector('.cwc-flow-mask');
      if (mask) mask.style.left = `${disp.toFixed(2)}%`;

      if (updateNums) {
        const numEl = el.querySelector('[data-flow-num]');
        if (numEl) numEl.textContent = el.classList.contains('cwc-flow-cell--compact') ? fmtTps(tps) : `${fmtTps(tps)} t/s`;

        const totEl = el.querySelector('[data-flow-total]');
        if (totEl && total != null) totEl.textContent = fmtTokens(total);
      }
    }

    if (now - lastPruneAt >= 2000) {
      lastPruneAt = now;
      const present = new Set([...document.querySelectorAll('.cwc-flow-cell')].map((el) => el.dataset.flowKey).filter(Boolean));
      for (const key of smooth.keys()) {
        if (!present.has(key)) smooth.delete(key);
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
