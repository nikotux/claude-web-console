// modules/stats/stats.js — gauges de sistema en el pie fijo (fila 1, compacta).
//
// CPU / RAM / Disco en UNA fila de mini-gauges; hostname, carga y uptime van
// al tooltip (dato de plomería → no ocupa espacio visual). Poll 2.5 s,
// pausado con la pestaña en segundo plano.
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
  if (d) return `${d}d ${h}h`;
  return `${h}h ${Math.floor((s % 3600) / 60)}m`;
}
function heat(pct) {
  if (pct >= 85) return 'hi';
  if (pct >= 60) return 'mid';
  return 'lo';
}
function gauge(label, pct) {
  const p = Math.round(pct);
  return `
    <span class="gauge-mini">
      <span class="gauge-label">${label}</span>
      <span class="gauge-bar"><span class="gauge-fill ${heat(pct)}" style="width:${p}%"></span></span>
      <span class="gauge-val">${p}%</span>
    </span>`;
}

export default {
  name: 'stats',

  mount(el) {
    // classList.add (no className=): el wrapper puede traer clases del layout
    // (p.ej. only-expanded) que NO hay que pisar.
    el.classList.add('gauges-row');
    async function tick() {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/stats');
        if (!res.ok) return;
        const s = await res.json();
        el.innerHTML = gauge('CPU', s.cpu.pct) + gauge('RAM', s.mem.pct) + gauge('DSK', s.disk.pct);
        el.title = `${s.hostname} · RAM ${fmtBytes(s.mem.used)}/${fmtBytes(s.mem.total)} · carga ${s.load[0].toFixed(2)} · up ${fmtUptime(s.uptime)}`;
      } catch { /* reintenta al próximo tick */ }
    }
    tick();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    setInterval(tick, POLL_MS);
  },
};
