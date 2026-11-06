import path from 'node:path';

const FILES = Symbol('codexProgressFiles');
const COMMAND_RUNNING = Symbol('codexProgressCommandRunning');
const STEP_SOURCE = Symbol('codexProgressStepSource');
const CURRENT_STEP = Symbol('codexProgressCurrentStep');
const RUN_FAILED = Symbol('codexProgressRunFailed');

const PLAN_LINE = /^\s*\**PLAN\**\s*:?\s*\**\s*$/i;
const NUMBERED_STEP = /^\s*(\d+)[.)]\s+(.+)$/;
const STEP_MARKER = /^\s*\**Paso\s+(\d+)\s*(?:de\s+\d+)?\**\s*[:.\-—]/im;

function clean(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function commandText(cmd) {
  if (Array.isArray(cmd)) {
    const parts = cmd.filter((part) => typeof part === 'string');
    const shell = path.basename(parts[0] || '');
    if ((shell === 'bash' || shell === 'sh') && /^-[a-z]*c[a-z]*$/i.test(parts[1] || '')) {
      return parts.slice(2).join(' ').trim();
    }
    return parts.join(' ').trim();
  }
  if (typeof cmd !== 'string') return '';
  const wrapped = cmd.match(/^\s*(?:\/bin\/)?(?:bash|sh)\s+-[a-z]*c[a-z]*\s+([\s\S]+?)\s*$/i);
  if (!wrapped) return cmd.trim();
  const inner = wrapped[1].trim();
  const quote = inner[0];
  return (quote === '"' || quote === "'") && inner.at(-1) === quote
    ? inner.slice(1, -1).trim()
    : inner;
}

export function describeCommand(cmd) {
  const command = commandText(cmd);
  const rules = [
    [/\b(?:test|vitest|jest|mocha|cwc-test|pytest)\b|\bnode\s+--test\b|\bplaywright\s+test\b/i, 'probando que el código funcione'],
    [/\b(?:tsc|typecheck|lint|eslint)\b|\bnode\s+--check\b|\bprettier\s+--check\b/i, 'revisando que todo compile'],
    [/\b(?:next|vite)\s+build\b|\bbuild\b/i, 'armando el proyecto'],
    [/\b(?:npm|pnpm|yarn)\s+(?:install|i|ci)\b/i, 'instalando dependencias'],
    [/\bgit\s+commit\b/i, 'guardando los cambios'],
    [/\bgit\s+push\b/i, 'subiendo los cambios'],
    [/\bgit\s+(?:diff|status|log|show)\b/i, 'revisando qué cambió'],
    [/\bgit\s+(?:worktree|checkout|switch|branch|fetch|pull|rebase|merge)\b/i, 'preparando la copia de trabajo'],
    [/\bgh\s+pr\b/i, 'trabajando con el PR'],
    [/\bgh\s+(?:run|api)\b/i, 'consultando GitHub'],
    [/(?:^|[;&|]\s*|\b)(?:rg|grep|cat|head|tail|ls|find|wc|nl|less)\b|\bsed\s+-n\b/i, 'leyendo el código'],
    [/\b(?:curl|wget)\b/i, 'consultando un servicio'],
    [/\b(?:psql|prisma)\b/i, 'trabajando con la base de datos'],
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(command)) return label;
  }
  return 'ejecutando una acción';
}

export function createCodexProgress() {
  const state = {
    updatedAt: null,
    steps: null,
    lastMessage: null,
    now: null,
    counts: { files: 0, actions: 0 },
    recent: [],
  };
  Object.defineProperties(state, {
    [FILES]: { value: new Set() },
    [COMMAND_RUNNING]: { value: false, writable: true },
    [STEP_SOURCE]: { value: null, writable: true },
    [CURRENT_STEP]: { value: null, writable: true },
    [RUN_FAILED]: { value: false, writable: true },
  });
  return state;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function setVisible(state, key, value) {
  if (same(state[key], value)) return false;
  state[key] = value;
  return true;
}

function addRecent(state, entry) {
  state.recent = [...state.recent, entry].slice(-10);
}

function firstParagraph(text) {
  if (typeof text !== 'string') return '';
  const paragraph = text.split(/\r?\n\s*\r?\n/).find((part) => part.trim());
  return clean(paragraph || '', 280);
}

function findPlanBlock(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  for (let start = 0; start < lines.length; start += 1) {
    if (!PLAN_LINE.test(lines[start])) continue;
    const steps = [];
    let end = start + 1;
    for (; end < lines.length; end += 1) {
      const line = lines[end];
      if (!line.trim()) continue;
      const match = line.match(NUMBERED_STEP);
      if (!match) break;
      steps.push(clean(match[2], 90));
    }
    if (steps.length < 2) continue;
    return {
      steps: steps.slice(0, 12),
      text: [...lines.slice(0, start), ...lines.slice(end)].join('\n'),
    };
  }
  return null;
}

function highestStepMarker(text) {
  if (typeof text !== 'string') return null;
  const pattern = new RegExp(STEP_MARKER.source, STEP_MARKER.flags.includes('g') ? STEP_MARKER.flags : `${STEP_MARKER.flags}g`);
  let highest = null;
  for (const match of text.matchAll(pattern)) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && (highest === null || number > highest)) highest = number;
  }
  return highest;
}

function stripLeadingStepMarker(text) {
  if (typeof text !== 'string') return '';
  const pattern = new RegExp(STEP_MARKER.source, 'i');
  return text.replace(pattern, '').trimStart();
}

