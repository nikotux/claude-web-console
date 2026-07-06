// modules/health/coherence-shared.js — lo COMPARTIDO entre el módulo server y
// el runner desacoplado del MÓDULO DE COHERENCIA (bin/cwc-coherence-runner.js).
//
// QUÉ ES: la subsección "🔗 Coherencia" de la pestaña Salud. Gemelo de la
// Optimización IA, pero en vez de mirar CADA motor por dentro (modelo/turnos),
// mira las RELACIONES entre motores y módulos: ¿se están usando entre sí? ¿o
// reinventan / duplican / se ignoran? El disparador real: descubrir que algunos
// motores del ciclo de tickets NO usaban el motor `comms` (contexto de Chris).
//
// DOS capas de análisis:
//   1. CENSO determinístico (core/inventory.js → coherenceCensus): grafo
//      quién-usa-a-quién + consumo de servicios transversales + señales (gh,
//      motores SDK, runners). evaluateCoherence() de acá aplica REGLAS de
//      cableado sobre ese censo → hallazgos duros (0 tokens).
//   2. ANÁLISIS IA (runner): sonnet READ-ONLY doble capa (regla 6) que VERIFICA
//      los hallazgos leyendo el código y PROPONE el cableado concreto. Las
//      propuestas NUNCA se auto-aplican (aprobar = chat supervisado).
//
// GARANTÍAS (idénticas a optimize-shared): regla de oro (runner desacoplado +
// estado persistido en ~/.cwc-data/coherence.json) · regla 6 (dos capas
// read-only, allowlist Read/Grep/Glob/TodoWrite, settingSources: []).
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../../core/inventory.js';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const COH_FILE = path.join(DATA_DIR, 'coherence.json');   // resultado persistido
export const COH_LOCK = path.join(DATA_DIR, 'coherence.lock');   // heartbeat del runner
export const COH_LOG = path.join(DATA_DIR, 'coherence.log');

export const COH_TIMEOUT_MS = 15 * 60 * 1000; // corte duro del análisis
export const COH_MAX_TURNS = 60;              // lee CLAUDE.md + varios motores
export const COH_HEARTBEAT_MS = 3000;
export const COH_LOCK_FRESH_MS = 20000;       // lock más viejo = runner muerto

// Allowlist de herramientas: SOLO lecturas locales (dos capas — regla 6).
// Idéntica al auditor de salud y al optimizador: LEE código, jamás escribe.
export function cohToolAllowed(name) {
  return ['Read', 'Grep', 'Glob', 'TodoWrite'].includes(name);
}

export const COH_RISKS = new Set(['bajo', 'medio', 'alto']);
export const COH_TIPOS = new Set(['cableado', 'dedup', 'fuente-unica', 'regla-oro', 'blindaje', 'espejo', 'adopcion', 'convencion', 'otro']);
export const COH_SEVERIDADES = new Set(['info', 'aviso', 'alto']);

// ===== Convenciones de CLAUDE.md, pre-masticadas (4ª dimensión, 2026-07-06) ===
// Mismo patrón que hardRulesText() de health/shared.js: recorta la sección
// '## Convenciones' UNA vez en Node y se inyecta como texto en el prompt — el
// modelo NO tiene que leer el CLAUDE.md entero para verificar convenciones
// transversales (colapsable+árbol, colores de tokens.css, diálogos/íconos
// centralizados…) en los módulos nuevos/cambiados. Si la extracción falla
// (archivo movido / sección renombrada) devuelve '' y el prompt se degrada
// solo (pierde este bloque, no rompe el análisis).
let _conventions = null;
export function conventionsText() {
  if (_conventions !== null) return _conventions;
  try {
    const lines = fss.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8').split('\n');
    const start = lines.findIndex((l) => /^##\s+Convenciones/.test(l));
    if (start === -1) { _conventions = ''; return _conventions; }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break; }
    }
    _conventions = lines.slice(start, end).join('\n').trim();
  } catch { _conventions = ''; }
  return _conventions;
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
export const proposalId = (p) => sha(`${p.foco || ''}|${p.tipo || ''}|${p.propuesta || ''}`);
const findingId = (f) => sha(`${f.categoria || ''}|${f.foco || ''}|${f.detalle || ''}`);

