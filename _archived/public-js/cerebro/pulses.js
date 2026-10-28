// El motor toca únicamente objetos Three ya creados por three-forcegraph. No
// importa Three: así conserva una sola copia de la librería y de sus materiales.

// Tuning de pulsos reales.
const PULSE_MS = 1400;
const CLUSTER_MS = 1100;
const PULSE_DECAY_POWER = 3;
const REAL_PULSE_INTENSITY = 0.9;
const REAL_STRONG_PULSE_INTENSITY = 1.35;
const PULSE_SCALE_BOOST = 1.4;
const COLLECTION_INTENSITY = 0.7;
const REAL_ROOT_PARTICLE_EDGES = 12;

// Tuning de la corriente y la respiración ambientales.
const AMBIENT_PARTICLES_PER_SECOND = 20;
const AMBIENT_PARTICLE_INTERVAL_JITTER = 0.35;
const AMBIENT_BURST_MIN_EDGES = 2;
const AMBIENT_BURST_MAX_EDGES = 4;
const AMBIENT_BURST_STEP_MIN_MS = 70;
const AMBIENT_BURST_STEP_MAX_MS = 110;
const AMBIENT_BURST_RETRY_MS = 50;
const MAX_AMBIENT_BURSTS = 3;
const NODE_BREATH_PERIOD_MS = 5200;
const NODE_BREATH_SCALE_AMPLITUDE = 0.03;
const AMBIENT_LIGHT_PERIOD_MS = 10000;
const AMBIENT_LIGHT_INTENSITY_AMPLITUDE = 0.07;

// Tuning de la cascada de eventos reales.
const CASCADE_HOPS = 3;
const CASCADE_NEIGHBORS_PER_NODE = 8;
const CASCADE_MAX_NODES = 40;
const CASCADE_HOP_DELAY_MIN_MS = 90;
const CASCADE_HOP_DELAY_MAX_MS = 140;
const CASCADE_INTENSITY_FALLOFF = 0.52;
const CASCADE_PULSE_MS = 1050;
const REAL_EDGE_PARTICLE_COUNT = 3;
const REAL_TRAIL_STEP_MIN_MS = 35;
const REAL_TRAIL_STEP_MAX_MS = 48;

// Tuning del relámpago ambiental: siempre queda muy por debajo del evento real.
const DISTANT_LIGHTNING_MIN_MS = 1800;
const DISTANT_LIGHTNING_MAX_MS = 4500;
const DISTANT_LIGHTNING_INTENSITY = 0.24;
const DISTANT_LIGHTNING_PULSE_MS = 800;
const DISTANT_LIGHTNING_HOPS = 2;
const DISTANT_LIGHTNING_NEIGHBORS_PER_NODE = 4;
const DISTANT_LIGHTNING_MAX_NODES = 14;
const DISTANT_LIGHTNING_ROOT_PARTICLE_EDGES = 4;
const DISTANT_LIGHTNING_HUB_CANDIDATES = 24;
const DISTANT_LIGHTNING_SECOND_FOCUS_CHANCE = 0.5;
const DISTANT_LIGHTNING_SECOND_FOCUS_MIN_DELAY_MS = 250;
const DISTANT_LIGHTNING_SECOND_FOCUS_MAX_DELAY_MS = 450;
const DISTANT_LIGHTNING_EDGE_PARTICLE_COUNT = 2;
const DISTANT_LIGHTNING_TRAIL_STEP_MIN_MS = 48;
const DISTANT_LIGHTNING_TRAIL_STEP_MAX_MS = 60;

const AMBIENT_PRIORITY = 1;
const REAL_EVENT_PRIORITY = 2;
const MAX_LIVE_TIMERS = 160;
const TWO_PI = Math.PI * 2;

