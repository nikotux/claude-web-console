# Plan de migración — Pad self-hosted como backbone (proyecto futuro)

**Fecha:** 2026-07-11 · **Autor:** Nicolás Mosquera (con Claude) · **Versión:** v01 · **Estado:** ✅ **EJECUTADO (Fases 1-2 completas, 2026-07-11/12)** — ver addendum abajo. · **Alcance:** levantar Pad de forma LOCAL (self-hosted) y evaluar/migrar `tasks`/`learning` hacia él.

> Este documento es la Opción 2 del decision-doc `docs/evaluacion-rol-pad.md`. Se ejecuta DESPUÉS de aprobado el proyecto. Hasta entonces, Pad se usa en la nube como superficie secundaria profesionalizada (Opción 1, ya hecha).

## ⚡ ADDENDUM — Ejecución real (2026-07-11/12), difiere del plan original en varios puntos

El plan de abajo (v01) fue el DISEÑO original y queda como HISTORIA para entender el razonamiento — la EJECUCIÓN real difirió en varios puntos clave, resumidos acá:

1. **BINARIO, no Docker.** El pedido de self-host fue denegado, ESCALADO y RE-APROBADO por un superior de Niko con la condición explícita de instalación como **binario local en una carpeta**, sin contenedores. Se usó `~/.local/bin/pad` (v0.9.2, checksum verificado) + systemd de usuario `pad-local.service` — NUNCA `docker run`.
2. **Recursos:** `CPUQuota=200%` (2 núcleos de holgura, pedido explícito de Niko — no reserva exclusiva) + `MemoryMax=4G`/`MemoryHigh=3G` (techo sobredimensionado para crecer). Medido con un benchmark aislado y descartable en `/tmp/pad-bench` (HOME sobreescrito, reversible) ANTES de la aprobación final — los números reales fueron parte de lo que destrabó el "sí" del superior.
3. **Bind por ZeroTier** (no solo localhost) — pedido explícito de Niko, accesible igual que la propia Consola.
4. **MCP: transporte STDIO, no HTTP.** Hallazgo clave no anticipado en el plan original: el binario local de Pad NO expone un endpoint MCP HTTP — solo habla MCP por stdio (`pad mcp serve`, spawneado como subproceso). `pad mcp install` tampoco soporta Claude Code como agente (solo claude-desktop/cursor/windsurf) — se cableó a mano: `claude mcp add --scope local pad -- ~/.local/bin/pad mcp serve --url http://10.213.222.192:7777`.
5. **Auth: browser-based, no token en archivo.** `pad auth login` abre un flujo OAuth-like en el navegador — Niko lo aprobó él mismo con su cuenta admin (recién creada vía el link de setup one-time), sin que la sesión de Claude tocara su password en ningún momento.
6. **Fase 2 (migración de datos) SÍ se ejecutó** — a diferencia del plan original que hablaba de `tasks`/`learning` (los módulos file-based de Consola), lo que realmente se migró fue el **workspace de Pad `console`** (Docs/Bugs/Tasks-de-Pad/Conventions/Playbooks/Roadmap Items/Roles — 104/104 items, 1-vía, verificado conteo por conteo con 4 agentes en paralelo). `tasks`/`learning` (los módulos propios de Consola) NO se tocaron — siguen file-based, fuera de este proyecto.
7. **Alcance del cutover — SOLO `console`, NUNCA `tolkien`.** Decisión explícita de Niko (2026-07-12): el workspace `tolkien` de Pad (usado por `src/modules/tickets/pad-client.js`) se dejó fuera — el Pad local no lo tiene y migrarlo es un proyecto aparte (impacto en equipo, Chris/otros pueden usar ese workspace en la nube). `pad-client.js` sigue sin tocarse, leyendo Tolkien desde el cloud.
8. **Nomenclatura final:** `pad` (nombre canónico) = local self-hosted, primario. `pad-cloud-backup` = el cloud original, conservado SOLO como respaldo pasivo durante la ventana de pruebas (nunca operativo tras el cutover).
9. **Fase 3 (adaptación técnica) se acotó** a la conexión MCP del chat (renombrada como arriba) — el cliente backend `pad-client.js` quedó explícitamente FUERA de la Fase 3 por la decisión del punto 7.

Detalle completo (con decision log) en Pad mismo: `ROAD-74` del workspace `console` (ahora en el propio Pad local).

## Resumen ejecutivo

Levantar una instancia LOCAL de Pad (binario Go + SQLite en `~/.pad/pad.db`, su propio server MCP con tool-surface idéntico al cloud, full offline) bajo el ethos local/privado de Consola (bind ZeroTier/localhost, systemd de usuario, backup del `.db`). Resuelve residencia de datos + resiliencia. Se hace por FASES: (1) piloto sin tocar `tasks`/`learning`; (2) medir; (3) migrar 1-vía solo si el piloto convence. NUNCA sync bidireccional.

## Fase 0 — Preflight (verificar antes de tocar nada)

