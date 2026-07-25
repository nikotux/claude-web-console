# El grafo de Pad `console` — estructura, leyes y verificación

> Detalle largo de la regla dura 11 del `CLAUDE.md` (bullet "Todo ítem de Pad nace ENLAZADO y en su NIVEL correcto"). Fuente de verdad de las leyes: `CONVE-1257` en el Pad LOCAL (workspace `console`). Si este doc y `CONVE-1257` divergen, manda el `CLAUDE.md` (regla del encabezado) y hay que corregir los otros dos.

## Por qué existe este doc

El 2026-07-25 una auditoría del workspace `console` encontró **61 ítems con cero aristas** (3,8% de 1589) y **36 nodos más cuya jerarquía estaba cableada con el link equivocado**, lo que los hacía aparecer flotando en el visor de grafo aunque tuvieran arista. Registro completo: `PLAN-1255` (fase 1) y su hijo de fase 2, más `BUG-1878` para la causa de código.

## Las dos capas del grafo

Pad es **item-only**: no existe un nodo nativo de "colección". Toda estructura se hace con links entre ítems, y hay dos tipos con semántica distinta:

| Link | Significa | Cardinalidad | Efecto en el visor |
|---|---|---|---|
| `parent` | "es parte de / vive dentro de" | **una** por ítem | forma el ÁRBOL: el hijo se dibuja anidado bajo el padre |
| `implements` | "se relaciona con / realiza" | **muchas** | arista de referencia; cruza constelaciones, no anida |
| `blocks` | dependencia temporal | muchas | arista de dependencia |
| `supersedes` | lineaje: el nuevo reemplaza al viejo | muchas | arista de historia |

El error clásico es usar `implements` donde correspondía `parent`. El ítem pasa cualquier censo de conectividad (tiene arista) pero el árbol no lo contiene, así que se dibuja como una nube suelta al costado. Es un falso negativo del censo: **conectividad ≠ estructura**.

## La taxonomía de `arquitectura`

Una sola raíz, `ARQUI-1258 «🖥️ Mi Consola»`, y 16 secciones abajo:

```
ARQUI-1258 🖥️ Mi Consola
├── 1259 Núcleo ─────────────── config · auth · bus · pad-client · tool-policy · inventory · tls
├── 1267 Chat & modelos ─────── chat · model-router (AutoTux) · Tándem · permisos
├── 1273 Terminal / tmux
├── 1274 Ciclo de tickets ───── tickets · comms · seguimientos · CDT · CONVE del ETA
├── 1280 Salud / Sistema Nervioso ── health · coherence · optimize · invariants
├── 1285 Banco de conocimiento ──── tasks · learning · audio · retro (+ buckets MC)
├── 1290 Tokens & Uso
├── 1294 Infra de red ───────── unifi
├── 1296 Conexiones & terceros ─── connections · mcps · skills · updates · env-vars
├── 1342 Proyectos & contexto
├── 1343 Archivos & explorador
├── 1344 Multi-tenant / onboarding
├── 1303 Frontend ──────────── 14 módulos front
├── 1345 Runners & CLIs
├── 1308 Backup & deploy
└── 1346 Otros
```

Profundidad real: hasta 4 niveles (`sección → módulo → archivo → endpoint`). Eso es correcto y no se aplana.

### Dos eras de mapeo (por qué había 36 raíces)

- **Era 1** (`ARQUI-1258..1316`, jul-2026): taxonomía a mano, con hojas gruesas y conceptuales (`«coherence»`, `«optimize»`, `«chat (index/runner-link/shared)»`). Colgó los hijos con `implements`.
- **Era 2** (`ARQUI-1347+`): el playbook `module-scan` mapeó módulo por módulo a nivel de archivo y endpoint. Colgó los hijos con `parent`.

Las dos eras conviven bien, pero la Era 1 quedó fuera del árbol hasta la reparación. Los placeholders gruesos **se conservaron** (capa conceptual útil) y recibieron `supersedes` desde su nodo fino Era-2, para que el lineaje quede explícito en vez de borrar historia.

## El caso especial de las lecciones de Mejora Continua

