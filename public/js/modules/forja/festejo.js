import { t } from '../../ui/i18n.js';
import { node } from './view.js';

const AUTO_DISMISS_MS = 12_000;
const TITLE_FLASH_MS = 900;

function durationLabel(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return t('forja.festejo.duration.minutes', '{count} min', { count: value });
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (hours < 24) return rest
    ? t('forja.festejo.duration.hoursMinutes', '{hours} h {minutes} min', { hours, minutes: rest })
    : t('forja.festejo.duration.hours', '{count} h', { count: hours });
  const days = Math.floor(hours / 24);
  const leftHours = hours % 24;
  return leftHours
    ? t('forja.festejo.duration.daysHours', '{days} días {hours} h', { days, hours: leftHours })
    : t('forja.festejo.duration.days', '{count} días', { count: days });
}

function throneLabel(throne = {}) {
  if (throne.status === 'leader') {
    return t('forja.festejo.throne.leader', '👑 Seguís en el trono — {name} a {gap}', {
      name: throne.rivalDisplayName || t('forja.festejo.throne.rival', 'tu rival'), gap: throne.gap || 0,
    });
  }
  if (throne.status === 'leader-alone') return t('forja.festejo.throne.alone', '👑 Seguís en el trono — sin retadores');
  if (throne.status === 'challenger') {
    return t('forja.festejo.throne.challenger', '⚔️ Estás a {gap} del trono', { gap: throne.gap || 0 });
  }
  return t('forja.festejo.throne.unknown', '⚔️ La arena se está reordenando');
}

function translatedMonth(label) {
  const months = {
    enero: () => t('forja.festejo.month.january', 'enero'),
    febrero: () => t('forja.festejo.month.february', 'febrero'),
    marzo: () => t('forja.festejo.month.march', 'marzo'),
    abril: () => t('forja.festejo.month.april', 'abril'),
    mayo: () => t('forja.festejo.month.may', 'mayo'),
    junio: () => t('forja.festejo.month.june', 'junio'),
    julio: () => t('forja.festejo.month.july', 'julio'),
    agosto: () => t('forja.festejo.month.august', 'agosto'),
    septiembre: () => t('forja.festejo.month.september', 'septiembre'),
    octubre: () => t('forja.festejo.month.october', 'octubre'),
    noviembre: () => t('forja.festejo.month.november', 'noviembre'),
    diciembre: () => t('forja.festejo.month.december', 'diciembre'),
  };
  return (months[String(label || '').toLowerCase()] || (() => String(label || '')))();
}

function addChip(parent, text) {
  parent.appendChild(node('span', 'fj-festejo-chip', text));
}

