import { t } from '../../ui/i18n.js';
import { escLayers, isTopEscLayer } from '../../ui/dialog.js';
import { icon } from '../../ui/icons.js';
import { node } from './view.js';

const AUTO_DISMISS_MS = 12_000;
const TITLE_FLASH_MS = 900;
let dialogSequence = 0;

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
  const card = node('article', 'fj-festejo-card');
  const embers = node('div', 'fj-festejo-embers');
  embers.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 6; index += 1) embers.appendChild(node('i', 'fj-festejo-ember'));
  const close = node('button', 'btn-ghost btn--icon fj-festejo-close');
  close.type = 'button';
  close.setAttribute('aria-label', t('forja.festejo.close', 'Cerrar festejo'));
  close.innerHTML = icon('close', { size: 15 });
  const counter = node('span', 'fj-festejo-position', t('forja.festejo.position', '{current} de {total}', { current: position, total }));
  const eye = document.createElement('img');
  eye.className = 'fj-festejo-eye';
  eye.src = '/img/forja/ojo-sauron.svg';
  eye.alt = '';
  eye.setAttribute('aria-hidden', 'true');
  const title = node('h1', 'fj-festejo-title', t('forja.festejo.title', '🔥 ¡UN NUEVO ANILLO FUE FORJADO, {name}!', {
    name: String(displayName || '').toLocaleUpperCase(),
  }));
  title.id = `fj-festejo-title-${++dialogSequence}`;
  overlay.setAttribute('aria-labelledby', title.id);
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
  const open = node('button', 'btn fj-festejo-open', t('forja.festejo.openSalon', '🔥 Ver en Mi salón'));
  open.type = 'button';
  actions.appendChild(open);
  close.addEventListener('click', onDismiss);
  open.addEventListener('click', () => { onDismiss(); onOpen(); });
  overlay.addEventListener('click', (event) => {
    if (!event.target.closest('button')) onDismiss();
  });
  card.append(embers, close, counter, eye, title, pr, chips, quote, throne, actions);
  overlay.appendChild(card);
  return { overlay, card, close };
}

