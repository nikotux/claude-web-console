import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const API = '/api/unifi/audit';
const MAP = { verde: 'ok', amarillo: 'atencion', rojo: 'critico' };
const SEVDOT = { verde: 'ok', amarillo: 'warn', rojo: 'fail' };
const LIGHT = { verde: '🟢', amarillo: '🟡', rojo: '🔴' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' + new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '—');
const pct = (v) => (v == null || v === '' ? '—' : `${v}%`);
const dash = (v) => (v == null || v === '' ? '—' : v);

export function mountUnifiPanel(el, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'hp-opt';
  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">${t('system.help.unifi.title', 'Red (UniFi)')}</span>
      ${helpBtn('sys-unifi')}
    </div>`;
  el.appendChild(wrap);

  let alive = true;
  let scanning = false;
  let savingSnapshot = false;
  let snapshotMsg = '';
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  function dotForUse(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'idle';
    if (n > 60) return 'fail';
    if (n >= 40) return 'warn';
    return 'ok';
  }

  function findingsHtml(findings) {
    const rows = (findings || []).map((h) => `
      <tr>
        <td><span class="hp-dot hp-dot--${SEVDOT[h.sev] || 'idle'}"></span></td>
        <td>${esc(h.area)}</td>
        <td title="${esc(h.detalle || '')}">${esc(h.titulo)}</td>
        <td>${esc(dash(h.valor))}</td>
        <td>${esc(dash(h.recomendacion))}</td>
      </tr>`).join('');
    return `<details class="hp-opt-group">
      <summary>🎯 ${t('unifi.findings', 'Hallazgos')} · ${(findings || []).length}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>${t('unifi.severity', 'Sev')}</th><th>${t('unifi.area', 'Área')}</th><th>${t('unifi.finding', 'Hallazgo')}</th><th>${t('unifi.value', 'Valor')}</th><th>${t('unifi.recommendation', 'Recomendación')}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5">${t('unifi.noFindings', 'Sin hallazgos.')}</td></tr>`}</tbody>
      </table>
    </details>`;
  }

  function radiosHtml(radios) {
    const rows = (radios || []).map((r) => {
      const useDot = dotForUse(r.cuTotal);
      return `<tr>
        <td>${esc(r.ap)}</td>
        <td>${esc(r.band)}</td>
        <td>${esc(dash(r.channel))}</td>
        <td>${esc(dash(r.width))}</td>
        <td><span class="hp-dot hp-dot--${useDot}"></span> ${esc(pct(r.cuTotal))}</td>
        <td>${esc(pct(r.txRetriesPct))}</td>
        <td>${esc(dash(r.numSta))}</td>
        <td>${esc(dash(r.txPower))}</td>
        <td>${r.bandsteering ? '✓' : '✗'}</td>
      </tr>`;
    }).join('');
    return `<details class="hp-opt-group">
      <summary>📡 ${t('unifi.radios', 'Radios / APs')} · ${(radios || []).length}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>${t('unifi.ap', 'AP')}</th><th>${t('unifi.band', 'Banda')}</th><th>${t('unifi.channel', 'Canal')}</th><th>${t('unifi.width', 'Ancho')}</th><th>${t('unifi.utilization', 'Utilización')}</th><th>${t('unifi.retries', 'Reintentos')}</th><th>${t('unifi.clients', 'Clientes')}</th><th>${t('unifi.power', 'Potencia')}</th><th>${t('unifi.bandSteering', 'BandSteering')}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="9">${t('unifi.noRadios', 'Sin radios.')}</td></tr>`}</tbody>
      </table>
    </details>`;
  }

  function modeLabel(mode) {
    if (mode === 'weighted') return t('unifi.modeWeighted', 'balanceo');
    if (mode === 'failover-only') return t('unifi.modeFailover', 'failover');
    return mode || '—';
  }

  function wanHtml(wan) {
    const wans = wan?.wans || [];
    const internet = wan?.internet || {};
    const rows = wans.map((w) => `
      <tr>
        <td>${esc(w.name)}</td>
        <td>${esc(w.group)}</td>
        <td>${esc(modeLabel(w.mode))}</td>
        <td>${w.smartq ? '✓' : '✗'}</td>
        <td>${w.availability == null ? '—' : `${Number(w.availability).toFixed(1)}%`}</td>
        <td>${w.latency == null ? '—' : `${esc(w.latency)}ms`}</td>
      </tr>`).join('');
    return `<details class="hp-opt-group">
      <summary>🌐 ${t('unifi.wan', 'WAN')} · ${wans.length}</summary>
      <p class="hp-empty">${t('unifi.latency', 'Latencia')} ${esc(dash(internet.latency))}ms · ↑${esc(dash(internet.xputUp))}/↓${esc(dash(internet.xputDown))} Mbps · ${t('unifi.speedtest', 'speedtest')} ${esc(dash(internet.speedtest))}</p>
      <table class="hp-opt-table">
        <thead><tr><th>${t('unifi.name', 'Nombre')}</th><th>${t('unifi.group', 'Grupo')}</th><th>${t('unifi.mode', 'Modo')}</th><th>${t('unifi.smartQueue', 'SmartQueue')}</th><th>${t('unifi.availability', 'Disponibilidad')}</th><th>${t('unifi.latency', 'Latencia')}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6">${t('unifi.noWans', 'Sin WANs.')}</td></tr>`}</tbody>
      </table>
    </details>`;
  }

  function snapshotHtml() {
    if (!ctx?.isAdmin) return '';
    return `<button class="btn btn--block" data-act="snapshot" ${scanning || savingSnapshot ? 'disabled' : ''}><span>${savingSnapshot ? t('unifi.savingSnapshot', 'Guardando snapshot…') : t('unifi.saveSnapshot', 'Guardar snapshot en Pad')}</span></button>
      ${snapshotMsg ? `<p class="hp-empty">${esc(snapshotMsg)}</p>` : ''}`;
  }

  function render(d) {
    const semaforo = d?.semaforo || 'amarillo';
    const datos = d?.datos || {};
    wrap.innerHTML = `
      <div class="hp-verdict hp-verdict--${MAP[semaforo] || 'atencion'}">
        <b>${LIGHT[semaforo] || LIGHT.amarillo} ${esc(d?.resumen || t('unifi.noSummary', 'Sin resumen'))}</b>
        <span class="hp-when">${scanning ? t('unifi.scanning', 'escaneando…') : fmtDate(d?.generatedAt)}</span>
      </div>
      ${findingsHtml(d?.hallazgos || [])}
      ${radiosHtml(datos.radios || [])}
      ${wanHtml(datos.wan || {})}
      <button class="btn btn--block" data-act="reload" ${scanning ? 'disabled' : ''}>${icon('refresh', { size: 14 })}<span>${scanning ? t('unifi.rescanning', 'Re-escaneando…') : t('unifi.rescan', 'Re-escanear ahora')}</span></button>
      ${snapshotHtml()}`;
    wrap.querySelector('[data-act="reload"]')?.addEventListener('click', () => load(true));
    wrap.querySelector('[data-act="snapshot"]')?.addEventListener('click', saveSnapshot);
  }

  let lastData = null;
  async function load(force) {
    scanning = !!force;
    snapshotMsg = '';
    if (force && lastData) render(lastData);
    try {
      const d = await (await fetch(API)).json();
      if (!alive) return;
      scanning = false;
      lastData = d;
      render(d);
    } catch {
      if (!alive) return;
      scanning = false;
      if (lastData) render(lastData);
      else wrap.innerHTML = `<p class="hp-empty">${t('unifi.readError', 'No se pudo leer la auditoría UniFi.')}</p>`;
    }
  }

  async function saveSnapshot() {
    if (savingSnapshot) return;
    savingSnapshot = true;
    snapshotMsg = t('unifi.savingSnapshot', 'Guardando snapshot…');
    if (lastData) render(lastData);
    try {
      const r = await fetch('/api/unifi/audit-snapshot', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || data?.message || t('unifi.snapshotError', 'No se pudo guardar el snapshot.'));
      if (!alive) return;
      snapshotMsg = t('unifi.snapshotSaved', 'guardado ✓');
    } catch (err) {
      if (!alive) return;
      snapshotMsg = err?.message || t('unifi.snapshotError', 'No se pudo guardar el snapshot.');
    } finally {
      savingSnapshot = false;
      if (alive && lastData) render(lastData);
    }
  }

  wrap.innerHTML = `<p class="hp-running">${pacman()} ${t('unifi.loading', 'cargando…')}</p>`;
  load();
}
