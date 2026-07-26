---
name: rutear
description: "🤝 Rutea las tareas de un plan de ejecución entre Claude/Tándem/Codex por NATURALEZA de la tarea (convención \"Ruteo de ejecución Tándem\", CONVE-558 / PLAYB-559): asigna {executor, modelo, esfuerzo} a cada tarea ANTES del GO para sacar la escritura de código de la ventana de Claude. Úsalo SIEMPRE que armes o cierres un plan de ejecución (trigger on-plan), en cualquier mundo — es el paso que precede a `agrupar`/`orquestar` cuando el plan es grande, o corre solo en un plan chico."
argument-hint: "[plan o lista de tareas a rutear] [world: interno|externo, opcional]"
---

# 🤝 Rutear un plan de ejecución (Tándem)

Desglosás un plan en tareas atómicas y le asignás a **cada una** su ruteo de ejecución — quién la hace, con qué modelo, con qué esfuerzo — ANTES de arrancar. El objetivo NO es ahorrar dinero (es suscripción): es no quemar la ventana de rate-limit de Claude sacando la generación de código a Codex.

## Pasos

1. **🧭 Verificá el ANCLA (Paso 0, CONVE-1957).** Antes de desglosar nada, el ítem-raíz del
   trabajo tiene que tener su `## 📌 Pedido original (verbatim)` y sus criterios de
   aceptación en Pad. Si no lo tiene, corré primero la skill `anclar` — rutear tareas que no
   se sabe a qué pedido sirven es exactamente cómo empieza la deriva.
2. **Desglosá** el plan en tareas/subtareas atómicas — una unidad de trabajo verificable cada una (mismo criterio que un ítem de Pad accionable, no una fase difusa).
3. **Clasificá la naturaleza** de cada tarea. Cuatro categorías, no más:
   - Diseño / arquitectura / prompt / contrato
   - Escribir código
   - Cableado trivial
   - Verificación E2E
4. **Asigná el ruteo** según el rúbrico:

   | Naturaleza | Ejecutor | Modelo | Esfuerzo |
   |---|---|---|---|
   | Diseño/prompt/contrato | Claude | opus\|sonnet | high (xhigh/max si es crítico) |
   | Escribir código | **Tándem** (Claude razona/verifica + Codex ejecuta) | **opus** | **high PINNED** (Codex gpt-5.6-sol corre en high) |
   | Cableado trivial | Claude | haiku | low |
   | Verificación E2E | Claude | sonnet\|opus | high |

5. **Agrupá por EJECUTOR antes de repartir sesiones.** Entrar o salir de Tándem **re-lanza el runner** (BUG-780: el flag `--tandem` es de SPAWN, no se cambia en caliente; `_maybeReopenForTandem` con throttle de 30 s y solo si la sesión está viva y ociosa). Por eso **una sesión = UN ejecutor**: tareas de ejecutor distinto o van a sesiones/bloques distintos, o se aceptan explícitamente los respawns. Dentro de una sesión Tándem, hasta el "cableado trivial" pasa por Codex — el hook `PreToolUse` deniega TODA escritura de Claude (Edit/Write/MultiEdit y también las de Bash: redirecciones, `sed -i`, `mv`/`cp`/`tee`…), salvo destino absoluto bajo `/tmp/`.
6. **Persistí** cada tarea en la colección Tasks del Pad del mundo correspondiente (campos `model`/`effort`/`executor`), colgada de su PLAN padre.
7. **Presentá** a Niko la tabla de ruteo completa + el ahorro estimado (cuántas tareas van a Codex vs a Claude puro) **antes del GO**. Es un gate, no un trámite: Niko puede reasignar cualquier fila.
8. **🧭 Cerrá con CP-0.** Con la tabla de ruteo lista y antes del GO, corré la skill
   `contrastar` en modo `CP-0`: ¿el plan cubre TODOS los criterios del ancla, y hay alguna
   tarea que no sirva a ninguno? Una tarea huérfana en esta etapa cuesta borrar una fila;
   descubierta al final cuesta rehacer el trabajo.

## Gotchas de spawn (si el plan se va a orquestar)
- `POST /api/chat/create` acepta `model:'tandem'` pero **NO** la config fina del protocolo. El razonador/ejecutor alternativos se fijan DESPUÉS con `POST /api/chat/model {model:'tandem', tandem:{reasonerModel,reasonerEffort,codexModel,codexEffort}}`.
- **Tándem es el default del sistema**: un `create` SIN `model` ya nace en Tándem. Si una tarea necesita Claude puro, pedilo explícito en el body.
- Verificá que agarró: el campo `tandemActive` de `/api/chat/list` (`false`/`null` = el motor vivo todavía no corre en Tándem).

## Argumentos

- `plan` (requerido): el plan o la lista de tareas a rutear.
- `world` (opcional): `interno` | `externo`. Si es `externo` (Tolkien), el resultado de este paso NO se escribe directo — se empaqueta en un **plan-puente** (Regla 12 / Limbo: el mundo interno se resuelve PRIMERO y por completo, la inyección a Tolkien es el ÚLTIMO paso, nunca al revés).

## Cuándo se combina con `agrupar`/`orquestar`

Un plan CHICO se ratea acá y listo — una sola sesión lo ejecuta de corrido con su tabla de ruteo. Un plan GRANDE (varios bloques en paralelo, superficie de archivos grande) primero pasa por acá tarea por tarea, y RECIÉN DESPUÉS por `agrupar` (agrupa esas tareas ya ruteadas en bloques por colisión de archivos + arma el DAG) y `orquestar` (las dirige). El ruteo es siempre el primer paso — no tiene sentido agrupar tareas que todavía no saben quién las ejecuta.

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Actualizado 2026-07-21: razonador de Tándem = Opus/high pinned (antes sonnet/medium) · Tándem = default del sistema · ruteo por BLOQUE por el coste de respawn.*
*Fuente de verdad: `PLAYB-559` en Pad `console`. Si el procedimiento cambia, actualizar ahí primero y resincronizar este archivo.*
