# Interfono — Análisis completo del bus de mensajería entre sesiones para revisión externa

**Fecha:** 2026-07-10 · **Autor:** Nicolás Mosquera (asistido por Claude Code) · **Versión:** v01
**Alcance:** `src/core/bus.js` (núcleo) + `bin/cwc-bus.js` (hooks/CLI) + `src/modules/interfono/` (panel) + la integración con el chat del SDK (auto-entrega server-side + centro global de popups en `public/js/`).
**Objetivo del documento:** entregar a un experto externo TODO lo necesario para auditar el diseño de entrega/notificación del Interfono y devolver recomendaciones accionables, **sin acceso al repositorio**.
**Idioma:** español (default del estándar documental interno). Los identificadores de código conservan su nombre original.

---

## Resumen ejecutivo

El **Interfono** es un bus de archivos (0 tokens, determinístico, sin LLM) que permite a varias sesiones de Claude Code — TUIs en `tmux` y chats del SDK — corriendo **a la vez sobre el mismo repositorio**, coordinarse: (1) mandarse **mensajes** entre sí y (2) **reservar archivos** (`claims`) antes de editarlos, para no pisarse. Nació para resolver un problema físico real (dos sesiones editando el mismo archivo a la vez, ediciones perdidas) y con el tiempo creció para que esos mensajes también "despierten" al chat visual (la superficie principal de trabajo), primero en silencio (auto-entrega a chats abiertos y ociosos) y después con un **popup global** que avisa en cualquier pantalla cuando un mensaje quedó sin tomar.

**El problema que motiva la revisión:** en el uso real de estos días (varias sesiones de Claude Code trabajando en paralelo — p. ej. Optimización IA y Revisión de Salud sobre distintos archivos), el usuario abre **varias ventanas/pestañas del navegador** para atender cada frente. El diseño actual asume, implícitamente, que "una ventana = todas las conversaciones le interesan por igual": el centro global de popups (`public/js/ui/interfono-center.js`) se alimenta de **todos** los chats del servidor (`GET /api/chat/list`), no solo de los que esa ventana en particular tiene abiertos o le conciernen. Resultado medido y reproducible en el propio código (ver §3.5 y §5-D1): un mensaje de coordinación entre dos sesiones de Optimización IA dispara un popup **en cualquier otra ventana abierta**, incluida una donde el usuario está concentrado en un tema de Salud que no tiene relación alguna con ese mensaje. A esto se suma que el popup **exige una decisión** ("▶ Retomar" / "✕ Descartar") en vez de resolverse solo — fricción visual que el usuario ya no quiere para el trabajo del día a día.

**Lo que pedimos al experto (detalle en §8):** en una línea — *¿cómo rediseñar la capa de notificación del Interfono para que (a) funcione "por backend", sin pedirle al usuario que decida retomar/descartar cada mensaje, y (b) solo se manifieste en la sesión/ventana realmente afectada, sin perder la robustez anti-colisión de archivos que ya funciona bien?*

---

## 1. Contexto del sistema

| Campo | Valor |
|---|---|
| Producto | Consola web personal sobre Claude Code (`claude-web-console`), un solo usuario dueño |
| Sesiones concurrentes que coordina | TUIs `tmux` (`bin/cwc-bus.js` vía hooks de Claude Code) + chats del SDK (`@anthropic-ai/claude-agent-sdk`, superficie principal de trabajo) |
| Superficie multi-ventana | La consola es una SPA: **cada pestaña/ventana del navegador que el usuario abre es una instancia independiente** del frontend, con su propio estado en memoria (`activeId`, `tabs` — qué chat está enfocado ahí). El servidor es uno solo y no distingue "ventanas"; solo conoce sesiones/chats |
| Transporte | Archivos planos en `~/.cwc-data/session-bus/` (mensajes, claims, lápidas) — 0 tokens, sobrevive reinicios del server |
| Costo real | El bus en sí es gratis. El único "costo" indirecto es cuando un mensaje se **auto-entrega** a un chat abierto: se inyecta como un turno más de esa conversación (consume contexto/ficha de esa conversación, no dispara una llamada nueva a un modelo por separado) |
| Confianza | Un solo usuario dueño de todas las sesiones — no hay aislamiento por identidad ni permisos entre sesiones (modelo de confianza plena, documentado como gotcha del proyecto) |
| Restricción dura de los hooks | **Fail-open siempre**: un fallo del Interfono NUNCA debe romper el turno de una sesión de Claude Code (excepción: `hook-guard`, que sí puede bloquear una edición, pero solo con evidencia positiva de colisión) |

---

## 2. Por qué llegamos acá — evolución en 3 etapas

### 2.1 Etapa 1 — el problema original: sesiones pisándose archivos

Con varias sesiones de Claude Code abiertas sobre el mismo repo (p. ej. dos chats trabajando features distintas, o una TUI y un chat en paralelo), no había forma de que se "hablaran": si dos sesiones tocaban el mismo archivo a la vez, una podía sobreescribir silenciosamente el trabajo de la otra. La única forma de evitarlo era que el usuario hiciera de cartero manual entre ventanas.

Se construyó `core/bus.js`: un bus de archivos con dos capacidades — **mensajería** (una sesión le deja un mensaje a otra, o a `all`) y **claims** (antes de editar, la sesión reclama el archivo; si otra sesión *viva* ya lo tiene reclamado, se frena). El árbol de decisión de un claim ajeno (`evaluateClaim`, §3.1) es la pieza más madura del sistema: distingue si la dueña del claim sigue realmente trabajando (caliente/viva) o es un "zombi" (sesión terminada, tmux caída, inactiva) para poder robar el claim de forma segura.

Identidad: una TUI se identifica por su nombre de sesión `tmux` (`tmux:<nombre>`); un chat del SDK, por su `sessionId` (`claude:<sessionId>`). Los hooks de Claude Code (`SessionStart`, `UserPromptSubmit`, `PreToolUse`/`PostToolUse` de Edit/Write/MultiEdit, `SessionEnd`) son la única vía de entrada/salida — instalados de forma aditiva/reversible en `~/.claude/settings.json` por `bin/install-interfono.js`.

### 2.2 Etapa 2 — el chat visual es la superficie principal, pero no "escucha" en vivo

Una TUI recibe un mensaje entrante con un **nudge en vivo**: si está idle, se le teclea el aviso por `tmux send-keys` y lo ve al instante. Un chat del SDK **no tiene ese canal** — solo "ve" mensajes pendientes cuando el hook `UserPromptSubmit` corre, es decir, cuando el usuario ya escribió su propio turno. Como el chat visual pasó a ser la superficie principal de trabajo (la TUI quedó como respaldo — decisión de producto ya tomada y documentada), esa asimetría era un problema: un mensaje podía quedar esperando indefinidamente si el chat no recibía un turno humano pronto.

Se agregó entonces, del lado del servidor (`ChatManager._deliverInterfono`, cada 12 s), una **auto-entrega silenciosa**: si un chat está **abierto** (tiene algún cliente WebSocket conectado) y **ocioso** (`status === 'waiting'`, sin turno en curso), el mensaje se inyecta como un turno sintético — aparece como una burbuja más en la conversación, paridad con el nudge de la TUI. Chats dormidos, ocupados o sin ninguna pestaña abierta **no** se despiertan solos (para no gastar tokens fantasma).

### 2.3 Etapa 3 — el centro global de popups (para no perder nada)

