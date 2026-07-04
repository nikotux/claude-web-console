# Tarea pendiente — Módulo bugfixes: modo branch para "Enviar PR"

> Origen: sesión Desk #519 (2026-07-03). El botón "Enviar PR" terminó "exitoso" sin
> efecto dos veces, porque el módulo solo soporta el modo-foto y el trabajo real vivía
> en un branch dentro de un git worktree. Los contextos ya documentan la excepción
> (`~/.cwc-data/bugfix-context.md` Fase 5, `~/.cwc-data/bugfix-pr-context.md` header);
> esta tarea cierra el gap de código.

## Qué falló (evidencia)

- `bugfixes.json` entrada TKT #519: `cwd: ~/tolkien`, `branch: null`, `files: []` —
  el módulo no tenía nada que copiar ni sabía del branch `fix/desk-519-holiday-calendar-drift`
  (que vivía en el worktree `~/tolkien-desk519`).
- Histórico: TODAS las entradas de `bugfixes.json` tienen `prUrl: null` — el flujo
  `pushPr` nunca produjo un PR real.
- `src/modules/bugfixes/index.js` (`pushPr`, ~L90): modo-foto — worktree temporal desde
  `origin/main`, branch sintético `bugfix/tkt-*`, copia solo `entry.files`, push sin
  force. `updatePr` (~L160): push fast-forward desde el branch del PR, jamás `--force`.
- Contradicción con `bugfix-pr-context.md` §2/§3: el workflow de la casa exige rebase +
  `--force-with-lease` post-rebase + suite completa verde pre-push; el módulo no hace
  ninguna de las tres.

## Qué implementar

1. **Registro de branch al cerrar la sesión de bugfix**: que la sesión (o el módulo, al
   capturar el summary) persista en la entrada: `branch`, `worktreePath`, `prNumber`,
   `rebased: bool`, `bodyDraftPath`. Hoy quedan `null`.
2. **Modo branch en `pushPr`/`updatePr`**: si la entrada tiene `branch` + worktree:
   - `git fetch origin` + freshness check (§2 del workflow).
   - Push de ESE branch desde su worktree. `--force-with-lease` SOLO si
     `rebased === true` y el branch es propio (`fix/*`, `bugfix/*`); jamás plain
     `--force`; jamás tocar `main`.
   - Si hay `prNumber`: `gh pr edit --body-file <bodyDraftPath>` en vez de crear PR.
   - Mantener el modo-foto actual como fallback para fixes simples de archivos.
3. **Verificación de resultado (obligatoria, la falla más grave)**: tras "enviar",
   consultar GitHub (`gh pr view --json headRefOid,updatedAt`) y comparar contra el SHA
   local. Si no cambió → reportar FALLO al usuario, nunca "listo" sin efecto.
4. **Gate de suite**: rehusarse a pushear si la entrada no marca la suite verde
   (`pnpm -r build && pnpm -r test`) posterior al último rebase, o correrla el módulo.
5. Descubrimiento de worktrees: `git worktree list --porcelain` en vez de asumir
   `~/tolkien`.

## Criterio de aceptación

- Reproducir el escenario #519 (branch con 2 commits rebased en un worktree, PR
  existente) y que el botón: pushee con `--force-with-lease`, actualice el body,
  verifique el head en GitHub y actualice `bugfixes.json` (`prUrl`, `status`).
- El modo-foto sigue funcionando para una entrada con `files` y sin `branch`.
- Un envío sin efecto real es imposible de reportar como éxito.
