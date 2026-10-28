<!-- cwc:ficha-modulo -->
# src/modules/news — ficha del proyecto

> Ficha de contexto de esta carpeta. Las reglas duras y convenciones globales
> viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

`news/` es el backend de **🆕 Novedades**: un changelog compartido, alegre y
orientado a quienes usan Mi Consola. Publica hasta seis entradas por push y
permite a cada principal autenticado conservar su propia marca de lectura.

## Superficie HTTP

| Método | Ruta | Acceso | Efecto |
|---|---|---|---|
| GET | `/api/news` | Autenticado | Entradas visibles, no leídas, última lectura y rol. Para admin suma `job` (generación viva leída de disco) y `pending` (commits sin redactar). |
| POST | `/api/news/seen` | Autenticado | Marca la hora actual como leída para ese principal. |
| PATCH | `/api/news/:id` | Admin | Edita campos visibles u oculta una entrada. |
| DELETE | `/api/news/:id` | Admin | Borra una entrada. |
| POST | `/api/news/generate` | Admin | Encola una generación desde git y responde sin esperar. |
| GET | `/api/news/job/:id` | Admin | Lee el estado efectivo del job en disco. |

La clave de lectura es el `username` para una sesión de usuario y `__host__`
para el token maestro. Un no-admin nunca recibe entradas `hidden:true` ni el
bloque interno `tech`.

## Archivos de runtime y retención

- `~/.cwc-data/news.json`: `{ entries: [...] }`, escritura atómica. Conserva
  como máximo las 200 entradas más recientes. Sus read-modify-write se
  serializan con `news.json.lock`, recuperable si supera 30 segundos.
- `~/.cwc-data/news-cursor.json`: último SHA procesado; avanza en cada job
  `done`, incluso cuando el redactor devuelve `[]`.
- `<dataDir-del-principal>/news-seen.json`: mapa
  `{ "<principal>": <timestamp ms> }`, escritura atómica y sin poda; una clave
  por lector. El endpoint pasa `systemScopeFor(req).dataDir` por operación y el
  shared solo cae a `resolveDataDir()` para usos standalone, de modo que la
  marca de un inquilino nunca se escribe en el HOME del host.
- `~/.cwc-data/news/<jobId>.json`: jobs `running|done|error`. Cada job guarda
  `commits` y `files` tal como se los pasó su disparador: es la evidencia para
  auditar qué vio realmente el redactor. Se podan oportunistamente al escribir
  cuando su `mtime` supera 24 horas.
- `~/.cwc-data/news.log`: salida append-only del runner; no se poda acá.

## Runner y seguridad

`bin/cwc-news-runner.js` corre detached+unref y persiste el resultado, por lo
que sobrevive a un reinicio de la web. Usa `sonnet`, hasta 30 turnos y timeout
duro de 8 minutos, publica como máximo 6 entradas por corrida y usa `cwd` en la
raíz de Mi Consola.

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
- El `jobId` NO se guarda en el navegador: el panel se re-engancha buscando en
  `~/.cwc-data/news/` el job `running` más reciente y no vencido
  (`findRunningNewsJob`). Si alguien vuelve a atar el indicador a una variable
  de memoria del front, cerrar el panel vuelve a hacer desaparecer una
  generación en curso.
- `pending` sale de `git rev-list --count` contra el marcador más nuevo entre
  el cursor y la última entrada `auto`; si ese SHA ya no existe, usa la ventana
  de 10 commits. Ante otro error de git devuelve `0` y no rompe el listado.
- El origen de `files` depende del disparador. `POST /api/news/generate` lo
  calcula con `generationInput()` como diff desde el marcador más nuevo entre
  cursor y última entrada `auto`; el push automático lo arma en `backup/index.js`. Ese segundo
  camino antes mandaba `staged`, es decir, solo los archivos del commit
  `cwc backup …`: si el trabajo ya venía commiteado quedaba en
  `["README.md"]`. Ahora manda el diff real de `beforeRef..HEAD`. Un `files`
  corto junto a muchos commits indica que ese cableado se rompió de nuevo: el
  redactor conserva los subjects, pero pierde el mapa de dónde mirar y publica
  de menos sin que nada falle; el job igualmente termina `done`.
- `buildNewsPrompt()` inyecta los títulos ya publicados para deduplicar. Por
  default usa `readNews()` limitado a 30 títulos y el parámetro `published`
  permite reemplazar esa lista. Esto permite repescar un rango viejo sin volver
  a contar lo mismo.
- El techo de entradas vive en dos lugares que deben moverse juntos: el
  `.slice(0, 6)` del runner y el texto `1 a 6 novedades` del prompt. Si solo se
  sube el límite del prompt, el runner recorta en silencio.
- La lista de archivos del prompt se ordena por `SURFACE_PREFIXES` antes de
  cortarse en `MAX_PROMPT_FILES`: el orden alfabético de git dejaba al redactor
  viendo solo `bin/` en un push grande (0 de 42 rutas de frontend visibles;
  ahora, 42 de 42). El orden de `SURFACE_PREFIXES` es significativo y
  `public/` va último porque es un prefijo genérico y ancho: si queda antes de
  `.claude/skills/`, sus rutas de CSS e i18n agotan el cupo y las skills —que el
  usuario invoca directo con `/nombre`— quedan en 0 de 8. Este reordenamiento
  afecta solo el prompt; `tech.files` de cada entrada publicada conserva el
  orden original como evidencia de auditoría de qué trajo el push.
