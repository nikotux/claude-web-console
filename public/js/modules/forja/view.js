import { getLang, t } from '../../ui/i18n.js';

export function node(tag, className = '', text = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null && text !== undefined) el.textContent = String(text);
  return el;
}

export function iconNode(icon, name, size = 16) {
  const holder = node('span', 'fj-icon');
  holder.innerHTML = icon(name, { size });
  return holder;
}

export function percent(cur, max) {
  const a = Number(cur) || 0;
  const b = Number(max) || 0;
  return b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0;
}

export function levelName(level = {}) {
  const translators = {
    nv1: () => t('forja.level.nv1.name', level.title || 'Orco de la mina'),
    nv2: () => t('forja.level.nv2.name', level.title || 'Uruk-hai'),
    nv3: () => t('forja.level.nv3.name', level.title || 'Capitán de Minas Morgul'),
    nv4: () => t('forja.level.nv4.name', level.title || 'Nazgûl'),
    nv5: () => t('forja.level.nv5.name', level.title || 'Boca de Sauron'),
    nv6: () => t('forja.level.nv6.name', level.title || 'Señor de Barad-dûr'),
    nv7: () => t('forja.level.nv7.name', level.title || 'El Ojo que Todo lo Ve'),
  };
  const fallback = level.title || level.code || `NV${Number(level.number) || 1}`;
  return (translators[level.id || `nv${Number(level.number) || 1}`] || (() => fallback))();
}

export function levelCode(level = {}) {
  return level.code || `NV${Number(level.number) || 1}`;
}

export function medalText(medal = {}, field) {
  const fallback = medal[field] || '';
  const names = {
    'alas-nazgul': () => t('forja.medal.alas-nazgul.name', fallback),
    erupcion: () => t('forja.medal.erupcion.name', fallback),
    troll: () => t('forja.medal.troll.name', fallback),
    legion: () => t('forja.medal.legion.name', fallback),
    trono: () => t('forja.medal.trono.name', fallback),
    centenario: () => t('forja.medal.centenario.name', fallback),
    vigilia: () => t('forja.medal.vigilia.name', fallback),
    daga: () => t('forja.medal.daga.name', fallback),
  };
  const descriptions = {
    'alas-nazgul': () => t('forja.medal.alas-nazgul.desc', fallback),
    erupcion: () => t('forja.medal.erupcion.desc', fallback),
    troll: () => t('forja.medal.troll.desc', fallback),
    legion: () => t('forja.medal.legion.desc', fallback),
    trono: () => t('forja.medal.trono.desc', fallback),
    centenario: () => t('forja.medal.centenario.desc', fallback),
    vigilia: () => t('forja.medal.vigilia.desc', fallback),
    daga: () => t('forja.medal.daga.desc', fallback),
  };
  const translators = field === 'name' ? names : descriptions;
  return (translators[medal.id] || (() => fallback))();
}

export function formatDate(value, { long = false } = {}) {
  if (!value) return '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T12:00:00Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(getLang() === 'en' ? 'en-US' : 'es-CO', {
    day: 'numeric', month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

export function formatSeason(season = {}) {
  if (/^\d{4}-\d{2}$/.test(String(season.key || ''))) {
    const date = new Date(`${season.key}-15T12:00:00Z`);
    return new Intl.DateTimeFormat(getLang() === 'en' ? 'en-US' : 'es-CO', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(date);
  }
  return season.label || '';
}

export function staleLabel(snap) {
  const generatedAt = Object.hasOwn(snap, 'dataAsOf') ? snap.dataAsOf : snap.generatedAt;
  const timestamp = Date.parse(generatedAt || '');
  if (!Number.isFinite(timestamp)) return t('forja.stale.unknown', 'Datos desactualizados');
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 2) return t('forja.stale.justNow', 'Datos de hace un momento');
  if (minutes < 60) return t('forja.stale.minutes', 'Datos de hace {count} min', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('forja.stale.hours', 'Datos de hace {count} h', { count: hours });
  const days = Math.round(hours / 24);
  return t('forja.stale.days', 'Datos de hace {count} días', { count: days });
}

export function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && /^\/Mordor-Staffing\/tolkien\/pull\/\d+$/.test(url.pathname)
      ? url.href
      : null;
  } catch { return null; }
}