El punto anterior deja un hueco: ¿qué pasa con un mensaje dirigido a un chat que está dormido, trabajando, o simplemente sin ninguna ventana abierta en ese momento? Ahí no hay auto-entrega. Para que esos mensajes no se pierdan de vista, se construyó el **Centro Global de Interfono** (`public/js/ui/interfono-center.js`, gemelo del centro de permisos `perm-center.js`): un stack de popups flotantes, visible **desde cualquier pantalla** de la consola, alimentado por el mismo poll de 8 s que ya usaba el resto de la UI (`GET /api/chat/list`, campo `pendingInterfono[]` por chat). Cada tarjeta ofrece **▶ Retomar** (inyecta el mensaje y despierta el chat si hacía falta) o **✕ Descartar** (lo marca entregado sin actuar).

Esta 3ª etapa es la que hoy genera la queja: fue diseñada para "no perder mensajes", pero no distingue **en qué ventana del navegador** aparece el aviso ni si esa ventana tiene algo que ver con el chat afectado — ver §3.5 y §5.

---

## 3. Arquitectura actual (detallada)

### 3.1 Primitivas del núcleo (`core/bus.js`)

```
Identidad:  tmux:<nombre-de-sesión-tmux>   (TUI, estable, derivada de $TMUX_PANE)
            claude:<sessionId>              (chat del SDK)
            Una TUI escucha en AMBOS handles; un chat solo en el suyo.

Mensajería: sendMessage({from, to, text, kind})  → archivo en messages/
            pendingFor(handles)                   → no entregados aún, no propios, TTL vivo
            markDelivered(msgs, handles)           → idempotente

Claims:     claimFile({absPath, handle, ...})      → reserva/renueva
            evaluateClaim(claim) → {state}:
                hot     🔴 editado hace <5 min (HOT_MS)         → BLOQUEA
                alive   🔴 observador dice "trabajando" y fresco → BLOQUEA
                gray    🟡 viva pero inactiva <30 min (GRAY_MS)  → permite + avisa (heads-up)
                zombie  🟢 sesión terminada / tmux caída         → ROBABLE
                stale   🟢 TTL vencido sin actividad              → ROBABLE
            blocks(state) / stealable(state)

Lápidas:    tombstone({file, formerHandle, byHandle}) — aviso persistido de que a alguien
            le "robaron" un claim inactivo; se lo notifican en su próximo turno.
```

Umbrales (constantes exportadas): `HOT_MS=5min`, `GRAY_MS=30min`, `OBS_FRESH_MS=5min`, `MSG_TTL_MS=6h`, `TOMB_TTL_MS=24h`, `MAX_HOPS=6`.

### 3.2 Hooks realmente instalados hoy (`~/.claude/settings.json`, verificado en esta máquina)

| Hook de Claude Code | Comando | Rol |
|---|---|---|
| `SessionStart` | `cwc-bus.js hook-inject` | Al abrir la sesión, imprime mensajes/lápidas pendientes → Claude los recibe como contexto |
| `UserPromptSubmit` | `cwc-bus.js hook-inject` (+ `cwc-observe.js working` + el hook de "🎾 la pelota", ajeno al Interfono) | En cada turno del usuario, misma inyección de pendientes |
| `PreToolUse` (matcher `Edit\|Write\|MultiEdit`) | `cwc-bus.js hook-guard` | Antes de editar: si el archivo tiene un claim ajeno que **bloquea**, frena la herramienta (`exit 2` + motivo en `stderr`) |
| `PostToolUse` (mismo matcher) | `cwc-bus.js hook-claim` | Después de editar: crea/renueva el claim propio sobre ese archivo |
| `SessionEnd` | `cwc-bus.js hook-release` (+ `cwc-observe.js ended`) | Libera todos los claims propios al cerrar |

`hook-inject` es fail-open (nunca corta la sesión); `hook-guard` es la única excepción deliberada que puede bloquear (con evidencia positiva de colisión).

### 3.3 Dos rutas de entrega — y son asimétricas

**a) TUI (`tmux`)** — vía `bin/cwc-bus.js`, función `tryNudge`:

```js
// send-keys de aviso a una TUI idle. Devuelve true si nudgeó.
function tryNudge(entry, self, text) {
  const obs = entry.claudeSid ? bus.readObserver(entry.claudeSid) : findObserverByTmux(entry.tmux);
  if (!obs || obs.status !== 'waiting' || !obs.model) return false;
  if (Date.now() - (obs.ts || 0) > 10 * 60 * 1000) return false; // no idle-fresh
  if (!bus.tmuxHasSession(entry.tmux)) return false;
  // ... tmux send-keys -l "<línea>" + Enter
  return true;
}
```
Si no se puede nudgear (trabajando, o es una shell sin Claude), el mensaje queda en la bandeja y lo ve recién en su próximo turno vía `hook-inject`. **Sin popup, sin decisión del usuario**: se entrega solo, o espera solo.

**b) Chat del SDK** — dos mecanismos combinados:

1. **Watcher server-side** (`ChatManager._deliverInterfono`, cada `INTERFONO_POLL_MS = 12000` ms):
```js
_deliverInterfono() {
  for (const c of this.chats.values()) {
    if (c.closed || !c.sessionId || c.viewMode !== 'chat') continue;
    if (!(c.alive && c.status === 'waiting' && c.clients.size > 0)) continue; // abierto + ocioso
    const msgs = bus.pendingFor([`claude:${c.sessionId}`]);
    if (msgs.length) c.deliverInterfono(msgs);
  }
}
```
`deliverInterfono` marca entregado, arma un texto con los mensajes y lo empuja como `{type:'user'}` — **visible como burbuja en la conversación**, y dispara el turno (`this.link?.send({t:'user', text})`). Es automático y silencioso: **no pide nada**, pero sí "interrumpe" esa conversación con un turno que el usuario no escribió.

2. **Centro global de popups** (para todo lo que el watcher NO cubre: chats dormidos, trabajando, o sin ninguna pestaña abierta):
```js
// public/js/main.js — se llama cada 8 s desde CUALQUIER ventana abierta de la consola
async function pollTabStatus() {
  const chats = await fetch('/api/chat/list').then(r => r.json()).then(d => d.chats || []);
  permCenter?.syncFromList(chats);
  intercomCenter?.syncFromList(chats);   // ← alimenta el popup con TODOS los chats del server
  ...
}
```
```js
// public/js/main.js — instanciación
intercomCenter = initInterfonoCenter({
  isChatActive: (chatId) => activeId === chatId && tabs.has(chatId), // ESTADO LOCAL de ESTA ventana
  openChat: openChatById,
});
```
```js
// public/js/ui/interfono-center.js
function render() {
  for (const item of items.values()) {
    const hide = isChatActive(item.chatId); // única condición de supresión
    item.el.hidden = hide;
  }
}
```

### 3.4 Diagrama de flujo (estado actual)

```
Sesión A manda un mensaje ──► bus.sendMessage() (archivo)
                                       │
              ┌────────────────────────┴─────────────────────────┐
              ▼ destino = TUI                                     ▼ destino = chat SDK
      tryNudge(): ¿idle+fresh?                          server watcher (12s):
        SÍ → send-keys YA (sin popup)                     ¿abierto + ocioso (waiting)?
        NO → bandeja (hook-inject en su próximo turno)       SÍ → auto-entrega (burbuja + turno)
                                                              NO → queda pendiente
                                                                     │
                                                                     ▼
                                                    CUALQUIER ventana del navegador
                                                    (poll de 8s, /api/chat/list)
                                                              │
                                          isChatActive(chatId) := activeId de ESTA ventana
                                                              │
                                          NO coincide con el chatId del mensaje
                                          (aunque esta ventana no tenga nada que ver)
                                                              │
                                                              ▼
                                               🔔 popup "Retomar / Descartar"
                                               aparece en TODAS las ventanas donde
                                               ese chat no sea la pestaña activa
```

