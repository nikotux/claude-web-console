# Evaluación estratégica — Rol de Pad en Mi Consola

**Fecha:** 2026-07-11 · **Autor:** Nicolás Mosquera (con Claude) · **Versión:** v01 · **Alcance:** decidir qué rol debe jugar Pad (getpad.dev) en el proyecto "Mi Consola", a la luz de la documentación oficial que NO se había consultado en la investigación previa (tema de Aprendizaje LT15).

> **ACTUALIZACIÓN 2026-07-12:** la recomendación de la sección 5 ("pilotear antes de comprometerse") se cumplió y la Opción 2 (self-host) SE EJECUTÓ — re-aprobada por un superior de Niko tras escalar el pedido inicialmente denegado, con la condición de binario local (no Docker) e impacto de recursos medido antes de aprobar. Fases 1 (instalación) y 2 (migración del workspace `console`, 104/104 items) completas; ver `docs/plan-migracion-pad-selfhost.md` (addendum de ejecución real) y `ROAD-74` en Pad. El workspace `tolkien` (Opción de "backbone" para ESE dominio) quedó deliberadamente fuera de este cutover — sigue en el cloud, `pad-client.js` sin cambios.

## Resumen ejecutivo

La investigación previa (LT15) concluyó "mantener `tasks`/`learning` privados y file-based; Pad = superficie secundaria" apoyándose, en parte, en una **asunción que ya estaba equivocada**: que el server de la consola "no puede usar el MCP de Pad". El propio LT15 la desmintió al encontrar `tickets/pad-client.js` (cliente MCP directo del backend). La documentación oficial agrega un dato decisivo que no teníamos: **Pad es open-source (Apache-2.0), se auto-hospeda con un binario Go + SQLite local, corre su PROPIO server MCP con un tool-surface idéntico al cloud, y funciona 100% offline.** Esto **resuelve los dos bloqueantes** que hacían inviable a Pad como columna vertebral (residencia de datos en nube ajena + pérdida de resiliencia/offline). Conclusión: la Opción "Pad como backbone" pasó de "no recomendada" a **genuinamente viable — pero SOLO en su variante self-hosted**, que es la única compatible con las reglas duras de Consola (todo local, privado, sobrevive reinicio). Se recomienda **NO rehacer nada ahora**: adoptar un camino por fases (profesionalizar el uso actual → pilotear self-host → migrar solo si el piloto convence).

## 1. Contexto y objetivo

- **Disparador:** al profesionalizar el workspace de Pad se descubrió que lo usábamos al ~30% de sus capacidades. Niko preguntó, con razón, si las asunciones sobre "para qué NO nos servía Pad" seguían válidas con la info oficial, o si había que **replantear y rehacer** el proyecto.
- **Objetivo de este documento:** dar una base de decisión con datos reales (no supuestos) sobre el ROL de Pad, separando dos preguntas que se estaban mezclando:
  - **Pregunta A (uso):** cómo modelar nuestro trabajo en el workspace (profesionalización). Bajo riesgo, reversible. *No es objeto de este doc — ya hay un plan aparte.*
  - **Pregunta B (rol):** ¿Pad debe REEMPLAZAR a los módulos internos `tasks`/`learning` y volverse la columna vertebral? Alto impacto arquitectónico. *Objeto de este doc.*

## 2. Metodología / fuentes

