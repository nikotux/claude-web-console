# AutoTux — Análisis completo del router de modelo para revisión externa

**Fecha:** 2026-07-10 · **Autor:** Nicolás Mosquera (asistido por Claude Code) · **Versión:** v01
**Alcance:** algoritmo de selección automática de modelo (`AutoTux`) del chat de la consola Claude Web Console.
**Objetivo del documento:** entregar a un experto externo TODO lo necesario para auditar el algoritmo y devolver recomendaciones accionables, SIN acceso al repositorio.
**Idioma:** español (default del estándar documental interno). Los identificadores de código conservan su nombre original. Si el revisor es angloparlante, se traduce a pedido.

---

## Resumen ejecutivo

`AutoTux` es un router in-process que, en cada turno del usuario, decide si sube o baja el modelo de la conversación dentro de una escala `haiku → sonnet → opus → fable` (barato → caro), buscando usar el modelo más barato que resuelva bien cada turno. Combina tres señales: (1) una **heurística de costo 0** sobre el texto, (2) un **clasificador Haiku** para mensajes ambiguos y (3) un **escalado reactivo** por cantidad de herramientas usadas. Una **histéresis asimétrica** gobierna las transiciones: subir es inmediato, bajar exige 3 turnos "simples" seguidos.

**El problema que motiva la revisión:** los datos reales muestran que, en la práctica, AutoTux se comporta como un **flip-flop entre Sonnet y Opus** — nunca usa Haiku ni Fable, sube 49 veces por cada 13 que baja, y en al menos un chat oscila Opus↔Sonnet 11 veces en 4 horas (rebotes de 4-6 minutos). El diseño parece sesgar el sistema hacia el modelo caro en vez de ahorrar. Queremos una segunda opinión experta sobre **el algoritmo de decisión y sus umbrales** antes de rediseñarlo.

**Lo que pedimos al experto:** ver §7 (preguntas concretas). En una línea: *¿cómo rediseñarías la lógica de decisión + histéresis para minimizar costo sin degradar la calidad percibida, dado que el sistema hoy queda pegado en Opus?*

---

## 1. Contexto del sistema

| Campo | Valor |
|---|---|
| Producto | Consola web personal sobre Claude Code (un solo usuario/dueño) |
| Superficie | Chat interactivo del SDK de Claude (`@anthropic-ai/claude-agent-sdk`) |
| Modelos disponibles | `haiku`, `sonnet`, `opus`, `fable` (alias del CLI de Claude Code) |
| Precios relativos (API-equivalente, in/out por Mtok) | haiku 1/5 · sonnet 3/15 · opus 5/25 · **fable 10/50** |
| Naturaleza | Suscripción del CLI (no factura por token); el "costo" es un equivalente a precios de API usado como proxy de consumo |
| Restricción de latencia | El cambio de modelo NO debe demorar el turno del usuario. Clasificar con Haiku tarda ~2-3 s solo de arranque, por eso corre en segundo plano |
| Persistencia | El router es plomería in-process; solo persiste un contador chico de histéresis por chat. El nivel se deriva del modelo actual, no se duplica |

**Regla de activación (importante):** AutoTux SOLO gestiona un chat si su modelo elegido es literalmente `auto`. Si el usuario fuerza `sonnet`/`opus`/`fable`/`haiku`/`opusplan`/`default` desde el selector, el router queda **inerte** para ese chat. Todo chat nuevo nace en `auto`.

---

## 2. Escala de modelos y "techo"

```
índice:     0        1        2        3
nivel:    haiku → sonnet → opus  →  fable
                            ▲
                      HEURISTIC_CEILING
```

- El **índice** ES el nivel (se deriva de `chat.model`).
- **Techo automático en `opus` (índice 2):** ninguna de las tres señales automáticas sugiere jamás `fable`. Subir a `fable` es SOLO manual.
  - Razón documentada: con solo 16 cambios manuales de `/model` en el historial real del usuario, no había señal estadística confiable para distinguir "tarea que amerita Opus" de "tarea que amerita Fable" — pueden verse idénticas en texto. Se prefirió no arriesgar el modelo más caro de forma automática.