### 3.5 El hallazgo concreto — por qué "afecta a todas las ventanas"

`isChatActive` solo puede responder con la información que YA tiene **esa** ventana de navegador (su propio `activeId` y su propio mapa `tabs`). Pero `syncFromList(chats)` recibe la lista **completa** de chats del servidor — no hay ningún filtro de "¿esta ventana tiene algo que ver con este chat?" antes de decidir si mostrar el popup. En la práctica:

- Ventana A tiene abierto y activo el Chat 1 (trabajando Optimización IA).
- Ventana B tiene abierto y activo el Chat 2 (trabajando Revisión de Salud) — sin relación alguna con el Chat 1.
- Llega un mensaje de coordinación al Chat 1 (p. ej. "libero el claim de inventory.js").
- El Chat 1 está `waiting` con clientes conectados (Ventana A lo tiene abierto) → se auto-entrega ahí, correcto.
- **Pero además**, el poll de 8 s de la Ventana B también trae ese mismo Chat 1 en la respuesta de `/api/chat/list` con `pendingInterfono` (hasta que se marque entregado) o, si el chat quedó momentáneamente "occupied" en vez de "waiting", el mensaje sigue pendiente varios ciclos → la Ventana B, que **no tiene idea de qué es el Chat 1**, igual dispara el popup, porque `isChatActive('chat-1')` da `false` en la Ventana B (ni siquiera está en su `tabs`).

Esto es exactamente lo que describe el usuario: "cuando abro varias sesiones para trabajar (...) el interfono se vuelve invasivo y afecta a todas las ventanas".

---

## 4. Datos reales de comportamiento (hoy, 2026-07-10)

Fuente: `~/.cwc-data/session-bus/messages/*.json` — 23 mensajes vivos en el momento de escribir este documento (TTL 6 h, así que reflejan solo la última ventana de actividad).

| Categoría | Cantidad | Ejemplo |
|---|---|---|
| Automáticos (`kind:'heads-up'`, generados por `hook-guard` en estado `gray`) | 2 | *"Heads-up: edité `public/css/style.css`, que figurabas reservando pero estabas inactiva..."* |
| Manuales, coordinación entre sesiones (`/btw` o `send` humano-disparado desde dentro de un chat) | 21 | *"Terminé mi cambio en inventory.js (regex de queryCalls, línea 243...). Libero el claim. Dale con tu propuesta de constMapStr..."* |

**Hallazgo secundario (identidad débil del lado chat):** los 21 mensajes manuales tienen `from: null`. Razón: `selfIdentity()` en `bin/cwc-bus.js` deriva el remitente del `$TMUX_PANE` (TUI) o del `session_id` recibido por `stdin` (hooks). Cuando un **chat del SDK** ejecuta `node bin/cwc-bus.js send ...` como una llamada de herramienta `Bash` normal, no hay `$TMUX` ni JSON de hook en `stdin` — así que `self.primary` queda `null` y el mensaje se registra con `fromName: "una sesión"` genérico. La atribución real depende enteramente del nombre de destino que el humano (o el propio modelo) tipeó a mano. Esto importa para el rediseño: **hoy no hay forma confiable, del lado servidor, de saber "qué chat mandó este mensaje"** sin parsear texto libre — un futuro filtro "¿esta ventana tiene relación con el remitente?" no puede apoyarse en `from` tal cual está.

**Ejemplo real de secuencia** (mismo día, ~1 h de trabajo con al menos 3 sesiones paralelas — Optimización IA sobre `inventory.js`, feature de adjuntos en `chat/index.js`, y Aprendizaje sobre `style.css`):

```
12:23  claude:938bb...  → claude:1b616...  heads-up automático (gray claim, style.css)
12:31  claude:1b616...  → claude:938bb...  heads-up automático (gray claim, style.css)
12:32  (from null)      → claude:1b616...  "Releído: tu edición de style.css NO pisó mi bloque..."
12:37  (from null)      → claude:1b616...  "Recibido, gracias. Terminé mis ediciones en style.css..."
13:12  (from null)      → claude:1b616...  "Estoy implementando adjuntos de archivos en el chat..."
13:14  (from null)      → claude:938bb...  "Necesito agregar ~15 líneas al final del bloque..."
13:14  (from null)      → claude:dbd7b...  "Terminé mis ediciones en src/modules/chat/index.js..."
13:15  (from null)      → claude:938bb...  "Adelante, tu zona no se solapa con mi bloque..."
13:17  claude:dbd7b...  → claude:1b616...  heads-up automático
13:22  (from null)      → claude:dbd7b...  "Recibido, releí chat/index.js: tus ediciones..."
...
13:42  (from null)      → claude:c907d...  "Otra sesión recibió la MISMA propuesta de Optimización IA..."
13:43  (from null)      → all              "Terminé mi cambio en inventory.js... Libero el claim..."
13:44  (from null)      → all              "Para la sesión 'Optimizar: censo (inventory)'..."
```

En **1 hora, ≥13 mensajes** cruzaron entre sesiones — cada uno de ellos, mientras el usuario tenía varias ventanas abiertas, es un candidato a disparar un popup "Retomar/Descartar" en ventanas que no tenían nada que ver con el tema. Esta es la cadencia real que hoy se siente como ruido.

---

## 5. Diagnóstico de por qué se siente invasivo (hipótesis internas — el experto puede confirmar, refutar o reordenar)

| # | Debilidad hipotética | Evidencia | Efecto |
|---|---|---|---|
| D1 | **Broadcast cross-ventana:** el popup se decide con el estado LOCAL de cada ventana (`activeId`/`tabs`) pero se alimenta de TODOS los chats del servidor | `isChatActive` en `main.js` + `syncFromList` sin filtro en `interfono-center.js` (§3.5) | Un mensaje ajeno a lo que el usuario mira en la Ventana B igual le aparece ahí |
| D2 | **Fricción de decisión obligatoria:** el diseño asume que el usuario SIEMPRE quiere elegir manualmente Retomar/Descartar | Únicas 2 acciones del popup (`ic-dismiss`/`ic-resume`) | Contradice el pedido explícito: "que no me pregunte, que funcione por backend" |
| D3 | **Auto-entrega sin filtrar relevancia:** el watcher de 12 s entrega el mensaje a CUALQUIER chat abierto+ocioso, sin distinguir si el usuario está realmente mirando esa pestaña en ese instante | `_deliverInterfono()` solo chequea `alive && waiting && clients.size>0`, no mira foco de UI | Una conversación que el usuario dejó "abierta de fondo" recibe un turno inyectado igual, y esa burbuja puede aparecer cuando vuelva a esa pestaña sin previo aviso |
| D4 | **Identidad débil del lado chat (`from: null`):** un chat del SDK no puede identificarse a sí mismo al invocar `send` por Bash tool | 21/23 mensajes de hoy con `from: null` (§4) | Imposibilita, tal cual está, cualquier regla futura de "solo avisar a la ventana relacionada con el remitente/destinatario real" |
| D5 | **Un solo canal para dos necesidades distintas:** "coordinación crítica de archivos" (alguien va a pisar tu edición) vs. "bitácora informativa" (aviso de progreso, sin acción requerida) reciben el mismo tratamiento visual | `kind` existe en el mensaje (`note` vs `heads-up`) pero la UI no lo usa para diferenciar urgencia | Un aviso puramente informativo compite visualmente con uno que sí requiere reacción |
| D6 | **Sin telemetría de la molestia:** a diferencia de otros módulos (p. ej. el router de modelo, que loguea cada decisión en `model-router-log.jsonl`), el Interfono no registra cuántas veces se mostró un popup, en qué ventana, ni si el usuario lo descartó sin leerlo | No existe un log equivalente | Difícil medir objetivamente si un rediseño realmente bajó el ruido |

