---
name: tkt
description: "🎫 Opera los tickets de Tolkien en masa desde la consola: censa los propios, los cruza contra Zoho y cierra los que Zoho ya dio por resueltos, siempre con dry-run y confirmación humana antes de escribir. Usala cuando el pedido hable de cerrar/sincronizar/alinear tickets de Tolkien con Zoho, o de ver cuántos tickets propios están desalineados."
cwc-share: host-only
cwc-default: false
---

# 🎫 Alinear tickets de Tolkien con Zoho

## Qué resuelve y por qué existe

El board de Tolkien es la fuente de verdad que Niko revisa cada mañana, pero puede mostrar como abiertos tickets a su nombre que Zoho ya marcó como resueltos. Esta skill alinea ambos sistemas desde la consola, sin abrir PRs ni tocar el código de Tolkien.

> [!IMPORTANT]
> **El objetivo NO es cerrar muchos tickets: es que el board diga la verdad.** Un ticket cuyo estado real no está verificado en Zoho **queda abierto** y se marca para revisión humana. Cerrar de más es peor que no cerrar.

## Flujo de 3 pasos

Antes de empezar, comprobá que la sesión de Tolkien esté conectada:

```bash
node bin/cwc-tolkien.js whoami
```

Si no hay sesión, el censo falla. Conectala desde **⚙ Sistema → Conexiones** y recién entonces retomá el flujo.

El tercer paso se muestra en dos filas para separar su dry-run obligatorio de la aplicación confirmada.

| Paso | Comando | Qué hace | ¿Escribe? |
|---|---|---|---|
| 1 | `node bin/cwc-tolkien.js census` | Lista los tickets de Tolkien asignados al usuario y sus campos de cierre | No |
| 2 | `node bin/cwc-tolkien.js reconcile` | Cruza cada ticket con su par en Zoho y produce 3 pilas | No |
| 3 | `node bin/cwc-tolkien.js close` | Dry-run: muestra qué se tocaría y con qué evidencia | No |
| 4 | `node bin/cwc-tolkien.js close --apply` | Cierra de verdad, con la identidad de Niko | **SÍ** |

Traducí el pedido de Niko al paso mínimo que lo resuelve: “censá/mirá mis tickets” → `census`; “compará/sincronizá/alineá con Zoho” o “¿cuántos están desalineados?” → `reconcile`; “mostrame qué cerrarías” → `close`; “cerralos” → primero `close`, presentar el dry-run y pedir confirmación explícita, y solo después `close --apply`.

## Las tres pilas de `reconcile`

| Pila | Significado | Acción |
|---|---|---|
| ✅ `closable` | Cerrado y resuelto en Zoho, pero abierto en Tolkien | Candidato a cierre; pasa por dry-run y confirmación humana |
| ⚠️ `real-open` | Abierto en Tolkien y en Zoho | Trabajo real: no se toca |
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

Si el usuario pide cerrar “todo” y el lote supera 50 tickets, **no agregues `--confirm-large` por cuenta propia**. Explicá el tope y preguntá si prefiere procesarlos en tandas de 50 —recomendado— o forzar el lote entero.

Ante cualquier duda sobre un ticket puntual, hacé primero una pasada de prueba de uno solo:

```bash
node bin/cwc-tolkien.js close --only WORK-123
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

## Cuando algo falla

Cada corrida con `--apply` deja un log JSONL con el estado anterior y posterior a cada escritura en:

```text
~/.cwc-data/tolkien/ops/close-<ts>-<pid>.jsonl
```

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
- No fuerza tickets que estén en espera estructurada.
- Nunca inventa evidencia: el texto de cierre se deriva del dato real del ticket de Zoho —número, estado, fecha de cierre, autor y resolución—.

## Primera corrida real

Al momento de escribirse esta skill, **2026-07-31**, el motor de cierre no se pudo probar de punta a punta contra tickets reales porque no había una sesión de Tolkien conectada. La primera corrida real debe hacerse con `--only <un ticket>` y el resultado debe revisarse en la UI de Tolkien antes de lanzar un lote.
