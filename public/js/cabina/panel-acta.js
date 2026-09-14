// Índice navegable de Modo Cabina, destilado por IA en segundo plano.
// El contrato conserva `name: 'acta'` y `data-cabina-panel="acta"` para no romper el montaje.

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 20;

const KIND_APPEARANCE = {
  decision: { icon: '◆', color: 'var(--cwc-accent)', label: 'Decisión' },
  tema: { icon: '●', color: 'var(--cwc-info)', label: 'Tema' },
  hallazgo: { icon: '✦', color: 'var(--cwc-warn)', label: 'Hallazgo' },
  entrega: { icon: '✓', color: 'var(--cwc-ok)', label: 'Entrega' },
  bloqueo: { icon: '!', color: 'var(--cwc-text-dim)', label: 'Bloqueo' },
};

let current = null;

function isCurrent(state) {
  return current === state && state.alive;
}

function normalizedMoments(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((moment) => Number.isInteger(moment?.eventIndex) && moment.eventIndex >= 0 && String(moment?.title || '').trim())
    .map((moment) => ({
      eventIndex: moment.eventIndex,
      kind: KIND_APPEARANCE[moment.kind] ? moment.kind : 'tema',
      title: String(moment.title).trim(),
      detail: String(moment.detail || '').trim(),
    }));
}

function setActive(state, eventIndex) {
  if (!isCurrent(state)) return;
  state.activeIndex = Number.isInteger(eventIndex) ? eventIndex : null;
  state.el.querySelectorAll('.cab-side-item[data-event-index]').forEach((item) => {
    const active = Number(item.dataset.eventIndex) === state.activeIndex;
    item.classList.toggle('cab-side-item--active', active);
    if (active) item.setAttribute('aria-current', 'location');
    else item.removeAttribute('aria-current');
  });
}

function chooseVisibleMoment(state) {
  if (!isCurrent(state)) return;
  const visible = [...state.visibleEntries.values()].filter((entry) => entry.isIntersecting);
  if (!visible.length) return;

  const rootTop = visible[0].rootBounds?.top || 0;
  const rootHeight = visible[0].rootBounds?.height || window.innerHeight;
  const readingLine = rootTop + (rootHeight * 0.3);
  visible.sort((a, b) => {
    const aDistance = Math.abs(a.boundingClientRect.top - readingLine);
    const bDistance = Math.abs(b.boundingClientRect.top - readingLine);
    return aDistance - bDistance;
  });
  setActive(state, Number(visible[0].target.dataset.eventIndex || visible[0].target.dataset.cabEventIndex));
}

function syncObserverTargets(state) {
  if (!isCurrent(state) || !('IntersectionObserver' in window)) return;
  state.observer?.disconnect();
  state.visibleEntries.clear();

  const indexed = new Set(state.moments.map((moment) => moment.eventIndex));
  const targets = [...document.querySelectorAll('[data-event-index], [data-cab-event-index]')]
    .filter((target) => {
      if (state.el.contains(target)) return false;
      const value = Number(target.dataset.eventIndex || target.dataset.cabEventIndex);
      return indexed.has(value);
    });
  if (!targets.length) return;

  state.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number(entry.target.dataset.eventIndex || entry.target.dataset.cabEventIndex);
      if (entry.isIntersecting) state.visibleEntries.set(index, entry);
      else state.visibleEntries.delete(index);
    }
    chooseVisibleMoment(state);
  }, { threshold: [0, 0.2, 0.5, 0.8] });
  targets.forEach((target) => state.observer.observe(target));
}

function scheduleObserverSync(state) {
  if (state.frameId) cancelAnimationFrame(state.frameId);
  state.frameId = requestAnimationFrame(() => {
    state.frameId = requestAnimationFrame(() => {
      state.frameId = 0;
      syncObserverTargets(state);
    });
  });
}

function momentButton(moment, position, active) {
  const appearance = KIND_APPEARANCE[moment.kind];
  const button = document.createElement('button');
  button.className = 'cab-side-item';
  if (active) button.classList.add('cab-side-item--active');
  button.type = 'button';
  button.dataset.eventIndex = String(moment.eventIndex);
  button.title = moment.detail ? `${moment.title} — ${moment.detail}` : moment.title;
  button.setAttribute('aria-label', `${appearance.label}: ${moment.title}${moment.detail ? `. ${moment.detail}` : ''}`);
  if (active) button.setAttribute('aria-current', 'location');

  const meta = document.createElement('span');
  meta.className = 'cab-side-meta';
  meta.style.display = 'flex';
  meta.style.alignItems = 'center';
  meta.style.gap = '6px';

  const kind = document.createElement('span');
  kind.textContent = appearance.icon;
  kind.style.color = appearance.color;
  kind.setAttribute('aria-hidden', 'true');

  const number = document.createElement('span');
  number.textContent = String(position + 1).padStart(2, '0');

  const title = document.createElement('span');
  title.className = 'cab-side-label';
  title.textContent = moment.title;
  meta.append(kind, number);
  button.append(meta, title);
  return button;
}

