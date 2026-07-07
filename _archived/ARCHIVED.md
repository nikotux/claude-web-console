# Archivado — Bugs & Features v1

**Fecha:** 2026-07-07 · **Por:** Nicolás (Niko) Mosquera

## Qué se archivó y por qué

**"Bugs & Features" v1** fue reemplazado por **"Tickets & Features"** (antes "Bugs v2"),
el dashboard determinístico que lee Zoho/GitHub directo vía MCP (sin sub-agente de IA
en el camino de lectura). El detonante fue el bug de Desk #527: v1 leía el estado de
Desk a través de un LLM que retranscribía datos ya estructurados a texto libre, y ese
paso fallaba sistemáticamente. v2 elimina el intérprete. Ver el plan completo en
`~/pool of documents/2026-07-06_plan-backend-deterministico-lectura-desk_v01.md`.

v1 quedó **archivado** (no borrado): reversible si hiciera falta.

## Contenido de esta carpeta

| Ruta | Qué era |
|---|---|
| `src-modules/bugs/` | Backend del triage de bugs (skill bug-triage, `/api/bugs`) |
| `src-modules/bugfixes/` | Backend de seguimiento de fixes/PRs + desk-runner LLM (`/api/bugfixes`) |
| `public-js-modules/bugs/` | Frontend: sección "Bugs & Features" + el tablero (`board/`) |
| `bin/cwc-triage-runner.js` | Runner de triage (LLM) |
| `bin/cwc-desk-runner.js` | Runner de estado de Desk (LLM, el del bug — parseo frágil) |
| `bin/cwc-ticket-investigate-runner.js` | Investigación de contexto de tickets sin PR |
| `bin/cwc-investigate-runner.js` | Investigación de PRs |
| `bin/cwc-bugfix-link.js` | CLI para vincular un PR al tablero v1 |
| `~/.cwc-data/_archived/` | Datos de v1: bugfixes.json, tickets.json, triage-cache.json, desk-live/, investigations/, etc. |

## Qué se migró a Tickets & Features (NO archivado)

- **Contextos de prompt editables** (`bugfix-context.md`, `bugfix-pr-context.md`):
  siguen en `~/.cwc-data/`, ahora servidos por `/api/tickets/context`
  (`src/modules/tickets/context-store.js`). Los usa `system/project-context-panel`.

## Notas

- El CSS de v1 (`.bb-*`, `.bfm-*`, parte de `.bf-*`) sigue en `public/css/style.css`
  porque v2 reutiliza varias clases (`.bb-chip`, `.bf-sub`, `.tk-card`…). El CSS muerto
  del tablero viejo quedó inerte; limpieza opcional a futuro (baja prioridad).
- Los imports relativos internos de los módulos archivados quedan "rotos" respecto a su
  nueva ubicación, pero no importa: nada los carga (fuera del registry). Reversión =
  mover de vuelta + re-registrar en `registry.js` / `main.js` / `index.html`.