---

## 3. Estructura de funcionamiento (flujo completo turno a turno)

### 3.1 Diagrama del ciclo

```
Usuario manda un mensaje  ──►  sendUser(text)
                                   │
                                   ├─(1) _applyModelRouter(text)   [SINCRÓNICO, 0 costo]
                                   │        │
                                   │        ├─ modelChoice ≠ 'auto' ────────► return (inerte)
                                   │        │
                                   │        ├─ decideModelForTurn(text)
                                   │        │      │
                                   │        │      ├─ heurística da nivel concreto
                                   │        │      │     └─► applyHysteresis ─► setModel si cambió
                                   │        │      │
                                   │        │      └─ heurística "ambigua" (null)
                                   │        │            └─► lanza clasificador Haiku
                                   │        │                 EN SEGUNDO PLANO (fire-and-forget)
                                   │        │                 └─► al volver: applyHysteresis ─► setModel
                                   │        │                     (gobierna el PRÓXIMO turno)
                                   │        ▼
                                   ├─(2) el turno se procesa con el modelo vigente
                                   │        │  (se cuentan las tool_use: _turnToolCount++)
                                   │        ▼
                                   └─(3) turno termina → estado 'waiting'
                                            └─ _applyReactiveEscalation()
                                                 └─ si _turnToolCount ≥ 6 ► sube 1 escalón
                                                    (para el PRÓXIMO turno)
```

### 3.2 Señal 1 — Heurística de costo 0 (`classifyHeuristic`)

Mira **solo el texto** del turno. Devuelve un índice sugerido o `null` (ambiguo).

| Condición (en orden) | Resultado |
|---|---|
| Texto vacío | `null` |
| `length ≤ 60` **y** matchea `TRIVIAL_RE` | **0 (haiku)** |
| Contiene ` ``` ` (code fence) | **2 (opus = techo)** |
| `length ≥ 800` caracteres | **2 (opus = techo)** |
| Cualquier otra cosa | `null` (ambiguo → no toca nada) |

`TRIVIAL_RE` (confirmaciones/saludos):
```
/^(ok(ay)?|dale|listo|gracias|perfecto|genial|buen[ií]simo|excelente|s[ií]|no|
   de acuerdo|correcto|entendido|continuemos?|sigamos?|dale,?\s*gracias)[.!¡¿?]*$/i