export function createPulseEngine({ graph, nodeByRef, linksByRef, palette }) {
  let nodes = nodeByRef || new Map();
  let links = linksByRef || new Map();
  let allLinks = [];
  let ambientStartLinks = [];
  let outgoingLinksByRef = new Map();
  let breathingNodes = [];
  let lightningHubRefs = [];
  const activeNodes = new Map();
  const activeCollections = new Map();
  const cascadeTimers = new Set();
  const timerMetadata = new Map();
  let ambientLights = null;
  let nextAmbientParticleAt = 0;
  let nextDistantLightningAt = 0;
  let activeAmbientBursts = 0;

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function randomInteger(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function shuffledSample(items, limit) {
    const sample = items.slice();
    for (let i = 0; i < Math.min(limit, sample.length); i++) {
      const j = i + Math.floor(Math.random() * (sample.length - i));
      [sample[i], sample[j]] = [sample[j], sample[i]];
    }
    return sample.slice(0, limit);
  }

  function refOf(endpoint) {
    return typeof endpoint === 'object' ? endpoint?.ref : endpoint;
  }

  function stablePhase(ref) {
    const value = String(ref ?? '');
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) / 4294967296) * TWO_PI;
  }

  function rebuildGraphCaches() {
    // Cada arista aparece en uno o dos buckets de linksByRef. Deducir por
    // identidad preserva exactamente el objeto que emitParticle espera.
    const uniqueLinks = new Set();
    for (const nodeLinks of links.values()) {
      for (const link of nodeLinks || []) uniqueLinks.add(link);
    }
    allLinks = [...uniqueLinks];

    // El recorrido ambiente necesita continuidad dirigida. Esta caché se arma
    // sólo al cambiar el grafo; cada ráfaga después consulta a lo sumo 4 aristas.
    outgoingLinksByRef = new Map();
    for (const link of allLinks) {
      const source = refOf(link.source);
      const target = refOf(link.target);
      if (source == null || target == null || source === target) continue;
      if (!outgoingLinksByRef.has(source)) outgoingLinksByRef.set(source, []);
      outgoingLinksByRef.get(source).push(link);
    }
    ambientStartLinks = allLinks.filter((link) => {
      const target = refOf(link.target);
      return (outgoingLinksByRef.get(target)?.length || 0) > 0;
    });

    // La fase sí es por nodo, pero se anima scale: los materiales se cachean
    // por color y mutarlos haría respirar juntos a cientos de nodos. Clonarlos
    // a todos costaría memoria y GPU; scale ya pertenece a cada objeto Three.
    breathingNodes = [...nodes.entries()].map(([ref, node]) => ({
      ref,
      node,
      phase: stablePhase(ref),
    }));

    lightningHubRefs = [...nodes.keys()]
      .filter((ref) => (links.get(ref)?.length || 0) > 0)
      .sort((a, b) => (links.get(b)?.length || 0) - (links.get(a)?.length || 0))
      .slice(0, DISTANT_LIGHTNING_HUB_CANDIDATES);
  }

  function cancelTrackedTimer(timer) {
    const metadata = timerMetadata.get(timer);
    window.clearTimeout(timer);
    cascadeTimers.delete(timer);
    timerMetadata.delete(timer);
    metadata?.onCancel?.();
  }

  function scheduleTrackedTimer(callback, delayMs, priority, onCancel) {
    if (cascadeTimers.size >= MAX_LIVE_TIMERS) {
      // Los timers ambientales son descartables: nunca pueden impedir que se
      // programe la estela o la propagación de un evento real.
      if (priority >= REAL_EVENT_PRIORITY) {
        const ambientTimer = [...cascadeTimers]
          .find((timer) => timerMetadata.get(timer)?.priority < priority);
        if (ambientTimer) cancelTrackedTimer(ambientTimer);
      }
      if (cascadeTimers.size >= MAX_LIVE_TIMERS) return null;
    }

    const timer = window.setTimeout(() => {
      cascadeTimers.delete(timer);
      timerMetadata.delete(timer);
      callback();
    }, delayMs);
    cascadeTimers.add(timer);
    timerMetadata.set(timer, { priority, onCancel });
    return timer;
  }

  function restoreNode(state) {
    const obj = state?.obj;
    if (!obj?.__cerBase || !obj.material) return;
    obj.material.dispose();
    obj.material = obj.__cerBase;
    obj.__cerBase = null;
    obj.scale.setScalar(1);
  }

  function restoreCollection(state) {
    for (const entry of state?.materials?.values?.() || []) {
      entry.material?.emissive?.setRGB(entry.emissive.r, entry.emissive.g, entry.emissive.b);
    }
  }

  function activateNode(ref, { intensity, durationMs, priority }) {
    const node = nodes.get(ref);
    const obj = node?.__threeObj;
    if (!obj?.material) return false;

    const now = performance.now();
    let state = activeNodes.get(ref);
    if (!state || state.obj !== obj) {
      if (state) restoreNode(state);
      if (!obj.__cerBase) {
        obj.__cerBase = obj.material;
        obj.material = obj.material.clone();
      }
      state = {
        obj,
        t0: now,
        intensity,
        durationMs,
        priority,
        baseOpacity: Number(obj.__cerBase?.opacity ?? obj.material.opacity ?? 1),
      };
      activeNodes.set(ref, state);
      return true;
    }

    // Una descarga ambiental nunca debe prolongar ni rebajar un evento real.
    if (priority < state.priority) return false;
    const progress = Math.min(1, Math.max(0, (now - state.t0) / state.durationMs));
    const remaining = state.intensity * Math.pow(1 - progress, PULSE_DECAY_POWER);
    state.t0 = now;
    state.intensity = Math.max(remaining, intensity);
    state.durationMs = durationMs;
    state.priority = priority;
    return true;
  }

  function linkTouchesRealPulse(link) {
    const sourcePriority = activeNodes.get(refOf(link?.source))?.priority || 0;
    const targetPriority = activeNodes.get(refOf(link?.target))?.priority || 0;
    return Math.max(sourcePriority, targetPriority) >= REAL_EVENT_PRIORITY;
  }

  function emitParticleTrail(link, options) {
    if (!link || (options.priority < REAL_EVENT_PRIORITY && linkTouchesRealPulse(link))) return;
    graph?.emitParticle?.(link);

    for (let index = 1; index < options.edgeParticleCount; index++) {
      const delayMs = index * randomBetween(options.trailStepMinMs, options.trailStepMaxMs);
      scheduleTrackedTimer(() => {
        // Un evento real que empezó después de programar una estela ambiental
        // también manda: la cola tenue se descarta antes de cruzarlo.
        if (options.priority < REAL_EVENT_PRIORITY && linkTouchesRealPulse(link)) return;
        graph?.emitParticle?.(link);
      }, delayMs, options.priority);
    }
  }

  function emitIncidentParticles(ref, limit, options) {
    for (const link of shuffledSample(links.get(ref) || [], limit)) {
      emitParticleTrail(link, options);
    }
  }

  function neighborsOf(ref, limit) {
    const byRef = new Map();
    for (const link of links.get(ref) || []) {
      const source = refOf(link.source);
      const target = refOf(link.target);
      const neighborRef = source === ref ? target : source;
      if (neighborRef == null || neighborRef === ref || !nodes.has(neighborRef)) continue;
      if (!byRef.has(neighborRef)) byRef.set(neighborRef, link);
    }
    return shuffledSample([...byRef.entries()], limit)
      .map(([neighborRef, link]) => ({ ref: neighborRef, link }));
  }

  function scheduleCascadeNode(ref, link, depth, options) {
    const delayPerHop = randomBetween(CASCADE_HOP_DELAY_MIN_MS, CASCADE_HOP_DELAY_MAX_MS);
    scheduleTrackedTimer(() => {
      const intensity = options.intensity * Math.pow(CASCADE_INTENSITY_FALLOFF, depth);
      if (activateNode(ref, {
        intensity,
        durationMs: options.branchDurationMs,
        priority: options.priority,
      })) {
        emitParticleTrail(link, options);
      }
    }, depth * delayPerHop, options.priority);
  }

  function triggerCascade(ref, options) {
    if (!activateNode(ref, {
      intensity: options.intensity,
      durationMs: options.rootDurationMs,
      priority: options.priority,
    })) return;

    emitIncidentParticles(ref, options.rootParticleEdges, options);

    const visited = new Set([ref]);
    let frontier = [ref];
    for (let depth = 1; depth <= options.hops && frontier.length; depth++) {
      const nextFrontier = [];
      for (const currentRef of frontier) {
        // Los dos topes evitan que un hub convierta una descarga en cientos de
        // clones, timers y partículas dentro del mismo frame.
        for (const neighbor of neighborsOf(currentRef, options.neighborsPerNode)) {
          if (visited.has(neighbor.ref) || visited.size >= options.maxNodes) continue;
          visited.add(neighbor.ref);
          nextFrontier.push(neighbor.ref);
          scheduleCascadeNode(neighbor.ref, neighbor.link, depth, options);
        }
        if (visited.size >= options.maxNodes) break;
      }
      frontier = nextFrontier;
    }
  }

  function pulseNode(ref, { strong = false } = {}) {
    triggerCascade(ref, {
      intensity: strong ? REAL_STRONG_PULSE_INTENSITY : REAL_PULSE_INTENSITY,
      rootDurationMs: PULSE_MS,
      branchDurationMs: CASCADE_PULSE_MS,
      priority: REAL_EVENT_PRIORITY,
      rootParticleEdges: REAL_ROOT_PARTICLE_EDGES,
      hops: CASCADE_HOPS,
      neighborsPerNode: CASCADE_NEIGHBORS_PER_NODE,
      maxNodes: CASCADE_MAX_NODES,
      edgeParticleCount: REAL_EDGE_PARTICLE_COUNT,
      trailStepMinMs: REAL_TRAIL_STEP_MIN_MS,
      trailStepMaxMs: REAL_TRAIL_STEP_MAX_MS,
    });
  }

  function pulseCollection(slug) {
    const current = activeCollections.get(slug);
    if (current) {
      current.t0 = performance.now();
      return;
    }

    const materials = new Map();
    for (const node of nodes.values()) {
      if (node.collection !== slug) continue;
      // Si ese nodo ya tiene un pulso individual, el material compartido vive
      // en __cerBase; usarlo evita guardar una copia que podría ser descartada
      // antes de que termine el destello del clúster.
      const material = node.__threeObj?.__cerBase || node.__threeObj?.material;
      if (!material?.uuid || !material.emissive || materials.has(material.uuid)) continue;
      materials.set(material.uuid, {
        material,
        emissive: {
          r: material.emissive.r,
          g: material.emissive.g,
          b: material.emissive.b,
        },
      });
    }
    if (!materials.size) return;
    activeCollections.set(slug, { t0: performance.now(), materials });
  }

  function buildAmbientPath() {
    if (!ambientStartLinks.length) return [];

    let firstLink = null;
    const attempts = Math.min(8, ambientStartLinks.length);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const candidate = ambientStartLinks[Math.floor(Math.random() * ambientStartLinks.length)];
      if (!linkTouchesRealPulse(candidate)) {
        firstLink = candidate;
        break;
      }
    }
    if (!firstLink) return [];

    const targetLength = randomInteger(AMBIENT_BURST_MIN_EDGES, AMBIENT_BURST_MAX_EDGES);
    const path = [firstLink];
    const usedLinks = new Set(path);
    let currentRef = refOf(firstLink.target);
    while (path.length < targetLength) {
      const candidates = (outgoingLinksByRef.get(currentRef) || [])
        .filter((link) => !usedLinks.has(link) && !linkTouchesRealPulse(link));
      if (!candidates.length) break;
      const link = candidates[Math.floor(Math.random() * candidates.length)];
      path.push(link);
      usedLinks.add(link);
      currentRef = refOf(link.target);
    }
    return path;
  }

  function emitAmbientBurst(nowMs) {
    if (activeAmbientBursts >= MAX_AMBIENT_BURSTS) {
      nextAmbientParticleAt = nowMs + AMBIENT_BURST_RETRY_MS;
      return;
    }

    const path = buildAmbientPath();
    if (path.length < AMBIENT_BURST_MIN_EDGES) {
      nextAmbientParticleAt = nowMs + AMBIENT_BURST_RETRY_MS;
      return;
    }

    // El intervalo se paga según la cantidad real emitida: una ráfaga de 3
    // aristas ocurre aproximadamente a un tercio de la vieja tasa de goteo.
    const baseInterval = (1000 * path.length) / AMBIENT_PARTICLES_PER_SECOND;
    const jitter = randomBetween(
      1 - AMBIENT_PARTICLE_INTERVAL_JITTER,
      1 + AMBIENT_PARTICLE_INTERVAL_JITTER,
    );
    nextAmbientParticleAt = nowMs + baseInterval * jitter;

    activeAmbientBursts++;
    const burst = { pending: 0, settled: false };
    const settleStep = () => {
      burst.pending--;
      if (burst.pending > 0 || burst.settled) return;
      burst.settled = true;
      activeAmbientBursts--;
    };

    if (!linkTouchesRealPulse(path[0])) graph?.emitParticle?.(path[0]);
    let delayMs = 0;
    for (let index = 1; index < path.length; index++) {
      delayMs += randomBetween(AMBIENT_BURST_STEP_MIN_MS, AMBIENT_BURST_STEP_MAX_MS);
      burst.pending++;
      const timer = scheduleTrackedTimer(() => {
        if (!linkTouchesRealPulse(path[index])) graph?.emitParticle?.(path[index]);
        settleStep();
      }, delayMs, AMBIENT_PRIORITY, settleStep);
      if (!timer) settleStep();
    }
    if (!burst.pending && !burst.settled) {
      burst.settled = true;
      activeAmbientBursts--;
    }
  }

  function triggerDistantLightningAt(ref) {
    triggerCascade(ref, {
      intensity: DISTANT_LIGHTNING_INTENSITY,
      rootDurationMs: DISTANT_LIGHTNING_PULSE_MS,
      branchDurationMs: DISTANT_LIGHTNING_PULSE_MS,
      priority: AMBIENT_PRIORITY,
      rootParticleEdges: DISTANT_LIGHTNING_ROOT_PARTICLE_EDGES,
      hops: DISTANT_LIGHTNING_HOPS,
      neighborsPerNode: DISTANT_LIGHTNING_NEIGHBORS_PER_NODE,
      maxNodes: DISTANT_LIGHTNING_MAX_NODES,
      edgeParticleCount: DISTANT_LIGHTNING_EDGE_PARTICLE_COUNT,
      trailStepMinMs: DISTANT_LIGHTNING_TRAIL_STEP_MIN_MS,
      trailStepMaxMs: DISTANT_LIGHTNING_TRAIL_STEP_MAX_MS,
    });
  }

  function triggerDistantLightning() {
    if (!lightningHubRefs.length) return;
    const ref = lightningHubRefs[Math.floor(Math.random() * lightningHubRefs.length)];
    triggerDistantLightningAt(ref);

    // A veces una segunda descarga tenue responde desde otro hub: suma vida
    // sin elevar la intensidad ni los topes reservados para el ambiente.
    if (lightningHubRefs.length < 2 || Math.random() >= DISTANT_LIGHTNING_SECOND_FOCUS_CHANCE) {
      return;
    }
    const otherRefs = lightningHubRefs.filter((candidateRef) => candidateRef !== ref);
    const secondRef = otherRefs[Math.floor(Math.random() * otherRefs.length)];
    scheduleTrackedTimer(() => {
      triggerDistantLightningAt(secondRef);
    }, randomBetween(
      DISTANT_LIGHTNING_SECOND_FOCUS_MIN_DELAY_MS,
      DISTANT_LIGHTNING_SECOND_FOCUS_MAX_DELAY_MS,
    ), AMBIENT_PRIORITY);
  }

  function tick(nowMs) {
    for (const [ref, state] of activeNodes) {
      const p = (nowMs - state.t0) / state.durationMs;
      if (p >= 1) {
        restoreNode(state);
        activeNodes.delete(ref);
        continue;
      }
      const k = Math.pow(1 - Math.max(0, p), PULSE_DECAY_POWER) * state.intensity;
      const obj = state.obj;
      const material = obj?.material;
      if (!material?.color || !material.emissive) continue;
      obj.scale.setScalar(1 + PULSE_SCALE_BOOST * k);
      material.emissive.setRGB(material.color.r * k, material.color.g * k, material.color.b * k);
      material.opacity = state.baseOpacity + (1 - state.baseOpacity) * Math.min(1, k);
    }

    for (const [slug, state] of activeCollections) {
      const p = (nowMs - state.t0) / CLUSTER_MS;
      if (p >= 1) {
        restoreCollection(state);
        activeCollections.delete(slug);
        continue;
      }
      const k = Math.pow(1 - Math.max(0, p), PULSE_DECAY_POWER) * COLLECTION_INTENSITY;
      for (const entry of state.materials.values()) {
        const material = entry.material;
        if (!material?.color || !material.emissive) continue;
        material.emissive.setRGB(material.color.r * k, material.color.g * k, material.color.b * k);
      }
    }

    // Respirar por objeto mantiene fases independientes sin tocar materiales
    // compartidos; los pulsos activos conservan siempre el control de su escala.
    for (const entry of breathingNodes) {
      if (activeNodes.has(entry.ref)) continue;
      const obj = entry.node?.__threeObj;
      if (!obj?.scale) continue;
      const wave = 0.5 + 0.5 * Math.sin((nowMs / NODE_BREATH_PERIOD_MS) * TWO_PI + entry.phase);
      obj.scale.setScalar(1 + NODE_BREATH_SCALE_AMPLITUDE * wave);
    }

    if (!nextAmbientParticleAt) nextAmbientParticleAt = nowMs + 1000 / AMBIENT_PARTICLES_PER_SECOND;
    else if (nowMs >= nextAmbientParticleAt) emitAmbientBurst(nowMs);

    if (!nextDistantLightningAt) {
      nextDistantLightningAt = nowMs + randomBetween(
        DISTANT_LIGHTNING_MIN_MS,
        DISTANT_LIGHTNING_MAX_MS,
      );
    } else if (nowMs >= nextDistantLightningAt) {
      triggerDistantLightning();
      nextDistantLightningAt = nowMs + randomBetween(
        DISTANT_LIGHTNING_MIN_MS,
        DISTANT_LIGHTNING_MAX_MS,
      );
    }

    if (ambientLights === null) {
      try {
        const scene = graph?.scene?.();
        ambientLights = (scene?.children || [])
          .filter((object) => object.isLight)
          .map((light) => ({ light, base: light.intensity }));
      } catch {
        ambientLights = [];
      }
    }
    for (let i = 0; i < ambientLights.length; i++) {
      const { light, base } = ambientLights[i];
      const wave = Math.sin((nowMs / AMBIENT_LIGHT_PERIOD_MS) * TWO_PI + i);
      light.intensity = base * (1 + AMBIENT_LIGHT_INTENSITY_AMPLITUDE * wave);
    }
  }

  function clear() {
    for (const timer of [...cascadeTimers]) cancelTrackedTimer(timer);
    cascadeTimers.clear();
    timerMetadata.clear();
    for (const state of activeCollections.values()) restoreCollection(state);
    activeCollections.clear();
    for (const state of activeNodes.values()) restoreNode(state);
    activeNodes.clear();
    for (const entry of breathingNodes) entry.node?.__threeObj?.scale?.setScalar(1);
    for (const { light, base } of ambientLights || []) light.intensity = base;
    nextAmbientParticleAt = 0;
    nextDistantLightningAt = 0;
    activeAmbientBursts = 0;
  }

  function setNodes(nextNodeByRef, nextLinksByRef) {
    clear();
    nodes = nextNodeByRef || new Map();
    links = nextLinksByRef || new Map();
    rebuildGraphCaches();
  }

  rebuildGraphCaches();

  // `palette` forma parte del contrato porque mantiene una sola fuente de color
  // para el grafo y sus pulsos, aunque Three ya entregue aquí colores resueltos.
  void palette;

  return { pulseNode, pulseCollection, tick, setNodes, clear };
}
