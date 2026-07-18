// modules/stats/stats.js — gauges de sistema en el pie fijo (fila 1, compacta).
//
// CPU / RAM / Disco en UNA fila de mini-gauges; hostname, carga y uptime van
// al tooltip (dato de plomería → no ocupa espacio visual). Poll 2.5 s,
// pausado con la pestaña en segundo plano.
const POLL_MS = 2500;

// Exportados (además de uso local acá): el dashboard de Salud
// (system/inventory-modal.js) los reusa para pintar CPU/RAM/Disco con el
// MISMO criterio de color/formato que este gauge del pie (fuente única).
export function fmtBytes(b) {
  if (!b) return '0';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)}${u[i]}`;
}
export function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  if (d) return `${d}d ${h}h`;
  return `${h}h ${Math.floor((s % 3600) / 60)}m`;
}
export function heat(pct) {
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
    let built = false;
    // Parcheo in-place de UN gauge ya construido: solo toca relleno/%/anillo,
    // sin reconstruir el subtree (evita reparsear HTML + SVG cada 2,5s).
    function patchGauge(mini, label, pct) {
      const p = Math.round(pct);
      const h = heat(pct);
      const fill = mini.querySelector('.gauge-fill');
      if (fill) { fill.style.width = `${p}%`; fill.className = `gauge-fill ${h}`; }
      const val = mini.querySelector('.gauge-val');
      if (val) val.textContent = `${p}%`;
      const ring = mini.querySelector('.gauge-ring');
      if (ring) { ring.style.setProperty('--pct', p); ring.className = `gauge-ring ${h}`; }
      mini.title = `${label} ${p}%`;
    }
    async function tick() {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/stats');
        if (!res.ok) return;
        const s = await res.json();
        const minis = el.querySelectorAll('.gauge-mini');
        if (!built || minis.length !== 3) {
          // Primera vez (o estructura perdida): construir el subtree una vez.
          el.innerHTML =
            gauge(ic, 'CPU', 'cpu', s.cpu.pct) +
            gauge(ic, 'RAM', 'ram', s.mem.pct) +
            gauge(ic, 'DSK', 'disk', s.disk.pct);
          built = true;
        } else {
          // Ticks siguientes: parchear en su lugar (sin rebuild).
          patchGauge(minis[0], 'CPU', s.cpu.pct);
          patchGauge(minis[1], 'RAM', s.mem.pct);
          patchGauge(minis[2], 'DSK', s.disk.pct);
        }
        el.title = `${s.hostname} · RAM ${fmtBytes(s.mem.used)}/${fmtBytes(s.mem.total)} · carga ${s.load[0].toFixed(2)} · up ${fmtUptime(s.uptime)}`;
      } catch { /* reintenta al próximo tick */ }
    }
    tick();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    setInterval(tick, POLL_MS);
  },
};
