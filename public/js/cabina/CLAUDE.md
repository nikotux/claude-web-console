<!-- cwc:ficha-modulo -->
# public/js/cabina — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es Modo Cabina

Modo Cabina es la piel simplificada de Mi Consola para usuarios patrocinados no
técnicos (`console:PLAN-3075`). Vive en `/cabina`, separada del shell de la
consola completa. En la ruta `/`, `src/server.js` redirige automáticamente acá
a un usuario no administrador cuyo `sponsorshipState` sea `sponsored` o
`awaiting-sponsor`; `?full=1` es el escape de soporte que conserva el acceso al
shell completo. La ruta `/cabina` sirve `cabina.html` con `sendFile`, así que un
cambio de ese markup se ve sin reiniciar el servicio.

## Contrato del shell y de las vistas

`main.js` es el shell: `VIEW_MODULES` relaciona cada nombre con un `import()`
dinámico, `location.hash` decide la ruta y el módulo se monta en
`[data-cabina-view].cab-main`. Antes de cambiar de vista llama al `unmount()`
anterior y protege import y montaje con `try/catch`; una vista opcional no debe
derribar toda Cabina.

Cada vista exporta por default:

```js
{ name, mount(el, ctx), unmount() }
```

El `name` debe coincidir exactamente con la clave de `VIEW_MODULES` y recibe
`ctx = { go, api, toast, fmtDate, icon }`. Si falta el módulo o el contrato no
coincide, el shell cae al placeholder «Esta sección todavía no está conectada»;
un rename incompleto no produce un error accionable. `conversaciones` y `salas`
son las únicas rutas con detalle `#/vista/<id>` y están enumeradas por nombre
tanto en `readRoute()` como en `go()`: una tercera vista con detalle debe
agregarse en ambos lugares.

En «Cómo trabajo», la tarjeta de identidad respeta estrictamente
`identityData.editable`: sólo con `true` muestra Editar y habilita el formulario
inline de nombre, email, GitHub y firma; con `false` degrada a solo lectura sin
botón. `identityEditing` conserva el modo de edición entre renders hasta Guardar
o Cancelar. Un fallo al guardar se muestra dentro del formulario con
`role="alert"` y no reemplaza el DOM, por lo que no pierde lo tipeado; si los
cuatro campos están vacíos, la vista muestra una pista para completarlos.

## Idioma ES/EN

Modo Cabina es bilingüe. Los textos visibles de sus 11 archivos JS usan
`t('cabina.<vista>.<slug>', 'español inline')`: el español queda en el segundo
argumento, según la convención del repo, y las 866 traducciones inglesas viven
en un único archivo, `public/i18n/en/cabina.json`. El namespace `cabina` está
registrado en `MODULES` de `public/js/ui/i18n.js`. Los prefijos son:

- `cabina.shell.` en `main.js`;
- `cabina.nueva.`, `cabina.conversaciones.`, `cabina.salas.`,
  `cabina.archivos.`, `cabina.conexiones.`, `cabina.comoTrabajo.` y
  `cabina.lecciones.` en las vistas correspondientes;
- `cabina.indice.` en `panel-acta.js`, `cabina.artefactos.` en
  `panel-artefactos.js` y `cabina.ayuda.` en `ayuda.js`.

`public/cabina.html` también forma parte de la cobertura: sus textos estáticos
usan `data-i18n` o `data-i18n-title`, con prefijo `cabina.shell.`. El botón
`.cab-lang[data-cabina-lang]` está en el header de la barra lateral, a la
derecha del logo, y usa el ícono compartido `language`. Es un interruptor de
dos idiomas, no un menú: muestra `getLang()` y su `title` indica el idioma al
que cambiará. El clic llama `setLang()`, que persiste la elección en el perfil
mediante `POST /api/account/lang` y recarga la página.

### Tres invariantes que no hay que romper

1. **El orden del arranque no es negociable.** En `main.js`,
   `await initI18n(...)` debe completarse ANTES del primer `import()` dinámico
   de una vista (`mountRoute` → `VIEW_MODULES`). Varias vistas definen textos
   en constantes de nivel de módulo: si se importan antes de cargar el
   diccionario, quedan congelados en español aunque la interfaz esté en inglés.
   `ayuda.js` fue el caso extremo: sus 138 textos estaban dentro del objeto
   `TEMAS` de nivel de módulo, que se reemplazó por la función exportada
   `temas()` para evaluarlos en cada uso. Toda vista nueva con un `const` de
   textos hereda esta trampa.