```

> **Nota de diseño discutible:** un mensaje con code fence o ≥800 chars salta **directo a Opus** (el techo), sin pasar por Sonnet. Pegar un log de error, un stack trace o una función "para dar contexto" ya dispara Opus.

### 3.3 Señal 2 — Clasificador Haiku para ambiguos (`classifyComplexity`)

Cuando la heurística devuelve `null`, se consulta a **Haiku** (1 turno, sin herramientas, timeout 20 s) con este prompt:

> *"Clasificá la COMPLEJIDAD de este pedido… Respondé UNA sola palabra: 'trivial' (saludo, confirmación, charla liviana), 'normal' (pregunta o tarea acotada, dificultad media) o 'complejo' (requiere código, análisis profundo, o tocar varias partes de un sistema)."*

- Mapeo: `trivial→0 (haiku)`, `normal→1 (sonnet)`, `complejo→2 (opus)`.
- Corre **en segundo plano** (fire-and-forget): no demora el turno actual; si contesta a tiempo, gobierna el **próximo** turno.
- Guarda `_routerClassifying` evita clasificar dos turnos en paralelo del mismo chat.
- Sin caché ni throttle: cualquier turno ambiguo dispara una nueva llamada.
- Costo documentado: clasificar con Haiku en cada turno es ~0,005 % del costo total (considerado insignificante por diseño).

### 3.4 Señal 3 — Escalado reactivo (`reactiveEscalation`)

Al **terminar** un turno (transición a `waiting`):

| Condición | Acción |
|---|---|
| Nivel actual ya en el techo (`≥ opus`) | no aplica |
| `toolCallsInTurn < REACTIVE_TOOL_THRESHOLD` (=6) | no aplica |
| `toolCallsInTurn ≥ 6` | **sube 1 escalón** para el próximo turno |

- `_turnToolCount` cuenta **cualquier** `tool_use` del turno (Read, Edit, Bash, etc.), es efímero (no persiste) y se resetea a 0 al empezar cada turno.
- Racional: "si un turno usó muchas herramientas, el nivel se quedó corto" (heurística estilo cascada FrugalGPT). No corrige el turno pasado, previene hacia adelante.

### 3.5 Histéresis (`applyHysteresis`) — el corazón del sistema

Dado un `suggestion` concreto (nunca null), un `currentLevel` y un contador `downStreak`:

| Caso | Comportamiento |
|---|---|
| `suggestion > currentLevel` (subir) | **inmediato**, este mismo turno. Resetea `downStreak` a 0 |
| `suggestion < currentLevel` (bajar) | incrementa `downStreak`. Solo baja **1 escalón** cuando `downStreak ≥ 3` (`DOWN_STREAK_TO_DEMOTE`). Si no, se queda igual |
| `suggestion == currentLevel` | sin cambio; resetea `downStreak` a 0 |

**Asimetría deliberada:** subir cuesta 1 turno; bajar cuesta 3 turnos "simples" **consecutivos** (cualquier turno "normal" o "complejo" en el medio resetea la racha). Bajar de Opus a Haiku requiere, en la práctica, **dos** rachas completas de 3 (baja de a un escalón).

### 3.6 Persistencia, visibilidad y logging

- Se persiste por chat: `routerDownStreak` (contador de histéresis) y `modelChoice`. El nivel NO se persiste (se deriva de `model`).
- `logDecision()` escribe append-only en `~/.cwc-data/model-router-log.jsonl` cada cambio automático: `{ts, chatId, sessionId, source: heuristic|classifier|reactive, from, to, text}`. Es **solo observación** para calibrar; nada se relee para decidir en caliente.
- El usuario ve un badge "🤖 AutoTux: <nivel>" y una nota inline cuando el router cambia el modelo solo.

---

## 4. Datos reales de comportamiento

### 4.1 Log de decisiones del router (señal LIMPIA del algoritmo)

Fuente: `model-router-log.jsonl`, 62 decisiones automáticas sobre 40 chats distintos (desde 2026-07-06, cuando se activó).

| Métrica | Valor |
|---|---|
| Total de decisiones automáticas | 62 |
| Por origen | classifier **27** · heuristic **23** · reactive **12** |
| Subidas vs bajadas | **49 subidas** / **13 bajadas** / 0 laterales |
| Transiciones observadas | `sonnet→opus` ×49 · `opus→sonnet` ×13 |
| Transiciones que tocan haiku o fable | **0** (¡nunca!) |
| Chats con ≥3 cambios (candidatos a rebote) | 4 |

Desglose por origen y dirección:

| Origen | Subidas | Bajadas |
|---|---|---|
| heuristic | 21 | 2 |
| classifier | 16 | 11 |
| reactive | 12 | 0 |

**Lectura:** en la práctica AutoTux es un **flip-flop de 1 bit entre Sonnet y Opus**. El nivel Haiku (0) y el nivel Fable (3) nunca se ejercitan. El detector de trivialidades prácticamente no logra bajar por debajo de Sonnet (haría falta encadenar rachas de 3 turnos simples, cosa que casi nunca ocurre en trabajo real).

### 4.2 Evidencia de rebote (yo-yo)

Chat `c3046810-1` — 11 cambios de modelo en ~3,5 h:
```
18:33  heuristic   sonnet→opus
20:04  classifier  opus→sonnet
20:10  classifier  sonnet→opus     ← rebote en 6 min
20:50  classifier  opus→sonnet
20:57  reactive    sonnet→opus     ← rebote en 7 min
21:05  classifier  opus→sonnet
21:08  classifier  sonnet→opus     ← rebote en 3 min
21:23  classifier  opus→sonnet
21:26  classifier  sonnet→opus     ← rebote en 3 min
22:02  heuristic   opus→sonnet
22:09  reactive    sonnet→opus     ← rebote en 7 min
```
Cada subida a Opus paga el contexto completo del hilo a precio Opus para 1-2 turnos, antes de que el clasificador lo revierta. La histéresis (bajada lenta) **no** amortigua esto porque las **subidas** son las que rebotan, y subir no tiene inercia.

### 4.3 Consumo por modelo (señal CONTAMINADA — leer con cuidado)

Fuente: `usage-history.json`, costo API-equivalente, últimos 7 días.

| Modelo | Costo 7 días |
|---|---|
| opus | $852.40 |
| fable | $472.66 |
| sonnet | $240.31 |
| haiku | $8.34 |

> **Caveat honesto y central:** este $ NO es atribuible limpio al router. (a) El **Fable** (día 04-05, ~$437) es 100 % elección manual — el router nunca lo toca. (b) Varios chats corren con modelo **forzado manualmente** (incluida la sesión que generó este documento, puesta en Opus a mano). (c) El router solo media Sonnet↔Opus en los chats en `auto`. Por eso, para juzgar **el algoritmo**, la señal válida es el log de §4.1 (62 decisiones limpias), no el gasto agregado. El gasto solo confirma la dirección: entre los modelos que el router SÍ maneja, Opus domina ampliamente.

---

## 5. Pre-diagnóstico interno (hipótesis a validar/refutar por el experto)

> Esto es NUESTRA lectura. Parte del valor del experto es confirmar, refutar o reordenar estos puntos.

| # | Debilidad hipotética | Evidencia | Efecto sobre costo |
|---|---|---|---|
| D1 | **Salto directo al techo:** code fence o ≥800 chars van de Sonnet a Opus sin pasar por Sonnet | `classifyHeuristic` mapea ambas a `HEURISTIC_CEILING` | Pegar código/logs para dar contexto ya cuesta Opus, aunque la tarea sea simple |
| D2 | **Histéresis asimétrica extrema:** subir=1 turno, bajar=3 seguidos | 49 subidas vs 13 bajadas en el log | El sistema tiende a "trepar y quedarse"; casi nunca vuelve a bajar |
| D3 | **Haiku y Fable inertes:** el rango efectivo es solo Sonnet↔Opus | 0/62 transiciones tocan haiku o fable | Se pierde todo el ahorro potencial de Haiku en charla/confirmaciones |
| D4 | **Rebote (yo-yo):** el clasificador cambia de opinión turno a turno | chat con 11 flips, rebotes de 3-7 min | Subidas repetidas a Opus por 1-2 turnos cada una |
| D5 | **Escalado reactivo tosco:** ≥6 tool_use ⇒ sube, sin distinguir "tarea con muchos archivos" de "modelo insuficiente" | 12/12 reactivas son subidas, 0 se revirtieron rápido | Sube a Opus por volumen de herramientas, no por dificultad real |
| D6 | **Clasificador sin memoria:** cada turno ambiguo dispara una llamada Haiku nueva | 27/62 decisiones vienen del clasificador | Costo chico pero constante; y su volatilidad alimenta D4 |

---

## 6. Restricciones de diseño INAMOVIBLES

El experto debe respetarlas al proponer cambios (no son negociables):

1. **Cero latencia añadida al turno del usuario.** Toda consulta a un modelo (p. ej. clasificador) corre en segundo plano y gobierna, como mucho, el turno siguiente.
2. **El techo automático en Opus se puede discutir, pero subir a Fable automáticamente es de altísimo riesgo** (Fable es 2× Opus en precio). Cualquier propuesta que lo habilite necesita una señal muy sólida.
3. **Estado mínimo persistido.** El router es plomería in-process; sobrevive reinicios solo con un contador chico. No se desea introducir estado pesado ni servicios nuevos.
4. **Sin costo de decisión desproporcionado.** Está OK gastar Haiku para clasificar (es ~0,005 % del total), pero no está OK una cascada que consulte modelos caros para decidir.
5. **El cambio de modelo reusa el mecanismo existente** (`setModel` → `q.setModel()` del SDK). No hay que reinventar la aplicación del cambio, solo la **decisión**.
6. **Un solo usuario, confianza plena, uso real variado** (código, análisis, charla, operaciones sobre el repo). No hay dataset etiquetado grande; el historial de cambios manuales es de ~16-60 eventos.

---

## 7. Preguntas concretas para el experto

1. **Histéresis:** ¿cómo balancearías subir/bajar para evitar el "trepar y quedarse" sin volverte inestable? ¿Simetría? ¿Bajada por tiempo/inactividad además de por rachas? ¿Cooldown anti-rebote tras una subida?
2. **Salto de escalones:** ¿tiene sentido que "trae código" salte directo a Opus, o debería subir de a un escalón (Sonnet primero) y dejar que el escalado reactivo decida Opus solo si el turno realmente lo necesita?
3. **Rango muerto (Haiku/Fable):** ¿cómo lograr que Haiku se use de verdad en turnos livianos sin generar rebotes molestos? ¿Vale la pena que Fable siga 100 % manual?
4. **Señal reactiva:** ¿conteo bruto de tool_use es buena señal de "modelo insuficiente"? ¿Qué señal usarías (reintentos, errores de herramienta, longitud/efímera de la respuesta, tokens de salida) para distinguir "tarea grande" de "tarea difícil"?
5. **Clasificador:** ¿mantener el clasificador Haiku por turno ambiguo, o cachear/throttlear? ¿Un umbral de confianza para no cambiar por señales débiles?
6. **Marco general:** ¿este problema se modela mejor como (a) máquina de estados con histéresis, (b) política tipo bandit/RL con la señal de "hubo que escalar" como recompensa negativa, o (c) cascada pura FrugalGPT (arrancar barato, escalar ante fallo)? ¿Por qué?
7. **Métrica objetivo:** ¿cómo definirías "éxito" para medir un rediseño con los datos que tenemos (solo el log de decisiones + costo por modelo, sin etiquetas de calidad)?

---

## 8. Anexo A — Constantes y umbrales (referencia rápida)

| Constante | Valor | Significado |
|---|---|---|
| `MODEL_LEVELS` | `['haiku','sonnet','opus','fable']` | escala barato→caro; índice = nivel |
| `HEURISTIC_CEILING` | `2` (opus) | techo de todas las señales automáticas |
| `DOWN_STREAK_TO_DEMOTE` | `3` | turnos simples seguidos para bajar 1 escalón |
| `LONG_MESSAGE_CHARS` | `800` | umbral de "mensaje largo" → Opus |
| `REACTIVE_TOOL_THRESHOLD` | `6` | tool_use en un turno para subir 1 escalón |
| `ROUTER_CLASSIFY_TIMEOUT_MS` | `20000` | timeout del clasificador Haiku |
| trivial max length | `60` | largo máximo para considerar un mensaje "trivial" |

---

## 9. Anexo B — Código fuente íntegro del núcleo (`core/model-router.js`)

> Fuente de verdad del algoritmo. El clasificador Haiku (`classifyComplexity`) y los call-sites (`_applyModelRouter`, `_applyReactiveEscalation`) viven en `modules/chat/index.js` y se resumen abajo.

```js
export const MODEL_LEVELS = ['haiku', 'sonnet', 'opus', 'fable'];
const HEURISTIC_CEILING = MODEL_LEVELS.indexOf('opus'); // 2
const DOWN_STREAK_TO_DEMOTE = 3;

