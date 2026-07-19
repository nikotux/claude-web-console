---
name: rutear
description: "🤝 Rutea las tareas de un plan de ejecución entre Claude/Tándem/Codex por NATURALEZA de la tarea (convención \"Ruteo de ejecución Tándem\", CONVE-558 / PLAYB-559): asigna {executor, modelo, esfuerzo} a cada tarea ANTES del GO para sacar la escritura de código de la ventana de Claude. Úsalo SIEMPRE que armes o cierres un plan de ejecución (trigger on-plan), en cualquier mundo — es el paso que precede a `agrupar`/`orquestar` cuando el plan es grande, o corre solo en un plan chico."
argument-hint: "[plan o lista de tareas a rutear] [world: interno|externo, opcional]"
---

# 🤝 Rutear un plan de ejecución (Tándem)

Desglosás un plan en tareas atómicas y le asignás a **cada una** su ruteo de ejecución — quién la hace, con qué modelo, con qué esfuerzo — ANTES de arrancar. El objetivo NO es ahorrar dinero (es suscripción): es no quemar la ventana de rate-limit de Claude sacando la generación de código a Codex.

## Pasos

1. **Desglosá** el plan en tareas/subtareas atómicas — una unidad de trabajo verificable cada una (mismo criterio que un ítem de Pad accionable, no una fase difusa).
2. **Clasificá la naturaleza** de cada tarea. Cuatro categorías, no más:
   - Diseño / arquitectura / prompt / contrato
   - Escribir código
   - Cableado trivial
   - Verificación E2E
3. **Asigná el ruteo** según el rúbrico:

   | Naturaleza | Ejecutor | Modelo | Esfuerzo |
   |---|---|---|---|
   | Diseño/prompt/contrato | Claude | opus\|sonnet | high (xhigh/max si es crítico) |
   | Escribir código | **Tándem** (Claude razona/verifica + Codex ejecuta) | sonnet | medium (Codex corre en high) |
   | Cableado trivial | Claude | haiku | low |
   | Verificación E2E | Claude | sonnet\|opus | high |

4. **Persistí** cada tarea en la colección Tasks del Pad del mundo correspondiente (campos `model`/`effort`/`executor`), colgada de su PLAN padre.
5. **Presentá** a Niko la tabla de ruteo completa + el ahorro estimado (cuántas tareas van a Codex vs a Claude puro) **antes del GO**. Es un gate, no un trámite: Niko puede reasignar cualquier fila.

## Argumentos

- `plan` (requerido): el plan o la lista de tareas a rutear.
- `world` (opcional): `interno` | `externo`. Si es `externo` (Tolkien), el resultado de este paso NO se escribe directo — se empaqueta en un **plan-puente** (Regla 12 / Limbo: el mundo interno se resuelve PRIMERO y por completo, la inyección a Tolkien es el ÚLTIMO paso, nunca al revés).

## Cuándo se combina con `agrupar`/`orquestar`

Un plan CHICO se ratea acá y listo — una sola sesión lo ejecuta de corrido con su tabla de ruteo. Un plan GRANDE (varios bloques en paralelo, superficie de archivos grande) primero pasa por acá tarea por tarea, y RECIÉN DESPUÉS por `agrupar` (agrupa esas tareas ya ruteadas en bloques por colisión de archivos + arma el DAG) y `orquestar` (las dirige). El ruteo es siempre el primer paso — no tiene sentido agrupar tareas que todavía no saben quién las ejecuta.

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Fuente de verdad: `PLAYB-559` en Pad `console`. Si el procedimiento cambia, actualizar ahí primero y resincronizar este archivo.*
