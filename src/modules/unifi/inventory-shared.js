// Escaneo ESTRUCTURAL del UDM Pro → Pad local (colección infraestructura-de-red). Re-ejecutable: upsert por campo uid; entidad ausente en el escaneo se marca 'retirado', no se borra. Estructura (config), NO telemetría. PLAN-774.
import {
  getDevices,
  getNetworks,
  getWlans,
  getFixedClients,
  getFirewallPolicies,
} from './client.js';
import {
  listItems,
  createItem,
  updateItem,
  getItem,
  addLink,
  listLinks,
} from '../../core/pad-service-client.js';

const COLLECTION = 'infraestructura-de-red';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = '—') {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value);
}

function markdown(lines) {
  return lines.map(([label, value]) => `- ${label}: ${text(value)}`).join('\n');
}

function scrubSecrets(value) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubSecrets(item));
  }

  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes('passphrase') ||
      normalized.includes('password') ||
      normalized.includes('psk') ||
      normalized.includes('secret') ||
      normalized.startsWith('x_') ||
      normalized === 'key'
    ) {
      continue;
    }
    copy[key] = scrubSecrets(item);
  }
  return copy;
}

function rawBlock(obj) {
  return '\n\n## Propiedades crudas (UDM Pro)\n\n'
    + '```json\n'
    + JSON.stringify(scrubSecrets(obj), null, 2)
    + '\n```';
}

async function buildInventory() {
  const inventory = [];

  try {
    const devices = await getDevices();
    for (const d of asArray(devices)) {
      if (!d?.id) continue;
      const updatable = d.firmwareUpdatable === true ? 'si' : (d.firmwareUpdatable === false ? 'no' : 'na');
      inventory.push({
        uid: `dev:${d.id}`,
        kind: 'dispositivo',
        title: `${text(d.name, 'Sin nombre')} · ${text(d.model, 'Sin modelo')}`,
        version: `${d.firmwareVersion || ''}`,
        updatable,
        rawModel: d.model || '',
        content: markdown([
          ['modelo', d.model],
          ['MAC', d.macAddress],
          ['IP', d.ipAddress],
          ['estado', d.state],
          ['firmware', d.firmwareVersion],
          ['actualizable', updatable],
          ['features', asArray(d.features).join(', ') || '—'],
        ]) + rawBlock(d),
      });
    }
  } catch (err) {
    console.warn(`[unifi-inventory] No se pudieron escanear dispositivos: ${err?.message || err}`);
  }

  try {
    const networks = await getNetworks();
    for (const n of asArray(networks)) {
      if (!n?._id) continue;
      inventory.push({
        uid: `net:${n._id}`,
        kind: 'red',
        title: `${text(n.name, 'Sin nombre')}${n.vlan ? ` (VLAN ${n.vlan})` : ''}`,
        version: '',
        updatable: 'na',
        content: markdown([
          ['VLAN', n.vlan || '—'],
          ['subred', n.ip_subnet || '—'],
          ['propósito', n.purpose],
          ['habilitada', n.enabled],
          ['DHCP', n.dhcpd_enabled],
          ['rango DHCP', (n.dhcpd_start && n.dhcpd_stop) ? `${n.dhcpd_start}–${n.dhcpd_stop}` : '—'],
          ['dominio', n.domain_name],
        ]) + rawBlock(n),
      });
    }
  } catch (err) {
    console.warn(`[unifi-inventory] No se pudieron escanear redes/VLANs: ${err?.message || err}`);
  }

  try {
    const wlans = await getWlans();
    for (const w of asArray(wlans)) {
      if (!w?._id) continue;
      inventory.push({
        uid: `wlan:${w._id}`,
        kind: 'wifi',
        title: `WiFi: ${text(w.name, 'Sin nombre')}`,
        version: '',
        updatable: 'na',
        linkToNetUid: w.networkconf_id ? `net:${w.networkconf_id}` : null,
        content: markdown([
          ['habilitada', w.enabled],
          ['seguridad', w.security],
          ['banda', w.wlan_band || '—'],
          ['red/VLAN', w.networkconf_id],
          ['WPA', w.wpa_mode],
          ['oculta', w.hide_ssid],
          ['invitados', w.is_guest],
        ]) + rawBlock(w),
      });
    }
  } catch (err) {
    console.warn(`[unifi-inventory] No se pudieron escanear WiFi: ${err?.message || err}`);
  }

  try {
    const policies = await getFirewallPolicies();
    for (const p of asArray(policies)) {
      if (!p?.id) continue;
      inventory.push({
        uid: `fw:${p.id}`,
        kind: 'firewall',
        title: `FW: ${text(p.name, 'Sin nombre')}`,
        version: '',
        updatable: 'na',
        content: markdown([
          ['acción', p.action?.type],
          ['habilitada', p.enabled],
          ['índice', p.index],
          ['descripción', p.description || '—'],
          ['protocolo', p.protocol],
          ['origen', p.source?.zoneId ?? p.source?.matchingTarget],
          ['destino', p.destination?.zoneId ?? p.destination?.matchingTarget],
        ]) + rawBlock(p),
      });
    }
  } catch (err) {
    console.warn(`[unifi-inventory] No se pudieron escanear políticas de firewall: ${err?.message || err}`);
  }

  try {
    const fixedClients = await getFixedClients();
    for (const u of asArray(fixedClients)) {
      if (!u?._id) continue;
      inventory.push({
        uid: `fix:${u._id}`,
        kind: 'reserva',
        title: `Reserva: ${text(u.name || u.mac, 'Sin nombre')}`,
        version: '',
        updatable: 'na',
        linkToNetUid: u.network_id ? `net:${u.network_id}` : null,
        content: markdown([
          ['MAC', u.mac],
          ['IP fija', u.fixed_ip],
        ]) + rawBlock(u),
      });
    }
  } catch (err) {
    console.warn(`[unifi-inventory] No se pudieron escanear reservas IP: ${err?.message || err}`);
  }

  return inventory;
}

