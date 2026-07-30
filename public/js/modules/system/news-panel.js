// modules/system/news-panel.js — changelog alegre y accionable de Mi Consola.
//
// La lista es para todas las personas; la edición y la redacción asistida
// aparecen únicamente para administradores. El backend conserva los jobs:
// este panel solo se reengancha por id y refleja su estado con polling.
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}[c]));

const CATEGORY = {
  nuevo: {
    label: () => t('news.category.new', '✨ Nuevo'),
    cls: 'news-category--new',
  },
  mejora: {
    label: () => t('news.category.improvement', '🔧 Mejora'),
    cls: 'news-category--improvement',
  },
  arreglo: {
    label: () => t('news.category.fix', '🐞 Arreglo'),
    cls: 'news-category--fix',
  },
};

function arrays(entry, key) {
  return Array.isArray(entry?.[key]) ? entry[key] : [];
}

function relativeDate(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return t('news.date.unknown', 'fecha desconocida');

  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return t('news.date.justNow', 'hace un momento');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1
      ? t('news.date.minute', 'hace 1 minuto')
      : t('news.date.minutes', 'hace {count} minutos', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1
      ? t('news.date.hour', 'hace 1 hora')
      : t('news.date.hours', 'hace {count} horas', { count: hours });
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return days === 1
      ? t('news.date.day', 'hace 1 día')
      : t('news.date.days', 'hace {count} días', { count: days });
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1
      ? t('news.date.month', 'hace 1 mes')
      : t('news.date.months', 'hace {count} meses', { count: months });
  }
  const years = Math.floor(days / 365);
  return years === 1
    ? t('news.date.year', 'hace 1 año')
    : t('news.date.years', 'hace {count} años', { count: years });
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('news.error.request', 'No se pudo completar la acción.'));
  return data;
}

function technicalDetails(entry) {
  const commits = Array.isArray(entry?.tech?.commits) ? entry.tech.commits : [];
  const files = Array.isArray(entry?.tech?.files) ? entry.tech.files : [];
  const commitList = commits.length
    ? `<ul class="news-tech-list">${commits.map((commit) => `
        <li><code>${esc(String(commit?.sha || '').slice(0, 8))}</code> ${esc(commit?.subject)}</li>`).join('')}
      </ul>`
    : `<p class="news-tech-empty">${t('news.tech.noCommits', 'Sin commits asociados.')}</p>`;
  const fileList = files.length
    ? `<ul class="news-file-list">${files.map((file) => `<li><code>${esc(file)}</code></li>`).join('')}</ul>`
    : `<p class="news-tech-empty">${t('news.tech.noFiles', 'Sin archivos asociados.')}</p>`;

  return `
    <details class="news-tech">
      <summary>${t('news.tech.title', 'Detalle técnico')}</summary>
      <div class="news-tech-grid">
        <section>
          <h4>${t('news.tech.commits', 'Commits')}</h4>
          ${commitList}
        </section>
        <section>
          <h4>${t('news.tech.files', 'Archivos')}</h4>
          ${fileList}
        </section>
      </div>
    </details>`;
}

