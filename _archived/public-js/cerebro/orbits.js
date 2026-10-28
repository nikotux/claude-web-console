// Estas opciones de diagnóstico aíslan saturaciones vistas con GPU real, que la
// verificación headless con SwiftShader no reproduce; el controlador las obtiene
// una sola vez desde la URL y las entrega a este módulo.
import * as THREE from 'three';

// Tuning visual y orbital. El radio queda explícito porque el solapamiento entre
// sistemas cercanos es un compromiso visual aceptado y se corrige desde acá.
const ORBIT_RADIUS_SCALE = 2.7;
const ORBIT_RADIUS_STEP = 0.72;
const ORBIT_MIN_RADIUS = 22;
const ORBIT_ELLIPSE_RATIO = 0.72;
const ORBIT_SEGMENTS = 96;
const ORBIT_LINE_OPACITY = 0.18;
const ORBIT_REFERENCE_RADIUS = 30;
const ORBIT_ANGULAR_SPEED = 0.0005;
const THREE_RING_MIN_SATELLITES = 7;
const FOUR_RING_MIN_SATELLITES = 16;
const SYSTEM_TILT_MAX = Math.PI * 0.36;
const CORONA_TEXTURE_SIZE = 128;
const CORONA_SIZE_SCALE = 1.6;
const CORONA_OPACITY = 0.08;
const STAR_COUNT = 400;
const STAR_RADIUS_MIN = 1400;
const STAR_RADIUS_MAX = 2200;
const STAR_SIZE = 2.1;
const STAR_OPACITY = 0.6;
const STAR_BRIGHTNESS_MIN = 0.55;
const STAR_BRIGHTNESS_MAX = 1.25;
const TWO_PI = Math.PI * 2;

function stableHash(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableUnit(value) {
  return stableHash(value) / 4294967296;
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function refOf(endpoint) {
  return typeof endpoint === 'object' ? endpoint?.ref : endpoint;
}

function ringCountFor(satelliteCount) {
  if (satelliteCount >= FOUR_RING_MIN_SATELLITES) return 4;
  if (satelliteCount >= THREE_RING_MIN_SATELLITES) return 3;
  return 2;
}

function nodeRadius(node, nodeRelSize) {
  return nodeRelSize * Math.cbrt(Math.max(1, Number(node?.val) || 1));
}

function createSystemQuaternion(ref) {
  const tiltX = (stableUnit(`${ref}:tilt-x`) * 2 - 1) * SYSTEM_TILT_MAX;
  const tiltY = (stableUnit(`${ref}:tilt-y`) * 2 - 1) * SYSTEM_TILT_MAX;
  const azimuth = stableUnit(`${ref}:azimuth`) * TWO_PI;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, tiltY, azimuth));
}

function createOrbitLine(radius, color) {
  const positions = new Float32Array(ORBIT_SEGMENTS * 3);
  for (let i = 0; i < ORBIT_SEGMENTS; i++) {
    const angle = (i / ORBIT_SEGMENTS) * TWO_PI;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.sin(angle) * radius * ORBIT_ELLIPSE_RATIO;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: ORBIT_LINE_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.LineLoop(geometry, material);
}

function rgbaFromRgb(color, alpha) {
  const match = String(color).match(
    /^rgb\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)$/i,
  );
  if (!match) throw new Error(`Color de paleta no compatible con canvas: ${color}`);
  const components = match.slice(1).map(Number);
  return `rgba(${components[0]}, ${components[1]}, ${components[2]}, ${alpha})`;
}

function createCoronaTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = CORONA_TEXTURE_SIZE;
  canvas.height = CORONA_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const center = CORONA_TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, rgbaFromRgb(color, 1));
  gradient.addColorStop(0.2, rgbaFromRgb(color, 0.78));
  gradient.addColorStop(0.55, rgbaFromRgb(color, 0.22));
  gradient.addColorStop(1, rgbaFromRgb(color, 0));
  context.fillStyle = gradient;
  context.fillRect(0, 0, CORONA_TEXTURE_SIZE, CORONA_TEXTURE_SIZE);
  return new THREE.CanvasTexture(canvas);
}