// ===== Reglas de coherencia determinísticas (0 tokens) =====
// Aplican sobre el censo de coherenceCensus(). Devuelven hallazgos {categoria,
// severidad, foco, detalle, sugerencia, id}. Son la SEMILLA que el análisis IA
// verifica y amplía. Bajo perfil de falsos positivos: los casos fuzzy
// (validación de rutas, espejos back↔front) se dejan a la capa IA.
export function evaluateCoherence(census) {
  const findings = [];
  const add = (f) => findings.push({ ...f, id: findingId(f) });
  const svc = Object.fromEntries((census.services || []).map((s) => [s.key, s]));

  // Regla 1: los módulos del ciclo bug/feature deberían consumir `comms`
  // (necesitan el contexto de Chris/PR). Es el hallazgo que originó el módulo.
  const WANT_COMMS = ['bugfixes', 'bugs'];
  if (svc.comms?.exists) {
    const consumers = new Set(svc.comms.consumerModules || []);
    for (const m of WANT_COMMS) {
      if (!consumers.has(m)) {
        add({
          categoria: 'reuso', severidad: 'alto', foco: m,
          detalle: `El módulo "${m}" (ciclo de tickets/features: necesita datos de Chris/PR/Desk) NO consume el motor transversal "comms" en el grafo de imports.`,
          sugerencia: `Que "${m}" consulte comms (GET /api/comms/index o su shared) para el hilo GitHub/Teams del contacto, en vez de scrapear por su cuenta.`,
          pasos: [
            `Identificar dónde "${m}" necesita el contexto de Chris/PR (prompts de "Trabajar en esto", estado del PR, etc.)`,
            'Consumir comms (fetchCommsContext del front o GET /api/comms/index del back — 0 tokens, ya cacheado) en vez de reimplementar el scraping',
            'node --check + verificar que el flujo arranca con el hilo inyectado',
          ],
        });
      }
    }
  }

  // Regla 2: scraping de `gh` en más de un módulo = duplicación potencial.
  const ghModules = [...new Set((census.ghCallers || []).map((g) => g.module))];
  if (ghModules.length > 1) {
    add({
      categoria: 'fuente-unica', severidad: 'aviso', foco: ghModules.join(', '),
      detalle: `Hay llamadas a la CLI "gh" en ${ghModules.length} módulos distintos (${(census.ghCallers || []).map((g) => g.file).join(', ')}) — scraping de GitHub potencialmente DUPLICADO sin fuente compartida.`,
      sugerencia: 'Unificar el scraping de gh en una sola fuente (p.ej. comms/shared) y que los demás la consuman, para no divergir ni re-pagar el mismo trabajo.',
      pasos: [
        'Listar qué lee cada módulo de gh (reviews/comentarios de un PR, estado, repo edit…)',
        'Extraer la lectura común a UN lector compartido (patrón comms/pr-read-shared.js con caché por PR) y que los demás lo consuman',
        'Dejar en cada módulo solo su parseo específico; verificar que ninguno pierde campos',
      ],
    });
  }

  // Regla 3: runners sin señales de la regla de oro NI delegación a un shared.
  for (const r of census.runners || []) {
    if (!r.goldenRule) {
      add({
        categoria: 'regla-oro', severidad: 'aviso', foco: r.file,
        detalle: `El runner ${r.file} no muestra señales de la "regla de oro" (lock=${r.hasLock} · heartbeat=${r.hasHeartbeat} · estado en ~/.cwc-data=${r.writesData} · delega en shared=${r.delegatesShared}).`,
        sugerencia: 'Confirmá que persiste estado REANUDABLE en ~/.cwc-data con lock/heartbeat (patrón desk/optimize). Si es un runner corto e idempotente, verificá que igual sobrevive a un reinicio.',
        pasos: [
          `Leer ${r.file} y ver si su trabajo sobrevive a un reinicio del server`,
          'Si no: mover el estado a ~/.cwc-data con lock/heartbeat (patrón optimize-shared) y reserva pid:0 en el spawn',
          'Si es corto/idempotente y ya sobrevive: descartá este aviso',
        ],
      });
    }
  }

  // Regla 4: motores del SDK sin las dos capas read-only (blindaje regla 6).
  for (const e of census.engines || []) {
    const capas = (e.layers?.preToolUse ? 1 : 0) + (e.layers?.canUseTool ? 1 : 0);
    const interactivo = /chat-runner|modules\/chat\//.test(e.file); // chat: escritura supervisada, no aplica
    if (capas === 0 && !interactivo) {
      add({
        categoria: 'blindaje', severidad: 'aviso', foco: e.file,
        detalle: `El motor SDK ${e.file} no expone las dos capas read-only (PreToolUse + canUseTool).`,
        sugerencia: 'Si es una corrida headless, aplicá el blindaje de dos capas (regla 6). Si es interactiva o de escritura supervisada, ignorá este aviso.',
        pasos: [
          `Determinar si ${e.file} es headless (debe ser read-only) o interactivo/escritura supervisada`,
          'Si headless: agregar hook PreToolUse + canUseTool con una allowlist (patrón optToolAllowed) + settingSources: []',
          'node --check + verificar que las tools fuera de la allowlist quedan denegadas',
        ],
      });
    }
  }

  // Regla 5: servicio transversal huérfano (existe pero nadie lo consume).
  for (const s of census.services || []) {
    if (s.exists && s.consumers.length === 0) {
      add({
        categoria: 'huerfano', severidad: 'info', foco: s.key,
        detalle: `El servicio transversal "${s.label}" existe pero no tiene consumidores en el grafo (capability posiblemente infrautilizada).`,
        sugerencia: `Revisá si algún flujo debería estar apoyándose en "${s.key}".`,
        pasos: [
          `Revisar qué flujos harían mejor su trabajo usando "${s.key}"`,
          'Cablear al menos un consumidor, o documentar por qué queda sin uso',
        ],
      });
    }
  }

  // ===== Completitud del inventario: ¿lo nuevo está registrado/cableado? =====
  // (reusa census.completeness, calculado en core/inventory.js). "Está
  // corriendo" NO se chequea acá — eso es runtime y vive en los Chequeos rápidos.
  const comp = census.completeness || {};
  for (const name of comp.unregistered || []) {
    add({
      categoria: 'registro', severidad: 'alto', foco: name,
      detalle: `Existe src/modules/${name}/ pero el módulo NO está en el array MODULES de registry.js: no se monta, sus endpoints/init NO corren.`,
      sugerencia: 'Registrar el módulo en src/core/registry.js.',
      pasos: [
        `Agregar en registry.js: import ${name} from '../modules/${name}/index.js';`,
        `Sumar ${name} al array const MODULES = [...]`,
        'node --check src/core/registry.js && reiniciar el servicio',
      ],
    });
  }
  for (const name of comp.unmounted || []) {
    add({
      categoria: 'registro', severidad: 'aviso', foco: name,
      detalle: `El módulo frontend "${name}" define mount() pero no aparece montado por [data-module="${name}"] en public/index.html (puede ser intencional si es un helper/sub-componente).`,
      sugerencia: 'Si es un módulo de UI de primer nivel, agregar su slot [data-module] en index.html y registrarlo en main.js.',
      pasos: [
        `Agregar el slot data-module="${name}" en public/index.html`,
        `Importar y sumar ${name} al array MODULES de public/js/main.js`,
        'Verificar en el navegador que monta (o descartar el aviso si es un helper)',
      ],
    });
  }
  for (const file of comp.orphanRunners || []) {
    add({
      categoria: 'huerfano', severidad: 'aviso', foco: file,
      detalle: `El runner ${file} existe en bin/ pero ningún archivo lo referencia/spawnea por su nombre (posible runner muerto, o referenciado dinámicamente).`,
      sugerencia: 'Confirmá quién lo lanza. Si nadie, borralo o cableá su spawn (patrón spawnOptimize con reserva pid:0).',
      pasos: [
        `grep -rn "${file.split('/').pop()}" src/ bin/`,
        'Si nadie lo spawnea: agregar su spawn desacoplado o eliminar el runner',
      ],
    });
  }
  for (const file of comp.orphanEngines || []) {
    add({
      categoria: 'huerfano', severidad: 'aviso', foco: file,
      detalle: `El motor SDK ${file} llama a query() pero nadie lo importa ni lo referencia por nombre: motor huérfano (no se dispara desde ningún lado detectable).`,
      sugerencia: 'Verificá que esté cableado a un endpoint/runner. Si quedó suelto (prueba), conectalo o quitalo.',
      pasos: [
        `grep -rn "${file.split('/').pop()}" src/ bin/`,
        'Cablearlo a un endpoint o runner que lo dispare, o eliminarlo si quedó de una prueba',
      ],
    });
  }

  // Regla 6: convenciones TRANSVERSALES mecánicamente chequeables (4ª
  // dimensión) — lead determinístico, la IA lo verifica (puede haber falsos
  // positivos: un hex en un comentario, etc.).
  for (const c of census.conventions || []) {
    if (!c.mechanical || !(c.violations || []).length) continue;
    add({
      categoria: 'convencion', severidad: 'aviso', foco: c.label,
      detalle: `Convención "${c.label}" (CLAUDE.md § Convenciones) — posibles violaciones en: ${c.violations.slice(0, 8).join(', ')}${c.violations.length > 8 ? '…' : ''}.`,
      sugerencia: 'Abrí cada archivo citado y confirmá si es una violación real o un falso positivo del lead (regex simple, no entiende contexto).',
      pasos: [
        'Abrir los archivos citados y verificar la línea que matchea',
        'Si es una violación real: corregirla siguiendo la convención (usar tokens.css / ui/dialog.js / ui/icons.js según corresponda)',
        'Si es un falso positivo (comentario, string legítimo): descartar este aviso',
      ],
    });
  }

  // ===== Propagación de patrones canónicos (3ª dimensión) =====
  // "Ya probamos un patrón bueno (pool paralelo, caché incremental…): ¿qué otros
  // sitios deberían adoptarlo?" El candidato es un LEAD — la regla de oro
  // ("paralelo lo que LEE, serial lo que ESCRIBE") la confirma la IA/vos.
  for (const pat of census.patterns || []) {
    if (!pat.providerExists) continue;
    if ((pat.candidates || []).length) {
      add({
        categoria: 'adopcion', severidad: 'aviso', foco: pat.label,
        detalle: `El patrón "${pat.label}" ya existe (lo usan: ${(pat.adopters || []).map((f) => f.split('/').pop()).join(', ') || 'nadie aún'}), pero estos sitios parecen hacer trabajo similar SIN adoptarlo: ${pat.candidates.join(', ')}.`,
        sugerencia: 'Evaluá si esos sitios deberían adoptar el patrón. Para paralelismo rige "paralelo lo que LEE, serial lo que ESCRIBE": solo si el trabajo por ítem es independiente/lectura.',
        pasos: [
          'Abrir cada candidato y ver si su bucle serial es independiente por ítem (LECTURA) o escribe en orden',
          `Si es independiente: adoptar el patrón canónico (${pat.label})`,
          'Si escribe/ordena o es interactivo: dejarlo serial y descartar el aviso',
        ],
      });
    } else if ((pat.adopters || []).length === 0) {
      add({
        categoria: 'adopcion', severidad: 'info', foco: pat.label,
        detalle: `El patrón "${pat.label}" existe pero no lo adopta ningún otro módulo (capability posiblemente subutilizada).`,
        sugerencia: 'Revisá si algún flujo debería adoptarlo.',
        pasos: ['Revisar qué flujos harían mejor su trabajo con este patrón', 'Adoptarlo en al menos uno, o documentar por qué no aplica'],
      });
    }
  }

  return findings;
}

