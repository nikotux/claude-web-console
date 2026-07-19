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
//
// PLOMERÍA COMPARTIDA (fusión 2026-07-06, propuesta de la Optimización IA):
// el lock/heartbeat, el store del resultado y el parseo de propuestas estaban
// duplicados línea por línea con optimize-shared.js — ahora ambos instancian
// las FÁBRICAS de proposal-runner-shared.js re-exportando los nombres
// históricos (bin/cwc-coherence-runner.js y el módulo server no cambian).
import fss from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../core/inventory.js';
import { hardRulesText } from './shared.js';
import { crossCheckPad } from './scan-shared.js';
import {
  DATA_DIR, sha, readOnlyToolAllowed, makeLock, makeResultStore, makeProposalParser,
} from './proposal-runner-shared.js';

export const COH_FILE = path.join(DATA_DIR, 'coherence.json');   // resultado persistido
export const COH_LOCK = path.join(DATA_DIR, 'coherence.lock');   // heartbeat del runner
export const COH_LOG = path.join(DATA_DIR, 'coherence.log');

export const COH_TIMEOUT_MS = 15 * 60 * 1000; // corte duro del análisis
export const COH_MAX_TURNS = 60;              // lee CLAUDE.md + varios motores
export const COH_HEARTBEAT_MS = 3000;
export const COH_LOCK_FRESH_MS = 20000;       // lock más viejo = runner muerto

// Allowlist de herramientas: SOLO lecturas locales (dos capas — regla 6).
// Idéntica al auditor de salud y al optimizador: LEE código, jamás escribe.
export const cohToolAllowed = readOnlyToolAllowed;

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

