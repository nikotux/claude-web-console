import { t } from './i18n.js';

const KIND_KEYS = new Set(['approved', 'merged', 'deployed']);

export function milestoneKind(kind) {
  return KIND_KEYS.has(kind) ? kind : 'approved';
}

export function milestoneGlyph(kind, { size = 14, className = '' } = {}) {
  const safe = milestoneKind(kind);
  const paths = {
    approved: '<path d="M1.5 8s2.2-4 6.5-4 6.5 4 6.5 4-2.2 4-6.5 4S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.8"/>',
    merged: '<circle cx="8" cy="8" r="5.2"/><path d="M8 2.8v10.4M2.8 8h10.4"/>',
    deployed: '<path d="M5.5 13.5h5M6.4 13.5 7 5.2h2l.6 8.3M7 5.2 8 1.8l1 3.4M5.8 8.5h4.4M4.4 13.5h7.2"/>',
  };
  return `<svg class="hito-glyph ${className}" data-kind="${safe}" viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[safe]}</svg>`;
}

export function milestoneChipText({ kind, number } = {}) {
  const values = {
    approved: t('chat.prMilestone.chip.approved', '#{number} · el Ojo aprueba', { number }),
    merged: t('chat.prMilestone.chip.merged', '#{number} · anillo forjado', { number }),
    deployed: t('chat.prMilestone.chip.deployed', '#{number} · arde en prod', { number }),
  };
  return values[milestoneKind(kind)];
}

export function milestoneToastTitle(kind) {
  const values = {
    approved: t('chat.prMilestone.toast.approved', 'El Ojo aprueba'),
    merged: t('chat.prMilestone.toast.merged', 'Anillo forjado'),
    deployed: t('chat.prMilestone.toast.deployed', 'Arde en Barad-dûr'),
  };
  return values[milestoneKind(kind)];
}

export function milestoneTrackHtml(milestone) {
  const stages = [
    ['approved', milestone?.approvedAt],
    ['merged', milestone?.mergedAt],
    ['deployed', milestone?.deployedAt],
  ];
  return stages.map(([kind, at], index) => {
    const label = {
      approved: t('chat.prMilestone.stage.approved', 'Aprobado'),
      merged: t('chat.prMilestone.stage.merged', 'Mergeado'),
      deployed: t('chat.prMilestone.stage.deployed', 'Producción'),
    }[kind];
    const time = formatBogotaTime(at) || t('chat.prMilestone.pending', 'pendiente');
    const separator = index === 0 ? '' : `<span class="hito-track-sep" aria-hidden="true">${index === 1 ? '—' : '···'}</span>`;
    return `${separator}<span class="hito-track-stage${at ? ' is-done' : ''}" title="${label}: ${time}">${milestoneGlyph(kind, { size: 12 })}<span>${time}</span></span>`;
  }).join('');
}

function formatBogotaTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}
