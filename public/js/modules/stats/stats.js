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
// Cada gauge tiene DOS representaciones (CSS muestra una según el estado del
// panel): barra con etiqueta y % (expandido) y anillo-ícono dinámico con el
// porcentaje como relleno cónico (rail colapsado).
function gauge(iconFn, label, iconName, pct) {
  const p = Math.round(pct);
  const h = heat(pct);
  return `
    <span class="gauge-mini" title="${label} ${p}%">
      <span class="gauge-label">${label}</span>
      <span class="gauge-bar"><span class="gauge-fill ${h}" style="width:${p}%"></span></span>
      <span class="gauge-val">${p}%</span>
      <span class="gauge-ring ${h}" style="--pct:${p}">${iconFn(iconName, { size: 10 })}</span>
    </span>`;
}

export default {
  name: 'stats',

  mount(el, ctx) {
    // classList.add (no className=): el wrapper puede traer clases del layout
    // (p.ej. only-expanded) que NO hay que pisar.
    el.classList.add('gauges-row');
    const ic = ctx?.icon || (() => '');
    async function tick() {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/stats');
        if (!res.ok) return;
        const s = await res.json();
        el.innerHTML =
          gauge(ic, 'CPU', 'cpu', s.cpu.pct) +
          gauge(ic, 'RAM', 'ram', s.mem.pct) +
          gauge(ic, 'DSK', 'disk', s.disk.pct);
        el.title = `${s.hostname} · RAM ${fmtBytes(s.mem.used)}/${fmtBytes(s.mem.total)} · carga ${s.load[0].toFixed(2)} · up ${fmtUptime(s.uptime)}`;
      } catch { /* reintenta al próximo tick */ }
    }
    tick();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    setInterval(tick, POLL_MS);
  },
};