function cardHtml(entry, { open, isAdmin, lastSeen }) {
  const category = CATEGORY[entry.category] || CATEGORY.mejora;
  const isUnread = Number(entry.createdAt) > Number(lastSeen || 0);
  const bullets = arrays(entry, 'bullets');
  const tryIt = arrays(entry, 'tryIt');
  const bulletList = bullets.length
    ? `<ul class="news-bullets">${bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join('')}</ul>`
    : '';
  const tryList = tryIt.length
    ? `<ol>${tryIt.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>`
    : `<p>${t('news.try.empty', 'Esta novedad todavía no tiene pasos de prueba.')}</p>`;
  const hiddenChip = entry.hidden
    ? `<span class="news-hidden-chip">${t('news.hidden', 'oculta')}</span>`
    : '';
  const unreadChip = isUnread
    ? `<span class="news-new-chip" title="${t('news.unread.title', 'Novedad que todavía no habías visto')}">${t('news.unread.chip', '🆕')}</span>`
    : '';
  const adminActions = isAdmin
    ? `
      <div class="news-actions">
        <button class="btn-ghost btn--sm" data-news-action="edit">${t('news.actions.edit', '✏️ Editar')}</button>
        <button class="btn-ghost btn--sm" data-news-action="visibility">${entry.hidden ? t('news.actions.show', '👁 Mostrar') : t('news.actions.hide', '🙈 Ocultar')}</button>
        <button class="btn-ghost btn--sm btn--danger" data-news-action="delete">${t('news.actions.delete', '🗑️ Borrar')}</button>
      </div>`
    : '';

  return `
    <article class="news-card${open ? '' : ' news-card--collapsed'}${entry.hidden ? ' news-card--hidden' : ''}" data-news-id="${esc(entry.id)}">
      <button class="news-card-head" type="button" data-news-toggle aria-expanded="${open ? 'true' : 'false'}">
        <span class="news-emoji">${esc(entry.emoji || t('news.defaultEmoji', '🆕'))}</span>
        <span class="news-card-title">${esc(entry.title)}</span>
        <span class="news-category ${category.cls}">${category.label()}</span>
        <time class="news-date" datetime="${esc(new Date(Number(entry.createdAt) || 0).toISOString())}">${relativeDate(entry.createdAt)}</time>
        ${unreadChip}
        ${hiddenChip}
        <span class="news-chevron">${icon('chevronDown', { size: 13 })}</span>
      </button>
      <div class="news-card-body">
        ${entry.summary ? `<p class="news-summary">${esc(entry.summary)}</p>` : ''}
        ${bulletList}
        <section class="news-try">
          <h3>${t('news.try.title', '🧪 Probalo así')}</h3>
          ${tryList}
        </section>
        ${technicalDetails(entry)}
        ${adminActions}
      </div>
    </article>`;
}

function initialOpenIds(entries, lastSeen) {
  const unread = entries.filter((entry) => Number(entry.createdAt) > Number(lastSeen || 0));
  if (unread.length) return new Set(unread.slice(0, 3).map((entry) => String(entry.id)));
  return new Set(entries.length ? [String(entries[0].id)] : []);
}

