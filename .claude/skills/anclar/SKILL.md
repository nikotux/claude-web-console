---
name: anclar
description: "🧭 Paso 0 de CUALQUIER trabajo no trivial (CONVE-1957 / CONVE-1958): guarda el pedido original VERBATIM en Pad, captura su INTENCIÓN (por qué lo piden y para qué) y destila sus criterios de aceptación observables, para que la resolución tenga un Norte contra el cual contrastarse y un criterio de desempate ante bifurcaciones. Úsalo al ARRANCAR un proyecto, ticket, PR, bug o refactor — antes de rutear, agrupar u orquestar. Sin ancla, el contraste final no tiene contra qué medir."
argument-hint: "[el pedido original, o la ref del ítem de Pad a anclar]"
cwc-share: catalog
cwc-default: true
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
3. **Capturá la INTENCIÓN — el porqué y el para qué.** El verbatim guarda el QUÉ; esto guarda
   por qué lo piden y para qué sirve. Tres preguntas, respondidas con las palabras de quien
   pidió siempre que se pueda:
   - **¿Qué problema le resuelve?** — qué le duele hoy sin esto.
   - **¿Para qué lo va a usar?** — qué cambia en su día cuando esté.
   - **¿Cuál sería su señal de «esto sí es lo que quería»?** — el hecho observable que le
     haría decir que salió bien, más allá del cumplimiento literal.
   Si no lo sabés, **preguntá**: es la pregunta más barata de todo el trabajo. Inferir la
   intención es la forma más silenciosa de deriva, porque después todos la dan por sabida.
4. **Destilá criterios de aceptación OBSERVABLES**, numerados `C1`, `C2`, … Cada uno tiene
   que poder responderse con evidencia citable (un archivo, una ref de Pad, la salida de un
   comando). "Que quede bien" no es un criterio; "el pedido se guarda en Pad al arrancar" sí.
   Un pedido difuso NO se ancla con criterios difusos: preguntá antes de inventarlos.
   **Y declará CÓMO se probaría cada uno** — con qué comando, en qué pantalla, contra qué
   resultado esperado. Un criterio cuya prueba no se te ocurre todavía no es observable: es
   una intención bien redactada. Esa declaración es lo que después ejecuta la skill `probar`.
5. **Declará el fuera de alcance.** La deriva más común es hacer de MÁS; sin este bloque no
   hay contra qué medirla. Si no hay nada explícito, escribilo así.
6. **Escribí las cinco secciones** en el `content` del ítem-raíz:

```markdown
## 📌 Pedido original (verbatim) — INMUTABLE
> <texto literal>

## 🧭 Intención (por qué / para qué)
- **Problema que resuelve:** …
- **Para qué lo va a usar:** …
- **Señal de éxito de quien pidió:** …

## 🎯 Criterios de aceptación (observables)
1. **C1 · …**
2. **C2 · …**

## 🚫 Fuera de alcance

## 📝 Enmiendas (append-only)
| Fecha | Enmienda | Aprobó |
|---|---|---|
```

7. **GATE — mostrale el ancla a quien pidió** antes de arrancar: la intención, la tabla de criterios y el fuera de alcance.
   Es su última oportunidad barata de decir "no, lo que quiero es esto
   otro". Un criterio mal destilado contamina todos los contrastes posteriores.
8. **Enganchá lo que sigue:** el plan de ejecución cuelga de este ítem, y `rutear`/`agrupar`
   leen los criterios para verificar cobertura. Cerrá con el checkpoint **CP-0** corriendo
   la skill `contrastar` apenas el plan esté armado, antes del GO.

## Reglas duras del ancla

| 🔴 | Regla |
|---|---|
| 🔴 | El bloque verbatim **NUNCA se reescribe**. Si el objetivo se edita para que coincida con lo hecho, el contraste no puede fallar nunca — y deja de servir. |
| 🔴 | Adaptarse es legítimo, pero se registra como **ENMIENDA aprobada** en la tabla, con fecha y quién aprobó. Nunca como una edición silenciosa del pedido. |
| 🟠 | Un cambio de alcance lo aprueba **quien pidió**, no quien ejecuta. |
| 🔴 | La intención es el **criterio de desempate**. Ante una bifurcación durante la ejecución —dos formas razonables de hacer algo, un detalle que el pedido no cubre— se resuelve por la intención, NUNCA por conveniencia local de quien ejecuta. Si la intención tampoco lo resuelve, se pregunta; no se decide solo. |

## Umbral

Trabajo trivial (un typo, una consulta) no necesita ancla. Mismo umbral que la Regla 11 del
`CLAUDE.md`: "trabajo no trivial". Ante la duda, anclarlo cuesta dos minutos.

## Mundos

En el mundo INTERNO el ancla se escribe en el workspace de Pad del usuario que corre la
skill. Si sos el dueño de la consola puede ser `console`; si sos un inquilino es TU
workspace (`tenant-<usuario>`), nunca el de otro usuario. Para un mundo EXTERNO, el ancla
se escribe desde una sesión de ESE mundo — nunca desde el interno (Regla 12: el cruce es
por plan-puente, jamás una escritura directa).

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Fuente de verdad: `CONVE-1957` (convención) + `CONVE-1958` (contrato) en el workspace Pad
del usuario. Si el procedimiento cambia, actualizá ahí primero y resincronizá este archivo.*