function createStarField(palette, collectionSlugs) {
  const random = createSeededRandom(stableHash('cerebro:star-field'));
  const slugs = collectionSlugs.length ? collectionSlugs : ['--cwc-white'];
  const colors = slugs.map((slug) => new THREE.Color(palette.colorFor(slug)));
  const positions = new Float32Array(STAR_COUNT * 3);
  const pointColors = new Float32Array(STAR_COUNT * 3);

  for (let i = 0; i < STAR_COUNT; i++) {
    // Distribución uniforme sobre una cáscara: cos(theta) uniforme evita que
    // las estrellas se amontonen artificialmente en los polos.
    const zUnit = random() * 2 - 1;
    const azimuth = random() * TWO_PI;
    const radial = Math.sqrt(1 - zUnit * zUnit);
    const radius = STAR_RADIUS_MIN + random() * (STAR_RADIUS_MAX - STAR_RADIUS_MIN);
    positions[i * 3] = radial * Math.cos(azimuth) * radius;
    positions[i * 3 + 1] = radial * Math.sin(azimuth) * radius;
    positions[i * 3 + 2] = zUnit * radius;

    const color = colors[Math.floor(random() * colors.length)].clone();
    color.multiplyScalar(
      STAR_BRIGHTNESS_MIN + random() * (STAR_BRIGHTNESS_MAX - STAR_BRIGHTNESS_MIN),
    );
    pointColors[i * 3] = color.r;
    pointColors[i * 3 + 1] = color.g;
    pointColors[i * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3));
  const material = new THREE.PointsMaterial({
    size: STAR_SIZE,
    vertexColors: true,
    transparent: true,
    opacity: STAR_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

function buildAssignments(nodes, links) {
  const nodeByRef = new Map(nodes.map((node) => [node.ref, node]));
  const candidatesByMoon = new Map();

  for (const link of links) {
    const source = nodeByRef.get(refOf(link.source));
    const target = nodeByRef.get(refOf(link.target));
    if (!source || !target) continue;
    if (source.galaxyTier === 'sun' && target.galaxyTier === 'moon') {
      if (!candidatesByMoon.has(target.ref)) candidatesByMoon.set(target.ref, []);
      candidatesByMoon.get(target.ref).push(source);
    }
    if (target.galaxyTier === 'sun' && source.galaxyTier === 'moon') {
      if (!candidatesByMoon.has(source.ref)) candidatesByMoon.set(source.ref, []);
      candidatesByMoon.get(source.ref).push(target);
    }
  }

  const satellitesBySun = new Map();
  for (const [moonRef, candidates] of candidatesByMoon) {
    // Un satélite compartido pertenece al sol de mayor grado: así el sistema
    // más conectado conserva su estructura. El ref rompe empates de modo estable.
    candidates.sort((a, b) => (
      (Number(b.degree) || 0) - (Number(a.degree) || 0)
      || String(a.ref).localeCompare(String(b.ref))
    ));
    const sun = candidates[0];
    if (!satellitesBySun.has(sun.ref)) satellitesBySun.set(sun.ref, []);
    satellitesBySun.get(sun.ref).push(nodeByRef.get(moonRef));
  }
  return satellitesBySun;
}

// API pública: el controlador conserva un solo campo estelar y una sola textura
// de corona. rebuild() reemplaza sistemas; tick() avanza sus satélites; dispose()
// libera absolutamente todos los recursos Three creados por este módulo.
export function createOrbitalScene({
  scene,
  palette,
  nodeRelSize,
  colorForNode,
  disableCorona = false,
  disableStars = false,
  disableOrbits = false,
}) {
  let systems = [];
  let orbitingCount = 0;
  let starField = null;
  let coronaTexture = null;
  let speedMultiplier = 1;
  let orbitalTimeMs = null;
  let previousTickMs = null;
  const scratchPosition = new THREE.Vector3();

  function setSpeedMultiplier(value) {
    const numericValue = Number(value);
    speedMultiplier = Number.isFinite(numericValue)
      ? Math.min(3, Math.max(0, numericValue))
      : 1;
  }

  function clearSystems() {
    for (const system of systems) {
      // El layout es híbrido: solo las lunas se fijan; liberarlas acá permite
      // que d3-force vuelva a gobernarlas si cambian de tier o sistema.
      for (const orbit of system.orbits) {
        orbit.node.fx = null;
        orbit.node.fy = null;
        orbit.node.fz = null;
      }
      if (system.group) scene.remove(system.group);
      for (const ring of system.rings) {
        ring.geometry.dispose();
        ring.material.dispose();
      }
      if (system.corona) {
        scene.remove(system.corona);
        system.corona.material.dispose();
      }
    }
    // Vaciar el array elimina también referencias a nodos que ya no existen;
    // no hay timers propios que puedan sobrevivir a un repintado.
    systems = [];
    orbitingCount = 0;
  }

  function rebuild({ nodes = [], links = [] }) {
    clearSystems();

    if (!disableStars && !starField) {
      const slugs = [...new Set(nodes.map((node) => node.collection).filter(Boolean))];
      starField = createStarField(palette, slugs);
      scene.add(starField);
    }
    if (!disableCorona && !coronaTexture) {
      coronaTexture = createCoronaTexture(palette.colorFor('--cwc-white'));
    }

    if (disableOrbits) {
      for (const node of nodes) {
        node.fx = null;
        node.fy = null;
        node.fz = null;
      }
    }

    const satellitesBySun = disableOrbits ? new Map() : buildAssignments(nodes, links);
    const suns = nodes.filter((node) => node.galaxyTier === 'sun');
    for (const sun of suns) {
      const satellites = satellitesBySun.get(sun.ref) || [];
      const ringCount = ringCountFor(satellites.length);
      const solarRadius = nodeRadius(sun, nodeRelSize);
      const baseOrbitRadius = Math.max(ORBIT_MIN_RADIUS, solarRadius * ORBIT_RADIUS_SCALE);
      const quaternion = createSystemQuaternion(sun.ref);
      const group = disableOrbits ? null : new THREE.Group();
      group?.quaternion.copy(quaternion);
      const rings = [];
      const ringBuckets = Array.from({ length: ringCount }, () => []);
      satellites.forEach((satellite, index) => ringBuckets[index % ringCount].push(satellite));

      if (group) {
        for (let ringIndex = 0; ringIndex < ringCount; ringIndex++) {
          const radius = baseOrbitRadius * (1 + ringIndex * ORBIT_RADIUS_STEP);
          const ring = createOrbitLine(radius, colorForNode(sun));
          group.add(ring);
          rings.push(ring);
        }
        scene.add(group);
      }

      let corona = null;
      if (!disableCorona) {
        const coronaMaterial = new THREE.SpriteMaterial({
          map: coronaTexture,
          color: colorForNode(sun),
          transparent: true,
          opacity: CORONA_OPACITY,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        corona = new THREE.Sprite(coronaMaterial);
        corona.scale.setScalar(solarRadius * CORONA_SIZE_SCALE);
        scene.add(corona);
      }

      const orbits = [];
      for (let ringIndex = 0; ringIndex < ringBuckets.length; ringIndex++) {
        const bucket = ringBuckets[ringIndex];
        const radius = baseOrbitRadius * (1 + ringIndex * ORBIT_RADIUS_STEP);
        const angularSpeed = ORBIT_ANGULAR_SPEED
          * Math.pow(ORBIT_REFERENCE_RADIUS / radius, 1.5);
        const ringPhase = stableUnit(`${sun.ref}:ring:${ringIndex}`) * TWO_PI;
        bucket.forEach((node, index) => {
          orbits.push({
            node,
            radius,
            angularSpeed,
            phase: ringPhase + (index / bucket.length) * TWO_PI,
          });
        });
      }

      orbitingCount += orbits.length;
      if (group || corona) systems.push({ sun, group, rings, corona, quaternion, orbits });
    }
    return orbitingCount;
  }

  function tick(nowMs) {
    if (orbitalTimeMs === null) orbitalTimeMs = nowMs;
    if (previousTickMs === null) previousTickMs = nowMs;
    const elapsedMs = Math.max(0, nowMs - previousTickMs);
    previousTickMs = nowMs;
    orbitalTimeMs += elapsedMs * speedMultiplier;

    for (const system of systems) {
      // Evitar objetos temporales en el hot path mantiene estable el GC aun
      // cuando la pestaña queda abierta durante horas.
      const centerX = Number.isFinite(system.sun.x) ? system.sun.x : 0;
      const centerY = Number.isFinite(system.sun.y) ? system.sun.y : 0;
      const centerZ = Number.isFinite(system.sun.z) ? system.sun.z : 0;
      system.group?.position.set(centerX, centerY, centerZ);
      system.corona?.position.set(centerX, centerY, centerZ);

      for (const orbit of system.orbits) {
        const angle = orbit.phase + orbitalTimeMs * orbit.angularSpeed;
        scratchPosition.set(
          Math.cos(angle) * orbit.radius,
          Math.sin(angle) * orbit.radius * ORBIT_ELLIPSE_RATIO,
          0,
        ).applyQuaternion(system.quaternion);
        const x = centerX + scratchPosition.x;
        const y = centerY + scratchPosition.y;
        const z = centerZ + scratchPosition.z;
        // fx/fy/fz sacan la luna del movimiento libre de d3-force. Escribir
        // x/y/z no alcanza si la simulación se detuvo: three-forcegraph deja de
        // copiar esas coordenadas al objeto Three y de recalcular sus aristas.
        // cerebro.js mantiene ese ciclo activo para sincronizar ambos en cada frame.
        orbit.node.x = orbit.node.fx = x;
        orbit.node.y = orbit.node.fy = y;
        orbit.node.z = orbit.node.fz = z;
      }
    }
  }

  function dispose() {
    clearSystems();
    if (starField) {
      scene.remove(starField);
      starField.geometry.dispose();
      starField.material.dispose();
      starField = null;
    }
    coronaTexture?.dispose();
    coronaTexture = null;
  }

  return {
    rebuild,
    tick,
    setSpeedMultiplier,
    dispose,
    get orbitingCount() { return orbitingCount; },
  };
}
