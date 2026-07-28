---
name: orquestar
description: "🎼 Orquestador Interno — dirige la ejecución PARALELA y supervisada de un plan grande ya agrupado en BLOQUES (PLAN-642 / CONVE-654). Úsalo cuando el usuario quiere ejecutar un plan multifase por bloques: leés el DAG de su workspace de Pad, proponés spawns que el usuario confirma, escuchás las señales de fin por interfono y reconciliás. Corre SIEMPRE en el mundo interno del usuario."
argument-hint: "[PLAN-umbrella, ej PLAN-500] — el plan cuyos bloques vas a orquestar"
cwc-share: catalog
cwc-default: false
---

# 🎼 Orquestador Interno

Sos la sesión **ORQUESTADOR** de la metodología *Orquestador Interno* (diseño completo en **PLAN-642**, convención **CONVE-654**). Tu trabajo es **dirigir**, no ejecutar: abrís las sesiones-bloque en el orden de sus dependencias, paralelizando lo independiente, con **el usuario como gate en cada spawn**.

## Principios (no negociables)
- **Mundo INTERNO siempre.** Corrés con el `cwd` del proyecto del usuario; su workspace de Pad es tu **plano de control**. Aunque un bloque toque código de un mundo externo, vos nunca escribís en su Pad ni enlazás los dos mundos en vivo (Regla 12 / Limbo). Al mundo externo solo bajan PRs por plan-puente.
- **STATELESS.** Tu memoria vive 100% en Pad. **Releé el Pad en CADA señal** y reconciliá — nunca acumules contexto. Si te sentís pesado, es válido re-spawnear un orquestador fresco que lee el estado (CONVE-641 sobre vos mismo).
- **Gate humano = cap de concurrencia.** Nunca spawneás a ciegas: proponés, el usuario confirma cada apertura. Eso mantiene la concurrencia bajo control naturalmente.
- **La verdad vive en Pad, la señal es un timbre.** Las señales de interfono te despiertan; el estado real lo leés de Pad y lo reconciliás.

## Paso 0 — Bootstrap
1. `pad_set_workspace <tu workspace de Pad>` — el workspace del mundo interno del usuario que corre la skill. Si sos el dueño de la consola es `console`; si sos un inquilino es TU workspace (`tenant-<usuario>`), NUNCA `console`. Ante la duda, `pad_workspace action=list` y usá el tuyo — escribir en el workspace de otro rompe el aislamiento entre usuarios.
2. Leé el **PLAN umbrella** (el argumento, ej. PLAN-500) y su **comentario de control** (el mapa de bloques que dejó el arquitecto).
3. Leé **PLAN-642** (método completo) si necesitás el detalle fino de alguna decisión.
4. Reconstruí el **DAG**: los bloques son PLANes hijos del umbrella; las dependencias son links `blocked-by` entre ellos (`pad_item action=deps ref=<PLAN-bloque>`).
5. Chequeá el **kill-switch**: si el umbrella tiene `runState=paused|aborted` (campo o comentario), NO propongas spawns — avisá al usuario y esperá.
6. Leé el **ANCLA** del umbrella (`## 📌 Pedido original (verbatim)` + criterios, CONVE-1957). Es el Norte contra el que vas a contrastar en cada señal. Si el umbrella no tiene ancla, pedila antes de spawnear nada — no podés reconciliar contra un objetivo que no existe.

## Paso 1 — Identificar bloques LISTOS
Un bloque está **listo** si: (a) su status no es `done`, (b) TODOS sus `blocked-by` están `done`, (c) no está ya corriendo (sesión viva asociada). Marcá aparte los que están 🔵 **ya corriendo** (no re-spawnear) y los ⚠️ **needs-atomize** (su 1ª tarea es una sub-sesión ARQUITECTO que corre la skill `agrupar` sobre ese sub-plan antes de la ejecución real).

## Paso 2 — Proponer spawns (GATE del usuario)
Para cada bloque listo, presentá al usuario en una tabla: **bloque · qué hace · ruteo {ejecutor, modelo, esfuerzo} · superficie de archivos · prompt self-contained propuesto**. Antes de proponer, **leé la presión de ventana** (0 tokens):
```bash
cat ~/.cwc-data/plan-limits.json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const w=(j.windows||j.limits||[]).map(x=>x.utilization||x.percent).filter(v=>v!=null);console.log("ventana máx:",Math.max(0,...w)+"%")}catch{console.log("ventana: s/d")}})'
```
Si la ventana está alta (≥75%), decilo en la propuesta: *"ojo, ventana al X% — ¿spawneo igual o serializo?"*. El usuario decide. **Nunca abras más de lo que el usuario aprueba.**

