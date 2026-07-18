# Decisión SP9-6 — Política de clones per-usuario + retención de transcripts

> Decision-doc del sub-plan **PLAN-595 (SP9 — Capacidad, límites y equidad de recursos)**, hijo de PLAN-500 (multi-tenant). Fuente: DOC-514. Gobierna la implementación de **TASK-673** (clones) y **TASK-674** (reaper de retención). Registrado además con `pad_item decide` en PLAN-595.

## BLUF
El host alcanza de sobra (411 GB libres, 8 núcleos, 53 GiB RAM); lo que se dimensiona son los LÍMITES por-inquilino. Para el disco: **clon SHALLOW por default** (chico, simple, re-clonable) con escalación documentada a `--reference` si N crece; **retención de transcripts por edad + tamaño con ventana de gracia por mtime** que protege sola las sesiones vivas.

## 1) Clones del workspace de trabajo (Tolkien u otro repo) por-inquilino

Cada inquilino trabaja sobre su propia copia del repo, confinada a `userWorkspace(userId)` (`~/.cwc-users/<u>/workspace/`). Hoy NO existe lógica de clone en el repo (verificado: `core/pad-provision.js` clona colecciones de Pad, no repos git).

| Ancla | Estrategia | Disco | Red | Riesgo | Veredicto |
|---|---|---|---|---|---|
| 🟢 | `--depth 1 --single-branch --branch main` (SHALLOW) | ~árbol de trabajo (chico) | baja | pierde historia; algunas ops de git degradadas | **DEFAULT** |
| 🟡 | `--reference <base>` (object store compartido, sin dissociate) | mínimo (comparte objetos) | mínima | si el repo base se mueve/`gc`/borra → el clon se corrompe | escalación bajo presión de disco |
| 🔵 | `--reference <base> --dissociate` | ~full (copia objetos) | mínima | seguro (sin acople) pero sin ahorro de disco | variante segura de 🟡 |
| ⚪ | clon completo | ~tamaño del repo c/u | alta | ninguno | opt-out para historia completa |

**Elegido (🟢):** `git clone --depth 1 --single-branch --branch main <repoUrl> <userWorkspace>/<repoName>`, **idempotente** (si `<destino>/.git` ya existe → no re-clona), best-effort (un fallo no tumba el onboarding), confinado al workspace del inquilino saneado.

**Por qué:** con 411 GB de margen HOY el disco no es cuello de botella, así que gana la opción más simple y disposable — un clon shallow se re-clona gratis si se corrompe. `--reference` (🟡) es lo ÚNICO que ahorra disco REAL (comparte el object store), pero acopla el clon a que el repo base nunca se mueva ni corra `git gc` agresivo (dangling alternates → clon roto). `--dissociate` (🔵) quita ese acople copiando los objetos, pero entonces el disco final ≈ full clone (solo ahorra red). Reservamos 🟡 para cuando N crezca y el disco apriete, **con el guard operativo: nunca borrar ni `gc` el clon base**.

**Escalación (documentada, no default):** cuando `df` del host baje del ~15% libre, migrar a `--reference <cloneBaseDelHost> --dissociate` para las provisiones nuevas (seguro), o a `--reference` sin dissociate si se acepta el guard del base. Config por env: `CWC_CLONE_STRATEGY=shallow|reference|full` + `CWC_CLONE_REFERENCE_BASE=<path>`.

**Fuera de alcance v1:** el repo base a referenciar (un clon canónico del host que nunca se toca). Hoy no hace falta (default shallow).

## 2) Retención / poda de transcripts por-inquilino

Los transcripts de Claude Code por-usuario viven en `userClaudeDir(userId)/projects/**/*.jsonl` (`~/.cwc-users/<u>/.claude/projects/...`). Crecen sin tope. Reaper reanudable (regla de oro/regla 2: estado en archivos, sobrevive reinicios; best-effort; loguea lo podado).

| Ancla | Parámetro | Env | Default | Qué hace |
|---|---|---|---|---|
| 1️⃣ | Edad máxima | `CWC_TRANSCRIPT_MAX_AGE_DAYS` | 90 | borra `.jsonl` con mtime > 90 días |
| 2️⃣ | Cap de tamaño por-user | `CWC_TRANSCRIPT_MAX_BYTES` | 2 GiB | si el dir del user supera el cap, borra oldest-first hasta bajar |
| 3️⃣ | Ventana de gracia | `CWC_TRANSCRIPT_GRACE_DAYS` | 7 | NUNCA borra archivos con mtime dentro de la ventana |

**Clave de diseño (3️⃣):** la ventana de gracia por **mtime** protege sola las sesiones VIVAS o recientes **sin que el reaper conozca los sessionIds vivos del server**. Un transcript de una sesión activa se escribe de continuo → su mtime es fresco → cae dentro de la gracia → el reaper no lo toca. Esto mantiene el reaper **desacoplado** del proceso del server (corre como runner aparte, sin IPC ni lock compartido con el manager de chats).

**Alcance v1:** solo transcripts de INQUILINOS (`~/.cwc-users/<u>/.claude/projects`). El HOST (Niko, `~/.claude/projects`) queda **opt-in** por env (`CWC_REAP_HOST=1`) porque es su home real, más sensible. El reaper **NO** toca datos de runtime (`~/.cwc-data`: chats.json, jobs, etc.) en v1 — demasiado riesgo de borrar estado importante; se documenta como extensión futura conservadora.

**Quién enumera los usuarios:** `~/.cwc-users/*` (dirs de inquilinos) + `hostUser()` si opt-in. Reusa `userClaudeDir(userId)` de `core/user-space.js`.

**Cadencia:** el reaper es un runner desacoplado (`bin/cwc-transcript-reaper.js`) que se corre a demanda o por timer/cron externo (systemd timer o cron de Niko, fuera del alcance de este bloque). Estado/log en `~/.cwc-data/transcript-reaper.log`.