---

## 6. Cómo lo queremos — pedido explícito del usuario (2026-07-10)

Palabras del usuario, parafraseadas y ordenadas:

1. **"Que el interfono funcione por backend"** — que la coordinación entre sesiones se resuelva sola, sin depender de que el usuario decida algo en una tarjeta emergente.
2. **"Que no me pregunte si quiero retomar la sesión"** — eliminar (o reducir drásticamente) la interacción tipo "▶ Retomar / ✕ Descartar" como paso obligatorio.
3. **"Que me redirija a las ventanas que realmente están afectando los procesos"** — que la notificación (si la hay) aparezca **solo** en la ventana/sesión que de verdad tiene relación con lo que pasó, no en todas.
4. **Motivo de fondo:** con varias ventanas abiertas trabajando en paralelo (p. ej. temas de Salud), el interfono hoy se convierte en ruido visual que interrumpe el trabajo concentrado en cada ventana.

Lo que el usuario **no** pidió cambiar (para que quede explícito y el experto no lo toque sin necesidad): la lógica de `claims`/anti-colisión de archivos (§3.1) funciona bien y no es el foco de la queja; el foco es exclusivamente la **capa de notificación/entrega** de mensajes hacia el usuario humano.

---

## 7. Restricciones de diseño inamovibles

El experto debe respetarlas al proponer cambios (no son negociables):

1. **Cero tokens extra en el camino de mensajería/claims.** El bus sigue siendo archivos, sin LLM. La única excepción tolerada es la ya existente: un mensaje auto-entregado a un chat consume el contexto de ESA conversación (no una llamada nueva).
2. **Fail-open de los hooks.** Ningún cambio puede hacer que un fallo del Interfono rompa el turno de una sesión de Claude Code (excepción ya existente y a preservar: `hook-guard` bloqueando con evidencia positiva).
3. **No tocar el árbol de decisión de claims (`evaluateClaim`) ni sus umbrales** — es la pieza que sí funciona y resuelve el problema original (sesiones pisándose archivos). El rediseño es sobre la capa de notificación al humano, no sobre la anti-colisión entre agentes.
4. **Estado 100% en archivos**, sobrevive reinicios del servidor — regla de oro del proyecto (`~/.cwc-data/session-bus/`). No se desea introducir un servicio nuevo con estado en memoria del proceso Node.
5. **El chat visual sigue siendo la superficie principal de trabajo; la TUI es respaldo.** Cualquier rediseño debe seguir dándole al chat una cobertura igual o mejor que la que ya tiene la TUI (nudge en vivo).
6. **Un solo usuario dueño, confianza plena entre sesiones.** No hace falta resolver permisos ni aislamiento — el problema es puramente de "a qué ventana/pantalla mostrarle qué, y cuándo pedirle algo al usuario".
7. **No perder mensajes silenciosamente.** Aunque se reduzca la interacción obligatoria, debe quedar alguna forma (aunque sea pasiva, tipo bitácora) de que un mensaje importante que nadie atendió no desaparezca sin dejar rastro.

---

## 8. Preguntas concretas para el experto

1. **Silencioso por defecto:** ¿qué mensajes/heads-up pueden resolverse **sin ninguna interacción del usuario** (auto-aplicar y solo dejar constancia en una bitácora pasiva) y cuáles de verdad ameritan una interrupción activa? ¿Cómo trazar esa línea con la información que ya existe (`kind: 'note'|'heads-up'`, estado del claim, etc.) sin agregar clasificación por IA?
2. **Scoping correcto de "ventana afectada":** ¿cómo atar una notificación a la ventana/pestaña del navegador que realmente tiene abierto (o tiene relación directa con) el chat/archivo en cuestión, en vez del broadcast actual vía `/api/chat/list` sin filtro? ¿Conviene que el servidor sepa "qué chats tiene abiertos cada ventana" (requeriría un identificador de ventana que hoy no existe), o hay una forma más simple del lado cliente?
3. **Dos clases de aviso:** ¿vale la pena separar "coordinación crítica de archivos" (alguien puede pisar tu trabajo) de "bitácora informativa" (progreso de otra sesión) con tratamientos de UI distintos — la primera interrumpe, la segunda solo queda registrada?
4. **Identidad del remitente (chat SDK):** dado que hoy un chat no puede identificarse a sí mismo al invocar `send` (§4, `from: null`), ¿conviene resolverlo (p. ej. pasando el `sessionId` explícitamente al invocar el CLI) para habilitar un filtro de relevancia más fino, o hay una alternativa que no dependa de eso?
5. **Reemplazo del popup obligatorio:** si se quita la exigencia de "Retomar/Descartar", ¿qué reemplazo mínimo tiene sentido — un indicador pasivo (badge/punto) en la tarjeta de esa sesión en el panel "Sesiones", una entrada de bitácora consultable a demanda, algo distinto?
6. **Marco general:** ¿este problema se modela mejor como (a) un sistema de notificaciones con prioridad y "scoping" por contexto (al estilo de un centro de notificaciones de sistema operativo, que agrupa por app/ventana), (b) reglas de enrutamiento explícitas por relación remitente↔destinatario, o (c) algo más simple que no hemos considerado?
7. **Métrica de éxito:** sin telemetría hoy de "cuántas veces se mostró un popup irrelevante" (§5-D6), ¿qué instrumentación mínima recomendarías agregar para poder medir, después del rediseño, si realmente bajó el ruido?

---

## Anexo A — Constantes y umbrales (referencia rápida)

| Constante | Valor | Dónde | Significado |
|---|---|---|---|
| `HOT_MS` | 5 min | `core/bus.js` | Claim "caliente": editado hace menos de esto → bloquea |
| `GRAY_MS` | 30 min | `core/bus.js` | Zona gris: viva pero inactiva → se permite editar avisando (heads-up) |
| `OBS_FRESH_MS` | 5 min | `core/bus.js` | Frescura del `ts` del observador de estado (trabajando/esperando) |
| `MSG_TTL_MS` | 6 h | `core/bus.js` | Vida de un mensaje en el bus |
| `TOMB_TTL_MS` | 24 h | `core/bus.js` | Vida de una lápida (claim robado) |
| `MAX_HOPS` | 6 | `core/bus.js` | Tope para cortar cadenas de respuesta infinitas (no usado activamente hoy fuera del campo) |
| `INTERFONO_POLL_MS` | 12000 ms | `modules/chat/index.js` | Cadencia del watcher server-side que auto-entrega a chats abiertos+ociosos |
| Poll del frontend | 8000 ms | `public/js/main.js` | Cadencia de `pollTabStatus()` (alimenta permisos + interfono + estado de pestañas), en **cada ventana abierta** |
| Umbral de nudge idle-fresh (TUI) | 10 min | `bin/cwc-bus.js` (`tryNudge`) | Si el observador no está fresco dentro de esta ventana, no se nudgea |
| `MAX_MSGS` (tope de render) | 50 | `interfono-center.js` | Tope de mensajes renderizados por tarjeta de popup |

