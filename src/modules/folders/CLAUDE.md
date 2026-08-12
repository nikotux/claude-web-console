<!-- cwc:ficha-modulo -->
# src/modules/folders — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

Persiste las carpetas manuales con las que cada usuario organiza la barra de Sesiones. Agrupa tanto conversaciones del SDK de chat como terminales tmux, por lo que es un módulo propio y no cuelga de `chat/`. Solo administra metadatos de organización.

## Archivos

- `index.js`: valida, lee y escribe el estado por usuario; expone los cinco endpoints HTTP del módulo.

## Estado

El host guarda `session-folders.json` en `~/.cwc-data/`. Cada inquilino usa el mismo nombre dentro de su `userDataDir(owner)`, es decir, su espacio privado bajo `~/.cwc-users/<usuario>/.cwc-data/`.

La forma persistida es `{ version: 1, folders: [...], items: { "<key>": "<folderId>" } }`. Las claves de ítem distinguen `chat:<chatId>` y `tmux:<socket>:<nombre>`. Todas las escrituras pasan por `writeJsonAtomic`; una lectura ausente o con JSON corrupto cae a un estado vacío, mientras que un documento parseable se sanea por ítem.

## Endpoints

| Método | Ruta | Contrato actual |
|---|---|---|
| GET | `/api/folders/list` | Devuelve `{ folders, items }` exclusivamente para el dueño de la request. |
| POST | `/api/folders/create` | Crea una carpeta desde `{ name, world, parentId? }`; el servidor genera el id. |
| POST | `/api/folders/rename` | Renombra la carpeta propia indicada por `{ id, name }`. |
| POST | `/api/folders/delete` | Borra la carpeta y sus hijas directas, libera asignaciones y devuelve `{ ok, freed }`. |
| POST | `/api/folders/assign` | Asigna `{ key, folderId }`; `folderId` nulo o vacío suelta la referencia. |

## Reglas que lo gobiernan

- El dueño siempre es `principalOf(req).username || hostUser()`. No hay bypass ni vista global para administradores.
- La ruta de datos se resuelve **por operación** con `storeFile(owner)`. Está prohibido calcularla en una constante de módulo: congelaría el espacio del host y cruzaría datos entre inquilinos (console:BUG-2185).
- Las validaciones son allowlist y fail-closed para nombres, mundos, ids y claves. Hay un máximo de 50 carpetas y 2.000 asignaciones por usuario.
- Solo se admite un nivel de subcarpetas: el padre debe existir, compartir `world` y ser raíz.
- Borrar una carpeta jamás borra ni archiva un chat, ni mata una terminal: únicamente borra la carpeta y suelta referencias.

## Lo que más duele

- `session-folders.json` es estado estrictamente privado. Resolver la ruta al importar el módulo produciría una fuga multi-tenant aunque después los endpoints filtraran respuestas.
- La lectura hace **saneo por ítem** con `sanitizeStore`, NO rechazo global: descarta individualmente las carpetas malformadas y las asignaciones huérfanas, y convierte en raíz una carpeta cuyo padre desapareció. Rechazar el documento entero convertiría un dato dudoso en la pérdida total de la organización del usuario en la siguiente escritura.
- El borrado de una raíz debe incluir sus hijas y limpiar todas las asignaciones que apunten a cualquiera de ellas; `freed` cuenta referencias liberadas, no sesiones eliminadas.
