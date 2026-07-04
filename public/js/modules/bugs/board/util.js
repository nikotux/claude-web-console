// board/util.js — helpers puros compartidos por todos los módulos del tablero.
// Sin estado, sin DOM, sin imports: la base de la pirámide (evita ciclos).

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const fmtDate = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
};

export function fmtAgo(ms) {
  if (!ms) return 'sin datos';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}