---

## Anexo B — Código fuente íntegro citado

### B.1 Núcleo — `src/core/bus.js` (fuente de verdad completa)

```js
// core/bus.js — "Interfono" entre sesiones de Claude Code.
//
// Problema que resuelve: varias sesiones de Claude Code (TUIs tmux + chats del
// SDK) corriendo a la vez sobre el MISMO repo pueden pisarse. Hoy la única
// forma de que se "hablen" era que el usuario hiciera de cartero. Este módulo
// es un BUS DE ARCHIVOS (0 tokens, determinístico) con dos capacidades:
//
//   1) MENSAJERÍA  — una sesión deja un mensaje para otra (o broadcast); la
//      destinataria lo recibe inyectado por su hook en el próximo turno.
//   2) CLAIMS      — antes de editar un archivo, una sesión reclama un "claim";
//      si otra sesión VIVA ya lo tiene, se frena y coordina. Los claims de
//      sesiones muertas (zombis) se detectan y roban con red de seguridad.
//
// TODO el estado vive en ~/.cwc-data/session-bus/ (sobrevive reinicios del
// server — regla de oro del proyecto). Nada colgado del proceso Node: las
// sesiones y los hooks invocan este core a través de bin/cwc-bus.js; el módulo
// backend (src/modules/interfono) lo importa para el panel.
//
// Identidad de una sesión = uno o más "handles":
//   - TUI  (tmux): `tmux:<nombre-de-sesión-tmux>`  (estable; emisor y receptor
//                   lo derivan de $TMUX_PANE — ver bin/cwc-bus.js)
//   - chat (SDK):  `claude:<sessionId>`             (id de sesión de Claude)
// Una TUI escucha en AMBOS (su claude sid y su tmux name); un chat solo en el
// claude sid. Así el emisor puede direccionar por nombre de tarjeta (tmux) y el
// receptor igual se reconoce.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { runTmux, tmuxDir } from './tmux.js';
import { loadTitles, titleKey } from './session-names.js';

// ===== Rutas y constantes =====
const ROOT = path.join(config.home, '.cwc-data', 'session-bus');
const MSG_DIR = path.join(ROOT, 'messages');
const CLAIM_DIR = path.join(ROOT, 'claims');
const TOMB_DIR = path.join(ROOT, 'tombstones');
const STATE_DIR = path.join(config.home, '.cwc-state'); // observador (cwc-observe.js)

// Umbrales del árbol de decisión de claims (ver evaluateClaim).
export const HOT_MS = 5 * 60 * 1000;      // claim "caliente": editado hace <5min
export const GRAY_MS = 30 * 60 * 1000;    // zona gris: viva pero inactiva <30min
export const OBS_FRESH_MS = 5 * 60 * 1000; // ts del observador considerado fresco
export const MSG_TTL_MS = 6 * 60 * 60 * 1000;   // mensajes viven 6h
export const TOMB_TTL_MS = 24 * 60 * 60 * 1000; // lápidas viven 24h
export const MAX_HOPS = 6; // corta cadenas de respuesta infinitas

function ensureDirs() {
  for (const d of [MSG_DIR, CLAIM_DIR, TOMB_DIR]) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* noop */ }
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj)); return true; } catch { return false; }
}
function listJson(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const j = readJson(path.join(dir, n));
    if (j) out.push({ _file: path.join(dir, n), ...j });
  }
  return out;
}

// Id sin depender de Math.random (vetado en algunos contextos del proyecto):
// contador de proceso + pid + tiempo. Único dentro de una corrida y entre
// procesos distintos.
let _seq = 0;
function newId(prefix) {
  _seq += 1;
  return `${prefix}${process.pid.toString(36)}${Date.now().toString(36)}${_seq.toString(36)}`;
}

// Slug estable de una ruta absoluta para nombre de archivo de claim.
function claimFileFor(absPath) {
  const hash = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
  return path.join(CLAIM_DIR, `${hash}.json`);
}

// ===== Observador (estado real trabajando/esperando por sesión de Claude) =====
export function readObserver(claudeSid) {
  if (!claudeSid) return null;
  return readJson(path.join(STATE_DIR, `${claudeSid}.json`));
}

// ===== tmux =====
function cwcSocketPath() {
  return path.join(tmuxDir(), config.tmuxSocket);
}
// ¿Existe una sesión tmux con ese nombre en el socket cwc?
export function tmuxHasSession(name) {
  if (!name) return false;
  const out = runTmux(cwcSocketPath(), ['has-session', '-t', `=${name}`], { throwOnError: false });
  // has-session no imprime nada en éxito y falla (runTmux => '') si no existe.
  // Distinguimos con list para no depender del throw: preguntamos la lista.
  if (out !== '') return true;
  const list = runTmux(cwcSocketPath(), ['list-sessions', '-F', '#{session_name}']);
  return list.split('\n').some((l) => l.trim() === name);
}

// ===== Directorio de sesiones (nombre amigable <-> handle) =====
// Reconstruye, SIN estado del server, el mismo mapa que muestran las tarjetas
// de "Sesiones": TUIs tmux (nombre = título custom || basename del cwd) + chats
// del SDK (de chats.json). Cada entrada trae su handle canónico para ruteo.
export function buildDirectory() {
  const entries = [];
  // --- TUIs tmux del socket cwc ---
  const titles = loadTitles();
  const raw = runTmux(cwcSocketPath(), ['list-sessions', '-F', '#{session_name}\t#{pane_current_path}\t#{pane_pid}']);
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [name, cwd, pid] = line.split('\t');
    if (!name) continue;
    const isBare = name.startsWith('cwct-'); // vistas TUI de conversaciones
    const friendly = titles[titleKey(config.tmuxSocket, name)] || path.basename(cwd || '') || name;
    entries.push({
      handle: `tmux:${name}`,
      name: friendly,
      kind: isBare ? 'tui-chat' : 'tui',
      tmux: name,
      cwd: cwd || null,
      pid: pid ? parseInt(pid, 10) : null,
      alive: true,
    });
  }
  // --- Chats del SDK (chats.json) ---
  const chats = readJson(path.join(config.home, '.cwc-data', 'chats.json'));
  if (Array.isArray(chats)) {
    for (const c of chats) {
      if (!c || !c.sessionId) continue;
      // Un chat en modo TUI ya aparece como sesión tmux bare: no duplicar.
      if (c.viewMode === 'tui') continue;
      entries.push({
        handle: `claude:${c.sessionId}`,
        name: c.title || c.id || 'chat',
        kind: 'chat',
        cwd: c.cwd || null,
        claudeSid: c.sessionId,
        alive: null, // se completa con el observador al evaluar
      });
    }
  }
  return entries;
}

// Resuelve el argumento de `/btw <destino>` a un handle (o 'all').
// Acepta: "all"/"todos" (broadcast); un handle explícito (tmux:… / claude:…);
// o un nombre amigable (case-insensitive, match exacto y luego por inclusión).
export function resolveTarget(arg) {
  const q = String(arg || '').trim();
  if (!q) return { error: 'Falta el destino' };
  if (/^(all|todos|todas|broadcast)$/i.test(q)) return { handle: 'all', name: 'todas las sesiones' };
  if (/^(tmux|claude):/.test(q)) return { handle: q, name: q };
  const dir = buildDirectory();
  const lc = q.toLowerCase();
  let hit = dir.find((e) => e.name.toLowerCase() === lc);
  if (!hit) {
    const partial = dir.filter((e) => e.name.toLowerCase().includes(lc));
    if (partial.length === 1) [hit] = partial;
    else if (partial.length > 1) {
      return { error: `"${q}" es ambiguo: ${partial.map((e) => e.name).join(', ')}` };
    }
  }
  if (!hit) return { error: `No encontré una sesión llamada "${q}". Sesiones: ${dir.map((e) => e.name).join(', ') || '(ninguna)'}` };
  return { handle: hit.handle, name: hit.name, entry: hit };
}

// ===== Mensajería =====
// Crea un mensaje. `from`/`fromName` identifican al emisor (best-effort).
export function sendMessage({ from, fromName, to, toName, text, kind = 'note', hops = 0 }) {
  ensureDirs();
  const id = newId('m');
  const msg = {
    id, from: from || null, fromName: fromName || 'una sesión',
    to, toName: toName || to, text: String(text || '').slice(0, 4000),
    kind, hops, ts: Date.now(), deliveredTo: {}, ackBy: {},
  };
  writeJson(path.join(MSG_DIR, `${id}.json`), msg);
  return msg;
}

// Mensajes pendientes para un conjunto de handles propios (no entregados aún a
// ninguno de ellos, no emitidos por uno mismo, dentro del TTL). NO muta.
export function pendingFor(handles) {
  const set = new Set(handles || []);
  const now = Date.now();
  return listJson(MSG_DIR).filter((m) => {
    if (now - (m.ts || 0) > MSG_TTL_MS) return false;
    if (set.has(m.from)) return false; // no me muestro mis propios mensajes
    const forMe = m.to === 'all' || set.has(m.to);
    if (!forMe) return false;
    return !handles.some((h) => m.deliveredTo && m.deliveredTo[h]);
  }).sort((a, b) => a.ts - b.ts);
}

// Marca como entregados a estos handles (idempotente) y persiste.
export function markDelivered(messages, handles) {
  const now = Date.now();
  for (const m of messages) {
    m.deliveredTo = m.deliveredTo || {};
    for (const h of handles) m.deliveredTo[h] = now;
    writeJson(m._file || path.join(MSG_DIR, `${m.id}.json`), stripMeta(m));
  }
}
function stripMeta(o) { const { _file, ...rest } = o; return rest; }

// Todos los mensajes vivos (para el panel).
export function allMessages() {
  const now = Date.now();
  return listJson(MSG_DIR)
    .filter((m) => now - (m.ts || 0) <= MSG_TTL_MS)
    .map(stripMeta)
    .sort((a, b) => b.ts - a.ts);
}

// ===== Claims =====
export function getClaim(absPath) {
  return readJson(claimFileFor(absPath));
}
export function allClaims() {
  return listJson(CLAIM_DIR).map(stripMeta);
}

// Crea o renueva el claim de `owner` sobre un archivo.
export function claimFile({ absPath, handle, claudeSid, name, kind, tmux, note }) {
  ensureDirs();
  const file = claimFileFor(absPath);
  const prev = readJson(file);
  const now = Date.now();
  const claim = {
    file: absPath,
    handle,
    claudeSid: claudeSid || (prev && prev.handle === handle ? prev.claudeSid : null) || null,
    name: name || (prev && prev.name) || handle,
    kind: kind || (prev && prev.kind) || null,
    tmux: tmux || (prev && prev.handle === handle ? prev.tmux : null) || null,
    note: note || (prev && prev.handle === handle ? prev.note : null) || null,
    ts: prev && prev.handle === handle ? (prev.ts || now) : now,
    renewedAt: now,
  };
  writeJson(file, claim);
  return claim;
}

// Libera el claim de un archivo si pertenece a alguno de estos handles.
export function releaseFile(absPath, handles) {
  const file = claimFileFor(absPath);
  const c = readJson(file);
  if (c && handles.includes(c.handle)) {
    try { fs.unlinkSync(file); } catch { /* noop */ }
    return true;
  }
  return false;
}

// Libera TODOS los claims de estos handles (cierre de sesión).
export function releaseAll(handles) {
  const set = new Set(handles || []);
  let n = 0;
  for (const c of listJson(CLAIM_DIR)) {
    if (set.has(c.handle)) {
      try { fs.unlinkSync(c._file); n += 1; } catch { /* noop */ }
    }
  }
  return n;
}

// Lápida: aviso persistido de que a `formerHandle` le robaron el claim de un
// archivo. Su próximo turno lo recibe inyectado (ver bin/cwc-bus.js hook-inject).
export function tombstone({ file, formerHandle, byHandle, byName }) {
  ensureDirs();
  const id = newId('t');
  writeJson(path.join(TOMB_DIR, `${id}.json`), {
    id, type: 'claim_stolen', file, formerHandle, byHandle, byName: byName || byHandle, ts: Date.now(),
  });
}
// Lápidas pendientes para un conjunto de handles (no entregadas).
export function tombstonesFor(handles) {
  const set = new Set(handles || []);
  const now = Date.now();
  return listJson(TOMB_DIR).filter((t) =>
    now - (t.ts || 0) <= TOMB_TTL_MS && set.has(t.formerHandle) && !(t.delivered));
}
export function markTombstonesDelivered(tombs) {
  for (const t of tombs) {
    t.delivered = Date.now();
    writeJson(t._file || path.join(TOMB_DIR, `${t.id}.json`), stripMeta(t));
  }
}

// ===== Árbol de decisión de un claim ajeno (¿sigue viva la dueña?) =====
// Devuelve { state, label, reason }. state ∈ hot | alive | gray | zombie | stale
export function evaluateClaim(claim) {
  if (!claim) return { state: 'none' };
  const now = Date.now();
  const age = now - (claim.renewedAt || claim.ts || 0);

  // 1) Caliente: editó ese archivo hace <5min => está EN el archivo ahora.
  if (age < HOT_MS) {
    return { state: 'hot', label: '🔴 editando ahora', reason: `${claim.name} editó este archivo hace menos de 5 minutos` };
  }

  // 2) Estado real del observador (si es una sesión con claude sid conocido).
  const obs = readObserver(claim.claudeSid);
  if (obs) {
    if (obs.status === 'ended') {
      return { state: 'zombie', label: '🟢 sesión terminada', reason: `${claim.name} ya cerró su sesión` };
    }
    if (obs.status === 'working' && now - (obs.ts || 0) < OBS_FRESH_MS) {
      return { state: 'alive', label: '🔴 trabajando', reason: `${claim.name} está trabajando activamente` };
    }
  }

  // 3) Signo vital físico: para TUIs, ¿existe todavía la sesión tmux?
  if (claim.tmux && !tmuxHasSession(claim.tmux)) {
    return { state: 'zombie', label: '🟢 tmux caída', reason: `La sesión tmux de ${claim.name} ya no existe` };
  }

  // 4) Viva pero inactiva: zona gris (<30min) vs TTL vencido.
  if (age < GRAY_MS) {
    return { state: 'gray', label: '🟡 inactiva', reason: `${claim.name} tenía el claim pero está inactiva (sin editar hace ${Math.round(age / 60000)} min)` };
  }
  return { state: 'stale', label: '🟢 claim vencido', reason: `El claim de ${claim.name} venció (sin actividad hace ${Math.round(age / 60000)} min)` };
}

// ¿Este estado bloquea la edición ajena?
export function blocks(state) { return state === 'hot' || state === 'alive'; }
// ¿Este estado permite robar el claim?
export function stealable(state) { return state === 'zombie' || state === 'stale' || state === 'none'; }

// ===== Recolección de basura oportunista =====
// La corre cualquier invocación del CLI: barre mensajes/lápidas/claims vencidos.
export function gc() {
  const now = Date.now();
  for (const m of listJson(MSG_DIR)) {
    if (now - (m.ts || 0) > MSG_TTL_MS) { try { fs.unlinkSync(m._file); } catch { /* noop */ } }
  }
  for (const t of listJson(TOMB_DIR)) {
    if (now - (t.ts || 0) > TOMB_TTL_MS) { try { fs.unlinkSync(t._file); } catch { /* noop */ } }
  }
  // Claims: se limpian por evaluación perezosa al chocar; acá solo barremos los
  // que superan LARGAMENTE el TTL gris y cuya tmux ya no existe (huérfanos).
  for (const c of listJson(CLAIM_DIR)) {
    const age = now - (c.renewedAt || c.ts || 0);
    if (age > GRAY_MS && c.tmux && !tmuxHasSession(c.tmux)) {
      try { fs.unlinkSync(c._file); } catch { /* noop */ }
    }
  }
}

export const paths = { ROOT, MSG_DIR, CLAIM_DIR, TOMB_DIR };
```

