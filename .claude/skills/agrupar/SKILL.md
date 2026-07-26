---
name: agrupar
description: "🧭 Paso ARQUITECTO del Orquestador Interno (PLAN-642 / CONVE-654): agrupa las tareas de un plan en BLOQUES por COLISIÓN de archivos + arma el DAG de dependencias, y lo materializa en Pad como PLANes-bloque + links. Úsalo tras atomizar un plan (ítems + ruteo CONVE-558) y ANTES de orquestar: es lo que deja el Pad listo para la skill `orquestar`. Corre en el mundo interno (Pad console)."
argument-hint: "[PLAN-umbrella a agrupar en bloques]"
---

# 🧭 Agrupar en bloques (paso Arquitecto)

Convertís un plan atomizado (tareas con ruteo) en **bloques ejecutables en paralelo** + su **DAG**, y lo dejás materializado en Pad para que la skill `orquestar` lo dirija. Es el "paso nuevo" que la metodología suma al modo arquitecto de siempre.

## Principio
**Paralelo solo lo que NO colisiona.** Dos tareas que tocan el **mismo archivo** deben ir en el **mismo bloque** (una sola sesión controla esa fase) — es la regla de oro (`health/pool.js`) elevada a dato del plan. La predicción de colisión en tiempo de diseño es **best-effort**; la red de seguridad en runtime son los **claims del interfono** (`evaluateClaim`), que detectan la colisión real.

**Segundo criterio de corte: el EJECUTOR.** Un bloque no solo agrupa por archivo compartido — también agrupa por ejecutor del ruteo (Claude puro vs 🤝 Tándem). Entrar/salir de Tándem re-lanza el runner (BUG-780: `--tandem` es flag de SPAWN), así que mezclar ejecutores dentro de una sesión-bloque paga un respawn por salto. **Un bloque = un ejecutor.**

## Dos naturalezas, no confundirlas
- **(A) COLISIÓN = mecánica.** Se calcula: predecís los archivos de cada tarea → grafo (aristas entre tareas que comparten archivo) → **un bloque = un componente conexo**.
- **(B) DEPENDENCIA lógica = humana.** "B necesita el resultado de A" NO es colisión: lo declara el arquitecto desde el **orden de fases** del plan. Vos proponés las aristas del DAG; **Niko las confirma**.

## Algoritmo
1. **Predecí los archivos por tarea** (`files`). Fuente: la descripción de la tarea + el **inventario** del proyecto (`~/.cwc-data/inventory.md`, generado por `core/inventory.js`). Guardá la predicción en la tarea (campo/nota `files`).
2. **Grafo de colisión** → componentes conexos → **bloques candidatos**.
3. **Partí cada componente por EJECUTOR.** Si un componente conexo mezcla tareas ruteadas a Claude puro y a Tándem, partilo en un bloque por ejecutor — salvo que compartan archivo, en cuyo caso el bloque entero va a Tándem (dentro de Tándem, Claude no puede escribir: el hook `PreToolUse` deniega Edit/Write y las escrituras por Bash salvo `/tmp`, así que hasta el cableado trivial lo hace Codex).
4. **HUB-files** (archivos que TODOS tocan: `registry.js`, `server.js`, `tokens.css`, `CLAUDE.md`, `health/invariants.js`): NO colapses todo en un bloque gigante. Agrupá por el archivo **primario** de cada tarea y creá un **BLOQUE DE INTEGRACIÓN** que corre ÚLTIMO y hace solo el cableado del hub → preserva el paralelismo.
5. **Archivos desconocidos** (no predecibles): la tarea va en su **propio bloque** + **flag** (los claims runtime son la red).
6. **DAG lógico**: agregá las aristas `blocked-by` entre bloques según las fases (B usa A → B blocked-by A). El bloque de integración/E2E queda `blocked-by` todos los de código.

## GATE (obligatorio) — proponé, NO crees a ciegas
Presentá a Niko: la tabla de **bloques** (id · tareas que contiene · superficie de archivos · ruteo · ready/needs-atomize) + el **DAG** (aristas). Esperá su **OK o ajuste** (fusionar/partir bloques, cambiar una dependencia). **Recién con el OK** materializás.

**🧭 Cobertura contra el ancla (CONVE-1957).** En la misma tabla, sumá una columna
`criterios` con los criterios del ancla (`C1`, `C2`, …) a los que sirve cada bloque. Dos
señales que se leen de un vistazo: un **criterio sin ningún bloque** = el plan no cubre lo
pedido; un **bloque sin ningún criterio** = trabajo que nadie pidió. Las dos se arreglan
acá gratis.

## Materializar en Pad (modelo de datos)
- **Bloque = PLAN hijo** del umbrella. Reusá sub-planes existentes como bloques cuando mapeen limpio (menos duplicación); creá PLANes nuevos solo para bloques que cruzan varios sub-planes (típico: el de integración/E2E).
- **Tareas = PEND/TASK** hijas del PLAN-bloque (re-parentá las existentes; para un bloque sin tareas aún, agregá una 1ª tarea `atomizar` ruteada a Claude opus/high = sub-sesión arquitecto).
- **DAG = links** `pad_item action=link ref=<bloque> target=<bloqueador> link_type=blocked-by`.
- **Ancla de control**: dejá un **comentario en el PLAN umbrella** con el mapa completo (bloques→PLAN-ref, DAG, ready-state, caveats de deploy) — es lo que lee la skill `orquestar` al arrancar.
- Marcá los bloques ya en curso (si hay una sesión viva) para que el orquestador no los re-spawnee.
- **Ancla heredada**: cada PLAN-bloque referencia el ítem-raíz anclado del umbrella (por `parent` o `implements`), para que la sesión-bloque pueda leer el pedido original sin reconstruirlo.

## Cierre
Avisá a Niko que el Pad quedó listo y que el próximo paso es abrir la skill `orquestar` en una sesión nueva apuntada al umbrella. Cerrá con `🎾 Pelota: …`.

## Ruteo (CONVE-558) por naturaleza de tarea
diseño/contrato → Claude opus/sonnet high · escribir código → Tándem (**opus** razona/verifica + Codex gpt-5.6-sol ejecuta) **high pinned** · cableado trivial → Claude haiku low · verificación E2E → Claude sonnet/opus high. Cada tarea del bloque lleva su `{executor, model, effort}` — así cada paso corre en su modelo óptimo (ahorro de ventana) y una reejecución no cae en un modelo caro por defecto. Cada bloque hereda UN ejecutor (ver Principio); el `{model, effort}` fino por tarea solo varía DENTRO del mismo ejecutor.