function appendMessage(block, text, { action = '', tone = '' } = {}) {
  const empty = document.createElement('div');
  empty.className = 'cab-side-empty';
  if (tone) empty.style.color = tone;
  empty.textContent = text;
  block.appendChild(empty);

  if (!action) return;
  const button = document.createElement('button');
  button.className = 'cab-btn cab-btn--cold';
  button.type = 'button';
  button.dataset.action = 'refresh-index';
  button.textContent = action;
  block.appendChild(button);
}

function elapsedSince(timestamp) {
  const time = Number(timestamp);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return 'un momento';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function appendStatus(block, state) {
  if (state.status === 'running') {
    const status = document.createElement('div');
    status.className = 'cab-side-meta';
    status.style.marginTop = '10px';
    status.style.color = 'var(--cwc-info)';
    status.textContent = state.polling
      ? 'Actualizando el índice…'
      : 'La actualización sigue en segundo plano.';
    block.appendChild(status);
  }

  if (state.status === 'ready') {
    const status = document.createElement('div');
    status.className = 'cab-side-meta';
    status.style.marginTop = '10px';
    const elapsed = elapsedSince(state.generatedAt);
    status.textContent = elapsed ? `Actualizado hace ${elapsed}` : 'Índice actualizado';
    try {
      const formatted = state.generatedAt ? state.ctx.fmtDate(state.generatedAt) : '';
      if (formatted) {
        status.textContent += ` · ${formatted}`;
        status.title = `Actualizado ${formatted}`;
      }
    } catch { /* la fecha relativa sigue siendo suficiente */ }
    block.appendChild(status);
  }

  if (state.hasNewEvents && ['ready', 'running'].includes(state.status)) {
    const stale = document.createElement('div');
    stale.className = 'cab-side-meta';
    stale.style.marginTop = '6px';
    stale.style.color = 'var(--cwc-warn)';
    stale.textContent = 'Hay mensajes nuevos sin indexar.';
    block.appendChild(stale);
  }
}

function render(state) {
  if (!isCurrent(state)) return;
  state.hasNewEvents = Number.isInteger(state.upToEvent)
    && state.latestEventIndex > state.upToEvent;
  const signature = [
    state.status,
    state.generatedAt,
    state.upToEvent,
    state.latestEventIndex,
    state.polling,
    ...state.moments.map((moment) => `${moment.eventIndex}:${moment.kind}:${moment.title}:${moment.detail}`),
  ].join('\n');

  if (signature === state.signature) {
    scheduleObserverSync(state);
    return;
  }
  state.signature = signature;

  const side = document.createElement('nav');
  side.className = 'cab-side';
  side.setAttribute('aria-label', 'Índice de la conversación');

  const block = document.createElement('div');
  block.className = 'cab-side-block';

  const heading = document.createElement('div');
  heading.className = 'cab-side-title';
  heading.style.display = 'flex';
  heading.style.alignItems = 'center';
  heading.style.justifyContent = 'space-between';
  heading.style.gap = '8px';

  const headingText = document.createElement('span');
  headingText.textContent = 'Índice';
  const refresh = document.createElement('button');
  refresh.className = 'cab-btn cab-btn--cold';
  refresh.type = 'button';
  refresh.dataset.action = 'refresh-index';
  refresh.textContent = 'Actualizar';
  refresh.disabled = state.status === 'loading' || (state.status === 'running' && state.polling);
  refresh.style.padding = '4px 8px';
  refresh.style.fontSize = 'var(--cwc-fs-xs)';
  heading.append(headingText, refresh);
  block.appendChild(heading);

  const showMoments = ['ready', 'running'].includes(state.status) && state.moments.length > 0;
  if (showMoments) {
    if (!state.moments.some((moment) => moment.eventIndex === state.activeIndex)) state.activeIndex = null;
    state.moments.forEach((moment, position) => {
      block.appendChild(momentButton(moment, position, moment.eventIndex === state.activeIndex));
    });
  } else {
    state.activeIndex = null;
    if (state.status === 'loading') {
      appendMessage(block, 'Buscando el índice…');
    } else if (state.status === 'running') {
      appendMessage(block, 'El índice se está preparando.');
    } else if (state.status === 'error') {
      appendMessage(block, 'No se pudo preparar el índice. Podés intentarlo de nuevo.', { action: 'Reintentar' });
    } else if (state.status === 'ready') {
      appendMessage(block, 'Todavía no hay temas relevantes para mostrar.');
    } else if (state.endpointMissing) {
      appendMessage(block, 'El índice todavía no está disponible.');
    } else {
      appendMessage(block, 'Este índice todavía no fue generado. Elegí Actualizar para prepararlo.');
    }
  }

  appendStatus(block, state);
  side.appendChild(block);
  state.el.replaceChildren(side);
  scheduleObserverSync(state);
}

async function requestJson(state, path, options = {}) {
  const controller = new AbortController();
  state.controllers.add(controller);
  try {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      signal: controller.signal,
    });
    if (response.status === 404) return { missing: true, data: null };
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error('index request failed');
    return { missing: false, data };
  } finally {
    state.controllers.delete(controller);
  }
}

