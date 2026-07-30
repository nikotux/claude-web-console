<!-- cwc:ficha-modulo -->
# src/modules/news — ficha del proyecto

> Ficha de contexto de esta carpeta. Las reglas duras y convenciones globales
> viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

`news/` es el backend de **🆕 Novedades**: un changelog compartido, alegre y
orientado a quienes usan Mi Consola. Publica de una a tres entradas por push y
permite a cada principal autenticado conservar su propia marca de lectura.

## Superficie HTTP

| Método | Ruta | Acceso | Efecto |
|---|---|---|---|
| GET | `/api/news` | Autenticado | Entradas visibles, no leídas, última lectura y rol. |
| POST | `/api/news/seen` | Autenticado | Marca la hora actual como leída para ese principal. |
| PATCH | `/api/news/:id` | Admin | Edita campos visibles u oculta una entrada. |
| DELETE | `/api/news/:id` | Admin | Borra una entrada. |
| POST | `/api/news/generate` | Admin | Encola una generación desde git y responde sin esperar. |
| GET | `/api/news/job/:id` | Admin | Lee el estado efectivo del job en disco. |

La clave de lectura es el `username` para una sesión de usuario y `__host__`
para el token maestro. Un no-admin nunca recibe entradas `hidden:true`.

## Archivos de runtime y retención

- `~/.cwc-data/news.json`: `{ entries: [...] }`, escritura atómica. Conserva
  como máximo las 200 entradas más recientes.
- `~/.cwc-data/news-seen.json`: mapa `{ "<principal>": <timestamp ms> }`,
  escritura atómica y sin poda; una clave por lector.
- `~/.cwc-data/news/<jobId>.json`: jobs `running|done|error`. Se podan
  oportunistamente al escribir cuando su `mtime` supera 24 horas.
- `~/.cwc-data/news.log`: salida append-only del runner; no se poda acá.

## Runner y seguridad

`bin/cwc-news-runner.js` corre detached+unref y persiste el resultado, por lo
que sobrevive a un reinicio de la web. Usa `sonnet`, hasta 30 turnos y timeout
duro de 8 minutos, con `cwd` en la raíz de Mi Consola.

Es una excepción nominal de **solo lectura** a la regla 6, blindada por las dos
capas obligatorias y la misma allowlist exacta en ambas:

1. Hook `PreToolUse` deny-by-default.
2. `canUseTool` deny-by-default.

Solo permite `Read`, `Grep`, `Glob` y `ToolSearch`. No carga `settingSources`;
por lo tanto no tiene Bash, Edit, Write, WebFetch ni MCP.

## Gotchas

- Los commits `cwc backup …` permanecen en `tech.commits` para trazabilidad,
  pero `buildNewsPrompt()` los omite del bloque descriptivo.
- `[]` es una respuesta válida: significa que el push solo tuvo cambios
  internos y el job termina `done` con `count:0`.
- El texto visible nunca toma nombres de archivo ni SHAs del modelo sin
  validación; esos datos quedan únicamente en `tech`.
- Todo `:id` se valida con `/^[a-f0-9]{6,32}$/` antes de construir una ruta.