### B.2 Nudge de TUI y mensajería (`bin/cwc-bus.js`, fragmentos relevantes)

```js
// ================= SEND =================
function doSend() {
  let args = process.argv.slice(3);
  if (args[0] === '--') args = args.slice(1);
  const raw = args.join(' ').trim();
  const m = raw.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) { /* uso */ return done(0); }
  const [, targetArg, text] = m;
  const target = bus.resolveTarget(targetArg);
  if (target.error) { console.log('⚠ ' + target.error); return done(0); }

  const self = selfIdentity(parseHookInputSafe());
  const msg = bus.sendMessage({
    from: self.primary, fromName: self.name,
    to: target.handle, toName: target.name, text,
  });

  // Nudge SEGURO: si el destino es UNA TUI con Claude idle (el observador dice
  // waiting + modelo presente + ts fresco) y su tmux existe, le tecleamos un
  // aviso corto por send-keys para que lo vea YA. Si está trabajando o es un
  // shell, NO tocamos su input: el mensaje espera en la bandeja (hook-inject).
  let nudged = false;
  if (target.entry && target.entry.kind === 'tui') {
    nudged = tryNudge(target.entry, self, text);
  }
  const via = nudged ? 'entregado en vivo' : 'quedó en la bandeja (lo verá en su próximo turno)';
  console.log(`✅ Mensaje para ${target.name}: ${via}. [id ${msg.id}]`);
  return done(0);
}

// send se invoca desde una Bash tool: normalmente NO hay JSON de hook en stdin.
// Por eso self.primary suele quedar null para un CHAT del SDK (solo una TUI
// puede derivar tmuxName de $TMUX). Ver §4 del documento — hallazgo D4.
function parseHookInputSafe() {
  if (process.stdin.isTTY) return {};
  try { const s = fs.readFileSync(0, 'utf8'); return s ? JSON.parse(s) : {}; } catch { return {}; }
}

// send-keys de aviso a una TUI idle. Devuelve true si nudgeó.
function tryNudge(entry, self, text) {
  try {
    const obs = entry.claudeSid ? bus.readObserver(entry.claudeSid) : findObserverByTmux(entry.tmux);
    if (!obs || obs.status !== 'waiting' || !obs.model) return false;
    if (Date.now() - (obs.ts || 0) > 10 * 60 * 1000) return false; // no idle-fresh
    if (!bus.tmuxHasSession(entry.tmux)) return false;
    const socket = tmuxSocketPath();
    const short = String(text).replace(/\s+/g, ' ').slice(0, 200);
    const line = `[Interfono · mensaje de ${self.name}] ${short}  (para responder: /btw ${self.name} <respuesta>)`;
    execFileSync('tmux', ['-S', socket, 'send-keys', '-t', `=${entry.tmux}`, '-l', line], { stdio: 'ignore', env: cleanEnv() });
    execFileSync('tmux', ['-S', socket, 'send-keys', '-t', `=${entry.tmux}`, 'Enter'], { stdio: 'ignore', env: cleanEnv() });
    return true;
  } catch { return false; }
}

// ================= HOOK: inject (SessionStart / UserPromptSubmit) =================
function doInject() {
  const input = parseHookInput();
  const self = selfIdentity(input);
  if (!self.handles.length) return done(0);
  const msgs = bus.pendingFor(self.handles);
  const tombs = bus.tombstonesFor(self.handles);
  if (!msgs.length && !tombs.length) return done(0);
  // ... arma texto e imprime a stdout (Claude lo recibe como contexto) ...
  bus.markDelivered(msgs, self.handles);
  bus.markTombstonesDelivered(tombs);
  return done(0);
}

// ================= HOOK: guard (PreToolUse Edit|Write|MultiEdit) =================
function doGuard() {
  const input = parseHookInput();
  const absPath = input?.tool_input?.file_path;
  if (!absPath) return done(0);
  const self = selfIdentity(input);
  const claim = bus.getClaim(absPath);
  if (!claim || self.handles.includes(claim.handle)) return done(0);
  const verdict = bus.evaluateClaim(claim);
  if (bus.blocks(verdict.state)) {
    process.stderr.write(`⛔ INTERFONO: otra sesión (${claim.name}) está trabajando en ${absPath} — ${verdict.reason}.\n...`);
    return done(2); // BLOQUEO real de la herramienta
  }
  if (verdict.state === 'gray') {
    // SOFT: se permite, pero se avisa a la (posible) dueña inactiva — es el
    // ORIGEN de los mensajes automáticos "heads-up" vistos en §4.
    bus.sendMessage({ from: self.primary, fromName: self.name, to: claim.handle, toName: claim.name,
      text: `Heads-up: edité ${absPath}, que figurabas reservando pero estabas inactiva. Reléelo antes de seguir.`,
      kind: 'heads-up' });
    return done(0);
  }
  if (bus.stealable(verdict.state)) {
    bus.tombstone({ file: absPath, formerHandle: claim.handle, byHandle: self.primary, byName: self.name });
    bus.releaseFile(absPath, [claim.handle]);
    return done(0);
  }
  return done(0);
}
```

