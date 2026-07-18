# Runbook SP9-3 — Caps systemd del Pad local

> Runbook de PLAN-595 (SP9). Fuente: DOC-514. La unidad canónica versionada vive en `systemd/pad-local.service` (este repo); la unidad VIVA está en `~/.config/systemd/user/pad-local.service` (fuera del repo).

## BLUF
Con N inquilinos cargando el Pad local conviene subir los caps systemd. Nuevos valores: **CPUQuota 400%** (2→4 núcleos de techo), **MemoryMax 8G / MemoryHigh 6G** (antes 4G/3G). Es techo, no reserva; el uso real es ~50 MB idle.

## Valores
| Cap | Antes | Ahora | Racional |
|---|---|---|---|
| CPUQuota | 200% (2 núcleos) | **400%** (4 núcleos) | host tiene 8 núcleos; margen para N usuarios sin dejar que un pico acapare todo |
| MemoryMax | 4G | **8G** | Pad ~50 MB idle; techo generoso, host tiene 62 GiB |
| MemoryHigh | 3G | **6G** | umbral de presión antes del hard-max |

## Aplicar (lo hace Niko al desplegar — NO reinicia el server de la consola)
```
cp ~/claude-web-console/systemd/pad-local.service ~/.config/systemd/user/pad-local.service
systemctl --user daemon-reload
systemctl --user restart pad-local
systemctl --user show pad-local -p CPUQuota,MemoryMax,MemoryHigh
```
Verificar que la última línea reporte `CPUQuotaPerSecUSec` acorde a 400% (=4s/s) y `MemoryMax=8589934592` / `MemoryHigh=6442450944`.

## Nota
Estos caps son un TECHO de seguridad, no una reserva: no quitan recursos a la consola ni al resto. Si Pad quedara CPU-bound con muchos inquilinos (improbable dado el idle medido), subir CPUQuota; si se acerca a MemoryHigh de forma sostenida, subir MemoryMax/High. Nunca quitar el techo (evita que un runaway del Pad tumbe la máquina).
