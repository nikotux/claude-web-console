# Runbook SP9-1 — Requisito de suscripción Claude por-usuario

> Runbook operativo de PLAN-595 (SP9). Fuente: DOC-514, decisión 🅱. Mundo INTERNO (Consola).

## BLUF
El throughput de IA **escala solo** en multi-tenant porque cada inquilino trae SU cuenta de Claude — no hay ventana de rate-limit compartida. El requisito: cada usuario necesita su propia suscripción con quota suficiente. La consola verifica que su OAuth token exista antes de habilitar sesiones.

## Requisito
| Ítem | Valor |
|---|---|
| Plan mínimo | Claude Pro (Max recomendado para uso intensivo/agentes) |
| Quota | La de su propio plan — es SU ventana de rate-limit, independiente de los demás |
| Cómo se canjea | Flujo de onboarding de la consola → `claude setup-token` (PTY), el usuario pega el código; el token queda en `userOauthTokenPath(userId)` (`~/.cwc-users/<u>/.claude/oauth-token`, mode 600) |
| Cuello compartido | NINGUNO de IA. Cada cuenta = su ventana. |

## Por qué escala solo
A diferencia de un recurso compartido (un solo API key de org toparía a todos contra el mismo rate-limit), acá cada inquilino aporta su propia suscripción → su propia ventana de 5h/semanal. Sumar usuarios suma capacidad de IA, no la reparte. Es la mejor propiedad del diseño 🅱 de DOC-514.

## Check liviano en el onboarding
- El paso de credenciales (`POST /api/onboard/creds-*`, runner PTY `bin/cwc-onboard-runner.js`) ya EXISTE y no se reescribe.
- La consola expone `hasToken` en `GET /api/onboard/creds-status?token=...`: `true` cuando `readUserOauthToken(user)` devuelve un token no vacío. El front puede avisar "falta canjear tu suscripción" si `hasToken=false` tras el flujo.
- El runner del inquilino es **fail-closed**: sin token propio NI creds en su `.claude`, NO arranca (self-check anti-consumo en `runner-link.spawnRunner`). Un inquilino sin suscripción canjeada simplemente no puede abrir sesiones — no consume la cuenta de nadie más.

## Operación
1. Al invitar un usuario, avisarle que necesita su propia suscripción Claude (Pro/Max).
2. En el onboarding, tras registrarse, completa el paso de credenciales (`claude setup-token`).
3. Verificar `hasToken=true` en el estado antes de darle por habilitado.
4. Si un usuario reporta "no puedo abrir sesiones": revisar que su `oauth-token` exista (check liviano) — no es un bug de la consola, es que falta canjear/renovar su token.
