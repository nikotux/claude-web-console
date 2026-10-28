<!-- cwc:ficha-modulo -->
# src/modules/visado — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

### visado/                  PETICIÓN estructurada de infraestructura desde una sala
🛃 Aduana: un participante pide y el dueño aprueba o rechaza. Separa
**CAPACIDAD** (lo que una persona puede ejecutar por sí misma) de **PETICIÓN**
(lo que puede pedirle al dueño). Nació de `console:PLAN-2493` como complemento
obligatorio de `console:BUG-2342`: aquel endurecimiento impidió que el inquilino
tocara infraestructura; sin este canal también le habría impedido pedirla. La
aprobación presta la autoridad del aprobador, nunca la eleva, y la ejecución
ocurre fuera de la sala en un runner desacoplado.

## Archivos y responsabilidades

- `catalog.js` — enum CERRADO de siete operaciones (`tolkien.data.refresh`,
  `tolkien.git.fetch`, `tolkien.git.update`, `tolkien.git.rebaseBranch`,
  `tolkien.env.provision`, `tolkien.env.push`, `tolkien.env.teardown`), más
  `getOp`, `listOpIds`, `resolveOptions`, `validateParams` y
  `CATALOG_CONTRACT_VERSION`.
- `store.js` — expedientes atómicos en `<dataDir>/visados/<id>.json`, máquina de
  ocho estados (`pendiente`, `aprobada`, `ejecutando`, `ejecutada`, `fallida`,
  `rechazada`, `caducada`, `cancelada`), huella sha256 y TTL.
- `index.js` — endpoints HTTP, gates de participante/dueño/autoridad y spawn
  desacoplado del runner. También sirve las seis lecturas acotadas que necesita
  el formulario (`estado`, `refresh`, `preview`, lista/detalle de entornos y ramas).
- `bin/cwc-visado-runner.js` — toma una petición aprobada, revalida y ejecuta la
  operación fuera del ciclo de vida de la web.
- `public/js/modules/visado/` — cola de aprobaciones del dueño, modal de decisión
  y formulario por el que una persona emite la petición.

## Propiedad que sostiene todo

**El invitado NUNCA escribe, solo ELIGE.** Cada parámetro se valida contra la
lista que produce el servidor, y se persiste el valor de ESA lista, no el del
cliente. Cerrar el enum de verbos era la parte fácil; el hueco real estaba en el
argumento: si `branch` o `id` fueran texto libre, el enum cerrado no habría
comprado nada. El frontend representa catálogo y opciones; jamás aporta un
verbo, argumento u orden ejecutable por fuera de ellos.

## Gotchas de esta carpeta

- El `gate` de cada entrada del catálogo es la **referencia importada** del gate
  real, no una copia de la condición. En particular, los gates host-only usan
  `isHostAdmin` de `tolkien/gates.js`; los admin-only conservan la referencia
  compartida `isAdmin`. Si un endpoint se endurece, el visado se mueve en el
  mismo commit (`CONVE-2085`): no recrear la condición dentro del catálogo.
- Las operaciones se exportan **desde `tolkien/index.js`**, NO desde un `ops.js`
  aparte. El flag module-level `busy` que impide que un fetch y un update se
  pisen sobre el mismo `.git` tiene que ser único; un archivo separado tendría
  su propio flag y rompería la exclusión.
- El store **no importa `core/user-space.js` ni `core/config.js`**: todas sus
  funciones reciben el `dataDir` ya resuelto (`console:PLAN-2186`). También lo
  consume un runner desacoplado; resolver identidad/config dentro del store
  volvería a acoplarlo al server y a `CWC_TOKEN`.
- Un expediente **nunca** vive bajo `~/.cwc-aduana/salas/`. Esa es la raíz
  escribible de la sala: guardar ahí la aprobación permitiría que un proceso de
  la propia sala se aprobara solo. Con la Ley 5 enmendada (`CONVE-2434`, una sala
  puede correr en «Todo») no es un riesgo hipotético.
- `operacion`, `label` y `advertencias` son **derivados al servir** por
  `conRender()` y NO se persisten. La verdad en disco es `opId` + `params` +
  `fingerprint`; el frontend jamás compone una orden.
- Las cinco lecturas se sirven desde `visado`; NO se aflojan los gates de
  `tolkien/`. Tocarlos reabriría `console:BUG-2347`, cerrado el mismo día. La
  autorización distinta es participar de la sala indicada y la respuesta
  expone solo lo necesario para elegir, no rutas del host ni unidades systemd.
- La revalidación del runner no es opcional. Entre pedir y aprobar puede pasar
  media hora y una opción puede desaparecer: vuelve a comprobar versión del
  contrato, existencia de la operación, opciones vigentes y huella. Sin eso, la
  lista cerrada sería una foto vieja disfrazada de garantía.
- `transicionar(...)` hacia `aprobada` exige `aprobador.userId` Y
  `aprobador.nombre`, ambos strings no vacíos. El código
  `aprobador_requerido` no distingue cuál de los dos falta.
- El runner renueva `latidoAt` y su lock `<id>.lock` cada 30 s; los listados
  relanzan aprobaciones sin inicio tras 2 min y `caducarEjecutandoVencidas()`
  solo falla una ejecución sin actividad durante 20 min. El hijo es
  host-authority (Ley 3 bis) y recibe el entorno completo porque las operaciones
  de Tolkien dependen de la configuración del `.env`; no introducir una
  allowlist sin inventariar antes las variables que consume cada `op*`.
- La IA de la sala NO tiene tool para emitir peticiones: las emite una persona
  desde el formulario. Darle esa tool permitiría que un aporte con instrucciones
  incrustadas generara peticiones pre-armadas.
- `local-enter` está DELIBERADAMENTE fuera del catálogo: es una puerta
  interactiva, no una operación, y C5 no se puede cumplir para ella.
- `tolkien.env.provision` está DENTRO por decisión explícita de Niko del
  2026-07-31. El riesgo de `console:BUG-2525` —el dev-server del entorno bindea
  a `0.0.0.0`— fue comunicado y asumido; no sacar la operación del catálogo ni
  presentar ese riesgo como desconocido.
- `tolkien.env.push` ofrece solo el entorno con worktree de la sala del `ctx`.
  Commitea cambios pendientes, pushea únicamente `cwc-env/<id>` al origin de
  Tolkien y crea/reutiliza un PR borrador; nunca hace force-push, ready ni merge.