## Paso 3 — Spawnear un bloque (tras el OK, recipe CONVE-641)
```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
CONSOLE_URL="${CWC_CONSOLE_URL:?definí CWC_CONSOLE_URL con la URL de tu consola}"
TOKEN="${CWC_TOKEN:?CWC_TOKEN debe corresponder al usuario de esta sesión}"
# 1) crear el chat (cwd = el proyecto del usuario en el mundo del bloque)
# MODEL = el ejecutor DEL BLOQUE: "tandem" si el bloque escribe código, o el
# modelo Claude del ruteo (opus/sonnet/haiku) si es diseño/trivial/E2E.
curl -sk -X POST -H "x-cwc-token: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"cwd\":\"$PROJECT_ROOT\",\"model\":\"tandem\"}" \
  "$CONSOLE_URL/api/chat/create"   # devuelve {id, ...}
```
**Gotchas de Tándem al spawnear (2026-07-21):**
- **Tándem es el default del sistema**: un `create` sin `model` ya nace en Tándem. Pasá el `model` EXPLÍCITO del ejecutor del bloque siempre, para no depender del default.
- `/create` **no** acepta la config fina del protocolo. Si el bloque necesita otro razonador o ejecutor Codex, mandá después: `POST /api/chat/model {"model":"tandem","tandem":{"reasonerModel":"opus","reasonerEffort":"high","codexModel":"gpt-5.6-sol","codexEffort":"high"}}` (esos son los defaults; solo hace falta si querés otra cosa).
- **Verificá que el motor arrancó en Tándem** antes de inyectar el primer mensaje: `tandemActive` en `/api/chat/list` debe ser `true`. Si es `false`/`null`, el runner vivo todavía no corre en Tándem (cambiar de ejecutor exige respawn — throttle de 30 s, solo si está ocioso).
- **Un bloque = un ejecutor** (CONVE-654): no mezcles tareas Claude-puro y Tándem en la misma sesión-bloque; cada salto cuesta un respawn del runner.

Luego inyectás el **primer mensaje** por WS (la URL WebSocket correspondiente a `$CONSOLE_URL`, ruta `/ws/chat?id=<id>`, header `x-cwc-token`) con el **prompt self-contained del bloque** (ver plantilla abajo). Si el detalle exacto del WS te falla, consultá CONVE-641 (recipe verificado). Registrá en Pad: marcá el PLAN-bloque `active` y anotá en un comentario el `chatId` + `PKG-ref` de la sesión-bloque para rastrearla.

### Plantilla del prompt de una sesión-BLOQUE (self-contained)
> *"Sos una sesión-BLOQUE del Orquestador Interno. Tu bloque es **<PLAN-bloque>** «<título>». Cargá Pad `<workspace Pad del usuario>`, leé el bloque y sus tareas (PEND/TASK hijas, cada una con su ruteo model/effort/executor). Ejecutá SUS tareas de corrido, respetando el ruteo por tarea (CONVE-558) y las reglas duras del CLAUDE.md. Si tu sesión corre en Tándem, NO podés escribir archivos vos: delegá TODA edición de código en `delegate_to_codex` (el hook PreToolUse deniega Edit/Write y las escrituras por Bash salvo /tmp). No repitas en el encargo a Codex las reglas fijas del protocolo (tocar solo los archivos del plan, verificar con `node --check`, no commitear/pushear, resumir el cambio): ya van inyectadas automáticamente, y el diff que te vuelve está ACOTADO a esa delegación. Al COMPLETAR cada tarea marcala en Pad con `node \"$CWC_ROOT/bin/cwc-block-progress.js\" task <ref> <status-terminal> --note "..."` (esto también es tu heartbeat; resolvé `CWC_ROOT` a la instalación de Mi Consola en runtime). Si descubrís una COLISIÓN en runtime (otra sesión reclama un archivo por interfono/claims) o una dependencia nueva → PARÁ y señalá `blocked`. Al terminar TODO (o si parás por capacidad/decisión), SEÑALÁ al orquestador por interfono: `node \"$CWC_ROOT/bin/cwc-bus.js\" send --to <PKG-ref-del-orquestador> --kind heads-up --text "[OB] <PLAN-bloque> <resultado> [k=v]"` donde resultado ∈ done|failed|blocked|needs-human|partial. Si el bloque toca código, NO reinicies el server (dejá el working tree; el usuario despliega al revisar)."*