2. **Un namespace de i18n equivale a un archivo JSON.** Durante la traducción,
   `cabina.json`, `cabina-ayuda.json` y `cabina-vistas.json` podían convivir en
   runtime porque `initI18n` hace `Object.assign` de todos sobre el mismo
   diccionario. Sin embargo, `bin/cwc-i18n-audit.js` asume un archivo por
   namespace y reportaba simultáneamente 549 claves faltantes y 549 huérfanas,
   todas falsas; eso ensuciaba el check `i18n` de Salud. Por eso se consolidó
   todo en `cabina.json`: NO volver a dividirlo.

3. **El HTML también aporta claves.** El primer barrido extrajo solo las de
   los `.js` y dejó 14 textos sin traducir: eran los del menú lateral, la zona
   más visible. Toda verificación de cobertura de Cabina debe cruzar tanto los
   `.js` como los atributos `data-i18n` y `data-i18n-title` de `cabina.html`.

## Contrato distinto de los paneles del hilo

`panel-acta.js` y `panel-artefactos.js` NO son vistas y no van en
`VIEW_MODULES`. `conversaciones.js` los importa dentro del detalle de un chat y
cada uno exporta por default:

```js
{ name, mount(el, ctx), update(events), unmount() }
```

Además de `api`, `toast`, `fmtDate` e `icon`, su contexto contiene `chatId` y
`goToEvent(index)`. `update(events)` recibe el snapshot vivo del hilo después
del historial y de cada evento nuevo.

`goToEvent` es el puente que vuelve navegables el Índice y el enlace «Ir al
mensaje» de Artefactos: busca el nodo correspondiente, cierra el panel, lo
centra y lo destaca. Depende de que cada mensaje que pinta el hilo conserve su
índice real en `data-event-index`; cambiar o renumerar ese atributo deja los
paneles visibles pero sus saltos no hacen nada.

## Lo que más duele

- **Íconos silenciosamente incorrectos.** `main.js` tiene un mapa local de solo
  cinco nombres (`back`, `search`, `send`, `warning`, `rest`). Cualquier otro
  nombre cae sin error ni log a `<circle cx="8" cy="8" r="5">`. Esto ya causó
  `console:BUG-3164`: Conexiones mostró todos sus íconos como círculos. Para
  agregar o cambiar íconos importá `icon()` de `public/js/ui/icons.js`; no uses
  `ctx.icon`. Los usos heredados de `ctx.icon` están limitados a esos cinco
  nombres conocidos.

- **El explorador tiene bases compartidas por tres vistas.**
  `public/css/cabina-explorador.css` alimenta Conversaciones, La Forja y Salas.
  No tocar para una sola vista las bases `.cab-fs-item`, `.cab-fs-tree`,
  `.cab-fs-icon`, `.cab-fs-item-main`, `.cab-fs-item-copy`, `.cab-fs-item-name`,
  `.cab-fs-item-meta`, `.cab-fs-menu`, `.cab-fs-more`, `.cab-fs-empty`,
  `.cab-fs-dragover`, `.cab-fs-drop-before` ni `.cab-fs-drop-after`. Cada vista
  aísla su geometría con `.cab-fs-conversation-grid` (Conversaciones),
  `.cab-fs-files` (La Forja) o `.cab-fs-salas-grid` (Salas; sus reglas viven en
  `cabina-sala.css`). Un cambio a una base exige verificar las tres superficies.

- **Los contadores flotantes dependen del markup interno de los paneles.**
  `conversaciones.js` cuenta
  `.cab-side-item[data-event-index]` para el Índice y
  `.cab-side-item[data-artifact-key]` para Artefactos mediante
  `MutationObserver`. Esos atributos los emiten los paneles, no el dock. Si un
  panel cambia su markup sin mantenerlos, el círculo muestra 0 y no hay error.

- **El auto-scroll respeta dónde está leyendo la persona.** El estado
  `pegadoAlFondo` usa un umbral de 120 px. El historial y las actualizaciones
  del asistente, incluido cada fragmento de streaming, solo siguen el fondo
  cuando ese estado lo permite; un evento propio del usuario sí vuelve al fondo
  deliberadamente. Forzarlo en cada actualización expulsa al usuario del
  pasaje que estaba leyendo. El caso más dañino es `delta`, porque llega muchas
  veces por respuesta.

- **Artefactos no sale del historial.** El replay conserva adjuntos como
  `{ type: 'image' }` sin nombre, insuficiente para construir una lista. El
  panel usa `GET /api/chat/attachments` como fuente de los archivos reales. El
  enlace «Ir al mensaje» intenta primero coincidencia por nombre y, cuando el
  replay lo perdió, ancla por cercanía entre `mtimeMs` y el mensaje humano: la
  tolerancia de 10 minutos se eligió a partir de una conversación medida (los
  adjuntos reales quedaron dentro de 6 min y el primer falso positivo apareció
  a 33 min), no es un timeout arbitrario.

