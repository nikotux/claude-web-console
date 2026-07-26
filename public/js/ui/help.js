// ui/help.js — sistema unificado de ayudas contextuales de la consola.
//
// Provee el botón "?" estándar, un listener delegado para contenido dinámico,
// el render de temas y el hub general. Cada tema se carga bajo demanda desde
// help-index.js y cualquier ausencia o fallo degrada a un aviso propio.
import { openModal } from './dialog.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { HELP_GROUPS, HELP_INDEX } from './help-index.js';

const boundRoots = new WeakSet();
const topicModules = new Map();
const isMobile = () => matchMedia('(max-width: 719px)').matches;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

export function helpBtn(topicId, { size = 15, label = null, cls = '' } = {}) {
  const title = t('core.help.btnTitle', 'Ayuda de esta sección');
  const labeled = label !== null;
  const classes = `btn-ghost btn--sm${labeled ? ' hlp-btn--labeled' : ' btn--icon'} hlp-btn${cls ? ` ${escapeHtml(cls)}` : ''}`;
  const content = `${icon('help', { size })}${labeled ? `<span>${escapeHtml(label)}</span>` : ''}`;
  return `<button type="button" class="${classes}" data-help="${escapeHtml(topicId)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${content}</button>`;
}

export function bindHelp(root = document) {
  if (!root?.addEventListener || boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-help]');
    if (!el) return;
    e.preventDefault();
    // El "?" puede vivir en headers o tarjetas clickeables; no debe activar su acción.
    e.stopPropagation();
    void openHelp(el.dataset.help);
  });
}

function openMissingHelp() {
  const m = openModal({ title: t('core.help.title', 'Ayuda'), width: 420 });
  const message = document.createElement('p');
  message.className = 'hlp-p';
  message.textContent = t('core.help.missing', 'Todavía no hay ayuda para esta sección.');
  m.body.appendChild(message);
}

function renderBlock(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'p') {
    const text = block.raw ? String(block.text ?? '') : escapeHtml(block.text);
    return `<p class="hlp-p">${text}</p>`;
  }
  if (block.type === 'steps') {
    const items = Array.isArray(block.items) ? block.items : [];
    return `<ol class="hlp-steps">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`;
  }
  if (block.type === 'legend') {
    const items = Array.isArray(block.items) ? block.items : [];
    return items.map((item) => {
      const visual = item?.icon ? icon(item.icon, { size: 13 }) : escapeHtml(item?.emoji);
      return `<div class="hlp-leg"><span class="hlp-leg-ic">${visual}</span><b>${escapeHtml(item?.name)}</b><span>${escapeHtml(item?.desc)}</span></div>`;
    }).join('');
  }
  if (block.type === 'kv') {
    const items = Array.isArray(block.items) ? block.items : [];
    return items.map((item) => `<div class="hlp-kv"><b>${escapeHtml(item?.k)}</b><span>${escapeHtml(item?.v)}</span></div>`).join('');
  }
  if (block.type === 'note') {
    const tone = ['info', 'warn', 'danger'].includes(block.tone) ? block.tone : 'info';
    const text = block.raw ? String(block.text ?? '') : escapeHtml(block.text);
    return `<div class="hlp-note hlp-note--${tone}">${text}</div>`;
  }
  if (block.type === 'html') return String(block.html ?? '');
  return '';
}

function balanceColumns(root) {
  try {
    const grid = root.querySelector('.hlp-grid');
    if (!grid || isMobile()) return;
    const secs = [...grid.children];
    if (secs.length < 3) return;

    // Las secciones de ancho completo cortan el flujo y separan los grupos.
    const groups = [];
    let cur = [];
    for (const s of secs) {
      if (s.classList.contains('hlp-sec--wide')) {
        if (cur.length) groups.push(cur);
        groups.push([s]);
        cur = [];
      } else {
        cur.push(s);
      }
    }
    if (cur.length) groups.push(cur);

    // Medimos todas las alturas antes de mover nodos: una sola lectura de layout.
    const h = new Map(secs.map((s) => [s, s.getBoundingClientRect().height]));
    grid.classList.add('hlp-grid--balanced');
    grid.textContent = '';
    for (const g of groups) {
      if (g.length === 1 && g[0].classList.contains('hlp-sec--wide')) {
        grid.appendChild(g[0]);
        continue;
      }
      const wrap = document.createElement('div');
      wrap.className = 'hlp-cols';
      const a = document.createElement('div');
      a.className = 'hlp-col';
      const b = document.createElement('div');
      b.className = 'hlp-col';
      wrap.append(a, b);
      let ha = 0;
      let hb = 0;
      for (const s of g) {
        // Greedy: cada sección va a la columna que hasta ahora es más corta.
        if (ha <= hb) {
          a.appendChild(s);
          ha += h.get(s) || 0;
        } else {
          b.appendChild(s);
          hb += h.get(s) || 0;
        }
      }
      if (!b.children.length) b.remove();
      grid.appendChild(wrap);
    }
  } catch (err) {
    console.warn('[help] no se pudo balancear columnas; queda el layout CSS.', err);
  }
}