### B.3 Integración con el chat del SDK (`src/modules/chat/index.js`, fragmentos relevantes)

```js
// ===== Entrega del INTERFONO a los chats (core/bus.js) =====
// Una TUI recibe un mensaje del interfono por un "nudge" (send-keys) que la
// despierta EN VIVO; un chat del SDK NO: solo "ve" el mensaje cuando toma un
// turno (el hook-inject corre en UserPromptSubmit — settingSources: ['user']).
// Por eso, para el chat visual (superficie principal de trabajo; la TUI es
// backup), esta plomería (a) AUTO-ENTREGA el mensaje a los chats abiertos y
// ociosos inyectando un turno sintético (paridad con el nudge idle de la TUI),
// y (b) expone los pendientes en /api/chat/list para el popup global
// (public/js/ui/interfono-center.js) + el botón "Retomar" (que despierta
// incluso un chat dormido, a demanda del usuario — 0 tokens fantasma).
const CWC_BUS = path.join(CONSOLE_ROOT, 'bin', 'cwc-bus.js');
const INTERFONO_POLL_MS = 12000;

class Chat {
  // ===== Interfono (mensajería entre sesiones, core/bus.js) =====
  _busHandle() { return this.sessionId ? `claude:${this.sessionId}` : null; }

  // Mensajes del interfono aún NO entregados a este chat (para el popup global
  // y el botón "Retomar"). Solo LEE el bus (0 tokens); no marca entregado — así
  // el aviso persiste hasta que el chat lo toma (turno/hook o botón).
  pendingInterfono() {
    const h = this._busHandle();
    if (this.closed || !h) return [];
    let msgs;
    try { msgs = bus.pendingFor([h]); } catch { return []; }
    return msgs.map((m) => ({
      id: m.id, fromName: String(m.fromName || 'sesión').slice(0, 60),
      text: String(m.text || '').slice(0, 400), ts: m.ts || null,
    }));
  }

  // Inyecta los mensajes pendientes como UN turno sintético (equivalente al
  // nudge send-keys de la TUI). Marca ENTREGADO antes de disparar el turno para
  // que el hook-inject de ese mismo UserPromptSubmit no re-inyecte el mismo
  // mensaje (doble). Revive el motor con resume si estaba dormido (_ensureEngine).
  deliverInterfono(msgs) {
    const h = this._busHandle();
    if (this.closed || !h || !Array.isArray(msgs) || !msgs.length) return;
    try { bus.markDelivered(msgs, [h]); } catch { /* noop */ }
    const body = msgs.map((m) => `• [${fmtHora(m.ts)}] ${m.fromName || 'una sesión'}: ${m.text}`).join('\n');
    const text = '📨 INTERFONO — mensaje(s) de otra(s) sesión(es) de Claude Code:\n' + body + '\n...';
    this.lastActivity = Date.now();
    this._setStatus('working');
    this._push({ type: 'user', text }); // visible como burbuja en la conversación
    this._ensureEngine().then((ok) => { if (ok !== false) this.link?.send({ t: 'user', text }); });
  }

  // Acción del popup/botón: 'deliver' inyecta (y despierta si hace falta),
  // 'dismiss' marca entregado SIN actuar (limpia el aviso). Idempotente.
  consumeInterfono(action) {
    const h = this._busHandle();
    if (this.closed || !h) return { ok: false, error: 'La conversación no tiene una sesión activa.' };
    let msgs;
    try { msgs = bus.pendingFor([h]); } catch { msgs = []; }
    if (!msgs.length) return { ok: true };
    if (action === 'dismiss') { bus.markDelivered(msgs, [h]); return { ok: true }; }
    this.deliverInterfono(msgs);
    return { ok: true };
  }

  info() {
    return {
      // ...
      pendingPerms: this.pendingPerms(),
      pendingInterfono: this.pendingInterfono(), // consumido por TODA ventana vía /api/chat/list
    };
  }
}

class ChatManager {
  constructor() {
    // Watcher del INTERFONO: auto-entrega los mensajes a los chats ABIERTOS y
    // OCIOSOS (paridad con el nudge idle de la TUI). Los dormidos/ocupados NO
    // se despiertan solos (evita gastar tokens fantasma): quedan para el popup
    // global + botón "Retomar". Cadencia ~12 s (barato: solo lee el bus).
    setInterval(() => { try { this._deliverInterfono(); } catch { /* noop */ } }, INTERFONO_POLL_MS).unref();
  }

  _deliverInterfono() {
    for (const c of this.chats.values()) {
      if (c.closed || !c.sessionId || c.viewMode !== 'chat') continue;
      if (!(c.alive && c.status === 'waiting' && c.clients.size > 0)) continue;
      let msgs;
      try { msgs = bus.pendingFor([`claude:${c.sessionId}`]); } catch { continue; }
      if (msgs.length) c.deliverInterfono(msgs);
    }
  }
}

// Endpoint que usa el popup global:
r.post('/interfono', (req, res) => {
  const chat = manager.get(req.body?.id);
  if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
  const action = req.body?.action; // 'deliver' | 'dismiss'
  const result = chat.consumeInterfono(action);
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json({ ok: true, chat: chat.info() });
});
```

