---
name: probar
description: "🧪 Prueba que lo entregado CUMPLE lo pedido: que exista, que sea como se pidió, y que HAGA lo que tiene que hacer. Deriva de cada criterio de aceptación una prueba observable, la ejecuta por el método más barato que responda (CLI/API, UI headless, entorno efímero, humano) y registra la SALIDA REAL como evidencia. Úsalo antes de contrastar y antes de entregar cualquier cosa: sin prueba corrida, un criterio no está cumplido — está escrito."
argument-hint: "[ref del ítem anclado, o qué querés probar]"
cwc-share: catalog
cwc-default: true
---

# 🧪 Probar lo entregado

**Escrito no es hecho.** Revisar el diff responde «¿está el código?». Solo ejecutar responde
«¿anda?». Son dos preguntas distintas, y la segunda es la única que le importa a quien pidió.

## Por qué existe

Un criterio de aceptación puede tener el código correcto, en el archivo correcto, y aun así no
cumplirse: el botón está en el código pero no se renderiza; se renderiza pero no es rojo; es
rojo pero al apretarlo no pasa nada. Cada uno de esos tres estados se ve idéntico en un diff.
Lo que los distingue es haberlo corrido.

## Los tres niveles — los tres, siempre, en este orden

Frenar en el primero es el error más común, porque el primero es el más barato y el que más se
parece a estar listo.

1️⃣ **¿EXISTE?** — la cosa está donde se dijo que iba a estar. El botón aparece en esa sección,
   el endpoint responde, el campo llega en la respuesta, el archivo se genera.
2️⃣ **¿ES COMO SE PIDIÓ?** — tiene las características pedidas. El botón es rojo, está en esa
   posición, dice ese texto; el endpoint devuelve ese formato; el permiso es el correcto.
3️⃣ **¿HACE LO QUE TIENE QUE HACER?** — el comportamiento. Al apretar el botón pasa lo que se
   esperaba, y el estado queda como se esperaba.

**Un criterio con 1️⃣ y 2️⃣ en verde y 3️⃣ sin correr NO está probado.** Los dos primeros solo
aseguran que hay algo que probar; el tercero es el que prueba el pedido.

## Escalera de métodos — usá el más barato que REALMENTE responda la pregunta

| Método | Cuándo sirve | Cuándo NO alcanza |
|---|---|---|
| **CLI / API directa** | lógica, endpoints, formatos, permisos, archivos generados | no ve nada de lo que pasa en la interfaz |
| **UI headless** (navegador automatizado) | que un elemento exista, su texto, su color/estilo computado, y qué pasa al interactuar | flujos que dependen de estado externo real |
| **Entorno efímero** (copia aislada del sistema con sus datos) | flujos completos, migraciones, cualquier cosa destructiva | caro: levantalo solo si los de arriba no responden |
| **Humano** (quien pidió, o vos mirando) | criterios de percepción: «se entiende», «se ve bien» | no es reproducible: dejá anotado qué se miró y quién |

Regla de la escalera: **bajá un escalón solo cuando el de arriba no puede responder la
pregunta**, no cuando te resulte más cómodo. Y al revés: no declares probado por CLI algo que
el pedido describe en términos de interfaz.

## La tabla de pruebas (la salida de esta skill)

| Criterio | Nivel | Método | Comando o pasos exactos | Esperado | Salida REAL | Estado |
|---|---|---|---|---|---|---|
| `C1` | 1️⃣2️⃣3️⃣ | CLI / UI / efímero / humano | `<lo que se corrió, textual>` | `<lo que debía pasar>` | `<lo que efectivamente pasó>` | ✅ / ❌ / ⚠️ |

Estados: **✅ pasó** · **❌ falló** · **⚠️ NO SE PUDO CORRER** (con el motivo en la misma fila).

## Reglas duras

| 🔴 | Regla |
|---|---|
| 🔴 | **«Salida REAL» lleva lo que EFECTIVAMENTE devolvió**, pegado o resumido con fidelidad. Nunca lo que debería devolver. Si esa columna se llena con la expectativa, la prueba no probó nada y encima da confianza falsa. |
| 🔴 | **Una prueba que no se pudo correr se declara ⚠️, con su motivo.** Jamás se asume verde ni se borra la fila. Una fila ⚠️ visible es información; una fila ausente es una mentira por omisión. |
| 🟠 | **Probá el camino que va a hacer quien pidió**, no el que te resulta cómodo de instrumentar. Si el pedido dice «desde la pantalla X», probarlo por API responde otra pregunta. |
| 🟠 | **Probá también el caso negativo** cuando el criterio lo implica: que el permiso deniegue a quien debe denegar, que el error se muestre cuando debe. |
| 🟠 | **No pruebes contra tu propia expectativa: probá contra el criterio.** Releé el criterio del ancla antes de escribir la fila, no después de ver el resultado. |

## Qué hacés con cada estado

| Estado | Acción |
|---|---|
| ✅ | la fila queda como evidencia citable para el contraste |
| ❌ | **es una corrección, no una enmienda.** Arreglalo y volvé a correr la prueba. No lo negocies con quien pidió: el criterio ya estaba acordado |
| ⚠️ | **lo decide quien pidió.** Explicale qué no se pudo probar y por qué, y qué riesgo queda vivo si se entrega así |

## Enganche con el resto

Los criterios salen de la skill `anclar`; la tabla que produce esta skill es **la evidencia que
cita `contrastar`** en CP-Ω. Un criterio marcado 🟢 en el contraste cuya única evidencia es que
el código está escrito no está cubierto: le falta su fila de prueba. Corré `probar` ANTES de
contrastar, nunca después — el contraste sin pruebas es una revisión de intenciones.

## Umbral

Un typo o un cambio de texto no necesita tabla. Todo lo que agregue o cambie comportamiento
observable, sí. Ante la duda, corré al menos el nivel 3️⃣ del criterio principal.

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.