function clearPolling(state) {
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  state.pollTimer = 0;
  state.polling = false;
}

function schedulePoll(state) {
  if (!isCurrent(state) || state.status !== 'running' || !state.polling) return;
  if (state.pollAttempts >= MAX_POLL_ATTEMPTS) {
    clearPolling(state);
    render(state);
    return;
  }
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  state.pollTimer = window.setTimeout(() => {
    state.pollTimer = 0;
    state.pollAttempts += 1;
    void loadIndex(state);
  }, POLL_INTERVAL_MS);
}

function applyIndex(state, data) {
  const status = ['ready', 'running', 'stale', 'error'].includes(data?.status)
    ? data.status
    : 'stale';
  const moments = normalizedMoments(data?.moments);
  state.status = status;
  state.endpointMissing = false;
  state.generatedAt = Number.isFinite(Number(data?.generatedAt)) ? Number(data.generatedAt) : null;
  state.upToEvent = Number.isInteger(data?.upToEvent) ? data.upToEvent : null;
  if (status !== 'running' || moments.length || !state.moments.length) state.moments = moments;
}

async function loadIndex(state) {
  const requestId = ++state.requestId;
  try {
    const result = await requestJson(state, `/api/chat/indice?id=${encodeURIComponent(state.ctx.chatId)}`);
    if (!isCurrent(state) || requestId !== state.requestId) return;
    if (result.missing) {
      clearPolling(state);
      state.status = 'stale';
      state.endpointMissing = true;
      state.moments = [];
      state.generatedAt = null;
      state.upToEvent = null;
    } else {
      applyIndex(state, result.data);
      if (state.status === 'running') {
        if (!state.polling) {
          state.polling = true;
          state.pollAttempts = 0;
        }
      } else {
        clearPolling(state);
      }
    }
    render(state);
    schedulePoll(state);
  } catch (error) {
    if (!isCurrent(state) || error?.name === 'AbortError' || requestId !== state.requestId) return;
    clearPolling(state);
    state.status = 'error';
    state.endpointMissing = false;
    render(state);
  }
}

async function refreshIndex(state) {
  if (!isCurrent(state) || (state.status === 'running' && state.polling)) return;
  state.requestId += 1;
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  state.pollTimer = 0;
  state.pollAttempts = 0;
  state.polling = true;
  state.status = 'running';
  state.endpointMissing = false;
  render(state);

  try {
    const result = await requestJson(state, '/api/chat/indice/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.ctx.chatId }),
    });
    if (!isCurrent(state)) return;
    if (result.missing) {
      clearPolling(state);
      state.status = 'stale';
      state.endpointMissing = true;
      state.moments = [];
      state.generatedAt = null;
      state.upToEvent = null;
      render(state);
      return;
    }
    schedulePoll(state);
  } catch (error) {
    if (!isCurrent(state) || error?.name === 'AbortError') return;
    clearPolling(state);
    state.status = 'error';
    state.endpointMissing = false;
    render(state);
  }
}

function teardown() {
  if (!current) return;
  const state = current;
  state.alive = false;
  state.el.removeEventListener('click', state.clickHandler);
  state.observer?.disconnect();
  if (state.frameId) cancelAnimationFrame(state.frameId);
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  state.controllers.forEach((controller) => controller.abort());
  state.controllers.clear();
  current = null;
}

export default {
  name: 'acta',

  async mount(el, ctx) {
    teardown();
    const state = {
      el,
      ctx,
      alive: true,
      activeIndex: null,
      moments: [],
      status: 'loading',
      endpointMissing: false,
      generatedAt: null,
      upToEvent: null,
      latestEventIndex: -1,
      hasNewEvents: false,
      signature: null,
      observer: null,
      visibleEntries: new Map(),
      frameId: 0,
      pollTimer: 0,
      pollAttempts: 0,
      polling: false,
      requestId: 0,
      controllers: new Set(),
      clickHandler: null,
    };
    current = state;
    state.clickHandler = (event) => {
      const refresh = event.target.closest('[data-action="refresh-index"]');
      if (refresh && state.el.contains(refresh)) {
        void refreshIndex(state);
        return;
      }

      const item = event.target.closest('.cab-side-item[data-event-index]');
      if (!item || !state.el.contains(item)) return;
      const eventIndex = Number(item.dataset.eventIndex);
      if (!Number.isInteger(eventIndex)) return;
      setActive(state, eventIndex);
      state.ctx.goToEvent(eventIndex);
    };
    el.addEventListener('click', state.clickHandler);
    render(state);
    void loadIndex(state);
  },

  update(events) {
    if (!current) return;
    current.latestEventIndex = Array.isArray(events) ? events.length - 1 : -1;
    render(current);
  },

  unmount() {
    teardown();
  },
};
