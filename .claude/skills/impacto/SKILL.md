---
name: impacto
description: "🕸️ Mapa de impacto (dependencias inversas) ANTES de tocar código: si modifico esto, ¿quién más depende, qué se rompe, y cómo funciona para OTROS usuarios? Barre cuatro ejes — quién lo llama · el otro lado · qué invariante lo blinda · multi-usuario — y devuelve una tabla donde cada fila con acción se convierte en TAREA del plan. Úsalo al armar cualquier plan de cambio y siempre que toques algo transversal: login, credenciales, rutas de datos, permisos, un endpoint compartido o un archivo hub."
argument-hint: "[qué vas a tocar: archivo, símbolo, ruta, endpoint, o la ref del plan]"
cwc-share: catalog
cwc-default: true
---

# 🕸️ Mapa de impacto

Antes de cambiar algo, averiguás **quién más vive de eso**. No es lo mismo que predecir qué
archivos vas a tocar: eso sirve para no chocar con otra sesión. Esto sirve para no entregar
algo roto por el lado que nadie miró.

## Por qué existe

Un plan se arma mirando **hacia adelante**: qué hay que hacer. El trabajo que se escapa casi
siempre está **hacia atrás**: el consumidor que llamaba a la función que cambiaste, la ficha
que ahora miente, el usuario que no es el que probaste. Nadie lo pierde por descuido — el plan
nunca lo tuvo, porque nadie hizo la pregunta inversa. Esa pregunta cuesta cinco minutos acá y
cuesta un ciclo entero de revisión si la hace quien recibe.

## Los cuatro ejes (barrelos todos, siempre en este orden)

### 1️⃣ ¿Quién lo llama?
Dependencias directas hacia lo que vas a tocar.
- `grep -rn "<nombre-del-archivo>"` y `grep -rn "<símbolo|export|constante>"` por el repo.
- Si es una ruta HTTP o WS: buscá la ruta como string, no solo el handler — el que la llama la
  tiene hardcodeada.
- Si es un archivo de datos o una carpeta de estado: buscá quién más la lee o la escribe,
  incluidos los procesos desacoplados.
- Si el proyecto tiene un censo o inventario generado, empezá por ahí antes que por el grep.

### 2️⃣ ¿Quién está del otro lado?
Lo que no aparece en un grep del mismo lenguaje o la misma capa.
- **Frontend ↔ backend:** un endpoint que cambia tiene un consumidor en la otra orilla.
- **Procesos desacoplados / CLIs / runners:** corren aparte y nadie los importa; se rompen en
  silencio y se enteran en runtime.
- **Documentación y fichas de contexto:** un `CLAUDE.md`, un README o un doc que describe lo
  que cambiaste queda MINTIENDO. Una ficha desactualizada no rompe un test: desinforma a la
  próxima sesión, que es peor.
- **Configuración, unidades de servicio, hooks, tareas programadas.**

### 3️⃣ ¿Qué lo blinda?
Reglas y chequeos que cubren ese código y que tu cambio podría violar o dejar sin sentido.
- Invariantes declarados, tests, chequeos de salud, reglas duras del `CLAUDE.md` del proyecto.
- Preguntá al revés también: si el cambio es correcto, **¿algún invariante quedó obsoleto?**
  Un invariante que ya no aplica es tan peligroso como uno violado.

### 4️⃣ ¿Cómo funciona para OTROS usuarios? _(el eje que más se olvida)_
Todo lo que probás, lo probás como vos. Preguntas obligatorias:
- ¿El dato o la ruta es **por usuario** o global? ¿Se resuelve con el helper de espacio de
  usuario, o hay una ruta del HOME hardcodeada que solo funciona para el dueño del server?
- ¿Funciona igual para alguien que **no es admin**? ¿Y para un usuario que no es el dueño?
- ¿Hay credenciales o permisos involucrados? Entonces: ¿cada usuario usa **las suyas**, o el
  cambio hace que alguien caiga a las de otro?
- ¿Qué pasa la primera vez, para un usuario **recién creado** que no tiene ese estado todavía?

## La tabla de salida

| Qué toco | Quién depende | Qué se rompe si no lo toco | Acción |
|---|---|---|---|
| `<archivo / símbolo / ruta>` | `<consumidor concreto, con archivo:línea>` | `<el síntoma real, no "podría fallar">` | 🆕 tarea nueva · ✅ ya está en el plan · ➖ sin acción (y por qué) |

Reglas de la tabla:
- **Una fila por dependencia real, con su ubicación citada.** «Podría afectar al frontend» no
  es una fila; `public/js/modules/x/y.js:120 llama a este endpoint` sí.
- **`➖ sin acción` lleva motivo.** Es la fila más importante: es la que demuestra que miraste
  y decidiste, en vez de no haber mirado.
- **Si un eje no arroja nada, escribilo igual.** Un eje vacío y un eje no barrido se ven
  idénticos tres días después.

## Qué hacés con el resultado

1. **Cada fila `🆕` se convierte en una TAREA del plan**, antes de cualquier gate o aprobación.
   Ese es el punto entero de la skill: el trabajo que se escapa entra al plan acá o no entra.
2. **Presentá la tabla a quien decide** junto al plan. Una fila `🆕` que nadie quiere hacer es
   una decisión legítima — pero es una decisión, no un olvido.
3. **Si aparece una dependencia que cambia el alcance** (tocar esto obliga a tocar aquello, y
   aquello estaba fuera de alcance), **no la absorbas en silencio**: es una enmienda al pedido
   original y la aprueba quien pidió.

## Umbral

No todo cambio necesita el barrido completo. Corré los cuatro ejes cuando: el cambio toca
autenticación, credenciales, permisos, rutas de datos o estado persistido; toca un archivo que
importa medio proyecto; cambia una firma pública, un endpoint o un formato de datos; o el
proyecto tiene más de un usuario. Para un cambio local y contenido, alcanza con el eje 1️⃣ —
pero corrélo, aunque sea corto.

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.