/*
 * Contrato de un tema de ayuda:
 * {
 *   title: 'Sesiones',            // string ya pasado por t()
 *   icon: 'terminal',             // nombre de icons.js (opcional)
 *   intro: 'Qué es, en 2 líneas', // ocupa todo el ancho arriba del grid
 *   sections: [
 *     {
 *       title: 'Primeros pasos',
 *       icon: 'plus',             // ícono opcional del summary
 *       wide: false,              // true ocupa todo el ancho del grid
 *       blocks: [
 *         { type: 'p', text, raw?: false },
 *         { type: 'steps', items: ['…'] },
 *         { type: 'legend', items: [{ icon?, emoji?, name, desc }] },
 *         { type: 'kv', items: [{ k, v }] },
 *         { type: 'note', tone: 'info'|'warn'|'danger', text, raw?: false },
 *         { type: 'html', html },
 *       ],
 *     },
 *   ],
 * }
 *
 * Todo el texto se escapa salvo `html`, que es un escape hatch deliberado.
 * Los bloques `p` y `note` aceptan `raw: true` para permitir markup confiable
 * como <b> o <code>; quien define el tema es responsable de ese HTML.
 */
function renderTopic(topic, modal) {
  const sections = Array.isArray(topic?.sections) ? topic.sections : [];
  const intro = typeof topic?.intro === 'string' ? topic.intro.trim() : '';
  modal.body.innerHTML = `
    <div class="hlp">
      ${intro ? `<p class="hlp-intro">${escapeHtml(intro)}</p>` : ''}
      <div class="hlp-grid">
        ${sections.map((section) => `
          <details class="hlp-sec${section?.wide ? ' hlp-sec--wide' : ''}"${isMobile() ? '' : ' open'}>
            <summary class="hlp-sec-title">${section?.icon ? `<span class="hlp-sec-ic">${icon(section.icon, { size: 14 })}</span>` : ''}<span>${escapeHtml(section?.title)}</span></summary>
            <div class="hlp-sec-body">${(Array.isArray(section?.blocks) ? section.blocks : []).map(renderBlock).join('')}</div>
          </details>`).join('')}
      </div>
      <div class="hlp-foot">
        <button type="button" class="btn-ghost btn--sm" data-ref="all">${escapeHtml(t('core.help.seeAll', 'Ver toda la guía de la consola'))}</button>
      </div>
    </div>`;
  modal.body.querySelector('[data-ref="all"]')?.addEventListener('click', () => {
    modal.close();
    openHelpIndex();
  });
  // Balanceo de columnas en 2 pasadas: el multicol del navegador llena en orden
  // y no puede partir una sección (break-inside: avoid), así que con alturas
  // dispares deja huecos muertos. Acá medimos el alto REAL ya renderizado y
  // repartimos cada sección a la columna más corta. Mejora progresiva: si algo
  // falla, queda el layout multicolumna de CSS, que igual es usable.
  balanceColumns(modal.body);
}

export async function openHelp(topicId) {
  const id = String(topicId ?? '');
  const entry = HELP_INDEX.find((item) => item.id === id);
  if (!entry) {
    openMissingHelp();
    return;
  }

  let loaded;
  try {
    loaded = topicModules.get(id);
    if (!loaded) {
      loaded = await entry.load();
      topicModules.set(id, loaded);
    }
    if (typeof loaded?.default !== 'function') throw new TypeError(`El tema "${id}" no exporta una función default.`);
  } catch (err) {
    console.warn(`[help] No se pudo cargar el tema "${id}".`, err);
    openMissingHelp();
    return;
  }

  let topic;
  try {
    topic = loaded.default();
  } catch (err) {
    console.warn(`[help] No se pudo construir el tema "${id}".`, err);
    openMissingHelp();
    return;
  }

  const title = String(topic?.title || entry.title);
  const modal = openModal({ title, width: 860 });
  try {
    if (topic?.icon && typeof modal.setTitle === 'function') {
      modal.setTitle(title);
      const titleEl = modal.card.querySelector('.dlg-title');
      if (titleEl) {
        titleEl.classList.add('hlp-modal-title');
        titleEl.innerHTML = `${icon(topic.icon, { size: 16 })}<span>${escapeHtml(title)}</span>`;
      }
    }
    renderTopic(topic, modal);
  } catch (err) {
    modal.close();
    console.warn(`[help] No se pudo renderizar el tema "${id}".`, err);
    openMissingHelp();
  }
}

export function openHelpIndex() {
  const modal = openModal({ title: t('core.help.indexTitle', 'Guía de la consola'), width: 860 });
  modal.body.innerHTML = `
    <div class="hlp-idx">
      <p class="hlp-intro">${escapeHtml(t('core.help.indexIntro', 'Encontrá una explicación rápida de cada parte de la consola.'))}</p>
      ${HELP_GROUPS.map((group) => {
        const topics = HELP_INDEX.filter((item) => item.group === group.id);
        return `
          <div class="hlp-idx-group">
            <div class="hlp-idx-gtitle">${escapeHtml(group.title)}</div>
            <div class="hlp-idx-cards">
              ${topics.map((item) => `
                <button type="button" class="hlp-idx-card" data-topic="${escapeHtml(item.id)}">
                  <span class="hlp-idx-ic">${icon(item.icon, { size: 17 })}</span>
                  <span class="hlp-idx-t">${escapeHtml(item.title)}</span>
                  <span class="hlp-idx-b">${escapeHtml(item.blurb)}</span>
                </button>`).join('')}
            </div>
          </div>`;
      }).join('')}
    </div>`;
  modal.body.querySelector('.hlp-idx')?.addEventListener('click', (e) => {
    const card = e.target?.closest?.('[data-topic]');
    if (!card) return;
    modal.close();
    void openHelp(card.dataset.topic);
  });
}