function celebrationCard(festejo, { displayName, position, total, onDismiss, onOpen }) {
  const overlay = node('div', 'fj-festejo-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('forja.festejo.dialogAria', 'Celebración de un nuevo anillo'));
  const card = node('article', 'fj-festejo-card');
  const embers = node('div', 'fj-festejo-embers');
  embers.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 6; index += 1) embers.appendChild(node('i', 'fj-festejo-ember'));
  const close = node('button', 'fj-festejo-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t('forja.festejo.close', 'Cerrar festejo'));
  const counter = node('span', 'fj-festejo-position', t('forja.festejo.position', '{current} de {total}', { current: position, total }));
  const eye = document.createElement('img');
  eye.className = 'fj-festejo-eye';
  eye.src = '/img/forja/ojo-sauron.svg';
  eye.alt = '';
  eye.setAttribute('aria-hidden', 'true');
  const title = node('h1', 'fj-festejo-title', t('forja.festejo.title', '🔥 ¡UN NUEVO ANILLO FUE FORJADO, {name}!', {
    name: String(displayName || '').toLocaleUpperCase(),
  }));
  const pr = node('p', 'fj-festejo-pr');
  pr.append(node('strong', 'fj-festejo-number', `#${festejo.number}`), document.createTextNode(` · ${festejo.title || ''}`));
  const chips = node('div', 'fj-festejo-chips');
  if (festejo.deskTicket) addChip(chips, t('forja.festejo.desk', '🎫 Desk #{number}', { number: festejo.deskTicket }));
  addChip(chips, t('forja.festejo.duration', '⏱ abierto → mergeado: {duration}', { duration: durationLabel(festejo.durationMin) }));
  addChip(chips, t('forja.festejo.lines', '📊 +{additions} / −{deletions}', {
    additions: festejo.additions || 0, deletions: festejo.deletions || 0,
  }));
  addChip(chips, t('forja.festejo.monthRing', '💍 Anillo nº {number} de {month}', {
    number: festejo.ringOfMonth || 0, month: translatedMonth(festejo.monthLabel),
  }));
  const quote = node('p', 'fj-festejo-quote', t('forja.festejo.quote', 'El Ojo te observa… y aprueba. 👁'));
  const throne = node('div', 'fj-festejo-throne', throneLabel(festejo.throne));
  const actions = node('div', 'fj-festejo-actions');
  const open = node('button', 'fj-festejo-open', t('forja.festejo.openSalon', '🔥 Ver en Mi salón'));
  open.type = 'button';
  actions.appendChild(open);
  close.addEventListener('click', onDismiss);
  open.addEventListener('click', () => { onOpen(); onDismiss(); });
  overlay.addEventListener('click', (event) => {
    if (!event.target.closest('button')) onDismiss();
  });
  card.append(embers, close, counter, eye, title, pr, chips, quote, throne, actions);
  overlay.appendChild(card);
  return { overlay, close };
}

export function createFestejoController({ api, onOpen, onPendingChange }) {
  const originalTitle = document.title;
  let displayName = '';
  let queue = [];
  let active = null;
  let fetching = null;
  let autoTimer = null;
  let titleTimer = null;
  let batchTotal = 0;
  let batchPosition = 0;
  let wanted = false;
  let destroyed = false;
  let acknowledgeTail = Promise.resolve();

  const stopTimers = () => {
    clearTimeout(autoTimer);
    clearInterval(titleTimer);
    autoTimer = null;
    titleTimer = null;
    document.title = originalTitle;
  };

  const startTimers = (dismiss) => {
    stopTimers();
    if (destroyed || document.hidden) return;
    let bright = true;
    const flash = () => {
      document.title = bright
        ? t('forja.festejo.tabTitle', '🔥 +1 anillo · {title}', { title: originalTitle })
        : originalTitle;
      bright = !bright;
    };
    flash();
    titleTimer = setInterval(flash, TITLE_FLASH_MS);
    autoTimer = setTimeout(dismiss, AUTO_DISMISS_MS);
  };

  const acknowledge = (number) => {
    acknowledgeTail = acknowledgeTail.then(() => api('/api/forja/festejos/visto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numbers: [number] }),
    })).then((data) => {
      if (destroyed) return;
      const count = data.pendingFestejos ?? data.pending?.length ?? 0;
      wanted = Number(count) > 0;
      onPendingChange(count);
    }).catch(() => {});
    return acknowledgeTail;
  };

  const showNext = () => {
    if (destroyed || active || !queue.length || document.hidden) return;
    const festejo = queue.shift();
    batchPosition += 1;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      stopTimers();
      active?.overlay.remove();
      active = null;
      void acknowledge(festejo.number);
      showNext();
    };
    active = celebrationCard(festejo, {
      displayName, position: batchPosition, total: batchTotal, onDismiss: dismiss, onOpen,
    });
    active.number = festejo.number;
    document.body.appendChild(active.overlay);
    active.close.focus();
    startTimers(dismiss);
  };

  const fetchPending = () => {
    if (destroyed || fetching || document.hidden) return fetching;
    fetching = api('/api/forja/festejos').then((data) => {
      if (destroyed) return;
      const existing = new Set([
        ...(active ? [active.number] : []),
        ...queue.map((item) => item.number),
      ]);
      const incoming = (Array.isArray(data.pending) ? data.pending : [])
        .filter((item) => Number.isSafeInteger(item?.number) && !existing.has(item.number));
      if (!active && !queue.length) {
        batchPosition = 0;
        batchTotal = incoming.length;
      } else {
        batchTotal += incoming.length;
      }
      queue.push(...incoming);
      wanted = Boolean(data.pending?.length);
      onPendingChange((active ? 1 : 0) + queue.length);
      showNext();
    }).catch(() => {}).finally(() => { fetching = null; });
    return fetching;
  };

  const onKeydown = (event) => {
    if (event.key === 'Escape' && active && !document.hidden) active.overlay.querySelector('.fj-festejo-close')?.click();
  };
  const onVisibilityChange = () => {
    if (document.hidden) {
      stopTimers();
      if (active) active.overlay.hidden = true;
      return;
    }
    if (active) {
      active.overlay.hidden = false;
      startTimers(() => active?.overlay.querySelector('.fj-festejo-close')?.click());
    } else if (queue.length) showNext();
    else if (wanted) void fetchPending();
  };
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    sync(count, name) {
      if (destroyed) return;
      displayName = name || displayName;
      wanted = Number(count) > 0;
      if (wanted) void fetchPending();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopTimers();
      active?.overlay.remove();
      active = null;
      queue = [];
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