- [ ] `docker --version` disponible (o decidir binario/Homebrew). Preferencia: Docker (aislado, reversible).
- [ ] Espacio en disco + que `~/.pad/` no exista todavía.
- [ ] IP ZeroTier actual (`ip -o addr show | grep zt`).
- [ ] Confirmar versión de Pad a fijar (pinnear un tag, p.ej. v0.9.x — releases ~semanales, no seguir `latest` a ciegas).

## Fase 1 — Piloto (levantar Pad local SIN tocar tasks/learning)

1. **Correr la instancia** (bind SOLO a localhost o IP ZeroTier — regla 1, NUNCA 0.0.0.0):
   ```
   docker run -d --name pad-local \
     -p 127.0.0.1:7777:7777 \
     -v ~/.pad:/data \
     ghcr.io/perpetualsoftware/pad:<tag-fijo>
   ```
   (evaluar bind a la IP ZeroTier si se quiere acceso desde otros dispositivos de la red, como el resto de la consola).
2. **systemd de usuario** para que sobreviva reinicios (regla 2): unidad `pad-local.service` con `Restart=on-failure`, análoga a `claude-web-console.service`.
3. **Inicializar**: `pad init` (crea el workspace); crear un workspace `console-local`.
4. **Autenticación**: investigar cómo autentica el MCP local (¿token local en un archivo vs OAuth?). Documentar el mecanismo (NO reusar el OAuth de la nube).
5. **Cablear el MCP local** a Claude Code SIN romper el de la nube: `pad mcp install` o una entrada `.mcp.json`/scope local apuntando a `http://127.0.0.1:7777` en vez de `mcp.getpad.dev`. Decidir si convive con el workspace cloud o lo reemplaza.
6. **Backup**: sumar `~/.pad/pad.db` al esquema `~/.cwc-backups` (snapshot periódico; Pad ya hace snapshots pre-migración automáticos).
7. **Usar el piloto** para trackear trabajo real un tiempo. Medir: ¿la UI/CLI/reportes aportan lo suficiente para justificar el servicio extra + la migración?

## Fase 2 — Decisión (con datos del piloto)

- Si el piloto NO convence → mantener Opción 1 (cloud secundaria). Bajar el contenedor. Fin.
- Si convence → seguir a Fase 3.

## Fase 3 — Migración 1-vía de tasks/learning (solo si Fase 2 = sí)

> Regla dura de la migración: **1-vía, NUNCA sync bidireccional** (la trampa de reconciliación que LT15 ya señaló). Se elige UNA fuente de verdad.

1. **Punto de verdad**: decidir si Pad local PASA a ser la fuente de verdad (y `tasks`/`learning` se retiran) o si quedan como export 1-vía.
2. **Cliente**: generalizar `pad-client.js` (hoy hardcodeado a `PAD_WORKSPACE='tolkien'` y `mcp.getpad.dev`) — parametrizar workspace + URL vía env (`CWC_PAD_URL`, `CWC_PAD_WORKSPACE`) para apuntar al local. El tool-surface es idéntico → cero cambios de lógica de tools.
3. **Migrar datos**: script 1-vía que lea `~/.cwc-data/tasks.json` + `learning.json` y cree los items Pad equivalentes (TASK/BUG/DOC) con el CRUD del cliente. Idempotente (pad_search antes de crear).
4. **Reescribir los módulos** `tasks`/`learning` para leer/escribir contra Pad local (o retirarlos si Pad es la única superficie). Respetar TODAS las reglas duras: si el server escribe a Pad, usar el patrón `pad-client.js` (cliente MCP backend), con manejo de indisponibilidad (best-effort, conservar último snapshot).
5. **Verificar**: proceso de cambio completo (node --check → restart → health → Codex). Confirmar offline (bajar la red, todo sigue).

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Un servicio más que mantener | Docker + systemd + backup del `.db`; binario único, bajo overhead |
| Madurez (proyecto de ~90★) | Apache-2.0 + datos en SQLite plano = cero lock-in (`sqlite3 dump` los saca) |
| Regresión en la migración | 1-vía, idempotente, piloto antes; los módulos actuales no se tocan hasta Fase 3 |
| Acoplar core a Pad local caído | best-effort + fallback; evaluar si `tasks`/`learning` quedan como cache local |

## Rollback

Bajar el contenedor (`docker rm -f pad-local`), quitar la unidad systemd y la entrada MCP local. Los datos quedan en `~/.pad/pad.db` (exportables con `sqlite3`). Los módulos `tasks`/`learning` siguen intactos hasta Fase 3, así que hasta ahí el rollback es total y sin pérdida.

## Definición de HECHO (del proyecto completo)

Pad local corriendo bajo systemd (sobrevive reinicio) + bind ZeroTier/localhost + backup del `.db` en `~/.cwc-backups` + MCP local cableado + (si Fase 3) `tasks`/`learning` migrados 1-vía y verificados offline + CLAUDE.md actualizado + decisión registrada en Pad.