const TRIVIAL_RE = /^(ok(ay)?|dale|listo|gracias|perfecto|genial|buen[ií]simo|excelente|s[ií]|no|de acuerdo|correcto|entendido|continuemos?|sigamos?|dale,?\s*gracias)[.!¡¿?]*$/i;
const CODE_FENCE_RE = /```/;
const LONG_MESSAGE_CHARS = 800;

// Heurística 0-costo: mira SOLO el texto. Devuelve índice sugerido o null (ambiguo).
export function classifyHeuristic(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.length <= 60 && TRIVIAL_RE.test(t)) return 0;      // haiku
  if (CODE_FENCE_RE.test(t)) return HEURISTIC_CEILING;      // trae código -> opus
  if (t.length >= LONG_MESSAGE_CHARS) return HEURISTIC_CEILING; // largo -> opus
  return null;                                              // ambiguo: no tocar nada
}

// Histéresis: subir es inmediato; bajar exige DOWN_STREAK_TO_DEMOTE turnos simples seguidos.
export function applyHysteresis({ currentLevel, suggestion, downStreak = 0 }) {
  if (suggestion > currentLevel) {
    return { level: suggestion, downStreak: 0, changed: true };            // sube YA
  }
  if (suggestion < currentLevel) {
    const streak = downStreak + 1;
    if (streak >= DOWN_STREAK_TO_DEMOTE) {
      return { level: currentLevel - 1, downStreak: 0, changed: true };    // baja 1 escalón
    }
    return { level: currentLevel, downStreak: streak, changed: false };
  }
  return { level: currentLevel, downStreak: 0, changed: false };            // igual
}

// Decisión del turno usando SOLO la heurística. ambiguous:true => el llamador consulta a Haiku.
export function decideModelForTurn({ currentModel, text, downStreak = 0 }) {
  const currentLevel = MODEL_LEVELS.indexOf(currentModel);
  if (currentLevel === -1) return null;                    // modelo no gestionado (opusplan/default)
  const suggestion = classifyHeuristic(text);
  if (suggestion === null) {
    return { level: currentLevel, downStreak, changed: false, ambiguous: true };
  }
  return { ...applyHysteresis({ currentLevel, suggestion, downStreak }), ambiguous: false };
}

const REACTIVE_TOOL_THRESHOLD = 6;

// Escalado reactivo: al terminar un turno, si usó muchas herramientas, sube 1 escalón.
export function reactiveEscalation({ currentLevel, toolCallsInTurn }) {
  if (currentLevel === -1 || currentLevel >= HEURISTIC_CEILING) return null;
  if ((toolCallsInTurn || 0) < REACTIVE_TOOL_THRESHOLD) return null;
  return { level: currentLevel + 1, downStreak: 0, changed: true };
}
```

