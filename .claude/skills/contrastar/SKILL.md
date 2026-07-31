---
name: contrastar
description: "🧭 Contrasta el trabajo hecho contra el pedido original anclado en Pad (CONVE-1957 / CONVE-1958) y emite veredicto 🟢 alineado / 🟡 deriva recuperable / 🔴 cambio de alcance. Úsalo al cerrar CADA fase o bloque (CP-N) y SIEMPRE antes de entregar cualquier resultado (CP-Ω): la verificación de un cambio es técnica Y de intención. En CP-Ω suma una pasada PANORÁMICA que puede dar 🟡 aunque todas las filas den 🟢. Si detecta deriva, corregí y volvé a correrlo — iterar hasta 🟢 es el objetivo."
argument-hint: "[ref del ítem anclado] [CP-0 | CP-N:<fase> | CP-Ω]"
cwc-share: catalog
cwc-default: true
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

1. **Releé el ancla FRESCA de Pad** (`pad_item action=get`) — el verbatim, **la intención** y
   los criterios —, no de tu memoria de la conversación.
   La memoria ya está contaminada por el camino que tomaste: es exactamente
   el sesgo que este paso existe para corregir.
2. **Recolectá la evidencia real** de lo hecho: la **tabla de pruebas** (skill `probar`) con sus
   salidas reales, `git diff --name-only`, los ítems de Pad cerrados, la salida de los comandos
   de verificación, los archivos tocados. Evidencia observable, no tu recuerdo de haberlo hecho.
   **Si no hay tabla de pruebas, corré `probar` ANTES de seguir**: sin ella, lo único que podés
   contrastar es que el código está escrito, y «escrito» no es «hecho».
3. **Fila por criterio.** Para cada `C1`, `C2`, … decidí 🟢/🟡/🔴 y **citá la evidencia**. Una
   fila 🟢 sin evidencia citable NO cuenta como cubierta. Y en un criterio que describe
   comportamiento observable, **la evidencia válida es la salida de una prueba ejecutada**, no
   la existencia del código: «está implementado en `x.js:120`» responde «¿está escrito?», que es
   otra pregunta. Un criterio así con evidencia solo de código se marca 🟡, no 🟢 — le falta la
   prueba, y esa es justamente la deriva que este paso existe para pescar.
4. **Buscá las dos derivas**, que son distintas y ambas cuentan:
   - **de MENOS / distinto** — un criterio sin cubrir, o cubierto por algo que no es lo pedido.
   - **de MÁS** — trabajo hecho que no sirve a NINGÚN criterio, o que cae en el fuera de
     alcance. Esta es la que nadie detecta sola, porque se siente productiva.
5. **Pasada PANORÁMICA — obligatoria en CP-Ω.** Las filas se leen de a una; quien pidió recibe
   el resultado ENTERO. Un checklist con todas las filas en 🟢 puede entregar algo que igual no
   cumple: cada pieza encaja con su criterio y el conjunto no cierra. Cerrá el checklist y
   contestá tres preguntas:
   - **¿La SUMA de las piezas cumple el pedido?** Leé el verbatim y la intención de corrido y
     mirá el resultado como un todo, no criterio por criterio. Buscá los huecos **entre** las
     piezas: lo que ninguna fila cubría porque caía justo en la juntura.
   - **¿Qué se decidió EN VUELO y cambió la forma?** Recorré la tabla `## 📝 Enmiendas`, los
     `pad_item action=decide` y los comentarios de las fases o bloques. Lo que buscás no es una
     decisión mala: es la **cadena** — varias decisiones locales, cada una razonable, que
     sumadas corrieron el resultado. Si alguna redefinió el objetivo sin enmienda aprobada,
     eso es 🔴.
   - **¿Qué le va a FALTAR a quien recibe?** Ponete en su lugar el día que lo abre: qué es lo
     primero que va a intentar y si funciona, y qué va a preguntar.
   **Esta pasada puede emitir 🟡 con TODAS las filas en 🟢 — y cuando lo hace, ese es el
   veredicto que manda.** Es exactamente para lo que existe.
6. **Emití el veredicto** con este formato exacto, como comentario en el ítem anclado
   (`pad_item action=comment`):

```
🧭 CONTRASTE <CP-0|CP-N:fase|CP-Ω> · <fecha>
| Criterio | Estado | Prueba | Evidencia |
|---|---|---|---|
| C1 · … | 🟢/🟡/🔴 | ✅/❌/⚠️/— | <salida de la prueba, archivo:línea, ref de Pad> |
VEREDICTO: 🟢 alineado | 🟡 deriva recuperable | 🔴 cambio de alcance
DERIVA DETECTADA: <de más / de menos / distinto — o "ninguna">
PANORAMA: <la suma cumple? · decisiones en vuelo · qué le va a faltar — "n/a" fuera de CP-Ω>
ACCIÓN: <corrección + re-contraste | escalar al usuario | entregar>
PASADA: <n>/3
```

(la columna `Prueba` lleva `—` cuando el criterio no describe comportamiento observable y por tanto no aplica)

7. **Actuá según el veredicto:**

| Veredicto | Acción |
|---|---|
| 🟢 alineado | seguir (CP-0/CP-N) o entregar (CP-Ω) |
| 🟡 deriva recuperable | **corregir dentro del alcance y VOLVER A CORRER esta skill.** Iterar es lo esperado: "cinco o seis pasadas" es un resultado correcto, no un fracaso. |
| 🔴 cambio de alcance | **PARÁ.** No lo decidas solo: pedile a quien pidió una enmienda, y registrala en la tabla `## 📝 Enmiendas` del ancla si la aprueba. |

8. **Tope de convergencia:** 3 veredictos 🟡 seguidos sin llegar a 🟢 ⇒ escalá al usuario con el
   diagnóstico en vez de seguir ciclando. Iterar hasta converger es el objetivo; ciclar sin
   converger significa que el ancla o el plan están mal, y eso lo decide un humano.

## En CP-Ω, además

El contraste final es la **obligación 11 del cierre** (CONVE-1945): un cambio no está listo
para entregar con los chequeos técnicos en verde si el contraste no da 🟢. En CP-Ω corren
**las dos pasadas, en orden**: primero fila-por-criterio con evidencia, después la panorámica
del paso 5. Un resultado con todas las filas en 🟢 y el panorama en 🟡 **no se entrega**.

Y las dos pasadas se apoyan en una tercera cosa que ocurre ANTES: **las pruebas ejecutadas**
(skill `probar`). El orden es probar → contrastar, nunca al revés. Contrastar sin haber
ejecutado nada verifica que se escribió lo pedido; probar verifica que lo escrito hace lo
pedido. Entregar con lo primero y sin lo segundo es el modo más común de entregar algo roto
con todos los tildes en verde.

Presentá al usuario la tabla criterio·prueba·evidencia·veredicto, el renglón del panorama y el
resumen del trabajo — es lo que le permite ver en diez segundos que lo entregado es lo que
pidió, y que además anda.

## Honestidad del contraste

El que hizo el trabajo es el peor juez de si lo hizo. Dos defensas concretas: (a) evidencia
citable obligatoria por fila, y (b) releer el ancla de Pad antes de mirar el diff, nunca al
revés. Si te encontrás argumentando por qué un criterio "en realidad ya está cubierto", esa
es la señal de deriva, no la refutación de la deriva.

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Fuente de verdad: `CONVE-1957` + `CONVE-1958` en el workspace Pad del usuario.*
