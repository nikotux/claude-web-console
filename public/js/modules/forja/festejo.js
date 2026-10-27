import { t } from '../../ui/i18n.js';
import { node } from './view.js';

const AUTO_DISMISS_MS = 12_000;
const TITLE_FLASH_MS = 900;
const STYLE_ID = 'fj-festejo-styles';

const FESTEJO_CSS = `
.fj-festejo-overlay{position:fixed;z-index:10000;inset:0;display:grid;place-items:center;padding:clamp(18px,5vw,64px);background:color-mix(in srgb,var(--forja-obsidian) 86%,transparent);font-family:var(--cwc-font-ui),"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";font-variant-numeric:tabular-nums;backdrop-filter:blur(7px)}
.fj-festejo-overlay[hidden]{display:none}.fj-festejo-card{position:relative;display:flex;width:min(1040px,94vw);min-height:min(520px,78vh);flex-direction:column;align-items:center;justify-content:center;overflow:hidden;padding:48px 54px 42px;border:1px solid var(--forja-lava);border-left:6px solid var(--forja-ember);border-radius:var(--cwc-radius-lg);background:radial-gradient(circle at 50% -12%,color-mix(in srgb,var(--forja-ember) 26%,transparent),transparent 34%),linear-gradient(145deg,var(--forja-basalt),var(--forja-obsidian) 69%);box-shadow:var(--cwc-shadow-lg),0 0 32px color-mix(in srgb,var(--forja-lava) 22%,transparent),inset 0 1px color-mix(in srgb,var(--forja-gold) 12%,transparent);color:var(--forja-cream);text-align:center}
.fj-festejo-card::before,.fj-festejo-card::after{position:absolute;width:48px;height:48px;content:""}.fj-festejo-card::before{top:14px;left:14px;border-top:1px solid var(--forja-gold);border-left:1px solid var(--forja-gold)}.fj-festejo-card::after{right:14px;bottom:14px;border-right:1px solid var(--forja-ember);border-bottom:1px solid var(--forja-ember)}
.fj-festejo-close{position:absolute;z-index:3;top:14px;right:14px;display:grid;width:34px;height:34px;place-items:center;border:1px solid color-mix(in srgb,var(--forja-metal) 48%,transparent);border-radius:50%;background:var(--forja-coal);color:var(--forja-muted);font:800 var(--cwc-fs-lg)/1 var(--cwc-font-ui),"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";cursor:pointer}.fj-festejo-close:hover,.fj-festejo-close:focus-visible{border-color:var(--forja-ember);color:var(--forja-cream);outline:none}
.fj-festejo-position{position:absolute;top:20px;left:50%;color:var(--forja-muted);font:800 var(--cwc-fs-xs)/1 var(--cwc-font-mono),"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";transform:translateX(-50%)}.fj-festejo-eye{display:block;width:112px;height:60px;filter:drop-shadow(0 0 17px var(--forja-lava));animation:fj-festejo-eye-pulse 1.7s ease-in-out infinite}.fj-festejo-title{max-width:900px;margin:15px 0 0;color:var(--forja-cream);font:900 calc(var(--cwc-fs-xl) * 1.45)/1.2 var(--cwc-font-serif),"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";letter-spacing:.055em;text-shadow:0 0 14px var(--forja-lava);text-transform:uppercase}.fj-festejo-pr{max-width:900px;margin:17px auto 0;color:var(--forja-cream);font-size:var(--cwc-fs-lg);line-height:1.45}.fj-festejo-number{color:var(--forja-ember);font-family:var(--cwc-font-mono),"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";font-weight:900}.fj-festejo-chips{display:flex;flex-wrap:wrap;justify-content:center;gap:9px;margin-top:22px}.fj-festejo-chip{padding:8px 11px;border:1px solid color-mix(in srgb,var(--forja-metal) 46%,var(--forja-coal));border-radius:var(--cwc-radius-sm);background:var(--forja-coal);color:var(--forja-cream);font-size:var(--cwc-fs-md)}
.fj-festejo-quote{margin:22px 0 0;color:var(--forja-gold);font:italic var(--cwc-fs-xl)/1.3 var(--cwc-font-serif),"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"}.fj-festejo-throne{margin:13px 0 0;padding:9px 16px;border:1px solid color-mix(in srgb,var(--forja-gold) 55%,var(--forja-coal));border-radius:999px;background:var(--forja-coal);color:var(--forja-gold);font:800 var(--cwc-fs-md)/1 var(--cwc-font-mono),"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"}.fj-festejo-actions{z-index:2;display:flex;justify-content:center;margin-top:20px}.fj-festejo-open{min-height:35px;padding:0 15px;border:1px solid var(--forja-ember);border-radius:var(--cwc-radius-sm);background:linear-gradient(135deg,var(--forja-lava),var(--forja-ember));color:var(--forja-obsidian);font:900 var(--cwc-fs-sm)/1 var(--cwc-font-ui),"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";cursor:pointer}
.fj-festejo-embers{position:absolute;inset:0;pointer-events:none}.fj-festejo-ember{position:absolute;width:4px;height:4px;border-radius:50%;background:var(--forja-gold);box-shadow:0 0 8px var(--forja-lava);animation:fj-festejo-ember-rise 3.8s linear infinite}.fj-festejo-ember:nth-child(1){top:76%;left:6%}.fj-festejo-ember:nth-child(2){top:20%;left:13%;animation-delay:-1.8s}.fj-festejo-ember:nth-child(3){top:88%;left:25%;animation-delay:-.8s}.fj-festejo-ember:nth-child(4){top:17%;left:72%;animation-delay:-2.2s}.fj-festejo-ember:nth-child(5){top:74%;left:86%;animation-delay:-1.2s}.fj-festejo-ember:nth-child(6){top:36%;left:94%;animation-delay:-2.8s}
.fj-festejo-badge{position:absolute;z-index:4;top:7px;right:7px;border-color:var(--forja-ember);background:var(--forja-lava);color:var(--forja-cream);box-shadow:0 0 10px var(--forja-lava)}
@keyframes fj-festejo-eye-pulse{0%,100%{filter:drop-shadow(0 0 8px var(--forja-lava));transform:scale(.96)}50%{filter:drop-shadow(0 0 18px var(--forja-ember));transform:scale(1.04)}}@keyframes fj-festejo-ember-rise{from{transform:translateY(55px);opacity:0}20%{opacity:1}to{transform:translate(18px,-280px);opacity:0}}
@media(max-width:700px){.fj-festejo-card{min-height:70vh;padding:54px 22px 34px}.fj-festejo-title{font-size:var(--cwc-fs-xl)}.fj-festejo-pr{font-size:var(--cwc-fs-md)}.fj-festejo-chip{padding:6px 8px;font-size:var(--cwc-fs-sm)}}@media(prefers-reduced-motion:reduce){.fj-festejo-eye,.fj-festejo-ember{animation:none!important}}
`;

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FESTEJO_CSS;
  document.head.appendChild(style);
}

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
  installStyles();
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
    if (document.hidden) return;
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
      const count = data.pendingFestejos ?? data.pending?.length ?? 0;
      wanted = Number(count) > 0;
      onPendingChange(count);
    }).catch(() => {});
    return acknowledgeTail;
  };

  const showNext = () => {
    if (active || !queue.length || document.hidden) return;
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
    if (fetching || document.hidden) return fetching;
    fetching = api('/api/forja/festejos').then((data) => {
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

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && active && !document.hidden) active.overlay.querySelector('.fj-festejo-close')?.click();
  });
  document.addEventListener('visibilitychange', () => {
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
  });

  return {
    sync(count, name) {
      displayName = name || displayName;
      wanted = Number(count) > 0;
      if (wanted) void fetchPending();
    },
  };
}