### Resumen de los call-sites (`modules/chat/index.js`)

- `sendUser(text)` → llama `_applyModelRouter(text)` **antes** de mandar el turno (sincrónico, 0 costo).
- `_applyModelRouter(text)`:
  - si `modelChoice !== 'auto'` → return (inerte);
  - `decideModelForTurn(...)`; si `changed` → `setModel(next, {auto:true})` + `logDecision('heuristic')`;
  - si `ambiguous` → dispara `classifyComplexity()` en segundo plano (guarda `_routerClassifying`); al volver, `applyHysteresis` → `setModel` + `logDecision('classifier')`.
- Durante el turno, cada `tool_use` incrementa `_turnToolCount`.
- Al pasar a `waiting` (fin de turno) → `_applyReactiveEscalation()`: `reactiveEscalation(...)`; si sube → `setModel(next, {auto:true})` + `logDecision('reactive')`; luego `_turnToolCount = 0`.
- `classifyComplexity({cwd, text})`: query Haiku, 1 turno, **sin herramientas** (doble bloqueo de tools), timeout 20 s; devuelve `trivial|normal|complejo` → índice 0/1/2, o `null` ante error/timeout.

---

## 10. Fundamentos de diseño citados (contexto para el experto)

El diseño original cita explícitamente:
- **RouteLLM / FrugalGPT:** la cascada "arrancar barato y escalar si hace falta" rinde mejor que predecir la complejidad de antemano.
- **Historial real del usuario:** ~16 cambios manuales de `/model` confirmaron un patrón reactivo (escala cuando algo se queda corto), no anticipado.
- **`opusplan` (precedente de Claude Code):** valida "la fase de la tarea decide el modelo", pero es un switch binario sin memoria; AutoTux agrega la histéresis.
- **Costo de clasificar:** medido en ~0,005 % del total → clasificar con Haiku se consideró gratis.

---

*Fin del documento. Cualquier propuesta del experto se integrará como plan de cambios sobre `core/model-router.js` y sus call-sites, respetando las restricciones de la §6.*