function applyTextProgress(state, text) {
  let changed = false;
  const plan = findPlanBlock(text);
  let narration = plan ? plan.text : text;

  if (plan && state[STEP_SOURCE] !== 'todo') {
    const isFirstPlan = state[STEP_SOURCE] !== 'text';
    const isReplan = state[STEP_SOURCE] === 'text' && state.steps?.length !== plan.steps.length;
    if (isFirstPlan || isReplan) {
      const current = isReplan && Number.isInteger(state[CURRENT_STEP])
        ? Math.min(state[CURRENT_STEP], plan.steps.length - 1)
        : 0;
      const steps = plan.steps.map((step, index) => ({ text: step, done: index < current }));
      state[STEP_SOURCE] = 'text';
      state[CURRENT_STEP] = current;
      changed = setVisible(state, 'steps', steps) || changed;
    }
  }

  if (state[STEP_SOURCE] === 'text') {
    const marker = highestStepMarker(text);
    if (marker !== null && marker >= 1 && marker <= state.steps.length) {
      const current = marker - 1;
      const steps = state.steps.map((step, index) => ({
        ...step,
        done: index < current,
      }));
      state[CURRENT_STEP] = current;
      changed = setVisible(state, 'steps', steps) || changed;
    }
  }

  narration = stripLeadingStepMarker(narration);
  const message = firstParagraph(narration);
  if (message) changed = setVisible(state, 'lastMessage', message) || changed;
  return changed;
}

export function applyCodexEvent(state, ev, now = Date.now()) {
  if (!state || typeof state !== 'object' || !ev || typeof ev !== 'object') return false;
  const eventType = typeof ev.type === 'string' ? ev.type : '';
  if (eventType === 'turn.failed' || eventType === 'error') {
    state[RUN_FAILED] = true;
    return false;
  }
  if (eventType === 'turn.completed') {
    if (!Array.isArray(state.steps) || state[RUN_FAILED]) return false;
    const steps = state.steps.map((step) => ({ ...step, done: true }));
    const changed = setVisible(state, 'steps', steps);
    if (changed) state.updatedAt = now;
    return changed;
  }
  if (!['item.started', 'item.updated', 'item.completed'].includes(eventType)) return false;
  const item = ev.item;
  if (!item || typeof item !== 'object' || typeof item.type !== 'string') return false;

  let changed = false;
  if (item.type === 'todo_list') {
    if (!Array.isArray(item.items)) return false;
    const steps = item.items.slice(0, 12).map((entry) => ({
      text: clean(entry?.text, 90),
      done: !!entry?.completed,
    }));
    state[STEP_SOURCE] = 'todo';
    state[CURRENT_STEP] = null;
    changed = setVisible(state, 'steps', steps);
  } else if (item.type === 'agent_message'
    && (eventType === 'item.completed' || eventType === 'item.updated')
    && typeof item.text === 'string' && item.text) {
    changed = applyTextProgress(state, item.text);
  } else if (item.type === 'command_execution') {
    const label = describeCommand(item.command);
    if (eventType === 'item.started') {
      state[COMMAND_RUNNING] = true;
      changed = setVisible(state, 'now', { kind: 'command', label, at: now });
    } else if (eventType === 'item.completed') {
      state[COMMAND_RUNNING] = false;
      state.counts.actions += 1;
      addRecent(state, {
        kind: 'command',
        label,
        ok: item.exit_code === 0,
        at: now,
      });
      changed = true;
    }
  } else if (item.type === 'file_change' && eventType === 'item.completed') {
    const paths = Array.isArray(item.changes)
      ? item.changes.map((change) => change?.path).filter((value) => typeof value === 'string' && value.trim())
      : [];
    if (!paths.length) return false;
    for (const file of paths) state[FILES].add(file);
    state.counts.files = state[FILES].size;
    const label = `editando ${path.basename(paths.at(-1))}`;
    state.now = { kind: 'edit', label, at: now };
    addRecent(state, { kind: 'edit', label, ok: true, at: now });
    changed = true;
  } else if (item.type === 'reasoning') {
    if (state[COMMAND_RUNNING]) return false;
    changed = setVisible(state, 'now', {
      kind: 'thinking',
      label: 'pensando el próximo paso',
      at: now,
    });
  } else if (item.type === 'mcp_tool_call') {
    changed = setVisible(state, 'now', {
      kind: 'tool',
      label: 'consultando una herramienta',
      at: now,
    });
  } else if (item.type === 'web_search') {
    changed = setVisible(state, 'now', {
      kind: 'web',
      label: 'buscando en la web',
      at: now,
    });
  }

  if (changed) state.updatedAt = now;
  return changed;
}

export function serializeCodexProgress(state) {
  const source = state && typeof state === 'object' ? state : createCodexProgress();
  return {
    updatedAt: source.updatedAt ?? null,
    steps: Array.isArray(source.steps)
      ? source.steps.map((step) => ({ text: step.text, done: !!step.done }))
      : null,
    lastMessage: typeof source.lastMessage === 'string' ? source.lastMessage : null,
    now: source.now ? { ...source.now } : null,
    counts: {
      files: Number(source.counts?.files) || 0,
      actions: Number(source.counts?.actions) || 0,
    },
    recent: Array.isArray(source.recent) ? source.recent.map((entry) => ({ ...entry })) : [],
  };
}
