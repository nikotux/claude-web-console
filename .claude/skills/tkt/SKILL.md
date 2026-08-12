---
name: tkt
description: "🎫 Opera los tickets de Tolkien en masa desde la consola: censa los propios, los cruza contra Zoho, cierra los resueltos y reasigna los que cambiaron de dueño, siempre con dry-run y confirmación humana antes de escribir. Usala cuando el pedido hable de cerrar/reasignar/sincronizar/alinear tickets de Tolkien con Zoho, o de ver cuántos tickets propios están desalineados."
cwc-share: catalog
cwc-default: true
---

# 🎫 Alinear tickets de Tolkien con Zoho

## Qué resuelve y por qué existe

El board de Tolkien es la fuente de verdad del trabajo asignado, pero puede mostrar como abiertos tickets a tu nombre que Zoho ya marcó como resueltos. Esta skill alinea ambos sistemas desde la consola, sin abrir PRs ni tocar el código de Tolkien.

> [!IMPORTANT]
> **El objetivo NO es cerrar muchos tickets: es que el board diga la verdad.** Un ticket cuyo estado real no está verificado en Zoho **queda abierto** y se marca para revisión humana. Cerrar de más es peor que no cerrar.

## Flujo operativo

Antes de empezar, comprobá que la sesión de Tolkien esté conectada:

Los comandos usan `$CWC_CONSOLE_ROOT`, la raíz de la instalación de la consola que el server inyecta en el entorno de cada sesión. Gracias a eso el CLI se resuelve desde cualquier directorio de trabajo. Si la variable no estuviera definida, la sesión no salió de la consola: pedile al usuario que abra el trabajo desde un chat o una terminal de la consola en vez de armar la ruta a mano.

```bash
node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien.js" whoami
```

Si no hay sesión, el censo falla. Conectala desde **⚙ Sistema → Conexiones** y recién entonces retomá el flujo.

Cada operación de escritura se muestra en dos filas para separar su dry-run obligatorio de la aplicación confirmada.

| Paso | Comando | Qué hace | ¿Escribe? |
|---|---|---|---|
| 1 | `node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien.js" census [--fresh]` | Lista los tickets de Tolkien asignados al usuario y sus campos de cierre | No |
| 2 | `node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien.js" reconcile [--fresh]` | Cruza cada ticket con su par en Zoho y produce 4 pilas | No |
| 3 | `node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien.js" close` | Dry-run: muestra qué se tocaría y con qué evidencia | No |
| 4 | `node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien.js" close --apply` | Cierra de verdad, con tu identidad de Tolkien | **SÍ** |
| 5 | `node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien.js" reassign` | Dry-run: resuelve por email el dueño real de cada ticket de `reassigned` y agrupa el lote por destinatario | No |
| 6 | `node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien.js" reassign --apply` | Reasigna en Tolkien únicamente la pila `reassigned` al dueño confirmado en Zoho | **SÍ** |
| Guardia | `node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien-canary.js" check --require <lista>` | Canario de solo lectura: navega únicamente URLs GET y vive en un script separado de `bin/cwc-tolkien.js`. Sus exit codes deciden el lote: `0` verde, seguir; `20` block, no aplicar; `10` info; `1` error operativo; `2` uso incorrecto | No |

Traducí el pedido del usuario al paso mínimo que lo resuelve: “censá/mirá mis tickets” → `census`; “compará/sincronizá/alineá con Zoho” o “¿cuántos están desalineados?” → `reconcile`; “mostrame qué cerrarías” → `close`; “cerralos” → primero `close`, presentar el dry-run y pedir confirmación explícita, y solo después `close --apply`; “sacá de mi board los que ya tienen otro dueño” → primero `reassign`, mostrar el resumen agrupado por destinatario y pedir confirmación explícita, y solo después `reassign --apply`.

Usá `census --fresh` y `reconcile --fresh` siempre que los datos de Zoho hayan podido cambiar desde la última corrida, por ejemplo después de cerrar o modificar un ticket. `--fresh` descarta el progreso parcial en caché y fuerza la relectura; sin él se puede reutilizar un parcial viejo y sacar conclusiones sobre datos desactualizados de Zoho, incluso leer como vacía una resolución recién guardada.