Las ~240 lecciones `MC-*` no cuelgan con `parent`: se enganchan con `implements` a uno de 7 buckets, elegido por su campo `category`.

| `category` | Bucket |
|---|---|
| `procedimiento` | `ARQUI-1310 MC · Procedimientos` |
| `metodologia` | `ARQUI-1311 MC · Metodología` |
| `convencion` | `ARQUI-1312 MC · Convenciones` |
| `feedback-cliente` | `ARQUI-1313 MC · Feedback de Chris` |
| `nota` | `ARQUI-1314 MC · Notas` |
| `regla` | `ARQUI-1315 MC · Reglas` |
| `herramienta` | `ARQUI-1316 MC · Herramientas` |

Los buckets sí cuelgan con `parent` de `ARQUI-1288 «retro / mejora continua»`, que a su vez cuelga de `ARQUI-1285 «Banco de conocimiento»`. Ese es el patrón: **el espinazo va con `parent`, las hojas de data viva se enganchan con `implements`.**

## Patrones de linkeo vigentes (derivados del grafo real)

Al crear un ítem nuevo, replicar el patrón que ya tienen sus hermanos en vez de inventar uno:

| Origen | Link | Destino | Precedentes |
|---|---|---|---|
| `mejora-continua` | `implements` | bucket `MC · *` | ~240 |
| `playbooks` (promovido de una lección) | `implements` | su lección `MC-*` gemela | ~70 |
| `pendientes` | `parent` | su `PLAN` | ~161 |
| `tasks` | `parent` | su `PLAN` / `ROAD` | ~180 |
| `bugs` | `parent` | su nodo de `arquitectura` | ~57 |
| `contexto-de-tickets` | `implements` | `ARQUI-1274 «Ciclo de tickets»` | 12 |
| `conventions` | `implements` | su nodo de `arquitectura` o el PLAN que la originó | ~19 |
| `infraestructura-de-red` | `implements` | el UDM Pro / su red | ~100 |
| `temas-de-aprendizaje` | `parent` | su `RUTA` | 10 |

## Islas legítimas

Un PLAN de trabajo humano no-código puede ser un **sol autónomo**, desconectado del árbol de arquitectura, y eso no es un defecto: forzarle un `implements` a un módulo sería un link falso. Al 2026-07-25 son 5: Homey del jefe, onboarding de Persona 1, rediseño de oficina, expediente Princeton y aprendizaje personal.

La regla práctica: **si el PLAN toca código de la consola, cross-linkealo a su módulo; si es trabajo del mundo real, dejalo como sol.**

## Verificación (0 tokens)

Read-only sobre la DB del Pad LOCAL, sin gastar tokens ni pegarle al MCP. Dos invariantes:

1. **Ítems con grado 0 debe ser 0** — contar ítems vivos del workspace sin ninguna arista en `item_links` ni en `item_wiki_links`.
2. **`arquitectura` debe tener 1 raíz** — contar ítems de esa colección sin link `parent` saliente; el único legítimo es `ARQUI-1258`.

```js
// node -e, contra /home/nmosquera/.pad/pad.db en modo readOnly
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/nmosquera/.pad/pad.db', { readOnly: true });
// workspace console: 58ec0882-e1c6-4f86-aeda-2bb47e8a05c3
// 1) grado 0  → items vivos que no aparecen ni como source ni como target
// 2) raíces   → items de 'arquitectura' sin fila (source_id=?, link_type='parent')
```

Escribir al grafo NO se hace por SQL: se usa el MCP `pad` o el CLI (`pad item update <ref> --parent <ref>`, `pad item implements <a> <b>`, `pad item supersedes <nuevo> <viejo>`, con `--url http://10.213.222.62:7777 --workspace console`). El CLI tiene rate limit: conviene espaciar las llamadas y reintentar.

## Estado al 2026-07-25 (post reparación)

| Métrica | Antes | Después |
|---|---|---|
| Ítems vivos | 1589 | 1589 |
| Huérfanos (grado 0) | 61 | **0** |
| Componentes conexos | 90 | **6** |
| Continente mayor | 1360 (85,6%) | **1532 (96,4%)** |
| Raíces de `arquitectura` | 36 | **1** |
| Links | 1768 | 1861 |
