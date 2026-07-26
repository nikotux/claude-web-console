---
name: contrastar
description: "🧭 Contrasta el trabajo hecho contra el pedido original anclado en Pad (CONVE-1957 / CONVE-1958) y emite veredicto 🟢 alineado / 🟡 deriva recuperable / 🔴 cambio de alcance. Úsalo al cerrar CADA fase o bloque (CP-N) y SIEMPRE antes de entregar cualquier resultado (CP-Ω): la verificación de un cambio es técnica Y de intención. Si detecta deriva, corregí y volvé a correrlo — iterar hasta 🟢 es el objetivo."
argument-hint: "[ref del ítem anclado] [CP-0 | CP-N:<fase> | CP-Ω]"
---

# 🧭 Contrastar contra el pedido original

Leés el ancla, mirás lo que realmente se hizo, y decidís si siguen siendo la misma cosa.
Convención madre: **CONVE-1957**; obligaciones: **CONVE-1958**.

## Los tres checkpoints

| Ancla | Checkpoint | Cuándo | Pregunta |
|---|---|---|---|
| 🟢 | **CP-0** | plan armado, antes del GO | ¿el plan cubre TODOS los criterios y nada que no sirva a ninguno? |
| 🟡 | **CP-N** | al cerrar cada fase o bloque | ¿lo hecho a qué criterio sirvió? ¿apareció trabajo huérfano? |
| 🔵 | **CP-Ω** | antes de entregar — obligatorio | criterio por criterio, con evidencia por fila |

## Pasos

1. **Releé el ancla FRESCA de Pad** (`pad_item action=get`), no de tu memoria de la
   conversación. La memoria ya está contaminada por el camino que tomaste: es exactamente
   el sesgo que este paso existe para corregir.
2. **Recolectá la evidencia real** de lo hecho: `git diff --name-only`, los ítems de Pad
   cerrados, la salida de los comandos de verificación, los archivos tocados. Evidencia
   observable, no tu recuerdo de haberlo hecho.
3. **Fila por criterio.** Para cada `C1`, `C2`, … decidí 🟢/🟡/🔴 y **citá la evidencia**.
   Una fila 🟢 sin evidencia citable NO cuenta como cubierta.
4. **Buscá las dos derivas**, que son distintas y ambas cuentan:
   - **de MENOS / distinto** — un criterio sin cubrir, o cubierto por algo que no es lo pedido.
   - **de MÁS** — trabajo hecho que no sirve a NINGÚN criterio, o que cae en el fuera de
     alcance. Esta es la que nadie detecta sola, porque se siente productiva.
5. **Emití el veredicto** con este formato exacto, como comentario en el ítem anclado
   (`pad_item action=comment`):

```
🧭 CONTRASTE <CP-0|CP-N:fase|CP-Ω> · <fecha>
| Criterio | Estado | Evidencia |
|---|---|---|
| C1 · … | 🟢/🟡/🔴 | <archivo:línea, ref de Pad, salida de comando> |
VEREDICTO: 🟢 alineado | 🟡 deriva recuperable | 🔴 cambio de alcance
DERIVA DETECTADA: <de más / de menos / distinto — o "ninguna">
ACCIÓN: <corrección + re-contraste | escalar a Niko | entregar>
PASADA: <n>/3
```

6. **Actuá según el veredicto:**

| Veredicto | Acción |
|---|---|
| 🟢 alineado | seguir (CP-0/CP-N) o entregar (CP-Ω) |
| 🟡 deriva recuperable | **corregir dentro del alcance y VOLVER A CORRER esta skill.** Iterar es lo esperado: "cinco o seis pasadas" es un resultado correcto, no un fracaso. |
| 🔴 cambio de alcance | **PARÁ.** No lo decidas solo: pedile a quien pidió una enmienda, y registrala en la tabla `## 📝 Enmiendas` del ancla si la aprueba. |

7. **Tope de convergencia:** 3 veredictos 🟡 seguidos sin llegar a 🟢 ⇒ escalá a Niko con el
   diagnóstico en vez de seguir ciclando. Iterar hasta converger es el objetivo; ciclar sin
   converger significa que el ancla o el plan están mal, y eso lo decide un humano.

## En CP-Ω, además

El contraste final es la **obligación 11 del cierre** (CONVE-1945): un cambio no está listo
para entregar con los chequeos técnicos en verde si el contraste no da 🟢. Presentá a Niko la
tabla criterio·evidencia·veredicto junto al resumen del trabajo — es lo que le permite ver
en diez segundos que lo entregado es lo que pidió.

## Honestidad del contraste

El que hizo el trabajo es el peor juez de si lo hizo. Dos defensas concretas: (a) evidencia
citable obligatoria por fila, y (b) releer el ancla de Pad antes de mirar el diff, nunca al
revés. Si te encontrás argumentando por qué un criterio "en realidad ya está cubierto", esa
es la señal de deriva, no la refutación de la deriva.

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Fuente de verdad: `CONVE-1957` + `CONVE-1958` en Pad `console`.*