export function createFestejoController({ api, onOpen, onPendingChange }) {
  const originalTitle = document.title;
  let displayName = '';
  let queue = [];
  let active = null;
  let fetching = null;
  let autoTimer = null;
  let titleTimer = null;
  let layerWaitTimer = null;
  let autoRemaining = AUTO_DISMISS_MS;
  let autoStartedAt = 0;
  let autoDismiss = null;
  let batchTotal = 0;
  let batchPosition = 0;
  let pendingOpener = null;
  let wanted = false;
  let destroyed = false;
  let acknowledgeTail = Promise.resolve();
  const acking = new Set();

  const stopTimers = () => {
    clearTimeout(autoTimer);
    clearInterval(titleTimer);
    autoTimer = null;
    titleTimer = null;
    autoRemaining = AUTO_DISMISS_MS;
    autoStartedAt = 0;
    autoDismiss = null;
    document.title = originalTitle;
  };

  const pauseAutoDismiss = () => {
    if (!autoTimer) return;
    clearTimeout(autoTimer);
    autoTimer = null;
    autoRemaining = Math.max(0, autoRemaining - (Date.now() - autoStartedAt));
  };

  const resumeAutoDismiss = () => {
    if (!active || destroyed || document.hidden || autoTimer || !autoDismiss) return;
    if (active.pointerInside || active.overlay.contains(document.activeElement)) return;
    autoStartedAt = Date.now();
    autoTimer = setTimeout(() => {
      autoTimer = null;
      autoRemaining = 0;
      autoDismiss({ auto: true });
    }, autoRemaining);
  };

  const startTimers = (dismiss, count) => {
    stopTimers();
    if (destroyed || document.hidden) return;
    const festiveTitle = t('forja.festejo.tabTitle', '🔥 +{count} anillo · {title}', { count, title: originalTitle });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.title = festiveTitle;
    } else {
      let bright = true;
      const flash = () => {
        document.title = bright ? festiveTitle : originalTitle;
        bright = !bright;
      };
      flash();
      titleTimer = setInterval(flash, TITLE_FLASH_MS);
    }
    autoDismiss = dismiss;
    resumeAutoDismiss();
  };

  const removeEscLayer = (entry) => {
    const index = escLayers.indexOf(entry);
    if (index !== -1) escLayers.splice(index, 1);
  };

  const restoreFocus = (opener, ref) => {
    let target = opener?.isConnected ? opener : null;
    if (!target && ref) target = document.querySelector(`[data-ref="${ref}"]`);
    target?.focus();
  };

  const acknowledge = (number) => {
    acking.add(number);
    acknowledgeTail = acknowledgeTail.then(() => api('/api/forja/festejos/visto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numbers: [number] }),
    })).then((data) => {
      if (destroyed) return;
      const count = data.pendingFestejos ?? data.pending?.length ?? 0;
      wanted = Number(count) > 0;
      onPendingChange(count);
    }).catch(() => {}).finally(() => { acking.delete(number); });
    return acknowledgeTail;
  };

  const showNext = () => {
    if (destroyed || active || !queue.length || document.hidden) return;
    if (escLayers.length) {
      if (!layerWaitTimer) {
        layerWaitTimer = setTimeout(() => {
          layerWaitTimer = null;
          showNext();
        }, 100);
      }
      return;
    }
    const festejo = queue.shift();
    batchPosition += 1;
    let dismissed = false;
    const activeOpener = document.activeElement !== document.body ? document.activeElement : null;
    const opener = pendingOpener?.isConnected && pendingOpener !== document.body ? pendingOpener : activeOpener;
    const openerRef = opener?.dataset?.ref || 'forja-cta';
    pendingOpener = null;
    const dismiss = ({ auto = false } = {}) => {
      if (dismissed) return;
      dismissed = true;
      const closing = active;
      const focusWasInside = Boolean(closing?.overlay.contains(document.activeElement));
      stopTimers();
      closing?.overlay.remove();
      removeEscLayer(closing?.escEntry);
      active = null;
      const shouldRestoreFocus = !auto || focusWasInside;
      const acknowledged = acknowledge(festejo.number);
      if (shouldRestoreFocus) restoreFocus(opener, openerRef);
      void acknowledged.then(() => {
        if (shouldRestoreFocus && !opener?.isConnected && document.activeElement === document.body) {
          restoreFocus(opener, openerRef);
        }
      });
      showNext();
    };
    active = celebrationCard(festejo, {
      displayName, position: batchPosition, total: batchTotal, onDismiss: dismiss, onOpen,
    });
    active.number = festejo.number;
    active.opener = opener;
    active.openerRef = openerRef;
    active.pointerInside = false;
    active.escEntry = { close: dismiss };
    escLayers.push(active.escEntry);
    document.body.appendChild(active.overlay);
    active.card.addEventListener('pointerenter', () => {
      if (!active) return;
      active.pointerInside = true;
      pauseAutoDismiss();
    });
    active.card.addEventListener('pointerleave', () => {
      if (!active) return;
      active.pointerInside = false;
      resumeAutoDismiss();
    });
    active.overlay.addEventListener('focusin', pauseAutoDismiss);
    active.overlay.addEventListener('focusout', () => {
      setTimeout(() => {
        if (active && !active.overlay.contains(document.activeElement)) resumeAutoDismiss();
      });
    });
    startTimers(dismiss, queue.length + 1);
  };

  const fetchPending = () => {
    if (destroyed || fetching || document.hidden) return fetching;
    if (!active && !queue.length) pendingOpener = document.activeElement;
    fetching = api('/api/forja/festejos').then((data) => {
      if (destroyed) return;
      const existing = new Set([
        ...(active ? [active.number] : []),
        ...queue.map((item) => item.number),
        ...acking,
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
      if (!active && document.activeElement !== document.body) pendingOpener = document.activeElement;
      onPendingChange((active ? 1 : 0) + queue.length);
      showNext();
      if (!active && !queue.length) pendingOpener = null;
    }).catch(() => {}).finally(() => { fetching = null; });
    return fetching;
  };

  const onKeydown = (event) => {
    if (!active || document.hidden || !isTopEscLayer(active.escEntry)) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      active.escEntry.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...active.overlay.querySelectorAll('button:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!active.overlay.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  };
  const onVisibilityChange = () => {
    if (document.hidden) {
      stopTimers();
      if (active) active.overlay.hidden = true;
      return;
    }
    if (active) {
      active.overlay.hidden = false;
      startTimers(active.escEntry.close, queue.length + 1);
    } else if (queue.length) showNext();
    else if (wanted) void fetchPending();
  };
  document.addEventListener('keydown', onKeydown, true);
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
      clearTimeout(layerWaitTimer);
      stopTimers();
      const closing = active;
      const focusWasInside = Boolean(closing?.overlay.contains(document.activeElement));
      closing?.overlay.remove();
      removeEscLayer(closing?.escEntry);
      active = null;
      queue = [];
      pendingOpener = null;
      if (focusWasInside) restoreFocus(closing?.opener, closing?.openerRef);
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
