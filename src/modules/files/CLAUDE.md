<!-- cwc:ficha-modulo -->
# src/modules/files — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

Backend del explorador y gestor de archivos: lista, previsualiza, descarga, comprime, sube, crea, renombra y mueve ítems a una papelera recuperable.

No es admin-gated. Trabaja con el root derivado del principal autenticado: el usuario host conserva su home completo; un inquilino queda confinado a su workspace mediante `userFileRoot()`.
`reqOwner(req)` obtiene el principal (con fallback a `hostUser()`) y
`reqFileRoot(req)` deriva ahora de ese helper, evitando que identidad y root se
calculen por caminos distintos.

## Endpoints

| Método | Ruta | Contrato actual |
|---|---|---|
| GET | `/api/files/list` | Lista una carpeta; `hidden=1` incluye dotfiles, salvo `node_modules`, `.git`, `dist` y `.cwc-trash`, que siempre se ocultan. |
| GET | `/api/files/read` | Lee texto hasta 2 MiB; para archivos mayores o detectados como binarios devuelve metadatos sin contenido. |
| GET | `/api/files/raw` | Previsualiza imágenes/PDF de una allowlist y texto; contenido activo o binario se fuerza como attachment. |
| GET | `/api/files/download` | Descarga forzada de un archivo. |
| GET | `/api/files/download-zip` | Genera en streaming el zip de una carpeta, sin seguir symlinks y omitiendo `.git`, `node_modules`, `dist` y la papelera. |
| POST | `/api/files/zip` | Genera el zip de una selección de hasta 1000 rutas, deduplicando nombres en el archivo final. |
| POST | `/api/files/upload` | Sube hasta 100 archivos multipart bajo el campo `files`, con máximo de 5 GiB por archivo y nombre único en destino. |
| POST | `/api/files/mkdir` | Crea `{ path, name }`; valida nombre simple y responde `409` si ya existe. |
| POST | `/api/files/rename` | Renombra `{ path, newName }` sin permitir el root ni pisar deliberadamente un destino existente. |
| POST | `/api/files/trash` | Mueve `{ path }` a la papelera; nunca admite el root. |
| GET | `/api/files/trash` | Lista la papelera con vencimiento y días restantes; la lectura también purga vencidos. |
| POST | `/api/files/trash/restore` | Restaura `{ id }` a su origen, con sufijo si hay colisión. |
| POST | `/api/files/trash/purge` | Elimina definitivamente `{ id }`; si la clave `id` no viene, vacía toda la papelera. |

## Archivos

- `index.js`: contiene los trece endpoints, el upload de Multer, los streams zip, la clasificación segura de previews y las defensas de confinamiento por ruta real.

La resolución lexical de rutas viene de `core/paths.js`; los roots por usuario, de `core/user-space.js`; la persistencia, restauración y poda de papelera, de `core/trash.js`.

## Estado

El módulo **no escribe estado de control en `~/.cwc-data/`**. Sí modifica el filesystem visible dentro del root del usuario.

La papelera es POR ROOT/DUEÑO y su índice está particionado por principal. Para
el host el root sigue siendo `config.home`, así que conserva `~/.cwc-trash/`;
cada inquilino usa la `.cwc-trash/` de su workspace.

- `<root>/.cwc-trash/index.json`: `{ "items": [{ "id", "name", "originalRel", "owner", "isDir", "deletedAt" }] }`, escrito atómicamente; las entradas legacy sin `owner` se atribuyen al host.
- `<root>/.cwc-trash/<id>`: contenido físico movido.
- Los cuatro endpoints propagan `reqOwner(req)`: mover pasa el owner a
  `moveToTrash`; listar, restaurar y purgar pasan
  `{ owner: reqOwner(req), all: isAdmin(req) }`, de modo que un no-admin no ve
  ni opera entradas ajenas. `originalRel` se resuelve contra el root del request
  con `resolveWithinRoot()`.
- Política de poda: TTL de 30 días; `init()` llama `autoPurge(config.home)` para
  la higiene de la papelera host y la de cada inquilino se depura al listarse.
  `POST /trash/purge` permite poda explícita individual o total dentro de lo
  autorizado.

## Lo que más duele

- `resolveWithinRoot()` solo confina la ruta como string. Antes de leer o mutar, `statSafeSync()`/`realpathSync()` debe confirmar que la ruta real —incluidos symlinks intermedios— sigue dentro del root del request. Un endpoint nuevo que omita la segunda capa puede leer o escribir fuera del espacio del usuario.
- `/raw` es una frontera anti-XSS del mismo origen. HTML, SVG, XML y otras extensiones activas siempre descargan; no delegues ciegamente el `Content-Type` en `sendFile`.
- La papelera sigue el mismo root del request y el índice SÍ está particionado
  por principal. No vuelvas a resolver `originalRel` contra `config.home`: debe
  pasar por `resolveWithinRoot(root, originalRel)`.
- El rename de archivos regulares usa `linkSync` + `unlinkSync` para que una carrera contra el destino produzca `EEXIST`; si falla el unlink intenta revertir el hardlink. Directorios y symlinks usan `renameSync` y solo reducen, no eliminan, la ventana TOCTOU.
- Ausencia de `id` en `/trash/purge` significa “purgar todo”; un `id` presente pero vacío/inválido debe seguir siendo `400`, nunca coercionarse a vaciado total.
- Los errores internos de disco (`ENOSPC`, `EACCES`, `EMFILE`, etc.) son `500`. Solo errores marcados `badRequest`/`conflict` o límites de Multer deben degradarse a 4xx.
- El listado no pagina y los zips son streaming: no agregues buffers completos de árboles grandes. La selección zip sí tiene el límite explícito de 1000 entradas.
