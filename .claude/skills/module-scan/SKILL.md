---
name: module-scan
description: "🔬 Loop MICRO del programa de modularización (PLAYB-26, scope backend): escanea UN módulo de Mi Consola, descubre lo escapado (código huérfano/sin registrar), arregla lo seguro y lo registra en Pad — sin romper nada, verificando cada paso, un módulo por vez. Úsalo al revisar/consolidar un módulo backend (trigger on-review), no solo para el programa de modularización original — cualquier auditoría módulo-por-módulo futura lo reusa tal cual."
argument-hint: "[module: nombre del módulo a escanear, ej. health, comms, tickets]"
cwc-share: host-only
cwc-default: false
---

# 🔬 Escanear y consolidar un módulo (loop de modularización)

Escaneás UN módulo backend de Mi Consola de punta a punta: bugs de correctitud, violaciones de reglas duras, código escapado (huérfano o sin registrar), y lo dejás consolidado y registrado en Pad. Un módulo por vez — nunca varios a la vez en la misma pasada.

## Argumentos

- `module` (requerido) — el módulo a escanear (ej. `health`, `comms`, `tickets`).

## Pasos

1. **Escanear read-only** (rol Auditor): lanzá un subagente Claude que lea los archivos del módulo y busque bugs de correctitud + violaciones de reglas duras + código escapado/muerto. En paralelo, corré el lane Codex (rol Independent Reviewer, skill `codex-verify`) si hay cuota. Inyectá las reglas duras (sección "Reglas duras"/"Convenciones" de CLAUDE.md) en el prompt del auditor.
2. **Verificar los hallazgos VOS MISMO** — imprescindible, hay falsos positivos reales conocidos (ej. un "gh fuera de canónico" que resultó ser un FP del censor matcheando la palabra "gh" dentro de un comentario). Leé el código citado antes de tocar nada.
3. **Descubrir escapados**: cruzá con `coherenceCensus().completeness` (`unregistered`/`unmounted`/`orphanRunners`/`orphanEngines`, ver `core/inventory.js`). Traé al módulo lo que le pertenece. NO confíes ciegamente en el inventario — el propio detector puede estar podrido.
4. **Aplicar SOLO fixes seguros y verificados.** Lo riesgoso (sin sello Codex) se DIFIERE a un `BUG` con tag `codex: pending` en vez de aplicarse a ciegas. Nunca debilitar una regla dura para que un hallazgo "cierre".
5. **Verificar** (Convención "Proceso de cambio" de CLAUDE.md): `node --check` → `systemctl --user restart claude-web-console` → `journalctl` → `GET /api/health/checks` en 11/11 ok → test funcional real → `codex-verify` sobre el diff (si hay cuota).
6. **Registrar en Pad**: actualizar el `DOC` del módulo (estado + hallazgos + sello), crear `BUG`s por lo diferido (linkeados con `implements` al DOC), marcar la `TASK` del módulo `done`.
7. **Actualizar CLAUDE.md + el inventario** (`node bin/cwc-inventory.js`) si cambió la arquitectura.

## Definición de HECHO (por módulo)

Registrado + montado (si aplica) + sin huérfanos + `node --check` ok + salud ok + Codex sin hallazgos abiertos (o `BUG` con `codex: pending`) + `DOC`/`TASK` de Pad al día.

## Orden histórico del programa (referencia, no repetir a ciegas)

B0 detector Coherencia → B1 tickets → B2 health → B3 comms/learning/chat → B4 tasks/tokens → B5 hojas sueltas. Si te invocan para un módulo NUEVO fuera de este orden (auditoría puntual, no el programa original), el loop es el mismo — solo cambia el argumento `module`.

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Fuente de verdad: `PLAYB-26` en Pad `console`. Si el procedimiento cambia, actualizar ahí primero y resincronizar este archivo.*
