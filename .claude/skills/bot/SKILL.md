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

## Ciclo de corrección

1. Corregí los hallazgos mediante el flujo normal de la sesión (Codex/Tándem).
2. Confirmá los cambios en un commit: los cambios sin commit no entran en la revisión.
3. Volvé a correr `/bot`.
4. Repetí hasta obtener `approve`.

Hacé como máximo 5 rondas. Si todavía no hay `approve`, frená y escalá al usuario con los hallazgos que siguen abiertos y lo que ya se intentó.

## Reglas duras

- Nunca hagas push ni abras un PR desde esta skill. Sigue aplicando el gate normal de push.
- Nunca muestres ni registres el token de GitHub.
- Los cambios sin commit no se revisan: pedí que se confirmen primero.
- Si el CLI termina con exit code 3, explicá que el modo preflight del bot todavía no está desplegado y continuá con el flujo normal.

---

Contrato: **preflight API v1**. Esta skill debe mantenerse sincronizada con **Tolkien desk:#1510**.
