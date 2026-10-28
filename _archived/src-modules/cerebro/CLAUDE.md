<!-- cwc:ficha-modulo -->
# src/modules/cerebro — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

Backend de la vista Cerebro de `console:PLAN-2843`. Entrega el grafo del Pad local del host y re-emite por SSE tanto sus cambios como sus lecturas reales, para que el frontend lo represente como una red neuronal que se ilumina. Es un espejo de observabilidad estrictamente read-only.

## Archivos

- `index.js`: aplica los gates de acceso, sirve el grafo, administra el stream SSE y conserva el buffer acotado de diagnóstico remoto.

## Estado

No escribe NADA en `~/.cwc-data` ni en disco. Todo su estado es efímero y vive únicamente en la RAM del proceso.

Conserva los clientes conectados, hasta 500 ids vistos, el último estado de disponibilidad, los contadores del throttle, los últimos 20 reportes de diagnóstico remoto ya sanitizados y, durante 20 segundos, la respuesta del grafo completo. Los timers nacen con el primer cliente y el estado SSE se limpia al desconectarse el último; el buffer de diagnóstico y la caché viven hasta el reinicio del server y nunca se persisten.

## Pintura de relaciones

Desde `console:PLAN-3057`, el frontend conserva y pinta el `edge.type` que el
server ya entregaba intacto: antes lo descartaba visualmente al asignar a todas
las aristas un color constante y ancho cero. `parent` queda como estructura de
fondo fina y neutra; `implements`, `blocks`, `supersedes`, `split_from` y `wiki`
usan colores de tokens CSS y mayor ancho. Las partículas source → target heredan
el color del tipo sin cambiar el motor de pulsos.

La leyenda permite filtrar cada tipo. El checkbox invertido «Ocultar jerarquía»
retira únicamente `parent` para exponer la red lateral; el grafo y el contador de
conexiones visibles se repintan sin modificar datos del Pad.

## Endpoints

| Método | Ruta | Contrato actual |
|---|---|---|
| POST | `/api/cerebro/diag` | Con cualquier sesión autenticada, sin exigir `oversight`, recibe un reporte de diagnóstico remoto. El body usa el límite JSON global de 256 KB; solo conserva la whitelist documentada por el frontend, recorta strings a 500 caracteres, limita errores a 10 y mantiene en RAM los últimos 20 reportes. |
| GET | `/api/cerebro/diag` | Con `oversight`, devuelve `{ ok:true, reports:[...] }` con el buffer sanitizado de diagnóstico remoto. |
| GET | `/api/cerebro/graph` | Con `oversight`, devuelve `{ ok:true, graph:{ nodes, edges } }` sin transformar la forma del Pad. Sin parámetros usa `/graph` y conserva el comportamiento histórico; con `?completed=1` incluye también los ítems terminales y agrega `completed` a cada nodo. La variante completa se cachea 20 segundos en RAM. Si el Pad no está disponible responde HTTP 200 con `{ ok:false, error }` para permitir reintentos con degradación amable. |
| GET | `/api/cerebro/stream` | Con `oversight`, abre SSE y envía `hello` `{ ts }`; `status` `{ padOk }` cuando cambia la disponibilidad; y `pulse` `{ kind:'read'|'write', action, ref, title, collection, actor, ts }` por uso real. `ref:null` en una lectura significa actividad a nivel colección. Los comentarios `: ping` son heartbeats y `retry: 3000` indica la reconexión. |

## Reglas que lo gobiernan

- `/graph`, `/stream` y el GET de `/diag` usan el gate `oversight`, resuelto en vivo por request con `principalOf(req)`; nunca usan `admin`. El POST de `/diag` exige únicamente un principal autenticado, porque bloquearlo por capacidad impediría recibir el reporte del navegador que está fallando.
- La telemetría se filtra estrictamente al workspace `console`; jamás puede salir actividad de un workspace `tenant-*`.
- Es read-only absoluto: jamás escribe al Pad. `getGraph`, `getCompleteGraph` y `getActivity` son lecturas directas, y `padTelemetry` solo se observa.
- `Cache-Control: no-cache, no-transform` es obligatorio porque `compression()` bufferaría el SSE y lo dejaría mudo.
- Los loops viven solo mientras hay clientes SSE y mueren con el último; después de reiniciar el server, `EventSource` reconecta y la vista vuelve a obtener `/graph`.
- Los pulsos se limitan a 40 por segundo; `hello`, `status` y heartbeat nunca se throttlean.

## Lo que más duele

- Sin `no-transform`, el SSE queda mudo y parece un bug del front.
- Sin la siembra silenciosa de la primera vuelta, abrir la vista dispara 30 pulsos viejos.
- `getGraph`/`getActivity` NO pasan por la caché de `pad-service-client` a propósito (300 KB y frescura de 2 s). Si alguien los "optimiza" metiéndolos en `request()`, el barrido de caché se los re-descarga cada 20 s para siempre y los pulsos llegan hasta 30 s tarde.
- El grafo completo lista primero las colecciones y luego pide sus ítems con un `limit` alto, sin `all=true`: contraintuitivamente, `all=true` devuelve 0 ítems, mientras el listado por defecto ya incluye los terminales. El estado de cada nodo sale de `fields.status` y `completed` se decide con `terminal_options` del schema de su colección, nunca con una lista hardcodeada.
- `/graph` solo aporta las relaciones de los ítems activos. Los completados se unen mediante su `parent_ref`; sus relaciones laterales (`implements`, `blocks`, `wiki`, etc.) no están disponibles en el listado. Recuperarlas requeriría `/items/<ref>/links` por cada completado (unas 1500 llamadas), costo aceptadamente inviable.
