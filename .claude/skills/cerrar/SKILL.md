---
name: cerrar
description: "✅ Cierra o reporta cualquier cambio — bug arreglado, feature, refactor o fase de un plan — ejecutando las verificaciones técnicas y el contraste de intención obligatorios antes de decir «listo»."
cwc-share: catalog
cwc-default: true
---

# ✅ Cerrar cualquier cambio

Ejecutás este contrato antes de cerrar o reportar **cualquier** cambio. Las once obligaciones son acumulativas: no entregues mientras alguna quede pendiente.

## Procedimiento

1. **Verificá la sintaxis de cada archivo JavaScript tocado.** Enumerá primero todos los archivos modificados o nuevos con `git status --short` y corré, sin omitir ninguno:

   ```bash
   node --check <archivo.js>
   ```

2. **Hacé un smoke test de imports en un proceso aparte.** Cargá el módulo o registry afectado con el mecanismo que use el repo:

   ```bash
   node -e "require('./ruta/al/registry.js')"
   node -e "import('./ruta/al/modulo.js').catch(error => { console.error(error); process.exit(1); })"
   ```

   `node --check` **no detecta imports nombrados rotos**; este paso es independiente y obligatorio.

3. **Reiniciá el servicio y revisá sus logs**, pero solo después de completar la pre-condición “Antes de reiniciar” de esta skill:

   ```bash
   systemctl --user restart claude-web-console
   journalctl --user -u claude-web-console -n 20 --no-pager
   ```

4. **Verificá la API en caliente** contra la instancia activa, usando el token de esa instalación:

   ```bash
   export CWC_BASE_URL="https://<host>:8092"
   export CWC_TOKEN="$(grep '^CWC_TOKEN=' .env | cut -d= -f2-)"
   curl -sk -H "x-cwc-token: $CWC_TOKEN" "$CWC_BASE_URL/api/<endpoint-afectado>"
   ```

5. **Verificá la UI con Playwright.** Esperá `domcontentloaded`; **NUNCA `networkidle`**, porque la aplicación hace polling y `networkidle` cuelga:

   ```bash
   node -e 'const { chromium } = require("playwright-core"); (async () => { const browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-cwc-token": process.env.CWC_TOKEN } }); const page = await context.newPage(); await page.goto(process.env.CWC_BASE_URL, { waitUntil: "domcontentloaded" }); console.log(await page.title()); await browser.close(); })().catch(error => { console.error(error); process.exit(1); });'
   ```

6. **Comprobá que `GET /api/health/checks` deje todos los checks en `ok`:**

   ```bash
   curl -sk -H "x-cwc-token: $CWC_TOKEN" "$CWC_BASE_URL/api/health/checks" | node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { const result = JSON.parse(body); const checks = result.checks; if (!Array.isArray(checks)) throw new Error("respuesta sin checks"); const bad = checks.filter(check => check.status !== "ok"); if (bad.length) { console.error(bad); process.exit(1); } console.log("todos los checks: ok"); });'
   ```

7. **Actualizá la ficha de la carpeta tocada**, `<carpeta>/CLAUDE.md`, según las Reglas 8 y 14(a), y verificá que figure en el diff:

   ```bash
   git diff --name-only -- <carpeta>/CLAUDE.md
   ```

8. **Actualizá el `CLAUDE.md` raíz solo si cambió una regla, una convención o el resumen del mapa**, según las Reglas 14(b) y 14(d). Verificá la decisión con:

   ```bash
   git diff --name-only -- CLAUDE.md
   ```

9. **Registrá el cierre en tu workspace de Pad** — el del mundo interno del usuario que corre la skill — según la Regla 11: `BUG` si es un bug; `TASK` o `PLAN` si es una entidad; `pad_item action=decide` si es una decisión de arquitectura.

10. **Avisá si las sesiones o chats ya abiertos no toman el cambio.** Los runners cargan el código al nacer: indicá explícitamente cuándo hace falta abrir o reiniciar sesiones para verlo.

11. **Ejecutá el contraste 🧭 CP-Ω contra el ancla del pedido original.** Usá la skill `contrastar`, revisá cada criterio con evidencia citable y exigí veredicto global 🟢 antes de entregar.

## La obligación 11 no es una más de la lista

Las obligaciones 1–10 verifican que el cambio no **ROMPA** nada; ninguna verifica que el cambio **SEA** lo que se pidió. Un trabajo con las diez en verde y el contraste en 🟡 no está terminado: corregí la deriva y volvé a contrastar.

Iterar hasta 🟢 es lo esperado. Tres pasadas 🟡 seguidas implican escalar a quien hizo el pedido. Un 🔴 indica cambio de alcance y no se resuelve en soledad: pedí una enmienda.

## Antes de reiniciar — checklist de sesiones paralelas

Esta es una pre-condición del paso 3, no un consejo:

- 🔴 `git status` no muestra ediciones **ajenas** a medio hacer. Reiniciar con código de otra sesión a medio escribir puede provocar un crash-loop.
- 🔴 No hay flujos OAuth o device-code en curso. Viven solo en memoria y el reinicio los mata sin aviso.
- 🟠 No hay jobs o runners dependientes de estado en memoria. El reinicio puede dejarlos huérfanos.
- 🟠 Si hay sesiones paralelas activas, coordiná el reinicio por interfono.

## Fuera de alcance

El commit lo hace el dueño desde el botón de la interfaz. Nunca preguntes “¿commiteo?” ni lo pongas en la pelota; como máximo, dejá un recordatorio pasivo al cerrar.

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Fuente de verdad: `PLAYB-2183`.*