- Documentación oficial: [getpad.dev](https://www.getpad.dev/) + repo [PerpetualSoftware/pad](https://github.com/PerpetualSoftware/pad) (Apache-2.0, v0.9.2, jul 2026).
- Introspección del server MCP en vivo: `pad_meta tool-surface` (v0.8) + `pad_library` (catálogo de convenciones/playbooks).
- Código real de la consola: `src/modules/tickets/pad-client.js` (cliente MCP backend), `src/core/sdk-settings.js`, reglas duras de `CLAUDE.md`.
- Tema de Aprendizaje LT15 (asunciones y veredicto previos).

## 3. Hallazgos

### 3.1 Qué asunciones de LT15 cambian

| Asunción previa | Veredicto con info oficial |
|---|---|
| "El server no puede usar el MCP de Pad" | ❌ **Falsa** (ya lo era): `pad-client.js` es cliente MCP backend directo, lee el OAuth fresco de `~/.claude/.credentials.json` en cada llamada |
| "Pad es solo inspiración de diseño" | ❌ Falsa: hay integración de LECTURA real en producción (workspace `tolkien`) |
| "Playbooks/Conventions = más riesgo que CLAUDE.md" | 🔄 Replanteable: el modelo es sólido y hay biblioteca curada |
| "Mantener `tasks`/`learning` locales por privacidad + resiliencia" | ✅ **Sigue válida para el CLOUD** — pero el **self-host la neutraliza** (ver 3.2) |

### 3.2 El dato nuevo decisivo: Pad self-hosted

| Capacidad self-host (repo oficial) | Implicación para Consola |
|---|---|
| Binario Go único + SQLite en `~/.pad/pad.db` | Datos **100% en la máquina** — resuelve residencia de datos |
| **Full functionality offline** | Compatible con regla 2 (sobrevive reinicio, sin dependencia externa) |
| Corre su **propio server MCP**, tool-surface **idéntico** al cloud | `pad-client.js` y el MCP del chat funcionan contra el local **sin cambiar código** |
| Docker (`-p 127.0.0.1:7777`) / binary / Homebrew | Se puede bind a localhost o IP ZeroTier (regla 1) |
| Apache-2.0, datos en SQLite plano | **Sin lock-in**: si Pad muere, los datos salen con un `sqlite3 dump` |
| 90★, v0.9.2, releases ~semanales | Proyecto chico pero activo → riesgo de madurez moderado |

### 3.3 Las tres opciones de rol

| Opción | Qué es | Datos privados | Resiliencia/offline | Infra nueva | Migración | Alineación reglas duras |
|---|---|---|---|---|---|---|
| **1 — Superficie secundaria** (mejorada) | `tasks`/`learning` locales = fuente de verdad; Pad hosted = vista compartible/móvil, publicación 1-vía desde chat | Solo lo publicado a mano va a la nube | ✅ intacta (core local) | Ninguna | Ninguna | ✅ Alta |
| **2 — Self-host como backbone** | Correr Pad local; migrar `tasks`/`learning` a Pad; apuntar el MCP al local | ✅ Todo en la máquina | ✅ Full offline | 🟡 1 servicio más (systemd/Docker) + backups del `.db` | 🔴 Media-alta (reescribir 2 módulos) | ✅ Alta (self-host) |
| **3 — Hosted como backbone** | Migrar `tasks`/`learning` al `mcp.getpad.dev` | ❌ Todo en nube ajena | ❌ Rompe offline + acopla a OAuth frágil | Ninguna | 🔴 Media-alta | ❌ Choca con reglas 1/2/3 |

## 4. Análisis y riesgos

- **Opción 3 se descarta** para datos privados de dev: viola el ethos local/privado de Consola (reglas 1/3), rompe la resiliencia offline (regla 2) y depende del refresh de OAuth que el propio `pad-client.js` marca como pendiente/frágil ("el token vence en ~1h y lo refresca Claude Code, no la consola").
- **Opción 2 es la única "backbone" viable** y es sorprendentemente buena: resuelve los dos bloqueantes históricos. Riesgos reales a pesar de eso:
  - *Operacional:* un servicio más que mantener (arranque, backups del `~/.pad/pad.db`, upgrades semanales). Mitigable (binario único, SQLite, snapshots pre-migración automáticos).
  - *Madurez:* proyecto de 90★. Mitigado por Apache-2.0 + datos en SQLite plano (cero lock-in).
  - *Migración:* reescribir `tasks`/`learning` para hablar con Pad (vía el MCP backend o el CLI `pad`) es trabajo no trivial y con riesgo de regresión. Los módulos actuales **no están rotos**.
  - *Doble verdad transitoria:* durante la migración conviven archivo local + Pad; hay que evitar el sync bidireccional (la trampa que LT15 ya señaló).
- **Opción 1 es el status quo mejorado**, riesgo casi nulo, y NO cierra la puerta a la 2. Su límite: no aprovecha el modelo completo de Pad para el trabajo interno (sigue siendo dos sistemas).
- **Observación clave:** la decisión NO es binaria ni urgente. Los módulos `tasks`/`learning` funcionan. Se puede DES-RIESGAR con un camino por fases.

## 5. Recomendaciones (priorizadas)

1. **NO rehacer nada ahora.** La info nueva abre una puerta, no obliga a cruzarla en caliente.
2. **Adoptar la Opción 1 ya** (profesionalizar el workspace + Pad como superficie secundaria). Es un win reversible y prepara el terreno para evaluar la 2 con uso real.
3. **Pilotear la Opción 2 antes de comprometerse**, no migrar de una: levantar Pad self-hosted (Docker, bind ZeroTier/localhost) en paralelo, SIN tocar `tasks`/`learning`, y usarlo un tiempo para el tracking de este mismo programa. Medir: ¿aporta lo suficiente para justificar la migración y el servicio extra?
4. **Solo si el piloto convence**, planificar la migración de `tasks`/`learning` a Pad self-hosted como un proyecto propio (con su decision-doc de migración, 1-vía, sin sync bidireccional).
5. **Descartar la Opción 3** (hosted como backbone) para datos privados, salvo que Niko explícitamente acepte datos de dev en nube ajena.

## 6. Anexos

- **Comando de piloto self-host (referencia):** `docker run -p 127.0.0.1:7777:7777 -v pad-data:/data ghcr.io/perpetualsoftware/pad` → `pad init` → `pad mcp install`.
- **Puntos a investigar antes de un piloto:** cómo autentica el MCP local (¿token local vs OAuth?), cómo apuntar `pad-client.js`/`settingSources` a `127.0.0.1:7777` en vez de `mcp.getpad.dev`, política de backup del `~/.pad/pad.db` bajo el esquema `~/.cwc-backups`.
- **Nota de coherencia:** este documento ES, en sí mismo, el tipo de "registro de decisión" que Pad modela con `pad_item decide` / DOC categoría 'decision' — un buen primer caso de uso si se adopta la Opción 1.
