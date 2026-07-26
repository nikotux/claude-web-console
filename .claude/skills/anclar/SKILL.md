---
name: anclar
description: "🧭 Paso 0 de CUALQUIER trabajo no trivial (CONVE-1957 / CONVE-1958): guarda el pedido original VERBATIM en Pad y destila sus criterios de aceptación observables, para que la resolución tenga un Norte contra el cual contrastarse. Úsalo al ARRANCAR un proyecto, ticket, PR, bug o refactor — antes de rutear, agrupar u orquestar. Sin ancla, el contraste final no tiene contra qué medir."
argument-hint: "[el pedido original, o la ref del ítem de Pad a anclar]"
---

# 🧭 Anclar el pedido original

Congelás el pedido tal como llegó y destilás qué significaría cumplirlo. Es el **Paso 0**:
corre ANTES de `rutear`, `agrupar` y `orquestar`. Convención madre: **CONVE-1957**;
obligaciones verificables: **CONVE-1958**.

## Por qué existe

Durante la resolución hay que adaptarse a lo que se encuentra. Esa adaptación es sana, pero
desde adentro es indistinguible de la deriva: se termina resolviendo un problema vecino al
pedido, no el pedido. Los chequeos técnicos verifican que nada se rompa; ninguno verifica
que lo hecho sea lo pedido.

## Pasos

1. **Identificá el ítem-raíz** del trabajo en Pad: un `PLAN` si es proyecto o feature, un
   `BUG` si es un bug, un `TASK` si es una tarea suelta, el ítem de `contexto-de-tickets`
   si viene de un ticket. Si no existe, creálo — es el sol de la constelación (Ley 1).
2. **Copiá el pedido VERBATIM.** Literal, sin parafrasear ni "mejorar la redacción". Si vino
   por voz, transcribilo tal cual y marcá SOLO los artefactos del dictado entre corchetes
   (p.ej. `pata [Pad]`). Si vino de un ticket de Zoho o un comentario de PR, citá el texto
   original con su fuente y fecha.
3. **Destilá criterios de aceptación OBSERVABLES**, numerados `C1`, `C2`, … Cada uno tiene
   que poder responderse con evidencia citable (un archivo, una ref de Pad, la salida de un
   comando). "Que quede bien" no es un criterio; "el pedido se guarda en Pad al arrancar" sí.
   Un pedido difuso NO se ancla con criterios difusos: preguntá antes de inventarlos.
4. **Declará el fuera de alcance.** La deriva más común es hacer de MÁS; sin este bloque no
   hay contra qué medirla. Si no hay nada explícito, escribilo así.
5. **Escribí las cuatro secciones** en el `content` del ítem-raíz:

```markdown
## 📌 Pedido original (verbatim) — INMUTABLE
> <texto literal>

## 🎯 Criterios de aceptación (observables)
1. **C1 · …**
2. **C2 · …**

## 🚫 Fuera de alcance

## 📝 Enmiendas (append-only)
| Fecha | Enmienda | Aprobó |
|---|---|---|
```

6. **GATE — mostrale el ancla a quien pidió** antes de arrancar: la tabla de criterios y el
   fuera de alcance. Es su última oportunidad barata de decir "no, lo que quiero es esto
   otro". Un criterio mal destilado contamina todos los contrastes posteriores.
7. **Enganchá lo que sigue:** el plan de ejecución cuelga de este ítem, y `rutear`/`agrupar`
   leen los criterios para verificar cobertura. Cerrá con el checkpoint **CP-0** corriendo
   la skill `contrastar` apenas el plan esté armado, antes del GO.

## Reglas duras del ancla

| 🔴 | Regla |
|---|---|
| 🔴 | El bloque verbatim **NUNCA se reescribe**. Si el objetivo se edita para que coincida con lo hecho, el contraste no puede fallar nunca — y deja de servir. |
| 🔴 | Adaptarse es legítimo, pero se registra como **ENMIENDA aprobada** en la tabla, con fecha y quién aprobó. Nunca como una edición silenciosa del pedido. |
| 🟠 | Un cambio de alcance lo aprueba **quien pidió**, no quien ejecuta. |

## Umbral

Trabajo trivial (un typo, una consulta) no necesita ancla. Mismo umbral que la Regla 11 del
`CLAUDE.md`: "trabajo no trivial". Ante la duda, anclarlo cuesta dos minutos.

## Mundos

En el mundo INTERNO el ancla se escribe en el Pad `console`. Para el mundo EXTERNO (Tolkien)
el ancla se escribe en el Pad `tolkien` desde una sesión de ESE mundo — nunca desde acá
(Regla 12: el cruce es por plan-puente, jamás una escritura directa).

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Fuente de verdad: `CONVE-1957` (convención) + `CONVE-1958` (contrato) en Pad `console`.
Si el procedimiento cambia, actualizá ahí primero y resincronizá este archivo.*
