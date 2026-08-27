<!-- cwc:ficha-modulo -->
# src/modules/mikrotik — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

### mikrotik/ — EN CONSTRUCCIÓN

Hoy el módulo solo contiene el store SQLite y la configuración de umbrales para
clasificar la calidad de conectividad. Todavía no tiene cliente, rutas, runner ni
registro en `src/core/registry.js`.

Escribe en `<data-dir>/mikrotik/`: `monitor.db` (SQLite en modo WAL) y, si se
necesitan overrides, lee `thresholds.json`. Las muestras crudas se conservan 48
horas por defecto; `rollup_hourly` y `rollup_daily` son permanentes y NUNCA se
podan. `gaps` registra explícitamente las ventanas sin datos para que los reportes
no oculten agujeros de medición.

`classify` tolera ejes nulos por diseño para mediciones parciales (incluido un
solo ping), pero exige al menos un eje con dato cuando el destino responde. Los
umbrales se recargan cuando cambia el mtime de `thresholds.json`;
`loadThresholds()` captura el mtime ANTES de leer, vuelve a comprobarlo después
del parse y reintenta hasta tres veces. El mtime cacheado identifica siempre el
contenido efectivamente parseado: ante una carrera queda más viejo y fuerza
relectura, nunca más nuevo. Si el archivo queda ilegible o inválido, se conservan
los últimos umbrales válidos. El nombre de tabla usado por los rollups pasa por
una allowlist antes de interpolarse en SQL.

`upsertWorker(worker)` manda `active` como NULL cuando el caller no lo incluyó:
el INSERT lo resuelve a 1 y el UPDATE de `ON CONFLICT` conserva
`workers.active`. Así un heartbeat no reactiva un worker decomisionado;
`active`, igual que `first_seen`, solo cambia si llega explícito.

`samples` y `gaps` declaran `FOREIGN KEY (worker_id) REFERENCES workers(id) ON
DELETE CASCADE`, y `openDb()` habilita `pragma('foreign_keys = ON')` porque
SQLite lo apaga por conexión. No hay migración destructiva a propósito: las DB
ya creadas no reciben FKs retroactivamente, por lo que `insertSample`,
`insertSamples` y `recordGap` se cubren además con `assertWorkerExists`, que
reusa un statement cacheado `SELECT 1 FROM workers WHERE id = ?`.

En netwatch, `thr-avg`/`thr-max`/`thr-jitter`/`thr-stdev`/`thr-loss-percent` son los UMBRALES CONFIGURABLES, mientras que las mediciones de solo lectura se llaman `rtt-avg`/`rtt-min`/`rtt-max`/`rtt-jitter`/`rtt-stdev`/`loss-count`/`loss-percent`. Las dos páginas oficiales de MikroTik se contradicen: la vieja (help.mikrotik.com) mezcla ambas familias en una sola tabla. Manda la CLI reference nueva: manual.mikrotik.com/docs/cli-reference/tool/netwatch/. Confundirlas hace que el cliente lea el umbral configurado creyendo que es la medición.