// Vista compacta del censo para el prompt (evita mandar el grafo entero).
function compactCensus(census) {
  return {
    servicios: (census.services || []).map((s) => ({ key: s.key, existe: s.exists, consumidores: s.consumerModules })),
    grafoModulos: (census.modules || []).map((m) => ({ modulo: m.module, usa: m.uses })),
    motores: (census.engines || []).map((e) => ({ file: e.file, modelo: e.models?.join('/') || (e.modelDynamic ? 'dinámico' : 'default'), capas: (e.layers?.preToolUse ? 1 : 0) + (e.layers?.canUseTool ? 1 : 0) })),
    ghCallers: (census.ghCallers || []).map((g) => g.file),
    runners: census.runners || [],
    completitud: census.completeness || {},
    patrones: (census.patterns || []).map((p) => ({ patron: p.label, existe: p.providerExists, adoptanN: (p.adopters || []).length, candidatos: p.candidates || [] })),
    convenciones: (census.conventions || []).map((c) => ({ convencion: c.label, mecanica: c.mechanical, alcance: c.scopedCount, violaciones: c.violations || [] })),
  };
}

// Prompt del análisis: recibe el censo (compacto) + los hallazgos determinísticos
// y VERIFICA leyendo el código antes de proponer el cableado concreto.
export function coherencePrompt(census, findings) {
  return [
    'Sos el AUDITOR DE COHERENCIA de Claude Web Console. Corrida NO interactiva,',
    'SOLO LECTURA (no modifiques nada, no corras comandos).',
    '',
    'Tu foco NO es cada motor por dentro (eso lo hace la Optimización IA), sino',
    'las RELACIONES entre motores y módulos: ¿se aprovechan entre sí para',
    'resolver las tareas, o reinventan, duplican trabajo o se ignoran? El caso',
    'testigo: motores del ciclo de tickets que scrapeaban GitHub por su cuenta',
    'en vez de usar el motor transversal `comms` (contexto de Chris).',
    '',
    'CENSO determinístico (core/inventory.js → grafo de imports + servicios',
    'transversales + señales; ya masticado, NO lo re-derives):',
    '```json',
    JSON.stringify(compactCensus(census)),
    '```',
    'HALLAZGOS determinísticos ya detectados (verificalos: pueden ser reales o',
    'falsos positivos del regex — citá el código):',
    '```json',
    JSON.stringify((findings || []).map((f) => ({ categoria: f.categoria, severidad: f.severidad, foco: f.foco, detalle: f.detalle }))),
    '```',
    ...(conventionsText() ? [
      '',
      'CONVENCIONES del proyecto (sección «## Convenciones» de CLAUDE.md, YA',
      'recortada — 4ª dimensión de coherencia: aplican a CUALQUIER módulo nuevo o',
      'cambiado, no a uno puntual):',
      '```',
      conventionsText(),
      '```',
    ] : []),
    '',
    'Método (presupuesto ACOTADO de turnos, administralo: leé primero CLAUDE.md,',
    'después SOLO lo que necesites verificar; reservá el último turno para el',
    'bloque ```json final):',
    '1. Leé CLAUDE.md de la raíz: las REGLAS DURAS (1-9) son INVIOLABLES. Ninguna',
    '   propuesta puede debilitar el blindaje read-only de dos capas, los runners',
    '   desacoplados (regla de oro), el bind ZeroTier ni el resto.',
    '2. Verificá cada hallazgo determinístico abriendo el código citado. Descartá',
    '   los que sean falsos positivos (p.ej. un runner corto idempotente que SÍ',
    '   sobrevive reinicios, o un módulo que ya consume el servicio por otra vía).',
    '3. Buscá MÁS incoherencias que el regex no ve: lógica DUPLICADA entre módulos',
    '   (ej. scraping de gh en bugfixes/desk-shared.js y comms/shared.js con',
    '   cachés separadas), ESPEJOS back↔front que podrían divergir (ej.',
    '   board/labels.js vs engine.js), flujos que deberían consultar un motor',
    '   transversal (comms, bus/interfono, inventory, tokens) y no lo hacen,',
    '   validación de rutas sin core/paths, settingSources sin core/sdk-settings.',
    '3b. PROPAGACIÓN DE PATRONES (importante): en `patrones` de arriba están los',
    '   patrones CANÓNICOS del proyecto (pool paralelo, caché incremental, runner',
    '   desacoplado) con quién los adopta y qué sitios parecen reinventarlos.',
    '   Buscá dónde MÁS convendría adoptarlos (tipo "adopcion"). Para el pool',
    '   paralelo aplicá la regla de oro del proyecto: "paralelo lo que LEE, serial',
    '   lo que ESCRIBE" — un bucle que ESCRIBE en orden o es interactivo (chat) NO',
    '   se paraleliza. Verificá leyendo el código antes de proponer.',
    '3c. CONVENCIONES TRANSVERSALES (4ª dimensión, tipo "convencion"): en',
    '   `convenciones` de arriba está cada convención de CLAUDE.md con su alcance',
    '   (archivos que aplican) y, si es mecánicamente chequeable, sus violaciones',
    '   YA detectadas por regex (verificalas — pueden ser falsos positivos: un hex',
    '   en un comentario, etc.). Para las NO mecánicas (p.ej. "todo módulo/panel',
    '   nuevo con mucho texto nace colapsado + agrupado en árbol"), elegí 2-4',
    '   módulos frontend recientes/relevantes de `public/js/modules/` y abrilos:',
    '   ¿nacen con `<details>`/patrón colapsable? ¿agrupan sub-elementos en árbol',
    '   si corresponde? Reportá solo violaciones concretas, citando el archivo.',
    '4. NO inventes para llenar: cada propuesta debe citar el archivo y ser',
    '   verificable. Si la arquitectura ya es coherente, decilo en el resumen.',
    '',
    'Al final, evaluá si vale un FLUJO NUEVO (p.ej. un servicio compartido que',
    'unifique el scraping de GitHub, o un helper de contexto que todo chat de',
    'trabajo consuma). Solo si el beneficio es claro.',
    '',
    'Respondé ÚNICAMENTE con un bloque ```json con EXACTAMENTE estas claves:',
    '{',
    '  "resumen": "3-5 líneas en criollo: qué tan bien se usan los motores/módulos entre sí, lo más valioso primero",',
    '  "propuestas": [{',
    '    "foco": "módulo o archivo protagonista (p.ej. bugfixes, comms/shared.js)",',
    '    "archivo": "ruta relativa del archivo principal",',
    '    "tipo": "cableado" | "dedup" | "fuente-unica" | "regla-oro" | "blindaje" | "espejo" | "adopcion" | "convencion" | "otro",',
    '    "actual": "cómo se relacionan HOY (concreto)",',
    '    "propuesta": "qué cableado/unificación hacer (concreto y accionable)",',
    '    "razon": "por qué mejora la coherencia/eficiencia (con evidencia del código)",',
    '    "impacto": "qué se gana (menos duplicación, un solo lugar de verdad, menos tokens…)",',
    '    "riesgo": "bajo" | "medio" | "alto",',
    '    "archivos": ["rutas a tocar"],',
    '    "pasos": ["pasos concretos para aplicarla"]',
    '  }],',
    '  "flujoNuevo": { "vale": true|false, "titulo": "…", "descripcion": "…", "diseno": ["fase/pieza por línea"] }',
    '}',
    'Máximo 12 propuestas, ordenadas por valor (impacto/riesgo). Sin texto fuera del bloque.',
  ].join('\n');
}