export function mountNewsPanel(el, ctx) {
  const { dialog, isAdmin = false } = ctx;
  el.innerHTML = `
    <div class="news-head">
      <div class="news-heading">
        <h2>${t('news.title', '🆕 Novedades')}</h2>
        <p>${t('news.subtitle', 'Lo nuevo de la consola y cómo probarlo')}</p>
      </div>
      <div class="news-head-controls">
        ${isAdmin ? `<button class="btn btn--sm" type="button" data-news-generate>${t('news.generate', '✍️ Redactar ahora')}</button>` : ''}
        ${helpBtn('news')}
      </div>
    </div>
    <div class="news-job" data-news-job hidden></div>
    <div class="news-root" data-news-root>
      <div class="news-loading">${pacman({ size: 'sm' })}<span>${t('news.loading', 'Cargando novedades…')}</span></div>
    </div>`;

  const root = el.querySelector('[data-news-root]');
  const jobStatus = el.querySelector('[data-news-job]');
  const generateButton = el.querySelector('[data-news-generate]');
  let alive = true;
  let generating = false;
  let pendingCount = 0;
  let openIds = null;
  let entriesById = new Map();
  let seenPending = false;
  let seenTimer = null;
  let pollTimer = null;

  function isPanelAlive() {
    return alive && root.isConnected;
  }

  function teardown() {
    alive = false;
    if (seenTimer) clearTimeout(seenTimer);
    if (pollTimer) clearTimeout(pollTimer);
    seenTimer = null;
    pollTimer = null;
    observer.disconnect();
  }

  // `el` es el contenedor compartido por los paneles del menú Sistema: al
  // cambiar de panel se vacía, pero nunca se desconecta. La vida de este panel
  // se mide con `root`, que sí queda huérfano cuando reemplazan su contenido.
  const observer = new MutationObserver(() => {
    if (root.isConnected) return;
    teardown();
  });
  observer.observe(el, { childList: true });

  function notifySeen() {
    const event = new CustomEvent('cwc:news-seen', { detail: { unread: 0 } });
    if (ctx.bus?.dispatchEvent) ctx.bus.dispatchEvent(event);
    else window.dispatchEvent(event);
  }

  async function markSeen(unread) {
    if (unread <= 0 || seenPending) return;
    seenPending = true;
    try {
      const data = await requestJson('/api/news/seen', { method: 'POST' });
      if (data.ok) notifySeen();
    } catch {
      // Best-effort: si falla, la próxima apertura vuelve a mostrar lo no leído.
    } finally {
      seenPending = false;
    }
  }

  function scheduleSeen(unread) {
    if (seenTimer) clearTimeout(seenTimer);
    seenTimer = null;
    if (unread <= 0) return;

    // La espera evita marcar novedades que la persona no llegó a leer.
    seenTimer = setTimeout(() => {
      seenTimer = null;
      if (!isPanelAlive()) return;
      markSeen(unread);
    }, 3000);
  }

  function showPanelError(message) {
    root.innerHTML = `
      <div class="news-error">
        <span>${esc(message || t('news.error.load', 'No pudimos cargar las novedades.'))}</span>
        <button class="btn-ghost btn--sm" type="button" data-news-retry>${t('news.retry', 'Reintentar')}</button>
      </div>`;
    root.querySelector('[data-news-retry]')?.addEventListener('click', load);
  }

  function render(data) {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    pendingCount = Number(data.pending) || 0;
    if (!generating) resetGenerateButton();
    entriesById = new Map(entries.map((entry) => [String(entry.id), entry]));
    if (openIds === null) openIds = initialOpenIds(entries, data.lastSeen);
    else openIds = new Set([...openIds].filter((id) => entriesById.has(id)));

    if (!entries.length) {
      root.innerHTML = `
        <div class="news-empty">
          <div class="news-empty-emoji">${t('news.empty.emoji', '🌱')}</div>
          <strong>${t('news.empty.title', 'Todavía no hay novedades por acá')}</strong>
          <p>${t('news.empty.text', 'Se publican solas cuando se sube una versión nueva de Mi Consola.')}</p>
        </div>`;
      scheduleSeen(Number(data.unread) || 0);
      return;
    }

    root.innerHTML = `<div class="news-list">${entries.map((entry) => cardHtml(entry, {
      open: openIds.has(String(entry.id)),
      isAdmin,
      lastSeen: data.lastSeen,
    })).join('')}</div>`;
    wireCards();
    scheduleSeen(Number(data.unread) || 0);
  }

  async function load() {
    if (!isPanelAlive()) return;
    root.innerHTML = `<div class="news-loading">${pacman({ size: 'sm' })}<span>${t('news.loading', 'Cargando novedades…')}</span></div>`;
    try {
      const data = await requestJson('/api/news');
      if (isPanelAlive()) render(data);
      if (isPanelAlive() && !generating && data.job?.id) {
        generating = true;
        if (generateButton) {
          generateButton.disabled = true;
          generateButton.innerHTML = `${pacman({ state: 'delegating', size: 'sm' })}<span>${t('news.generate.running', 'Redactando…')}</span>`;
        }
        setJobStatus(`${pacman({ state: 'delegating', size: 'sm' })}<span>${t('news.generate.resumed', 'Ya hay una redacción en curso: seguimos esperándola…')}</span>`);
        scheduleJobPoll(String(data.job.id));
      }
    } catch (error) {
      if (isPanelAlive()) showPanelError(error.message);
    }
  }

  function setActionBusy(card, busy) {
    card.querySelectorAll('[data-news-action]').forEach((button) => {
      button.disabled = busy;
    });
  }

  async function toggleVisibility(entry, card) {
    setActionBusy(card, true);
    try {
      await requestJson(`/api/news/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: !entry.hidden }),
      });
      await load();
    } catch (error) {
      if (isPanelAlive()) showPanelError(error.message);
    } finally {
      if (card.isConnected) setActionBusy(card, false);
    }
  }

  async function deleteEntry(entry, card) {
    const confirmed = await dialog.confirmDialog({
      title: t('news.delete.title', 'Borrar novedad'),
      message: t('news.delete.message', '¿Borrar “{title}”? Esta acción no se puede deshacer.', { title: entry.title }),
      confirmLabel: t('news.delete.confirm', 'Borrar'),
      danger: true,
    });
    if (!confirmed || !isPanelAlive()) return;

    setActionBusy(card, true);
    try {
      await requestJson(`/api/news/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      openIds.delete(String(entry.id));
      await load();
    } catch (error) {
      if (isPanelAlive()) showPanelError(error.message);
    } finally {
      if (card.isConnected) setActionBusy(card, false);
    }
  }

  function editEntry(entry) {
    const modal = dialog.openModal({
      title: t('news.edit.title', 'Editar novedad'),
      width: 620,
    });
    modal.body.innerHTML = `
      <form class="news-edit" data-news-edit>
        <div class="news-edit-grid">
          <label class="news-field news-field--emoji">
            <span>${t('news.edit.emoji', 'Emoji')}</span>
            <input class="dlg-input" name="emoji" autocomplete="off">
          </label>
          <label class="news-field">
            <span>${t('news.edit.category', 'Categoría')}</span>
            <select class="dlg-input" name="category">
              <option value="nuevo">${t('news.category.new', '✨ Nuevo')}</option>
              <option value="mejora">${t('news.category.improvement', '🔧 Mejora')}</option>
              <option value="arreglo">${t('news.category.fix', '🐞 Arreglo')}</option>
            </select>
          </label>
        </div>
        <label class="news-field">
          <span>${t('news.edit.entryTitle', 'Título')}</span>
          <input class="dlg-input" name="title" autocomplete="off">
        </label>
        <label class="news-field">
          <span>${t('news.edit.summary', 'Resumen')}</span>
          <textarea class="dlg-input news-edit-text" name="summary" rows="3"></textarea>
        </label>
        <label class="news-field">
          <span>${t('news.edit.bullets', 'Viñetas (una por línea)')}</span>
          <textarea class="dlg-input news-edit-text" name="bullets" rows="5"></textarea>
        </label>
        <label class="news-field">
          <span>${t('news.edit.tryIt', 'Probalo así (un paso por línea)')}</span>
          <textarea class="dlg-input news-edit-text" name="tryIt" rows="5"></textarea>
        </label>
        <p class="news-edit-error" data-news-edit-error hidden></p>
        <div class="dlg-actions">
          <button class="btn-ghost" type="button" data-news-cancel>${t('news.edit.cancel', 'Cancelar')}</button>
          <button class="btn" type="submit" data-news-save>${t('news.edit.save', 'Guardar')}</button>
        </div>
      </form>`;

    const form = modal.body.querySelector('[data-news-edit]');
    form.elements.emoji.value = entry.emoji || '';
    form.elements.category.value = CATEGORY[entry.category] ? entry.category : 'mejora';
    form.elements.title.value = entry.title || '';
    form.elements.summary.value = entry.summary || '';
    form.elements.bullets.value = arrays(entry, 'bullets').join('\n');
    form.elements.tryIt.value = arrays(entry, 'tryIt').join('\n');
    form.querySelector('[data-news-cancel]').addEventListener('click', modal.close);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorEl = form.querySelector('[data-news-edit-error]');
      const saveButton = form.querySelector('[data-news-save]');
      const title = form.elements.title.value.trim();
      if (!title) {
        errorEl.textContent = t('news.edit.titleRequired', 'El título no puede quedar vacío.');
        errorEl.hidden = false;
        return;
      }

      const lines = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);
      saveButton.disabled = true;
      saveButton.innerHTML = `${pacman({ size: 'sm' })}<span>${t('news.edit.saving', 'Guardando…')}</span>`;
      errorEl.hidden = true;
      try {
        await requestJson(`/api/news/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emoji: form.elements.emoji.value.trim(),
            category: form.elements.category.value,
            title,
            summary: form.elements.summary.value.trim(),
            bullets: lines(form.elements.bullets.value),
            tryIt: lines(form.elements.tryIt.value),
          }),
        });
        modal.close();
        await load();
      } catch (error) {
        errorEl.textContent = error.message;
        errorEl.hidden = false;
        saveButton.disabled = false;
        saveButton.textContent = t('news.edit.save', 'Guardar');
      }
    });
  }

  function wireCards() {
    root.querySelectorAll('[data-news-id]').forEach((card) => {
      const id = card.dataset.newsId;
      const entry = entriesById.get(id);
      if (!entry) return;
      const toggle = card.querySelector('[data-news-toggle]');
      toggle.addEventListener('click', () => {
        const collapsed = card.classList.toggle('news-card--collapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
        if (collapsed) openIds.delete(id);
        else openIds.add(id);
      });
      card.querySelector('[data-news-action="edit"]')?.addEventListener('click', () => editEntry(entry));
      card.querySelector('[data-news-action="visibility"]')?.addEventListener('click', () => toggleVisibility(entry, card));
      card.querySelector('[data-news-action="delete"]')?.addEventListener('click', () => deleteEntry(entry, card));
    });
  }

  function resetGenerateButton() {
    if (!generateButton) return;
    generateButton.disabled = false;
    const label = t('news.generate', '✍️ Redactar ahora');
    generateButton.textContent = pendingCount > 0 ? `${label} (${pendingCount})` : label;
    generateButton.title = pendingCount > 0
      ? t('news.generate.pending', '{count} commit(s) sin redactar desde la última novedad', { count: pendingCount })
      : t('news.generate.hint', 'Redacta novedades a partir del progreso reciente');
  }

  function setJobStatus(html, tone = '') {
    jobStatus.hidden = false;
    jobStatus.className = `news-job${tone ? ` news-job--${tone}` : ''}`;
    jobStatus.innerHTML = html;
  }

  function scheduleJobPoll(id) {
    if (!isPanelAlive()) {
      teardown();
      return;
    }
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!isPanelAlive()) {
        teardown();
        return;
      }
      try {
        const job = await requestJson(`/api/news/job/${encodeURIComponent(id)}`);
        if (!isPanelAlive()) {
          teardown();
          return;
        }
        if (job.status === 'running') {
          scheduleJobPoll(id);
          return;
        }
        generating = false;
        resetGenerateButton();
        if (job.status === 'done') {
          setJobStatus(t('news.generate.done', '✅ Listo: se publicaron {count} novedades.', { count: Number(job.count) || 0 }), 'ok');
          openIds = null;
          await load();
          return;
        }
        setJobStatus(esc(job.error || t('news.generate.error', 'No se pudieron redactar las novedades.')), 'error');
      } catch (error) {
        if (!isPanelAlive()) {
          teardown();
          return;
        }
        generating = false;
        resetGenerateButton();
        setJobStatus(esc(error.message), 'error');
      }
    }, 2000);
  }

  generateButton?.addEventListener('click', async () => {
    if (generating) return;
    generating = true;
    generateButton.disabled = true;
    generateButton.innerHTML = `${pacman({ state: 'delegating', size: 'sm' })}<span>${t('news.generate.running', 'Redactando…')}</span>`;
    setJobStatus(`${pacman({ state: 'delegating', size: 'sm' })}<span>${t('news.generate.wait', 'Preparando novedades a partir de la versión nueva…')}</span>`);
    try {
      const job = await requestJson('/api/news/generate', { method: 'POST' });
      if (!job.id) throw new Error(t('news.generate.noJob', 'El servidor no devolvió el identificador del trabajo.'));
      scheduleJobPoll(job.id);
    } catch (error) {
      generating = false;
      resetGenerateButton();
      setJobStatus(esc(error.message), 'error');
    }
  });

  load();
}
