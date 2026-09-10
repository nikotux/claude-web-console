<!-- cwc:ficha-modulo -->
# src/modules/sponsorship — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

Patrocinio self-service de perfiles que un administrador dejó en
`awaiting-sponsor`. Separa las dos facultades del alta: el admin decide quién
entra a la consola; cada usuario decide a quién le presta su propia credencial
de Claude.

La ruta base es `/api/sponsorship`. Todos sus endpoints requieren autenticación
por el gate global de la API, resuelven al usuario con `principalOf(req)` y
**nunca son admin-only**. Esa ausencia de gate administrativo es deliberada: la
adopción pertenece al sponsor, no al administrador.

## Endpoints

| Método | Ruta | Contrato |
|---|---|---|
| GET | `/api/sponsorship/candidates` | Devuelve `{ candidates: [{ username }] }` sólo para perfiles en `awaiting-sponsor`; no filtra ningún otro dato del registro. |
| GET | `/api/sponsorship/mine` | Devuelve `{ canSponsor, tokenReady, sponsored }`; cada patrocinado incluye `{ username, todayUsd, thresholdUsd }`. |
| POST | `/api/sponsorship/adopt` | El principal adopta `{ username }` únicamente si el target existe y sigue esperando sponsor, no es él mismo y el principal no es patrocinado. |
| POST | `/api/sponsorship/release` | El principal suelta `{ username }` sólo cuando es su sponsor actual; cualquier otro caso responde `403` sin revelar al sponsor real. |

`mine` reutiliza la lectura cacheada del módulo `tokens` mediante
`withLocalUsage()`: conserva el TTL y la deduplicación de llamadas concurrentes.
La medición es resiliente por usuario; un fallo produce `todayUsd: null` sin
tumbar a los demás. El umbral usa `CWC_SPONSORED_USAGE_WARN_USD`, igual que el
chequeo de Salud, con default USD 10.

## Regla de autoridad

**Sólo se presta lo que es propio.** Un principal con
`sponsorshipState === 'none'` puede adoptar; un perfil patrocinado no puede
armar cadenas ni prestar la credencial de su sponsor. Adoptar tampoco roba un
perfil ya patrocinado: primero su sponsor actual debe liberarlo.

`release` deja al perfil en `awaiting-sponsor`, no en `none`, porque el admin ya
decidió que esa cuenta pertenece al tier patrocinado y todavía necesita quién
la pague. Volver a `none` revoca el patrocinio por completo y sigue siendo una
facultad administrativa mediante `{ sponsor: null }`.

## Archivos y estado

- `index.js`: registra los cuatro handlers HTTP y delega toda transición a
  `core/users.js`.
- No mantiene store propio. `setUserSponsor()` y `setAwaitingSponsor()`
  persisten indirectamente en `users.json`; este módulo nunca lo toca directo.

## Lo que más duele

- No agregues `requireAdmin`: impediría que cada sponsor decida desde su consola.
- `/candidates` devuelve únicamente `username`; agregar tier, rol o sponsor filtra datos de terceros a usuarios no-admin.
- Validar `awaiting-sponsor` antes de adoptar es el guard que impide robarle un patrocinado a otra persona.
- Un token de patrocinio ausente no impide adoptar: `tokenReady` existe para que la UI avise y la resolución de credenciales siga fallando cerrada mientras tanto.