// Parseo defensivo del texto del modelo → resultado normalizado.
export function parseCoherence(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const propuestas = (Array.isArray(o.propuestas) ? o.propuestas : []).slice(0, 12).map((p) => {
    const clean = {
      foco: String(p.foco ?? '').slice(0, 80),
      archivo: String(p.archivo ?? '').slice(0, 200),
      tipo: COH_TIPOS.has(p.tipo) ? p.tipo : 'otro',
      actual: String(p.actual ?? '').slice(0, 400),
      propuesta: String(p.propuesta ?? '').slice(0, 500),
      razon: String(p.razon ?? '').slice(0, 600),
      impacto: String(p.impacto ?? '').slice(0, 300),
      riesgo: COH_RISKS.has(p.riesgo) ? p.riesgo : 'medio',
      archivos: (Array.isArray(p.archivos) ? p.archivos : []).slice(0, 6).map((a) => String(a).slice(0, 200)),
      pasos: (Array.isArray(p.pasos) ? p.pasos : []).slice(0, 8).map((s) => String(s).slice(0, 300)),
      status: 'pending',
    };
    return { ...clean, id: proposalId(clean) };
  });
  const fn = o.flujoNuevo && typeof o.flujoNuevo === 'object' ? o.flujoNuevo : null;
  return {
    resumen: String(o.resumen ?? '').slice(0, 1200),
    propuestas,
    flujoNuevo: fn ? {
      vale: fn.vale === true,
      titulo: String(fn.titulo ?? '').slice(0, 120),
      descripcion: String(fn.descripcion ?? '').slice(0, 800),
      diseno: (Array.isArray(fn.diseno) ? fn.diseno : []).slice(0, 10).map((s) => String(s).slice(0, 300)),
    } : null,
  };
}