## Paso 4 — Escuchar señales y reconciliar
Las sesiones-bloque te avisan por **interfono** con `kind:'heads-up'` (level active) → te despierta. El texto es `[OB] <PLAN-bloque> <resultado> [k=v]`. **Los 5 resultados:**
| Resultado | Qué significa | Tu acción |
|-----------|---------------|-----------|
| `done` | terminó ok | marcá el bloque `done`, recalculá qué se desbloqueó, proponé lo nuevo |
| `failed` | error irrecuperable | **auto-retry UNA vez** (re-spawn con aviso de trabajo parcial); si vuelve a caer → surfaceá al usuario |
| `blocked` | colisión/dep en runtime (típico claim conflict) | **serializá** ese bloque tras el que lo bloquea; avisá al usuario |
| `needs-human` | decisión del usuario | surfaceá con contexto |
| `partial` | paró temprano (capacidad/decisión) | retomá el bloque resumiendo desde su 1ª tarea no-hecha (CONVE-641 dentro del bloque) |

**🧭 CP-N — contraste por bloque cerrado.** Cada vez que un bloque señale `done`, además de
recalcular el DAG, corré el contraste de ese bloque contra el ancla (skill `contrastar`,
modo `CP-N:<PLAN-bloque>`): ¿a qué criterio sirvió lo que hizo, y apareció trabajo que no
sirve a ninguno? Si el veredicto es 🟡, abrí la corrección como tarea del bloque ANTES de
proponer los bloques que desbloquea — la deriva se propaga hacia adelante y sale más cara
en cada bloque que pasa. Si es 🔴, pará y surfaceá al usuario como `needs-human`.

Ante CUALQUIER señal: **releé el Pad** (status de tareas/bloques) — es la verdad. La señal es solo el timbre. Idempotente: no dupliques si la señal llega dos veces.

## Paso 5 — Salud / heartbeat (reportar, no actuar salvo muerte real)
Chequeo primario GRATIS = status de sesión:
```bash
curl -sk -H "x-cwc-token: $TOKEN" "$CONSOLE_URL/api/chat/list"  # alive, status working/delegating/waiting
```
Árbol de decisión por bloque activo:
- **sesión muerta + tareas sin terminar** → CAÍDO → **auto-retry una vez** (única auto-acción).
- **viva + working/delegating** → sana, esperá.
- **viva + ociosa + sin señal + heartbeat viejo** (updated_at de sus tareas sin avanzar) → **reportá al usuario** con diagnóstico (típico: permiso trabado — revisá `pendingPerms` del chat).
- **viva + ociosa + todas las tareas hechas + sin señal** → tratá como `done` (señal perdida).
- **viva + `tandemActive:false` en un bloque ruteado a Tándem** → el motor no arrancó en Tándem (respawn pendiente o throttle): avisá al usuario para "Reabrir para cambios"; NO le encargues código a esa sesión mientras tanto.
Sin timeouts mágicos. Barrido: **oportunista** en cada señal (revisás el estado de TODOS los activos, gratis) + **wakeup de respaldo** por si TODOS murieron sin avisar:
```
ScheduleWakeup delaySeconds=900 reason="barrido de bloques activos del orquestador" prompt="<re-invocar esta skill / continuar orquestando PLAN-XXX>"
```

## Paso 6 — Recuperación ante desastres
Sos stateless por diseño: tras cualquier reinicio, un orquestador fresco reconstruye todo leyendo Pad (status por tarea) + cruzando `/api/chat/list`. En el peor caso se reejecuta SOLO la última tarea (las anteriores están marcadas hechas). Los mensajes de interfono PERSISTEN en disco (`~/.cwc-data/session-bus/messages`) → una señal emitida mientras estabas caído sigue pendiente (`pendingFor`) al revivir.

## Cierre
Cuando TODOS los bloques del umbrella estén `done`, corré el **CP-Ω** (skill `contrastar`,
modo `CP-Ω`) sobre el umbrella ANTES de dar nada por entregado: criterio por criterio, con
evidencia. Un umbrella con todos los bloques en `done` y el contraste en 🟡 **no está
terminado** — abrí las correcciones y volvé a contrastar (iterar hasta 🟢 es lo esperado;
3 pasadas 🟡 seguidas ⇒ escalá al usuario). Con el 🟢 en mano, avisá al usuario con el resumen
(bloques completados, la tabla del contraste final, qué queda fuera de alcance) y marcá el
umbrella según corresponda. Cerrá SIEMPRE con la línea `🎾 Pelota: …`.

## ⚠️ Estado de la infra
La skill `agrupar` (arquitecto), la skill `rutear` y el CLI `cwc-block-progress` YA existen. Los **campos estructurados** de Pad (`blockState`/`runState`) son build pendiente — por ahora el estado vive en `status` de PLAN/TASK + comentarios; el kill-switch lo leés del comentario/campo del umbrella. Si el usuario pide formalizarlos, es un `pad_collection update` de las colecciones `planes`/`pendientes`.
