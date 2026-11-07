import { t } from '../../ui/i18n.js';

const WAKE_PREFIX = '🔔 [cwc-despertador]';

export function isWakeText(text) {
  return typeof text === 'string' && text.startsWith(WAKE_PREFIX);
}

export function wakeSummary(text) {
  const value = String(text ?? '');
  const checkin = value.match(/\bPasaron\s+(\d+)\s+min\b/);
  if (isWakeText(value) && checkin) {
    const minutes = Number(checkin[1]);
    return {
      kind: 'checkin',
      text: t('chat.wake.checkin', 'Pasaron {n} min, reviso si ya llegó lo que esperábamos', { n: minutes }),
    };
  }

  if (isWakeText(value)) {
    const lines = value.split(/\r?\n/);
    const codexOutcomes = [];
    const ciOutcomes = [];
    let subagents = 0;
    for (const line of lines) {
      const codex = line.match(/^• Codex .* → (.+)$/u);
      if (codex) codexOutcomes.push(codex[1].trim());
      const ci = line.match(/^• CI del PR #\d+ → (.+)$/u);
      if (ci) ciOutcomes.push(ci[1].trim());
      if (/^• Subagente .* → terminado\s*$/u.test(line)) subagents += 1;
    }

    if (codexOutcomes.some((outcome) => outcome !== 'done')) {
      return {
        kind: 'codex-problem',
        text: t('chat.wake.codexProblem', 'Codex terminó con un problema, hay que revisarlo'),
      };
    }
    if (ciOutcomes.some((outcome) => outcome.startsWith('falló'))) {
      return {
        kind: 'ci-failed',
        text: t('chat.wake.ciFailed', 'El CI falló, hay que revisarlo'),
      };
    }
    if (ciOutcomes.length && (codexOutcomes.length || subagents)) {
      return {
        kind: 'mixed',
        text: t('chat.wake.several', 'Terminaron varios trabajos, puedes continuar'),
      };
    }
    if (ciOutcomes.length) {
      return {
        kind: 'ci',
        text: t('chat.wake.ciDone', 'El CI terminó, mira qué sigue'),
      };
    }
    if (codexOutcomes.length && subagents) {
      return {
        kind: 'mixed',
        text: t('chat.wake.mixed', 'Codex y el subagente terminaron, puedes continuar'),
      };
    }
    if (codexOutcomes.length === 1) {
      return {
        kind: 'codex',
        text: t('chat.wake.codexOne', 'Codex terminó, puedes continuar'),
      };
    }
    if (codexOutcomes.length > 1) {
      return {
        kind: 'codex',
        text: t('chat.wake.codexMany', 'Codex terminó {n} encargos, puedes continuar', { n: codexOutcomes.length }),
      };
    }
    if (subagents === 1) {
      return {
        kind: 'sub',
        text: t('chat.wake.subOne', 'El subagente terminó, puedes continuar'),
      };
    }
    if (subagents > 1) {
      return {
        kind: 'sub',
        text: t('chat.wake.subMany', 'Terminaron {n} subagentes, puedes continuar', { n: subagents }),
      };
    }
  }

  return { kind: 'other', text: t('chat.wake.other', 'Aviso del despertador') };
}