### B.4 El centro global de popups y la causa raíz del cross-ventana (`public/js/ui/interfono-center.js` + `public/js/main.js`, íntegros los fragmentos relevantes)

```js
// ui/interfono-center.js — centro GLOBAL de interfono: popups flotantes con
// los mensajes de OTRAS sesiones de Claude Code que están esperando ser
// tomados por un chat, visibles desde cualquier pantalla (gemelo de
// ui/perm-center.js).
export function initInterfonoCenter({ isChatActive, openChat }) {
  const stack = document.createElement('div');
  stack.className = 'cwc-intercom';
  document.body.appendChild(stack);
  const items = new Map(); // chatId -> { el, chatId, busy, sig }

  function upsert(chatId, title, pend) {
    if (!chatId || !pend?.length) return;
    // ... crea/actualiza la tarjeta con botones Descartar/Retomar ...
  }

  async function act(item, action) {
    // POST /api/chat/interfono { id: item.chatId, action }
  }

  // ===== Render / supresión =====
  function render() {
    let visible = 0;
    for (const item of items.values()) {
      const hide = isChatActive(item.chatId); // ← ÚNICA condición de supresión
      item.el.hidden = hide;
      if (!hide) visible += 1;
    }
    stack.hidden = visible === 0;
  }

  // ===== Alimentación: poll de 8 s de /api/chat/list =====
  function syncFromList(chats) {
    const seen = new Set();
    for (const c of chats || []) {
      const pend = c.pendingInterfono || [];
      if (!pend.length) continue;
      seen.add(c.id);
      upsert(c.id, c.title, pend); // ← TODOS los chats del server, sin filtrar por ventana
    }
    for (const [chatId, item] of items) {
      if (seen.has(chatId) || item.busy) continue;
      remove(chatId);
    }
  }
  return { syncFromList, refresh: render };
}
```

```js
// public/js/main.js — cada ventana del navegador corre ESTA instancia entera
// de la SPA, con su propio `tabs` (Map) y `activeId` (string) EN MEMORIA.
intercomCenter = initInterfonoCenter({
  isChatActive: (chatId) => activeId === chatId && tabs.has(chatId), // estado 100% LOCAL
  openChat: openChatById,
});

async function pollTabStatus() {
  if (document.hidden) return;
  // Sin pestañas abiertas IGUAL se consulta /api/chat/list — deliberado, para
  // que el centro avise de chats vivos lanzados desde OTRO dispositivo/ventana.
  const chats = await fetch('/api/chat/list').then((r) => r.json()).then((d) => d.chats || []);
  permCenter?.syncFromList(chats);
  intercomCenter?.syncFromList(chats); // TODOS los chats, cada 8s, en TODA ventana
  // ...
}
function pollAll() { pollModels(); pollTabStatus(); }
setInterval(pollAll, 8000);
```

---

*Fin del documento. Cualquier propuesta del experto se integrará como plan de cambios sobre `src/core/bus.js`, `bin/cwc-bus.js`, `src/modules/chat/index.js` y `public/js/ui/interfono-center.js` + `public/js/main.js`, respetando las restricciones de la §7.*
