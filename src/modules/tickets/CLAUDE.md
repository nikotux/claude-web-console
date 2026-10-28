<!-- cwc:ficha-modulo -->
# src/modules/tickets — librería compartida

Tickets & Features v2 se archivó el **2026-10-28** por **console:PLAN-3480**.
Esta carpeta NO es un módulo: no tiene index.js, registro, rutas propias ni
refresher. El dashboard, sus fuentes, claims y runner viven en _archived/
(ver _archived/ARCHIVED.md). No volver a arrancar su timer de 60 segundos.

## Archivos conservados y consumidores

| Archivo | Consumidores vivos y responsabilidad |
|---|---|
| meta-store.js | chat/index.js: appendHistorico y extractSessionWork al cerrar chats vinculados a tickets/PRs. Metadata en Pad LOCAL, colección contexto-de-tickets. |
| context-store.js | projects/index.js (HTTP), health/index.js (verifySync), retro/promote-shared.js, bin/cwc-tenant-mirror-reset.js y bin/cwc-retro-context-rehydrate.js. Masters work/pr y espejo al clon propio. |

La librería queda con `meta-store.js` y `context-store.js`.
`desk-mcp-client.js` y `derive.js` se archivaron el 2026-10-28 al retirar
Seguimientos, su último consumidor vivo (console:PLAN-3480); ver
`_archived/ARCHIVED.md`.
Chat inyecta setTicketClaudeDirResolver(owner => userClaudeDir(owner || hostUser()))
inmediatamente después de importar meta-store.js. La librería recibe el resolver
sin importar core/user-space.js: conservar el aislamiento de transcripts por dueño.
La metadata sigue enlazándose best-effort al grafo local; no precalentar su
colección en HOT_PAD_COLLECTIONS.

## Contexto de trabajo en Proyectos

Las cuatro rutas viven en src/modules/projects/index.js y las consume
public/js/modules/system/project-context-panel.js:

- GET /api/projects/work-context?kind=work|pr: contexto y bandera isDefault.
- POST /api/projects/work-context: guarda context y devuelve contexto + sync.
- GET /api/projects/work-context/sync: verifica el espejo.
- POST /api/projects/work-context/sync: sincroniza manualmente y verifica.

Todas resuelven systemScopeFor(req), conservando el comportamiento por usuario.
Los masters históricos bugfix-context.md y bugfix-pr-context.md siguen en el
dataDir del dueño. Los inquilinos sin master leen la semilla del host sin escribirla;
al guardar materializan sus masters. El espejo apunta al clon propio, nunca al del
host como fallback. Si falta el clon, el guardado conserva el master sin crear un clon.

## Contratos de los stores

- meta-store.js mantiene contexto adicional e histórico por ticket/PR en el Pad
  LOCAL. La extracción del transcript es determinística; no usa IA.
- context-store.js conserva los marcadores cwc:tickets-context en CLAUDE.local.md,
  respeta el texto manual externo al bloque y genera .cwc-ticket-playbook.md.
  verifySync devuelve ok, stale, missing o unavailable.
- El fan-out del host sólo alcanza clones provisionados sin master propio work/pr;
  renderiza desde cada scope y nunca copia el CLAUDE.local.md completo del host.
- El maestro conserva todo el feedback. Las unidades de ## 6 se ordenan por rank y
  novedad: espejo hasta MIRROR_BUDGET=30000 y playbook hasta
  PLAYBOOK_FEEDBACK_BUDGET=40000; el resto no se renderiza. Conservar los marcadores
  cwc:retro-context, cwc:retro-rank y cwc:retro-archived, y los ids retirados usados
  para deduplicar. El splitter respeta fences; no corta encabezados dentro de ellos.
- MIRROR_RULES incluye ## 6 en work y pr. Si ninguna sección coincide, se conserva
  el fallback de contexto completo con aviso.
- Antes de escribir fuera de la consola se sanitizan refs internas. El detector
  findForeignRefsForTolkien es fail-closed: ante refs foráneas devuelve
  ok:false/reason:foreign-refs antes de ensureGitExclude o writePlaybook.
  El maestro no se modifica al sanitizar el espejo.
