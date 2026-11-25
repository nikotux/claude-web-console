---
name: bot
description: "🤖 Corre la revisión del bot de PRs de Tolkien (Sol 6.2, misma política y veredicto) sobre tu rama ANTES de abrir o actualizar el PR, y trae los hallazgos al chat para corregirlos de una. Usala antes de cualquier push/PR en Tolkien o cuando el usuario diga /bot, 'pasale el bot', 'revisá con el bot', 'preflight'."
cwc-share: catalog
cwc-default: true
---

# 🤖 Preflight del bot de PRs

## Qué resuelve

Evita el ciclo lento de push → revisión del bot → corrección → otro push. Ejecuta sobre el `HEAD` confirmado de la rama la misma política y el mismo veredicto del bot de PRs, antes de abrir o actualizar el PR.

Usala antes de cualquier push o PR en Tolkien, y cuando el usuario diga `/bot`, «pasale el bot», «revisá con el bot» o «preflight».

## Cómo correrlo

Los comandos usan `$CWC_CONSOLE_ROOT`, la raíz de la instalación de la consola que el server inyecta en cada sesión. Así el CLI funciona desde cualquier checkout. Si la variable no está definida, la sesión no salió de la consola: pedile al usuario que abra el trabajo desde un chat o una terminal de la consola, sin armar la ruta a mano.

```bash
node "$CWC_CONSOLE_ROOT/bin/cwc-bot-preflight.js" --json
```

Corré el comando como tarea en background: la revisión suele tardar entre 2 y 6 minutos. Esperá su resultado sin bloquear el resto de la sesión.

## Cómo presentar el resultado

Resumí primero el veredicto y después los hallazgos, con los bloqueantes arriba y lenguaje llano:

| Severidad | Hallazgo | Archivo:línea | Qué hacer |
|---|---|---|---|
| blocking | F1 · descripción breve | `src/archivo.js:42` | Corrección concreta |
| P2 | F2 · descripción breve | `src/otro.js:18` | Mejora a evaluar |
| P3 | F3 · descripción breve | `src/ejemplo.js:7` | Mejora a evaluar |

Los hallazgos `blocking` son los que frenan el merge; los `P2` y `P3` son mejoras a evaluar.

No copies el JSON crudo si una explicación breve alcanza. Incluí también los hallazgos no bloqueantes.

## Triage de hallazgos: argumento primero, código por descarte

Aplica a los hallazgos del preflight y a los del bot sobre el PR. Antes de escribir una línea de código, pasá cada hallazgo por estas preguntas en orden. El código es el último recurso: cada arreglo es código nuevo que el bot revisa de cero y puede traer hallazgos nuevos (así se arma el loop).

Las citas `:NN` son líneas de `.github/review-policy.md` en `origin/main` de Tolkien. Releelas antes de citar: la política cambia.

1. **¿Lo introdujo el PR?** Si no → respuesta con evidencia de que el defecto ya existía (`:50`).
2. **¿Es de Simplicidad?** Si el reemplazo stock que propone el bot no resuelve el escenario → respuesta explicando por qué (`:50`). Si lo resuelve → código (suele achicar el PR).
3. **¿Es improbable según Likelihood (`:20-27`)?** El escenario requiere alguna de estas cosas, sin evidencia de que pase en producción:
   - 1️⃣ un sistema externo (Zoho, Graph, Teams, QuickBooks…) que viola su contrato documentado;
   - 2️⃣ una salida de IA equivocada de forma puntual que pasa todas las validaciones;
   - 3️⃣ datos que ni la fuente ni el código del camino normal pueden producir;
   - 4️⃣ un operador que usa mal un comando privilegiado a propósito.
   Si encaja y el impacto no es grave → respuesta citando el criterio + evidencia.
   ⚠️ Excepción `:34`: plata mal cobrada o pagada, datos de una persona vistos por otra, datos borrados o pisados, o una frontera de seguridad cruzada siguen bloqueando aunque sean improbables.
4. **Experimento vigente (Nico, 2026-11-25): argumento en todo.** Aunque el hallazgo no encaje claro en 1–3, intentá primero la respuesta con evidencia. Recién si el bot la rechaza (`still_open`), pasá a código.

**Qué argumento rinde más (resultado del experimento en Tolkien #2331, 2026-11-25: 4 de 6 hallazgos cerrados sin código):**

| Argumento | Cita | Resultado |
|---|---|---|
| No lo introdujo el PR (el mismo camino existe en la base) | `:50` | ✅ 1/1 |
| No puede ocurrir (un workflow o guard lo impide, citando `archivo:línea`) | `:50` | ✅ 1/1 |
| Impacto menor → P3, que no bloquea (acotar tamaño, alcance y quién lo ve) | `:51` | ✅ 2/2 |
| Improbable con datos de prod | `:20-27` | ⚠️ 0/3: el bot lo rechaza si los datos no cubren exactamente el escenario (p. ej. ramas pusheadas vs. locales) o si el camino normal puede producirlo |

Orden sugerido: 1) no lo introdujo el PR, 2) no puede ocurrir, 3) **impacto menor → P3**, 4) recién después, improbable. Si un argumento de probabilidad fue rechazado, probá impacto menor sobre el mismo hallazgo antes de ir a código.

Cómo responder (`:54`: sin evidencia, el argumento falla; repetir la política no es respuesta):
- Una respuesta por hallazgo, **en su hilo**, con: el criterio (`:NN`), `Requires:` qué tendría que pasar, y la evidencia: `archivo:línea` del código que produce o limita el dato, el contrato documentado del proveedor, o datos de producción.
- Respondé todos los hallazgos **en una sola tanda**: el bot junta las respuestas que llegan dentro de 60 s en una sola re-revisión, y cada head tiene solo 3 re-revisiones por comentario.
- Antes de publicar, mostrale al usuario el texto exacto de cada respuesta y esperá su OK (es un mensaje externo).
- En el preflight todavía no hay PR ni hilos: dejá las respuestas redactadas y publicalas después de abrir el PR.

Registrá el experimento en una tabla al cerrar cada ronda:

| Hallazgo | Ruta (argumento / código) | Criterio citado | Resultado del bot |
|---|---|---|---|

## Ciclo y tope

1. Hacé el triage de todos los hallazgos.
2. Publicá las respuestas (con OK) o corregí por el flujo normal de la sesión (Codex/Tándem) solo los hallazgos que quedaron para código.
3. Confirmá los cambios en un commit: los cambios sin commit no entran en la revisión.
4. Volvé a correr `/bot` (preflight) o esperá la re-revisión del bot en el PR.

Tope: **como máximo 2 rondas de código por PR**. Desde la tercera, solo respuestas con evidencia o escalar al usuario con los hallazgos abiertos, lo que se intentó y el resultado de cada argumento.

## Reglas duras

- Nunca hagas push ni abras un PR desde esta skill. Sigue aplicando el gate normal de push.
- Nunca publiques respuestas a hallazgos sin mostrar el texto exacto y tener el OK del usuario.
- Nunca muestres ni registres el token de GitHub.
- Los cambios sin commit no se revisan: pedí que se confirmen primero.
- Si el CLI termina con exit code 3, explicá que el modo preflight del bot todavía no está desplegado y continuá con el flujo normal.

---

Contrato: **preflight API v1**. Esta skill debe mantenerse sincronizada con **Tolkien desk:#1510**.