`reconcile` falla de forma cerrada si el censo no informa el email del usuario o si no puede resolver ese email a un `agentId` de Zoho. En ese caso, volvé a correr `census`: nunca continúes con la verificación de asignado desactivada.

## Las cuatro pilas de `reconcile`

| Pila | Significado | Acción |
|---|---|---|
| ✅ `closable` | Cerrado y resuelto en Zoho, pero abierto en Tolkien | Candidato a cierre; pasa por dry-run y confirmación humana |
| ⚠️ `realOpen` | Abierto en Tolkien y en Zoho, todavía asignado al usuario | Trabajo real: no se toca |
| ❗ `reassigned` | Abierto en Zoho pero YA NO asignado a vos; el trabajo existe pero es de otra persona | Candidato a `reassign`; nunca se mezcla con las otras pilas |
| ❓ `unpaired` | Sin par, con par ambiguo o con estado no verificable | Queda abierto y va a revisión humana |

`unpaired` puede explicar por qué no hay evidencia suficiente con estas razones:

| Razón | Qué significa |
|---|---|
| `census_error` | El censo no pudo leer o interpretar correctamente el ticket de Tolkien |
| `not_active_in_tolkien` | El ticket ya no figura activo en Tolkien |
| `no_desk_link` | El ticket no contiene un vínculo o referencia utilizable a Zoho Desk |
| `desk_lookup_failed` | Falló la consulta a Zoho Desk; el estado real no quedó verificado |
| `no_desk_match` | Zoho no devolvió ningún ticket que corresponda |
| `ambiguous_desk_match` | Hay más de un posible par y no se puede elegir con certeza |
| `desk_number_mismatch` | El número encontrado en Zoho no coincide con el esperado por Tolkien |
| `closed_but_not_resolved` | Zoho lo cerró como cancelado, duplicado u otro resultado distinto de resuelto |
| `closed_without_close_time` | Figura cerrado, pero no hay fecha de cierre verificable |
| `unknown_status_type` | El tipo de estado devuelto por Zoho no se reconoce con seguridad |

## ⛔ Protocolo de confirmación obligatorio

**NUNCA ejecutes `--apply` sin haber mostrado antes el dry-run al usuario y haber recibido un OK explícito en ese mismo intercambio.** Un OK viejo, genérico o dado antes de ver ese lote no sirve.

Presentá el dry-run de forma resumida: indicá cuántos tickets se cerrarían, cuántos se saltean por estar en espera y mostrale al usuario la evidencia textual de al menos 2 o 3 ejemplos para que pueda juzgar su calidad. Después preguntá de forma cerrada:

> ¿Aplico el cierre de estos N tickets?

Para `reassign`, mostrale siempre el resumen agrupado por destinatario (`Nombre: N tickets`) y el conteo de salteados por cada motivo. Ese resumen tiene que verse **antes** de pedir el OK:

> ¿Reasigno estos N tickets a los destinatarios indicados?

Inmediatamente antes de cualquier `close --apply` o `reassign --apply`, ejecutá el canario: `node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien-canary.js" check --require <lista>`. Si no termina verde, no apliques el lote.

Si el usuario pide cerrar “todo” y el lote supera 50 tickets, **no agregues `--confirm-large` por cuenta propia**. Explicá el tope y preguntá si prefiere procesarlos en tandas de 50 —recomendado— o forzar el lote entero.

Ante cualquier duda sobre un ticket puntual, hacé primero una pasada de prueba de uno solo:

```bash
node "$CWC_CONSOLE_ROOT/bin/cwc-tolkien.js" close --only WORK-123
```

Solo después de revisar esa evidencia se considera el lote grande.

## Opciones de `close`

| Opción | Uso |
|---|---|
| `--apply` | Ejecuta las escrituras; sin esta opción, `close` siempre es dry-run |
| `--limit <n>` | Limita la cantidad de candidatos procesados |
| `--confirm-large` | Autoriza explícitamente un lote mayor de 50; requiere la confirmación humana específica del protocolo |
| `--only <workKey\|id>` | Procesa únicamente ese ticket; es repetible para seleccionar varios |
| `--next-actor <kind>` | Define el próximo actor; el valor por defecto es `external_system` |
| `--reconcile <ruta>` | Usa un archivo de reconciliación concreto en lugar del predeterminado |

`--next-actor scheduled_time` está **prohibido**: Tolkien rechaza esa combinación.

