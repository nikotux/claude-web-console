import { t } from './i18n.js';

const KIND_KEYS = new Set(['approved', 'merged', 'deployed']);

export function milestoneKind(kind) {
  return KIND_KEYS.has(kind) ? kind : 'approved';
}

export function milestoneGlyph(kind, { size = 14, className = '' } = {}) {
  const safe = milestoneKind(kind);
  const paths = {
    approved: '<path d="M1 6s1.8-3 5-3 5 3 5 3-1.8 3-5 3-5-3-5-3Z"/><path d="M6 4.35v3.3"/>',
    merged: '<circle cx="6" cy="6.4" r="4.25"/><path d="M4.8 2.25 6 1l1.2 1.25"/>',
    deployed: '<path d="M2.2 10h7.6M3.8 10 4.7 4.2 6 2l1.3 2.2.9 5.8M4.35 6.1 6 5.15 7.65 6.1M6 2V.8"/>',
  };
  return `<svg class="hito-glyph ${className}" data-kind="${safe}" viewBox="0 0 12 12" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[safe]}</svg>`;
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