- **Las carpetas no pertenecen solo a Cabina.** `/api/folders/*` persiste el
  mismo store que usa la barra de Sesiones de la consola completa. Sus claves
  mezclan `chat:<chatId>` y `tmux:<socket>:<nombre>`. Al reordenar,
  `mergeWithHiddenOrder()` reemplaza únicamente las posiciones de chats que
  Cabina pinta y conserva las claves tmux ocultas y su orden relativo; mandar
  solo las claves visibles desordena la consola completa. La lista y sus
  resúmenes deben filtrar primero por `belongsToIdentity`: contar la respuesta
  completa de `/api/chat/list` hace que los badges de un administrador incluyan
  conversaciones ajenas y mientan.

- **Los paneles son opcionales y fallan cerrados visualmente.** El montaje
  dinámico y cada `update()` de panel absorben el error para que el hilo siga
  usable. Si desaparece Índice o Artefactos sin mensaje de error, revisar
  primero el import, el contrato y los atributos de conteo.

## El Índice corre fuera del navegador

`panel-acta.js` no resume ni llama al modelo: solo consume
`GET /api/chat/indice`, solicita una actualización con
`POST /api/chat/indice/refresh` y hace polling mientras el estado sea
`running`. La destilación real vive en `bin/cwc-indice-runner.js`, un proceso
desacoplado que recibe desde disco un snapshot incremental de texto puro y
persiste el resultado. Su query está blindada read-only por dos capas mediante
`textOnlyQuery`: `PreToolUse` deniega y `canUseTool` deniega, con
`settingSources: []` y cero herramientas. No mover esa destilación al browser
ni al ciclo de vida del server.

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `main.js` | Shell, arranque de i18n, interruptor de idioma, router por hash, imports de vistas, API/toasts, identidad, badges y alta de conversación. |
| `conversaciones.js` | Lista y carpetas de chats; consume `/api/retro/counts`, liviano, para los 5 contadores del resumen; detalle del hilo por WebSocket; streaming, auto-scroll y dock de paneles. |
| `archivos.js` | La Forja: navegación, orden, preview, upload, drag/drop y operaciones de `/api/files`. |
| `conexiones.js` | Estado y flujos de conexión/desconexión de Microsoft 365, Zoho y Freshservice. |
| `como-trabajo.js` | Lectura y edición guiada de preferencias/identidad vía `/api/projects/me`, con revisión antes de guardar. |
| `lecciones.js` | Mejora Continua simplificada: usa `/api/retro` entero a propósito porque pinta las tres agrupaciones (~702 filas), filtra y permite decidir propuestas. |
| `salas.js` | Lista y detalle de Salas de Aduana: mensajes entre personas, invitaciones, citas y corte explícito hacia la IA. |
| `ayuda.js` | Ayuda de Cabina; exporta `temas()` para evaluar sus textos traducibles en cada uso, después de inicializar i18n. |
| `panel-acta.js` | Índice semántico navegable; lee estado, refresca, hace polling y sincroniza el momento visible. |
| `panel-artefactos.js` | Lista y preview de adjuntos reales; descarga y anclaje aproximado al mensaje de origen. |
| `public/css/cabina.css` | Piel, shell, componentes generales, hilo, paneles flotantes y responsive estructural. |
| `public/css/cabina-explorador.css` | Bases compartidas `cab-fs-*` y scopes de Conversaciones/La Forja. |
| `public/css/cabina-sala.css` | Layout y estados exclusivos de lista/detalle de Salas. |

Nota histórica de `PLAN-3075`: `salas.js` y `cabina-sala.css` fueron escritos
por otra sesión de Claude Code en paralelo. No asumir autoría única ni que un
contrato de nombres garantiza por sí solo que JS y CSS asignen el mismo rol de
layout a cada clase; verificar posiciones y tamaños reales cuando se crucen.

## CSS y convenciones

- Para medidas, preferir `clamp()` y grillas fluidas. Los media queries se
  reservan para saltos de estructura, visibilidad o interacción, no para
  microajustar anchos y altos continuos.
- La tipografía usa la escala `--cwc-fs-*` de `public/css/tokens.css`; no crear
  tamaños paralelos para texto de interfaz.
- Para colores nuevos rige la convención global: tokens `--cwc-*` de
  `tokens.css` o `color-mix()` sobre ellos, sin hex nuevos en módulos ni hojas
  satélite.
- **Deuda existente:** Cabina todavía NO cumple literalmente «cero hex fuera de
  `tokens.css`». `cabina.css` declara una paleta local `--lite-*` con valores
  hex/rgba. No extender esa deuda ni afirmar que ya está resuelta; centralizarla
  requiere una migración separada y verificación visual de toda la piel.
