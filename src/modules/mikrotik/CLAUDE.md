<!-- cwc:ficha-modulo -->
# src/modules/mikrotik — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

### mikrotik/ — EN CONSTRUCCIÓN

Hoy el módulo solo contiene el store SQLite y la configuración de umbrales para
clasificar la calidad de conectividad. Todavía no tiene cliente, rutas, runner ni
registro como módulo.

Escribe en `<data-dir>/mikrotik/`: `monitor.db` (SQLite en modo WAL) y, si se
necesitan overrides, lee `thresholds.json`. Las muestras crudas se conservan 48
horas por defecto; `rollup_hourly` y `rollup_daily` son permanentes y NUNCA se
podan. `gaps` registra explícitamente las ventanas sin datos para que los reportes
no oculten agujeros de medición.

`classify` tolera ejes nulos por diseño para mediciones parciales (incluido un
solo ping), pero exige al menos un eje con dato cuando el destino responde. Los
umbrales se recargan cuando cambia el mtime de `thresholds.json`; si el archivo
queda ilegible o inválido, se conservan los últimos umbrales válidos. El nombre
de tabla usado por los rollups pasa por una allowlist antes de interpolarse en
SQL.

En netwatch, `thr-avg`/`thr-max`/`thr-jitter`/`thr-stdev`/`thr-loss-percent` son los UMBRALES CONFIGURABLES, mientras que las mediciones de solo lectura se llaman `rtt-avg`/`rtt-min`/`rtt-max`/`rtt-jitter`/`rtt-stdev`/`loss-count`/`loss-percent`. Las dos páginas oficiales de MikroTik se contradicen: la vieja (help.mikrotik.com) mezcla ambas familias en una sola tabla. Manda la CLI reference nueva: manual.mikrotik.com/docs/cli-reference/tool/netwatch/. Confundirlas hace que el cliente lea el umbral configurado creyendo que es la medición.