// Parseo defensivo + id estable (sha1 foco|tipo|propuesta) — fábrica compartida.
const parser = makeProposalParser({ keyField: 'foco', tipos: COH_TIPOS, risks: COH_RISKS });
export const proposalId = parser.proposalId;
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

  // Regla 1: los módulos del ciclo de tickets/features deberían consumir `comms`
  // (necesitan el contexto de Chris/PR). Es el hallazgo que originó el módulo.
  // NOTA (2026-07-11, B0): antes ['bugfixes','bugs'] — módulos ARCHIVADOS,
  // reemplazados por `tickets` (One Front Door). `tickets` YA consume comms
  // (tickets/sources.js), así que la regla queda vigente y correctamente
  // silenciosa; si un futuro módulo del ciclo dejara de usar comms, vuelve a saltar.
  const WANT_COMMS = ['tickets'];
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

  // Regla 2: scraping de `gh` FUERA de las fuentes canónicas = duplicación.
  // EXENCIONES hand-authored (FP verificado a mano 2026-07-06, mismo espíritu
  // que el campo `exclude` de CANONICAL_PATTERNS/CANONICAL_CONVENTIONS: sin
  // esto el aviso reaparecía eternamente aunque la unificación Fase C ya se
  // hizo). Dos categorías:
  //   GH_CANONICAL — los archivos que SON la fuente única (no pueden ser su
  //     propia duplicación): comms/pr-read-shared.js (LECTOR ÚNICO fetchPrRich/
  //     fetchPrDiff con caché por PR) y comms/gateway-shared.js (GATEWAY de
  //     escritura pr comment/reviewer/close/edit).
  //   GH_EXEMPT — llamadas verificadas UNA a una que NO son el scraping que la
  //     regla caza (motivo al lado; si estos archivos suman gh NUEVO, la capa
  //     IA lo sigue viendo — la exención es solo de esta regla mecánica).
  // Un módulo NUEVO que llame a gh por su cuenta SÍ dispara el aviso (ahora
  // basta UNO solo: duplica contra la fuente canónica, no hace falta un par).
  const GH_CANONICAL = new Set([
    'src/modules/comms/pr-read-shared.js', // LECTOR ÚNICO de PRs (Fase C 2026-07-05)
    'src/modules/comms/gateway-shared.js', // GATEWAY de escritura (2026-07-05)
  ]);
  const GH_EXEMPT = new Map([
    // `repo edit` (gh) de la descripción del repo de LA CONSOLA (remote
    // personal) — dominio distinto de Tolkien, best-effort, no es scraping de
    // PRs. OJO: acá se escribe "repo edit (gh)" y no al revés a propósito: el
    // censor ghRe de core/inventory.js matchea comillas+gh+verbo y este mismo
    // archivo se auto-detectaría como caller (FP del censor).
    ['src/modules/backup/index.js', 'repo edit (gh) del repo de la consola (dominio propio, no Tolkien)'],
    // NOTA (2026-07-11, B0): se quitó la exención de `src/modules/bugfixes/index.js`
    // — módulo ARCHIVADO, el archivo ya no existe (nunca matcheaba census.ghCallers).
    // El scraping del ciclo VIVO vive ahora en tickets/. VERIFICADO (2026-07-12,
    // resolución del hallazgo de Coherencia): en AMBOS archivos las menciones de la
    // CLI son SOLO comentarios (nombres de comando entre backticks que el censor
    // ghRe confunde con llamadas reales); las lecturas REALES de PR van por la
    // fuente canónica comms/pr-read-shared.js (listPrs/fetchPrRich). No hay
    // scraping duplicado — se eximen con motivo. OJO: los motivos de abajo NO
    // deben contener el nombre-de-CLI seguido de un verbo (pr/repo/view/list…) o
    // este mismo archivo se auto-detectaría como caller (mismo FP que backup).
    ['src/modules/tickets/refresher.js', 'gh solo en comentarios; las lecturas reales van por comms/pr-read-shared.js'],
    ['src/modules/tickets/sources.js', 'gh solo en comentarios; usa listPrs/fetchPrRich de comms/pr-read-shared.js'],
  ]);
  const ghSuspects = (census.ghCallers || []).filter((g) => !GH_CANONICAL.has(g.file) && !GH_EXEMPT.has(g.file));
  if (ghSuspects.length > 0) {
    const ghModules = [...new Set(ghSuspects.map((g) => g.module))];
    add({
      categoria: 'fuente-unica', severidad: 'aviso', foco: ghModules.join(', '),
      detalle: `Hay llamadas a la CLI "gh" fuera de las fuentes canónicas (${ghSuspects.map((g) => g.file).join(', ')}) — scraping de GitHub potencialmente DUPLICADO contra el lector único comms/pr-read-shared.js o el gateway comms/gateway-shared.js.`,
      sugerencia: 'Consumir la fuente canónica: lecturas de PR → fetchPrRich/fetchPrDiff (comms/pr-read-shared.js, caché por PR); escrituras → sendComm (comms/gateway-shared.js). Si es una excepción legítima verificada, documentarla y sumarla a GH_EXEMPT (coherence-shared.js) con su motivo.',
      pasos: [
        'Listar qué lee/escribe de gh cada archivo señalado (reviews/comentarios de un PR, estado, repo edit…)',
        'Migrar la lectura a fetchPrRich/fetchPrDiff y la escritura a sendComm; dejar en el módulo solo su parseo específico',
        'Verificar que ningún consumidor pierde campos; si es excepción legítima, exención en GH_EXEMPT con motivo',
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

// CROSS-CHECK DETERMINÍSTICO con Pad (2026-07-19, "que los motores se hablen
// entre sí a través de Pad"): reusa crossCheckPad (scan-shared.js, mismo
// matching por jaccard de términos que usa el Escaneo Unificado) sobre los
// hallazgos determinísticos de evaluateCoherence() — más confiable que el
// texto libre de padContext() (el modelo PUEDE ignorar un texto libre; este
// match es matemático). Adapta el shape {categoria,foco,detalle,severidad} de
// coherencia al {area,detail,file,severity,module} que espera crossCheckPad.
// best-effort: si Pad no responde, devuelve '' y el prompt sigue igual.
export async function coherenceCrossCheckText(findings = []) {
  const mapped = findings.map((f) => ({
    area: f.foco, detail: f.detalle, file: null, module: f.foco, severity: f.severidad === 'alto' ? 'high' : 'medium',
  }));
  const cc = await crossCheckPad(mapped);
  if (!cc.available || (!cc.rastreado.length && !cc.regresion.length)) return '';
  const lines = ['CRUCE DETERMINÍSTICO contra Pad (match por similitud de términos, ver crossCheckPad):'];
  if (cc.rastreado.length) {
    lines.push(`- ${cc.rastreado.length} hallazgo(s) YA rastreado(s) como BUG abierto — NO los propongas de nuevo, referencialos:`);
    for (const r of cc.rastreado.slice(0, 15)) lines.push(`  · ${r.match.ref} (${r.match.score}%) — ${r.area}`);
  }
  if (cc.regresion.length) {
    lines.push(`- ${cc.regresion.length} hallazgo(s) que matchean un BUG YA CERRADO (posible regresión — volvió pese a estar resuelto):`);
    for (const r of cc.regresion.slice(0, 15)) lines.push(`  · ${r.match.ref} (${r.match.score}%) — ${r.area}`);
  }
  return lines.join('\n');
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
export function coherencePrompt(census, findings, padCtx = '') {
  // REGLAS DURAS ya masticadas (0 tool calls, mismo patrón que unitPrompt de
  // shared.js y que conventionsText() de arriba): si hardRulesText() trae texto
  // se inyecta directo y el modelo NO gasta un Read del CLAUDE.md entero solo
  // para esto; si vino vacío, fallback a la instrucción vieja.
  const rules = hardRulesText();
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
    ...(rules ? [
      '',
      'REGLAS DURAS del proyecto (sección «## Reglas duras» de CLAUDE.md, YA',
      'extraída acá — NO abras CLAUDE.md para esto, usá este texto directo):',
      '',
      rules,
    ] : []),
    ...(padCtx ? [
      '',
      'CONTEXTO DE PAD LOCAL (workspace `console`) — bugs de acoplamiento/',
      'duplicación ya rastreados + programas en curso. Usalo para NO re-reportar',
      'lo ya sabido y para conectar tus hallazgos con lo que está en marcha:',
      '',
      padCtx,
    ] : []),
    '',
    ...(rules
      ? ['Método (presupuesto ACOTADO de turnos, administralo: las reglas duras van',
        'inyectadas arriba — no gastes un turno en abrir CLAUDE.md para eso; leé',
        'SOLO lo que necesites verificar; reservá el último turno para el',
        'bloque ```json final):',
        '1. Las REGLAS DURAS (1-9) van INYECTADAS arriba y son INVIOLABLES. Ninguna']
      : ['Método (presupuesto ACOTADO de turnos, administralo: leé primero CLAUDE.md,',
        'después SOLO lo que necesites verificar; reservá el último turno para el',
        'bloque ```json final):',
        '1. Leé CLAUDE.md de la raíz: las REGLAS DURAS (1-9) son INVIOLABLES. Ninguna']),
    '   propuesta puede debilitar el blindaje read-only de dos capas, los runners',
    '   desacoplados (regla de oro), el bind ZeroTier ni el resto.',
    '2. Verificá cada hallazgo determinístico abriendo el código citado. Descartá',
    '   los que sean falsos positivos (p.ej. un runner corto idempotente que SÍ',
    '   sobrevive reinicios, o un módulo que ya consume el servicio por otra vía).',
    '3. Buscá MÁS incoherencias que el regex no ve: lógica DUPLICADA entre módulos',
    '   (ej. scraping de gh en tickets/sources.js y comms/shared.js con',
    '   cachés separadas), ESPEJOS back↔front que podrían divergir (ej.',
    '   tickets/derive.js vs su front), flujos que deberían consultar un motor',
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
    '    "foco": "módulo o archivo protagonista (p.ej. tickets, comms/shared.js)",',
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

// Parseo defensivo del texto del modelo — fábrica compartida (ver arriba).
export const parseCoherence = parser.parse;

// ===== Resultado persistido (sobrevive reinicios; el front lo encuesta) =====
const store = makeResultStore({
  file: COH_FILE, tag: 'coherence',
  empty: () => ({ updatedAt: null, resumen: null, propuestas: [], flujoNuevo: null, findings: [], error: null }),
});
export const readCoh = store.read;
export const writeCoh = store.write;

// ===== Lock/heartbeat del runner (patrón optimize/desk) =====
// Fábrica compartida: reserva pid:0 del server + reclamo del runner (ver
// makeLock en proposal-runner-shared.js — otherCohAlive exige pid real).
const lock = makeLock({ file: COH_LOCK, freshMs: COH_LOCK_FRESH_MS });
export const writeCohLock = lock.write;
export const clearCohLock = lock.clear;
export const readCohLock = lock.read;
export const isCohRunning = lock.isRunning;
export const otherCohAlive = lock.otherAlive;
