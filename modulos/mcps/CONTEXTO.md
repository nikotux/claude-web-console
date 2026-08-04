# `modulos/mcps/` — ficha

> **BLUF.** `mcps` descubre servidores desde los archivos de configuración del
> taller, conserva su último estado en SQLite y los sondea con timeout por ítem y
> un pool acotado. Una fuente rota o un servidor colgado se vuelve un estado local:
> nunca detiene el censo de los demás.

## Decisión de arquitectura

El censo separa descubrimiento de sondeo. `censo()` actualiza primero las
declaraciones y responde con el último estado persistido; salvo que la consulta
pida `esperar=1`, el sondeo queda en segundo plano. Así abrir el panel no hereda la
latencia de la red ni de un proceso stdio. El pool limita la cantidad global de
sondas en vuelo y cada una conserva su propio timeout.

Las fuentes por defecto son `~/.claude.json` y `.mcp.json` en la raíz del taller.
Una ruta ausente, ilegible o con JSON inválido aparece como fuente fallida y no
impide leer las siguientes. De `env` y `headers` sólo se exponen y persisten las
claves. Sus valores existen durante el cálculo de una huella SHA-256 no reversible
y se descartan antes de que el servidor entre al estado vivo del módulo.

Las credenciales no cruzan por imports ni por archivos laterales. `mcps` declara a
`credenciales` como dependencia opcional y usa exclusivamente
`nucleo.modulos.usar('credenciales')`. De su inventario toma metadata —clave,
versión y actualización— para otra huella; nunca pide ni recibe un valor. Si ese
módulo falta, el censo sigue disponible y declara que la metadata no está.

## La deriva que vuelve visible un fallo silencioso

Un runner arma sus MCP al arrancar y no vuelve a leer la configuración. Un cambio
de archivo o una rotación de credencial puede dejarlo vivo con material anterior,
sin un error que explique por qué el MCP no cargó. Cuando una sonda termina en
`ok`, el censo conserva las huellas con las que observó esa carga. En los censos
siguientes compara esas huellas con las vigentes:

- `config_rotada`: cambió la configuración desde la última carga observada.
- `credencial_rotada`: cambió la metadata de una credencial relacionada.

El estado de la sonda no se reemplaza por la deriva. Un servidor puede seguir en
`ok` y, al mismo tiempo, pedir un reinicio porque quien lo cargó conserva la
credencial vieja. La transición emite `mcps.credencial.rotada`; repetir el mismo
censo no repite el evento.

## El defecto que no se repite

El precedente `claude-web-console/src/modules/mcps/` hacía un censo serial con un
timeout de 30 segundos por mundo. Un solo MCP caído bloqueaba el menú entero
(BUG-910), y cada servidor adicional multiplicaba la espera. Acá el aislamiento no
depende de que todos se porten bien: cada sonda devuelve su propio resultado, el
pool mantiene como máximo `NTUX_MCPS_CONCURRENCIA` en vuelo y un rechazo nunca
cancela los workers restantes.

## Datos y retención

| Tabla | Clase | Qué persiste | Retención |
|---|---|---|---|
| `servidores` | Durable | Declaración saneada, huellas vigentes y de carga, último estado | Se archiva al desinstalar |
| `sondeos` | Efímera | Estado, duración y motivo por servidor | 30 días, declarados al núcleo |

Ambas tablas tienen `cliente NOT NULL`. Ninguna columna admite valores de `env`,
cabeceras, tokens o secretos. Las entradas que desaparecen de una fuente no se
borran: conservan un `visto_en` anterior para que la desaparición sea observable.

## Mapa de archivos

| Ruta | Papel |
|---|---|
| `module.json` | Contrato del servicio, rutas, panel, eventos y capacidad ofrecida |
| `migraciones/001-inicial.sql` | Censo durable e historial de sondeos |
| `src/descubrir.js` | Lectura tolerante, saneamiento y huella de configuración |
| `src/pool.js` | Límite global de trabajo concurrente |
| `src/sondas.js` | Sondas HTTP/SSE y stdio con timeout individual |
| `src/deriva.js` | Huella de metadata y comparación contra la última carga |
| `src/index.js` | Ciclo de vida, SQLite, API, eventos y barrido prestado |
| `esquemas/eventos/` | Cargas estrictas y sin material secreto |
| `ui/panel.js` | Panel declarado; se incorpora en la segunda delegación |

## Superficie HTTP

| Ruta | Qué devuelve |
|---|---|
| `GET /api/mcps` | Último censo; dispara el sondeo sin bloquear la respuesta |
| `GET /api/mcps/detalle` | Servidor, últimos 100 sondeos y metadata relacionada |
| `GET /api/mcps/alertas` | Estados no `ok` y entradas con deriva |
| `POST /api/mcps/sondear` | Re-sondeo de uno o de todos los servidores |

## Lo que no va acá

| No hacer | En cambio |
|---|---|
| Importar `credenciales` | Usar el puente opcional declarado en `nucleo.modulos` |
| Persistir valores de `env` o `headers` | Guardar sólo claves y huellas |
| Lanzar todas las sondas juntas | Pasarlas por `enPool` |
| Crear timers, procesos o conexiones directos | Pedir recursos prestados al núcleo y devolverlos al detener |
| Borrar un servidor que desapareció | Conservar su último `visto_en` |

## Variables

| Clave | Defecto | Uso |
|---|---:|---|
| `NTUX_MCPS_FUENTES` | vacío | Fuentes separadas por coma; vacío usa las dos predeterminadas |
| `NTUX_MCPS_TIMEOUT_MS` | 8000 | Plazo propio de cada sonda |
| `NTUX_MCPS_CONCURRENCIA` | 4 | Máximo de sondas en vuelo |
| `NTUX_MCPS_SONDEO_MS` | 300000 | Cadencia del barrido completo |
| `NTUX_MCPS_SONDEO_STDIO` | true | Permite lanzar MCP stdio durante el sondeo |
| `NTUX_MCPS_TOPE_ENTRADAS` | 200 | Tope de filas devueltas por el censo |

## Comprobación

```bash
node --check modulos/mcps/src/descubrir.js
node --check modulos/mcps/src/pool.js
node --check modulos/mcps/src/sondas.js
node --check modulos/mcps/src/deriva.js
node --check modulos/mcps/src/index.js
node herramientas/ntux.js verificar
npm run prueba
```