function itemsArray(data) {
  if (Array.isArray(data)) return data;
  return asArray(data?.items);
}

function parseFields(item) {
  const f = item?.fields;
  if (!f) return {};
  if (typeof f === 'object') return f;
  try { return JSON.parse(f) || {}; } catch { return {}; }
}

export async function scanToPad({ dryRun = false } = {}) {
  const inv = await buildInventory();
  const r = await listItems(COLLECTION);
  if (!r.ok) {
    return { ok: false, error: r.error };
  }

  const existingByUid = new Map();
  const existingItems = itemsArray(r.data);
  for (const item of existingItems) {
    const uid = parseFields(item).uid;
    if (uid) {
      existingByUid.set(uid, item);
    }
  }

  const now = new Date().toISOString();
  const seen = new Set(inv.map((entry) => entry.uid));
  let created = 0;
  let updated = 0;
  let retired = 0;
  let linked = 0;
  let errors = 0;
  const errorDetails = [];

  function failureReason(result) {
    const status = result?.status ? `HTTP ${result.status}: ` : '';
    return `${status}${result?.error || result?.code || 'error desconocido'}`.slice(0, 180);
  }

  function recordError(ref, result) {
    if (errorDetails.length >= 20) return;
    errorDetails.push(`${ref}: ${failureReason(result)}`);
  }

  function isOpenChildren(result) {
    const code = result?.code || result?.data?.code || result?.data?.error?.code;
    return code === 'open_children' || result?.status === 409;
  }

  for (const entry of inv) {
    const item = existingByUid.get(entry.uid);

    if (!item) {
      if (dryRun) {
        created += 1;
        continue;
      }

      const write = await createItem(COLLECTION, {
        title: entry.title,
        content: entry.content,
        fields: {
          kind: entry.kind,
          status: 'presente',
          version: entry.version,
          updatable: entry.updatable,
          uid: entry.uid,
          lastSeen: now,
        },
      });

      if (write.ok) created += 1;
      else errors += 1;
      continue;
    }

    if (dryRun) {
      updated += 1;
      continue;
    }

    const current = await getItem(item.ref);
    if (!current.ok) {
      errors += 1;
      continue;
    }

    const mergedFields = {
      ...parseFields(current.data),
      kind: entry.kind,
      status: 'presente',
      version: entry.version,
      updatable: entry.updatable,
      uid: entry.uid,
      lastSeen: now,
    };
    const write = await updateItem(item.ref, {
      title: entry.title,
      content: entry.content,
      fields: mergedFields,
    });

    if (write.ok) updated += 1;
    else errors += 1;
  }

  const membersToRetire = [];
  const networksToRetire = [];
  for (const item of existingItems) {
    const fields = parseFields(item);
    const uid = fields.uid;
    if (!uid || seen.has(uid) || fields.status === 'retirado') {
      continue;
    }

    const candidate = { item, fields };
    if (fields.kind === 'red') networksToRetire.push(candidate);
    else membersToRetire.push(candidate);
  }

  // BUG-1254: Pad ve los links implements como PARENT/CHILD; retirar primero
  // los miembros evita que el guard open_children bloquee a la red padre.
  const itemsToRetire = [...membersToRetire, ...networksToRetire];
  for (const { item, fields } of itemsToRetire) {
    if (dryRun) {
      retired += 1;
      continue;
    }

    const retirementFields = {
      ...fields,
      status: 'retirado',
      lastSeen: now,
    };
    let write = await updateItem(item.ref, { fields: retirementFields });

    // Una red aún puede conservar hijos presentes; en ese conflicto explícito,
    // Pad permite confirmar el retiro mediante force en el mismo PATCH.
    if (!write.ok && isOpenChildren(write)) {
      write = await updateItem(item.ref, {
        fields: retirementFields,
        force: true,
      });
    }

    if (write.ok) retired += 1;
    else {
      errors += 1;
      recordError(`retiro ${item.ref}`, write);
    }
  }

  if (!dryRun) {
    const r2 = await listItems(COLLECTION);
    if (r2.ok) {
      const refByUid = new Map();
      for (const item of itemsArray(r2.data)) {
        const uid = parseFields(item).uid;
        if (uid) {
          refByUid.set(uid, item.ref);
        }
      }

      const gwEntry = inv.find((e) => e.kind === 'dispositivo' && /udm|uxg|ugw|udr|dream|ucg/i.test(String(e.rawModel || ''))) || inv.find((e) => e.kind === 'dispositivo') || null;
      const gatewayUid = gwEntry ? gwEntry.uid : null;
      const gatewayRef = gatewayUid ? refByUid.get(gatewayUid) : null;

      async function ensureLink(sourceRef, targetRef) {
        try {
          if (!sourceRef || !targetRef) {
            return;
          }

          const lk = await listLinks(sourceRef);
          if (
            lk.ok &&
            Array.isArray(lk.data) &&
            lk.data.some((l) => l.target_ref === targetRef || l.source_ref === targetRef)
          ) {
            return;
          }

          const w = await addLink(sourceRef, targetRef, 'implements');
          if (w.ok) linked += 1;
          else {
            errors += 1;
            recordError(`link ${sourceRef} -> ${targetRef}`, w);
          }
        } catch (err) {
          errors += 1;
          recordError(`link ${sourceRef} -> ${targetRef}`, { error: err?.message || err });
        }
      }

      for (const entry of inv) {
        if (!entry.linkToNetUid) {
          continue;
        }

        await ensureLink(refByUid.get(entry.uid), refByUid.get(entry.linkToNetUid));
      }

      if (gatewayRef) {
        for (const entry of inv) {
          if (entry.kind === 'red') {
            await ensureLink(refByUid.get(entry.uid), gatewayRef);
          } else if (entry.kind === 'dispositivo' && entry.uid !== gatewayUid) {
            await ensureLink(refByUid.get(entry.uid), gatewayRef);
          } else if (entry.kind === 'firewall') {
            await ensureLink(refByUid.get(entry.uid), gatewayRef);
          }
        }
      }
    }
  }

  return { ok: true, created, updated, retired, linked, total: inv.length, dryRun, errors, errorDetails };
}
