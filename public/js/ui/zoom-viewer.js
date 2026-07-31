// ui/zoom-viewer.js — visor modal genérico con zoom y paneo.
//
// La geometría se resuelve acá y no en el contenido para que SVG, imágenes y
// futuros nodos compartan exactamente las mismas interacciones.
import { openModal } from './dialog.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export function openZoomViewer({ title = '', node, onClose = null } = {}) {
  const pointers = new Map();
  let pinch = null;
  let observer = null;

  const modal = openModal({
    title,
    width: 'min(96vw, 1400px)',
    onClose: () => {
      // El observer sí sobrevive al árbol observado; desconectarlo evita que el
      // visor cerrado conserve referencias al contenido pesado.
      observer?.disconnect();
      pointers.clear();
      onClose?.();
    },
  });
  modal.card.classList.add('zv-card');
  modal.body.classList.add('zv-body');

  const bar = document.createElement('div');
  bar.className = 'zv-bar';

  const outButton = document.createElement('button');
  outButton.className = 'btn-ghost btn--sm btn--icon zv-btn-out';
  outButton.type = 'button';
  outButton.title = t('core.zoom.out', 'Alejar');
  outButton.setAttribute('aria-label', t('core.zoom.out', 'Alejar'));
  outButton.innerHTML = icon('minus', { size: 15 });

  const percentButton = document.createElement('button');
  percentButton.className = 'btn-ghost btn--sm zv-pct';
  percentButton.type = 'button';
  percentButton.title = t('core.zoom.reset', 'Tamaño real (100%)');
  percentButton.setAttribute('aria-label', t('core.zoom.reset', 'Tamaño real (100%)'));
  percentButton.textContent = '100%';

  const inButton = document.createElement('button');
  inButton.className = 'btn-ghost btn--sm btn--icon zv-btn-in';
  inButton.type = 'button';
  inButton.title = t('core.zoom.in', 'Acercar');
  inButton.setAttribute('aria-label', t('core.zoom.in', 'Acercar'));
  inButton.innerHTML = icon('plus', { size: 15 });

  const fitButton = document.createElement('button');
  fitButton.className = 'btn-ghost btn--sm zv-btn-fit';
  fitButton.type = 'button';
  fitButton.title = t('core.zoom.fitTitle', 'Ajustar a la ventana');
  fitButton.setAttribute('aria-label', t('core.zoom.fitTitle', 'Ajustar a la ventana'));
  fitButton.innerHTML = icon('maximize', { size: 14 });
  const fitLabel = document.createElement('span');
  fitLabel.textContent = t('core.zoom.fit', 'Ajustar');
  fitButton.appendChild(fitLabel);
  bar.append(outButton, percentButton, inButton, fitButton);

  const viewport = document.createElement('div');
  viewport.className = 'zv-viewport';
  viewport.tabIndex = 0;
  const stage = document.createElement('div');
  stage.className = 'zv-stage';
  // Toda la matemática usa la esquina superior izquierda; dejar el origen al
  // default central haría derivar el punto focal en cada zoom.
  stage.style.transformOrigin = '0 0';
  stage.appendChild(node);
  viewport.appendChild(stage);

  const hint = document.createElement('div');
  hint.className = 'zv-hint';
  hint.textContent = t('core.zoom.hint', 'Arrastrá para navegar · rueda o pinch para acercar · doble click para ajustar');
  modal.body.append(bar, viewport, hint);

  let natW = 0;
  let natH = 0;
  const isSvg = node.tagName?.toLowerCase() === 'svg';
  if (isSvg) {
    const viewBox = node.viewBox?.baseVal;
    if (viewBox && Number.isFinite(viewBox.width) && viewBox.width > 0
      && Number.isFinite(viewBox.height) && viewBox.height > 0) {
      natW = viewBox.width;
      natH = viewBox.height;
    }
  }
  if (!(natW > 0 && natH > 0)) {
    const rect = node.getBoundingClientRect();
    natW = Number.isFinite(rect.width) ? rect.width : 0;
    natH = Number.isFinite(rect.height) ? rect.height : 0;
  }

  // Mermaid suele imponer max-width inline; fijar ambas dimensiones elimina
  // esa segunda fuente de escala y deja una sola transformación predecible.
  node.style.width = natW + 'px';
  node.style.height = natH + 'px';
  node.style.maxWidth = '';
  node.style.minWidth = '';
  node.style.maxHeight = '';

  let k = 1;
  let tx = 0;
  let ty = 0;
  let fitScale = 1;
  let minScale = 0.25;
  let maxScale = 8;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function apply() {
    k = clamp(k, minScale, maxScale);
    stage.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + k + ')';
    percentButton.textContent = Math.round(k * 100) + '%';
  }

  function clampPan() {
    const vp = viewport.getBoundingClientRect();
    const scaledW = natW * k;
    const scaledH = natH * k;

    if (scaledW < vp.width) tx = (vp.width - scaledW) / 2;
    else tx = clamp(tx, vp.width - scaledW - 40, 40);

    if (scaledH < vp.height) ty = (vp.height - scaledH) / 2;
    else ty = clamp(ty, vp.height - scaledH - 40, 40);
  }

  function fit() {
    const vp = viewport.getBoundingClientRect();
    // Además de evitar divisiones inválidas, conservar k=1 permite que un nodo
    // todavía sin tamaño siga siendo visible cuando su propio layout despierte.
    if (!(natW > 0 && natH > 0 && vp.width > 0 && vp.height > 0)) {
      k = 1;
      apply();
      return;
    }

    k = Math.min(vp.width / natW, vp.height / natH) * 0.98;
    fitScale = k;
    minScale = Math.min(fitScale, 1) * 0.25;
    maxScale = Math.max(fitScale, 1) * 8;
    k = clamp(k, minScale, maxScale);
    tx = (vp.width - natW * k) / 2;
    ty = (vp.height - natH * k) / 2;
    clampPan();
    apply();
  }

  function zoomAt(factor, cx, cy) {
    const next = clamp(k * factor, minScale, maxScale);
    const real = next / k;
    tx = cx - (cx - tx) * real;
    ty = cy - (cy - ty) * real;
    k = next;
    clampPan();
    apply();
  }

  function viewportCenter() {
    const vp = viewport.getBoundingClientRect();
    return { x: vp.width / 2, y: vp.height / 2 };
  }

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 400;
    const vp = viewport.getBoundingClientRect();
    zoomAt(Math.exp(-delta * 0.0015), e.clientX - vp.left, e.clientY - vp.top);
  }, { passive: false });

  function pointerGeometry() {
    const [a, b] = [...pointers.values()];
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  }

  viewport.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('zv-dragging');
    pinch = pointers.size === 2 ? pointerGeometry() : null;
  });

  viewport.addEventListener('pointermove', (e) => {
    const previous = pointers.get(e.pointerId);
    if (!previous) return;

    if (pointers.size === 1) {
      tx += e.clientX - previous.x;
      ty += e.clientY - previous.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      clampPan();
      apply();
      return;
    }

    if (pointers.size === 2) {
      const before = pinch || pointerGeometry();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = pointerGeometry();
      const vp = viewport.getBoundingClientRect();
      if (before.distance > 0 && after.distance > 0) {
        zoomAt(after.distance / before.distance, before.x - vp.left, before.y - vp.top);
      }
      // El centroide aporta traslación independiente del cambio de escala, como
      // en un mapa táctil: los dos dedos pueden pellizcar y navegar a la vez.
      tx += after.x - before.x;
      ty += after.y - before.y;
      clampPan();
      apply();
      pinch = after;
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    pinch = pointers.size === 2 ? pointerGeometry() : null;
    if (pointers.size === 0) viewport.classList.remove('zv-dragging');
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  viewport.addEventListener('dblclick', (e) => {
    const vp = viewport.getBoundingClientRect();
    const nearFit = fitScale > 0 && Math.abs(k - fitScale) / fitScale < 0.05;
    if (nearFit) zoomAt(2 / k, e.clientX - vp.left, e.clientY - vp.top);
    else fit();
  });

  outButton.addEventListener('click', () => {
    const center = viewportCenter();
    zoomAt(1 / 1.25, center.x, center.y);
  });
  inButton.addEventListener('click', () => {
    const center = viewportCenter();
    zoomAt(1.25, center.x, center.y);
  });
  percentButton.addEventListener('click', () => {
    const center = viewportCenter();
    zoomAt(1 / k, center.x, center.y);
  });
  fitButton.addEventListener('click', fit);

  viewport.addEventListener('keydown', (e) => {
    const center = viewportCenter();
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomAt(1.25, center.x, center.y);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomAt(1 / 1.25, center.x, center.y);
    } else if (e.key === '0') {
      e.preventDefault();
      fit();
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 200 : 60;
      if (e.key === 'ArrowLeft') tx += step;
      else if (e.key === 'ArrowRight') tx -= step;
      else if (e.key === 'ArrowUp') ty += step;
      else if (e.key === 'ArrowDown') ty -= step;
      clampPan();
      apply();
    }
  });

  observer = new ResizeObserver(() => {
    const wasFit = fitScale > 0 && Math.abs(k - fitScale) / fitScale < 0.01;
    if (wasFit) fit();
    else {
      clampPan();
      apply();
    }
  });
  observer.observe(viewport);

  requestAnimationFrame(() => {
    fit();
    viewport.focus({ preventScroll: true });
  });

  return { modal, fit, close: modal.close };
}