## Opciones y guardas de `reassign`

`reassign` consume **únicamente** `reconcile.reassigned`: nunca toca `closable`, `realOpen` ni `unpaired`. El destinatario se resuelve en dos saltos, `zoho.assigneeId` → agente Zoho → email exacto de una opción viva de Tolkien. Los nombres sólo se muestran; jamás se usan para elegir.

| Opción | Uso |
|---|---|
| `--apply` | Ejecuta las escrituras; sin esta opción, `reassign` siempre es dry-run |
| `--limit <n>` | Limita la cantidad de candidatos procesados |
| `--confirm-large` | Autoriza explícitamente un lote mayor de 50; requiere confirmación humana específica |
| `--only <workKey\|id>` | Procesa únicamente ese ticket de `reassigned`; es repetible |
| `--reconcile <ruta>` | Usa un archivo de reconciliación concreto en lugar del predeterminado |

La resolución falla cerrada y saltea el ticket con uno de estos motivos:

| Motivo | Qué significa |
|---|---|
| `sin_asignado_en_zoho` | Zoho no informa un dueño |
| `agente_zoho_desconocido` | El `assigneeId` no existe en el directorio cargado de Zoho; si aparece en TODOS los tickets, el CLI aborta porque significa que el directorio no cargó |
| `agente_sin_email` | El agente existe, pero no tiene email utilizable |
| `sin_usuario_en_tolkien` | Ninguna opción viva de Tolkien tiene ese email exacto |
| `usuario_ambiguo_en_tolkien` | Más de una opción viva tiene el mismo email; no se elige ninguna |
| `ya_es_del_usuario` | El destinatario resuelto es el propio usuario de la sesión |

El email del select sigue siendo la llave para **elegir** al destinatario, pero
no sirve para verificar el resultado: después del submit Tolkien vuelve a dejar
seleccionado el placeholder `— reassign to —`, con UUID vacío. `reassign`
verifica el nombre visible extraído de `Taken by <Nombre> ·`, normalizado sin
acentos, mayúsculas ni diferencias de espaciado; si el UUID esperado llegara a
permanecer visible, también vale como confirmación. Si ninguna señal coincide,
registra `reassign_unverified`; si el dueño sigue siendo el anterior, el detalle
lo dice explícitamente.

Cada navegación al detalle permite 60 segundos y se reintenta una sola vez ante
timeout, esperando 2 segundos. La aplicación también es idempotente: si antes
del submit el ownership ya muestra al destinatario esperado, no vuelve a
escribir, sino que registra `skipped` con motivo `ya_reasignado`. El resumen
cuenta aparte cuántos «ya estaban reasignados», por lo que es seguro re-correr el
mismo `reconcile.json` después de una ejecución parcial.

## Cuando algo falla

Cada corrida con `--apply` deja un log JSONL con el estado anterior y posterior a cada escritura en:

```text
~/.cwc-data/tolkien/ops/close-<ts>-<pid>.jsonl
~/.cwc-data/tolkien/ops/reassign-<ts>-<pid>.jsonl
```

Esas rutas son relativas a TU espacio: cada usuario de la consola tiene su propio `~/.cwc-data` aislado, y una corrida nunca ve ni toca las operaciones de otra persona.

Los códigos de error de Tolkien que pueden aparecer son:

- `invalid_work_context`
- `invalid_completion_verification`
- `record_initial_outcome`
- `outcome_change_requires_correction`

La verificación manda: si un paso no se pudo **verificar releyendo el ticket**, reportalo como fallado aunque no haya aparecido un error visible.

## Límites duros

- No toca el repo `~/tolkien`: solamente lo consulta en modo lectura.
- No abre PRs.
- No opera tickets de otras personas.
- Opera con la sesión de Tolkien del usuario que la corre: cada persona cierra y reasigna únicamente sus propios tickets, con su propia identidad.
- No fuerza tickets que estén en espera estructurada.
- Nunca inventa evidencia: el texto de cierre se deriva del dato real del ticket de Zoho —número, estado, fecha de cierre, autor y resolución—.

## Primera corrida real

La referencia inicial de esta skill es **2026-07-31**. Si es tu primera corrida real, empezá con `--only <un ticket>` y revisá el resultado en la UI de Tolkien antes de lanzar un lote, aunque el dry-run se vea correcto.
