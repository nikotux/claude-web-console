// Auditoria deterministica de voz sobre UniFi: solo lectura contra UDM y upsert
// best-effort al Pad local.
import {
  getNetworks,
  getHealth,
  getWlans,
  getDeviceStats,
} from './client.js';
import {
  listItems,
  createItem,
  updateItem,
  getItem,
} from '../../core/pad-service-client.js';

const COLLECTION = 'auditoria-red';
const UID = 'voz-audit';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseFields(item) {
  const f = item?.fields;
  if (!f) return {};
  if (typeof f === 'object') return f;
  try { return JSON.parse(f) || {}; } catch { return {}; }
}

function bandFor(radio) {
  if (radio === 'ng') return '2.4 GHz';
  if (radio === 'na') return '5 GHz';
  if (radio === '6e') return '6 GHz';
  return String(radio ?? '');
}

function slug(value) {
  return String(value ?? 'na')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'na';
}

function text(value, fallback = '') {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value);
}

function pct(value) {
  return `${value}%`;
}

function tableCell(value) {
  return text(value, '-').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function itemsArray(data) {
  if (Array.isArray(data)) return data;
  return asArray(data?.items);
}

function healthBySubsystem(health, subsystem) {
  return asArray(health).find((entry) => entry?.subsystem === subsystem) || {};
}

export async function getRadios() {
  const devices = await getDeviceStats();
  const radios = [];

  for (const d of asArray(devices).filter((device) => device?.type === 'uap')) {
    const statsByName = new Map();
    for (const st of asArray(d.radio_table_stats)) {
      if (st?.name) {
        statsByName.set(st.name, st);
      }
    }

    for (const rt of asArray(d.radio_table)) {
      const st = statsByName.get(rt?.name) || {};
      radios.push({
        ap: d.name,
        radio: rt?.radio,
        band: bandFor(rt?.radio),
        channel: st.channel ?? rt?.channel,
        width: st.bw ?? rt?.ht,
        txPower: st.tx_power,
        txPowerMode: rt?.tx_power_mode,
        minRssiEnabled: rt?.min_rssi_enabled,
        minRssi: rt?.min_rssi,
        cuTotal: st.cu_total,
        cuSelfRx: st.cu_self_rx,
        cuSelfTx: st.cu_self_tx,
        txRetriesPct: st.tx_retries_pct,
        numSta: st.num_sta,
        satisfaction: st.satisfaction,
        state: st.state,
        bandsteering: d.bandsteering_mode,
      });
    }
  }

  return radios;
}

export async function getWan() {
  const [networks, health] = await Promise.all([getNetworks(), getHealth()]);
  const healthWan = healthBySubsystem(health, 'wan');
  const www = healthBySubsystem(health, 'www');
  const wanNetworks = asArray(networks).filter((n) => n?.purpose === 'wan' || n?.wan_networkgroup);

  const wans = wanNetworks.map((n) => {
    const group = n.wan_networkgroup;
    const uptime = group ? healthWan.uptime_stats?.[group] : null;
    return {
      name: n.name,
      group,
      mode: n.wan_load_balance_type,
      smartq: n.smartq_enabled === true,
      availability: uptime?.availability,
      latency: uptime?.latency_average,
    };
  });

  return {
    wans,
    smartqAny: wanNetworks.some((n) => n?.smartq_enabled === true),
    internet: {
      latency: www.latency,
      xputUp: www.xput_up,
      xputDown: www.xput_down,
      drops: www.drops,
      speedtest: www.speedtest_status,
    },
  };
}

export async function buildVoiceAudit() {
  const [radios, wan, wlans] = await Promise.all([getRadios(), getWan(), getWlans()]);
  const hallazgos = [];

  function addFinding({ id, sev, area, titulo, detalle = '', valor = '', recomendacion = '' }) {
    hallazgos.push({ id, sev, area, titulo, detalle, valor, recomendacion });
  }

  for (const radio of radios) {
    const apRadio = `${slug(radio.ap)}-${slug(radio.radio)}`;
    const cuTotal = Number(radio.cuTotal);
    const txRetriesPct = Number(radio.txRetriesPct);
    const width = radio.width;

    if (radio.radio === 'ng') {
      if (cuTotal > 60) {
        addFinding({
          id: `radio-24-cu-${apRadio}`,
          sev: 'rojo',
          area: 'WiFi',
          titulo: 'Canal 2.4 GHz saturado',
          detalle: `AP ${text(radio.ap, 'sin nombre')} en canal ${text(radio.channel, '-')}`,
          valor: pct(radio.cuTotal),
          recomendacion: 'Bajar potencia TX del AP, reducir SSIDs en 2.4 GHz o mover clientes a 5 GHz',
        });
      } else if (cuTotal >= 40 && cuTotal <= 60) {
        addFinding({
          id: `radio-24-cu-${apRadio}`,
          sev: 'amarillo',
          area: 'WiFi',
          titulo: 'Canal 2.4 GHz saturado',
          detalle: `AP ${text(radio.ap, 'sin nombre')} en canal ${text(radio.channel, '-')}`,
          valor: pct(radio.cuTotal),
          recomendacion: 'Bajar potencia TX del AP, reducir SSIDs en 2.4 GHz o mover clientes a 5 GHz',
        });
      }

      if (txRetriesPct > 10) {
        addFinding({
          id: `radio-24-retries-${apRadio}`,
          sev: 'amarillo',
          area: 'WiFi',
          titulo: 'Reintentos altos en 2.4 GHz',
          detalle: `AP ${text(radio.ap, 'sin nombre')} en canal ${text(radio.channel, '-')}`,
          valor: pct(radio.txRetriesPct),
          recomendacion: 'Revisar interferencia, potencia TX y cantidad de clientes en 2.4 GHz',
        });
      }

      if (width != null && Number(width) !== 20) {
        addFinding({
          id: `radio-24-width-${apRadio}`,
          sev: 'amarillo',
          area: 'WiFi',
          titulo: 'Ancho 2.4 GHz debería ser 20 MHz',
          detalle: `AP ${text(radio.ap, 'sin nombre')}`,
          valor: text(width, '-'),
          recomendacion: 'Configurar 2.4 GHz en 20 MHz para reducir solapamiento e interferencia',
        });
      }
    }

    if (radio.radio === 'na' && cuTotal > 70) {
      addFinding({
        id: `radio-5-cu-${apRadio}`,
        sev: 'amarillo',
        area: 'WiFi',
        titulo: 'Canal 5 GHz cargado',
        detalle: `AP ${text(radio.ap, 'sin nombre')} en canal ${text(radio.channel, '-')}`,
        valor: pct(radio.cuTotal),
        recomendacion: 'Revisar plan de canales, ancho de canal y distribución de clientes',
      });
    }
  }

  if (!wan.smartqAny) {
    addFinding({
      id: 'wan-smartq',
      sev: 'amarillo',
      area: 'WAN',
      titulo: 'Sin Smart Queue',
      detalle: 'No hay WAN con Smart Queue activo',
      valor: 'off',
      recomendacion: 'Activar Smart Queue en el WAN al ~90-95% del up/down medido para controlar bufferbloat',
    });
  }

  for (const item of asArray(wan.wans)) {
    if (item.mode === 'weighted') {
      addFinding({
        id: `wan-balance-${slug(item.group || item.name)}`,
        sev: 'amarillo',
        area: 'WAN',
        titulo: 'Multi-WAN en balanceo',
        detalle: `WAN ${text(item.name || item.group, 'sin nombre')} está en modo balanceo`,
        valor: item.mode,
        recomendacion: 'Para voz preferir failover, o fijar la salida de voz a una WAN estable',
      });
    }

    if (item.availability != null && Number(item.availability) < 99) {
      addFinding({
        id: `wan-availability-${slug(item.group || item.name)}`,
        sev: 'amarillo',
        area: 'WAN',
        titulo: 'WAN con caídas',
        detalle: `WAN ${text(item.name || item.group, 'sin nombre')}`,
        valor: `${Number(item.availability).toFixed(1)}%`,
        recomendacion: 'Revisar estabilidad del enlace, modem/ONT y eventos del proveedor',
      });
    }
  }

  const enabledWlans = asArray(wlans).filter((w) => w?.enabled === true);
  for (const wlan of enabledWlans) {
    if (wlan.minrate_ng_enabled && (wlan.minrate_ng_data_rate_kbps ?? 0) <= 1000) {
      addFinding({
        id: `wlan-legacy-rate-${slug(wlan._id || wlan.name)}`,
        sev: 'amarillo',
        area: 'WLAN',
        titulo: 'Tasas legacy 1 Mbps en 2.4 GHz',
        detalle: `SSID ${text(wlan.name, 'sin nombre')}`,
        valor: `${wlan.minrate_ng_data_rate_kbps ?? 0} kbps`,
        recomendacion: 'Subir min data rate 2.4 GHz a 6 Mbps',
      });
    }
  }

  if (enabledWlans.length > 4) {
    addFinding({
      id: 'wlan-enabled-count',
      sev: 'amarillo',
      area: 'WLAN',
      titulo: 'Demasiadas SSIDs activas',
      detalle: 'Hay más de 4 WLAN habilitadas',
      valor: String(enabledWlans.length),
      recomendacion: 'Reducir SSIDs activas para bajar overhead de beaconing',
    });
  }

  if (!hallazgos.some((h) => h.sev === 'rojo' || h.sev === 'amarillo')) {
    addFinding({
      id: 'voice-ok',
      sev: 'verde',
      area: 'General',
      titulo: 'Sin problemas detectados para voz',
      detalle: 'No se detectaron condiciones criticas en radios, WAN ni WLAN',
      valor: '',
      recomendacion: '',
    });
  }

  const redCount = hallazgos.filter((h) => h.sev === 'rojo').length;
  const yellowCount = hallazgos.filter((h) => h.sev === 'amarillo').length;
  const semaforo = redCount > 0 ? 'rojo' : (yellowCount > 0 ? 'amarillo' : 'verde');

  return {
    semaforo,
    hallazgos,
    resumen: `${hallazgos.length} hallazgos · ${redCount} rojos · ${yellowCount} amarillos`,
    generatedAt: Date.now(),
    datos: {
      radios,
      wan,
      wlanCount: enabledWlans.length,
    },
  };
}

function historyLines(content) {
  const lines = String(content || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Historial');
  if (start < 0) {
    return [];
  }

  const history = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) {
      break;
    }
    if (line.startsWith('- ')) {
      history.push(line);
    }
  }
  return history;
}