// ===== Resultado persistido (sobrevive reinicios; el front lo encuesta) =====
export function readCoh() {
  try { return JSON.parse(fss.readFileSync(COH_FILE, 'utf8')); }
  catch { return { updatedAt: null, resumen: null, propuestas: [], flujoNuevo: null, findings: [], error: null }; }
}
export function writeCoh(data) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(COH_FILE, JSON.stringify(data), { mode: 0o600 });
  } catch (err) { console.error('[coherence] no pude escribir coherence.json:', err?.message); }
}

// ===== Lock/heartbeat del runner (patrón optimize/desk) =====
export function writeCohLock(state) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(COH_LOCK, JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}
export function clearCohLock() { try { fss.unlinkSync(COH_LOCK); } catch { /* noop */ } }
export function readCohLock() {
  try {
    const l = JSON.parse(fss.readFileSync(COH_LOCK, 'utf8'));
    if (Date.now() - l.ts >= COH_LOCK_FRESH_MS) return null;
    return l;
  } catch { return null; }
}
export function isCohRunning() { return !!readCohLock(); }
// ¿Hay OTRO runner realmente corriendo? Exige pid REAL (≠ 0): la reserva del
// server (pid:0) no cuenta, así el runner no ve su propia reserva.
export function otherCohAlive() {
  try {
    const { pid, ts } = JSON.parse(fss.readFileSync(COH_LOCK, 'utf8'));
    return !!pid && pid !== process.pid && Date.now() - ts < COH_LOCK_FRESH_MS;
  } catch { return false; }
}
