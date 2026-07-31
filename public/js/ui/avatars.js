// ui/avatars.js — avatares visuales estables para participantes del chat.
//
// Son siluetas SVG sólidas, no íconos de trazo como los de icons.js: a 22 px
// el detalle fino desaparece y un contorno relleno se reconoce mucho más rápido.

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_BOX = '0 0 24 24';

export const AVATAR_SHAPES = [
  'rombo',
  'triangulo',
  'hexagono',
  'estrella',
  'gota',
  'luna',
  'rayo',
  'cruz',
  'ancla',
  'hoja',
  'ola',
  'anillo',
];

export const AVATAR_TONES = ['peer-1', 'peer-2', 'peer-3', 'peer-4', 'peer-5', 'peer-6'];

// Figuras FIJADAS a un usuario, fuera de la rotación por hash. Van acá y no en
// AVATAR_SHAPES a propósito: sumar un elemento a ese array cambiaría el módulo
// del hash y le reasignaría el avatar a todos los usuarios existentes.
export const AVATAR_PINS = {
  rarboleda: 'fantasma',
};

// Cada figura privilegia una silueta distinta sobre detalles que se perderían
// al reducirla. Todos los nodos heredan currentColor de la clase peer-N.
const SHAPE_NODES = {
  rombo: { tag: 'polygon', attrs: { points: '12,2 22,12 12,22 2,12' } },
  triangulo: { tag: 'polygon', attrs: { points: '12,2 22,21 2,21' } },
  hexagono: { tag: 'polygon', attrs: { points: '7,2.5 17,2.5 22,12 17,21.5 7,21.5 2,12' } },
  estrella: { tag: 'polygon', attrs: { points: '12,1.8 14.8,8.2 21.8,8.9 16.5,13.5 18.1,20.5 12,16.8 5.9,20.5 7.5,13.5 2.2,8.9 9.2,8.2' } },
  gota: { tag: 'path', attrs: { d: 'M12 1.8C9.7 5.7 4.7 10.9 4.7 15.4a7.3 7.3 0 0 0 14.6 0C19.3 10.9 14.3 5.7 12 1.8Z' } },
  luna: { tag: 'path', attrs: { d: 'M19.7 17.2A9.2 9.2 0 1 1 10.1 2.8a7.5 7.5 0 0 0 9.6 14.4Z' } },
  rayo: { tag: 'polygon', attrs: { points: '13.6,1.5 4.5,13.1 10.7,13.1 9.7,22.5 19.5,9.7 13.2,9.7' } },
  cruz: { tag: 'polygon', attrs: { points: '8.5,2 15.5,2 15.5,8.5 22,8.5 22,15.5 15.5,15.5 15.5,22 8.5,22 8.5,15.5 2,15.5 2,8.5 8.5,8.5' } },
  ancla: { tag: 'path', attrs: { d: 'M12 1.8a3 3 0 0 1 1.5 5.6v2.4h2.7V7.7l4.5 4.1-4.5 4.1v-2.4h-2.7v5.2a7.2 7.2 0 0 0 5-4.7l3.1 1a10.2 10.2 0 0 1-19.2 0l3.1-1a7.2 7.2 0 0 0 5 4.7v-5.2H7.8v2.4l-4.5-4.1 4.5-4.1v2.1h2.7V7.4A3 3 0 0 1 12 1.8Zm0 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z', 'fill-rule': 'evenodd' } },
  hoja: { tag: 'path', attrs: { d: 'M21.5 2.5C12.3 2.8 5.3 6.1 3.2 12.2c-1 2.8.1 5.5 2.5 7.1L16 8.4 7.8 20.6c3.2.8 6.4-.4 8-3.1 2.7-4.5 3.1-9.3 5.7-15Z' } },
  ola: { tag: 'path', attrs: { d: 'M1.8 15.1c3.1-5.8 6.2-8.7 9.4-8.7 3.9 0 4.7 4.3 8.3 4.3 1 0 1.9-.3 2.7-.9-.9 5.1-3.6 7.8-7.2 7.8-3.7 0-5-3.2-8.1-3.2-1.7 0-3.4.8-5.1 2.4Z' } },
  anillo: { tag: 'path', attrs: { d: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z', 'fill-rule': 'evenodd' } },
  fantasma: { tag: 'path', attrs: { d: 'M3 21 V11 a9 9 0 0 1 18 0 v10 l-3 -2.5 -3 2.5 -3 -2.5 -3 2.5 -3 -2.5 -3 2.5 Z M9 8.4 a2 2.6 0 1 0 0.01 0 Z M15 8.4 a2 2.6 0 1 0 0.01 0 Z', 'fill-rule': 'evenodd' } },
};

// FNV-1a de 32 bits mantiene la asignación idéntica entre recargas. Si el hash
// cambiara, se perdería la identificación rápida que estos avatares aportan.
function hash32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function avatarFor(username, { taken = [] } = {}) {
  const safeUsername = typeof username === 'string' ? username : '';
  const hash = hash32(safeUsername);

  // Un pin manda sobre la rotación; el tono se sigue derivando del hash para
  // que conserve el color que ya tenía.
  const pinned = AVATAR_PINS[safeUsername];
  if (pinned && SHAPE_NODES[pinned]) {
    const tone = AVATAR_TONES[(hash >>> 8) % AVATAR_TONES.length];
    return { shape: pinned, tone, key: `${pinned}:${tone}` };
  }

  const originalShapeIndex = hash % AVATAR_SHAPES.length;
  const originalToneIndex = (hash >>> 8) % AVATAR_TONES.length;
  const occupied = new Set(Array.isArray(taken) ? taken : []);

  // El desempate es por sala: una coincidencia solo confunde dentro de la misma
  // conversación. El llamador aporta las keys ya usadas en esa sala concreta.
  for (let toneOffset = 0; toneOffset < AVATAR_TONES.length; toneOffset += 1) {
    const toneIndex = (originalToneIndex + toneOffset) % AVATAR_TONES.length;
    for (let shapeOffset = 0; shapeOffset < AVATAR_SHAPES.length; shapeOffset += 1) {
      const shapeIndex = (originalShapeIndex + shapeOffset) % AVATAR_SHAPES.length;
      const shape = AVATAR_SHAPES[shapeIndex];
      const tone = AVATAR_TONES[toneIndex];
      const key = `${shape}:${tone}`;
      if (!occupied.has(key)) return { shape, tone, key };
    }
  }

  // Las 72 combinaciones agotadas no justifican bloquear el render con un
  // bucle infinito: en ese caso extremo se conserva la asignación original.
  const shape = AVATAR_SHAPES[originalShapeIndex];
  const tone = AVATAR_TONES[originalToneIndex];
  return { shape, tone, key: `${shape}:${tone}` };
}

export function avatarNodeFrom(assignment, { size = 22, title = '' } = {}) {
  const px = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : 22;
  const span = document.createElement('span');
  const svg = document.createElementNS(SVG_NS, 'svg');
  const descriptor = SHAPE_NODES[assignment?.shape] || SHAPE_NODES[AVATAR_SHAPES[0]];
  const shape = document.createElementNS(SVG_NS, descriptor.tag);

  span.className = `cwc-avatar ${assignment?.tone || ''}`.trim();
  span.style.width = `${px}px`;
  span.style.height = `${px}px`;
  if (title) span.setAttribute('title', String(title));

  svg.setAttribute('viewBox', VIEW_BOX);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  shape.setAttribute('fill', 'currentColor');
  for (const [name, value] of Object.entries(descriptor.attrs)) {
    shape.setAttribute(name, value);
  }
  svg.append(shape);
  span.append(svg);

  return span;
}

export function avatarEl(username, { size = 22, taken = [], title = '' } = {}) {
  const avatar = avatarFor(username, { taken });
  return avatarNodeFrom(avatar, { size, title });
}