function auditMarkdown(audit, previousContent, lastRun) {
  const title = 'Auditoría de voz UniFi';
  const rows = audit.hallazgos.map((h) => (
    `| ${tableCell(h.sev)} | ${tableCell(h.area)} | ${tableCell(h.titulo)} | ${tableCell(h.valor)} | ${tableCell(h.recomendacion)} |`
  ));
  const previousHistory = historyLines(previousContent).slice(-9);
  const history = [
    ...previousHistory,
    `- ${lastRun} · ${audit.semaforo} · ${audit.hallazgos.length} hallazgos`,
  ];

  return [
    `# ${title}`,
    '',
    `Semáforo: ${audit.semaforo}`,
    '',
    '| sev | area | titulo | valor | recomendacion |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Historial',
    '',
    ...history,
  ].join('\n');
}

export async function snapshotToPad() {
  try {
    const audit = await buildVoiceAudit();
    const listed = await listItems(COLLECTION);
    if (!listed.ok) {
      return { ok: false, error: listed.error };
    }

    const existing = itemsArray(listed.data).find((item) => parseFields(item).uid === UID);
    let existingContent = existing?.content || '';
    if (existing?.ref) {
      const current = await getItem(existing.ref);
      if (current.ok) {
        existingContent = current.data?.content || existingContent;
      }
    }

    const lastRun = new Date().toISOString();
    const title = 'Auditoría de voz UniFi';
    const content = auditMarkdown(audit, existingContent, lastRun);
    const fields = {
      semaforo: audit.semaforo,
      hallazgos: audit.hallazgos.length,
      uid: UID,
      lastRun,
    };

    const write = existing
      ? await updateItem(existing.ref, { title, content, fields })
      : await createItem(COLLECTION, { title, content, fields });

    if (!write.ok) {
      return { ok: false, error: write.error };
    }

    return {
      ok: true,
      ref: existing?.ref || write.data?.ref,
      semaforo: audit.semaforo,
      hallazgos: audit.hallazgos.length,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
