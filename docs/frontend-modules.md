# Patrón de módulos frontend

Cómo agregar un módulo nuevo a la consola **sin tocar los existentes**. Es el
espejo del patrón del backend (`src/core/registry.js`): allá un módulo expone
`{ name, registerHttp, registerWs }`; acá expone `{ name, mount }`.

## La interfaz

Cada módulo frontend es un archivo en `public/js/modules/<nombre>/<nombre>.js`
que exporta por default:

```js
export default {
  name: 'minombre',           // debe coincidir con el data-module del HTML
  mount(el, ctx) {
    // `el` es TU contenedor: renderizá TODO adentro (header incluido).
    // `ctx` son los servicios de la app (ver abajo). No uses
    // document.getElementById para nada que esté fuera de `el`.
  },
};
```

## Los 3 pasos para un módulo nuevo

1. **Slot en el HTML** — agregá en `public/index.html` un contenedor donde
   quieras que viva:

   ```html
   <section class="side-sec" data-module="minombre"></section>
   ```

2. **El módulo** — creá `public/js/modules/minombre/minombre.js` con la
   interfaz de arriba. Convenciones internas:
   - Renderizá con template strings dentro de `el` y usá `data-ref="x"` para
     tus propios elementos (`el.querySelector('[data-ref="x"]')`), nunca ids
     globales.
   - Íconos: `ctx.icon('refresh', { size: 14 })` (nombres en
     `public/js/ui/icons.js`).
   - Botones: SOLO `.btn` (primario, uno por vista) y `.btn-ghost`, con
     modificadores `.btn--sm`, `.btn--danger`, `.btn--block`, `.btn--icon`.
   - Nada de `confirm()`/`prompt()`/`alert()`: usá `ctx.dialog`.
   - Estado de carga: `<div class="cwc-loading"><span class="cwc-spinner"></span>cargando…</div>`.
   - Si hacés polling: pausalo con `document.hidden`.

3. **Registrarlo** — en `public/js/main.js`, importalo y sumalo al array:

   ```js
   import minombre from './modules/minombre/minombre.js';
   const MODULES = [launcher, sessions, tolkien, stats, usage, system, minombre];
   ```

Cero cambios en los demás módulos. Si el slot no existe en el HTML, el módulo
simplemente no se monta (no rompe).

## Los servicios de `ctx`

| Servicio | Qué hace |
|---|---|
| `ctx.icon(name, {size})` | SVG del sistema de íconos (string HTML). |
| `ctx.dialog.openModal({title, width, onClose})` | Cáscara de modal propia. Devuelve `{ body, close, setTitle }`; renderizá dentro de `body`. |
| `ctx.dialog.confirmDialog({title, message, confirmLabel, danger})` | `Promise<boolean>`. |
| `ctx.dialog.promptDialog({title, message, value, placeholder})` | `Promise<string\|null>`. |
| `ctx.dialog.alertDialog({title, message})` | `Promise<void>`. |
| `ctx.openSession({cwd, runClaude, model, title, attach})` | Crea una sesión (pestaña) y la enfoca. `cwd` relativo al home; `model` opcional lanza `claude --model <x>`; `attach: {socket, session}` envuelve una sesión tmux existente. |
| `ctx.focusSession(id)` | Enfoca una pestaña abierta. `false` si no existe. |
| `ctx.findSessionByCwd(rel)` | Id de la pestaña abierta cuyo cwd termina en esa ruta, o `null`. |
| `ctx.whoami` | `Promise` con `{type, username, admin}` (o `null`). |
| `ctx.bus` | `EventTarget` de la app. Eventos actuales: `sessions-changed` (se creó/mató una sesión — refrescá tu lista) y `open-launcher` (abrir el lanzador). Podés emitir los tuyos. |
| `ctx.isMobile()` / `ctx.hideSidebarOnMobile()` | Helpers de viewport. |

## Estilos

- Variables SIEMPRE de `public/css/tokens.css` (`--cwc-*`); prohibido el hex
  suelto. Tipografía solo con `--cwc-fs-xs|sm|md|lg|xl`; radios solo con
  `--cwc-radius-sm|md|lg`.
- Componentes compartidos (botones, diálogos, spinner) en `public/css/ui.css`.
- Los estilos propios del módulo van en `public/css/style.css` bajo un
  comentario `/* ===== MiNombre ===== */`, prefijando las clases con una
  sigla propia (ej. `.mn-…`).

## Ejemplo mínimo completo

```js
// public/js/modules/reloj/reloj.js
export default {
  name: 'reloj',
  mount(el, ctx) {
    el.innerHTML = `
      <header class="sec-head"><span class="sec-title">Reloj</span></header>
      <div class="tk-card"><span data-ref="hora">--:--</span></div>`;
    const hora = el.querySelector('[data-ref="hora"]');
    setInterval(() => {
      if (!document.hidden) hora.textContent = new Date().toLocaleTimeString('es');
    }, 1000);
  },
};
```

Más `<section class="side-sec" data-module="reloj"></section>` en index.html y
el import en `MODULES`. Listo.

## Referencia completa: La Forja

`public/js/modules/forja/` muestra el patrón para una superficie con tarjeta de sidebar, polling que respeta `document.hidden`, modal con pestañas, estado opt-in, ayuda e i18n. El orquestador (`forja.js`) conserva red y ciclo de vida; las vistas (`ficha.js`, `salon.js`, `arena.js`) reciben datos y construyen DOM sin interpolar strings del servidor en `innerHTML`. Sus estilos siguen viviendo en `public/css/style.css` bajo el prefijo `.fj-` y sus colores salen de tokens semánticos `--forja-*`.

## Si el módulo necesita backend

Creá también `src/modules/<nombre>/index.js` con la interfaz estándar del
backend y sumalo a `src/core/registry.js` (ver README, sección "Cómo agregar
un módulo nuevo"). Tus rutas quedan bajo `/api/<nombre>/…` y ya pasan por la
autenticación global.
