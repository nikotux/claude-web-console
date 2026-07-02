// modules/stats/stats.js — gauges de sistema en el pie fijo del sidebar.
// Poll a /api/stats; siempre visible (no depende de acordeón).
const POLL_MS = 2500;

function fmtBytes(b) {
  if (!b) return '0';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)}${u[i]}`;
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function heatClass(pct) {
  if (pct >= 85) return 'hi';
  if (pct >= 60) return 'mid';
  return 'lo';
}

function gauge(label, pct, text) {
  const p = Math.round(pct);
  return `
    <div class="gauge">
      <span class="gauge-label">${label}</span>
      <span class="gauge-bar"><span class="gauge-fill ${heatClass(pct)}" style="width:${p}%"></span></span>
      <span class="gauge-val">${text}</span>
    </div>`;
}

export function initStats(container) {
  async function tick() {
    if (document.hidden) return; // no gastamos red con la pestaña en segundo plano
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) return;
      const s = await res.json();
      container.innerHTML =
        gauge('CPU', s.cpu.pct, `${Math.round(s.cpu.pct)}%`) +
        gauge('RAM', s.mem.pct, `${fmtBytes(s.mem.used)}/${fmtBytes(s.mem.total)}`) +
        gauge('Disco', s.disk.pct, `${Math.round(s.disk.pct)}%`) +
        `<div class="stats-foot">${s.hostname} · carga ${s.load[0].toFixed(2)} · up ${fmtUptime(s.uptime)}</div>`;
    } catch { /* reintenta al próximo tick */ }
  }
  tick();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  return setInterval(tick, POLL_MS);
}
