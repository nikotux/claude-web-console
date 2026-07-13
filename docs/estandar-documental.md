# Estándar Documental — Consola Tolkien

## 0. Metadatos

| Campo | Valor |
|---|---|
| **Versión** | 1.2 |
| **Fecha** | 2026-07-13 |
| **Responsable** | Nicolás (Niko) Mosquera |
| **Fuente de verdad** | Este archivo (`docs/estandar-documental.md`). Ninguna otra copia es autoritativa. |
| **Ámbito** | Todo documento generado dentro de la consola Tolkien (`claude-web-console`) o desde ella hacia canales externos. |
| **Regla de activación** | Antes de generar cualquier documento (informe, correo, nota, guía, minuta), la IA DEBE leer este archivo completo. |

---

## 1. Reglas núcleo (versión condensada)

> Esta sección es extraíble por sí sola. Si solo se puede inyectar un fragmento
> de este estándar, es este.

1. **Idioma por audiencia, sin mezclas.** Interno y para la IA: español. Canales externos (Zoho Desk, PRs a Chris, Mark Bernstein): inglés. Nunca mezclar idiomas dentro de un mismo documento.
2. **Un documento, un propósito.** Cada archivo cubre un solo tema (patrón `feedback-*.md`: una regla por archivo).
3. **Fechas siempre en ISO** `YYYY-MM-DD` (con `HH:MM` cuando aplique, como en el Changelog).
4. **Nombres de archivo en kebab-case en español**, salvo identificadores de código (inglés técnico).
5. **Identidad y firma según el registro de canales** (sección 6). En canales donde no se publica con la identidad real de Niko, la firma es exactamente `— Nicolás (dev team)`.
6. **Todo documento generado a pedido se copia a `~/pool of documents/`** con el esquema `YYYY-MM-DD_tema-descriptivo_vNN.md`.
7. **Plan primero, ejecución de corrido después.** Fuente única de esta regla: `~/.claude/CLAUDE.md` (global). Este documento y cualquier otro solo la referencian.
8. **Referencias a archivos inexistentes se marcan** `[HISTÓRICO — archivo eliminado]`, nunca se dejan huérfanas.
9. **Lo existente se codifica, lo nuevo se marca.** Toda convención sin práctica real previa lleva la etiqueta 🆕 PROPUESTA hasta que se use por primera vez y se valide.

---

## 2. Matriz de decisión: audiencia → idioma → tono → detalle

| Destinatario / Rol | Idioma | Tono | Nivel de detalle | Formato preferente |
|---|---|---|---|---|
| Niko (dueño/desarrollador) | Español | Directo, técnico, visual (tablas, íconos) | Alto | Markdown estructurado |
| IA / Claude Code (sesiones futuras) | Español | Normativo/imperativo ("NUNCA", "SIEMPRE") | Muy alto | Reglas + gotchas + fechas |
| Chris / `cswenor` (revisor GitHub) | **Inglés** | Formal, claro, verificable | Medio-alto | Bloque fijo de PR (§3.4) |
| Cliente/solicitante (Zoho Desk) | **Inglés** | Formal, breve | Bajo-medio | Nota corta + firma |
| Mark Bernstein (CEO) | **Inglés** | Ejecutivo: conclusión primero, sin jerga | Bajo (resumen) + anexo opcional | Correo ejecutivo (§4.1) |
| Julián García (Dir. Operaciones) | Español | Técnico, orientado a proyectos | Medio-alto | Correo técnico / informe |
| Equipo interno Mordor | Español | Profesional cercano | Medio | Correo interno / minuta |
| Equipo vía Teams (bot "Tolkien") | Español | Breve, informativo | Bajo | Mensaje corto + firma (§6) |
| Otra sesión de Claude Code (Interfono) | Español | Breve, funcional | Bajo | Mensaje determinístico |

**Regla de desempate:** si la audiencia es mixta, gana el destinatario de mayor jerarquía o el más externo. Ante duda real, preguntar antes de redactar.

---

## 3. Bloque A — Convenciones existentes (codificadas de la práctica real)

### 3.1 CLAUDE.md y reglas de sistema

- **Propósito:** guía operativa viva del proyecto (reglas duras, mapa, gotchas, proceso de cambio).
- **Idioma:** español imperativo.
- **Estructura:** jerarquía `#`/`##`/`###`, negritas para términos clave, bloques de código para rutas/comandos/variables.
- **Regla de oro:** cada excepción a una regla dura se documenta con fecha ISO y justificación (patrón de la regla 6 de CLAUDE.md: regla + excepción quirúrgica + gotcha + fecha).
- **Mantenimiento:** se actualiza en CADA modificación de arquitectura.

### 3.2 Notas de memoria (`feedback-*.md`, `proyecto-estado.md`)

- **Propósito:** memoria persistente entre sesiones; mini-SOP de una regla.
- **Extensión:** 15–30 líneas. Una regla por archivo.
- **Contenido mínimo:** la regla + el motivo + el formato exacto exigido.
- **Nombre:** kebab-case descriptivo en español (`feedback-tema-concreto.md`).
- **Registro:** toda nota nueva se enlaza desde el índice `MEMORY.md`.

### 3.3 Changelog (README.md)

- **Formato de entrada:** `### YYYY-MM-DD HH:MM — rama`.
- **Estructura dual:** bullets narrativos en español (resumen humano) + listado técnico `Modified/Added/Deleted` (diff crudo).
- **Frecuencia:** una entrada por cada push exitoso a GitHub. Acumulativo, sin tope.

### 3.4 Notas de cierre de Pull Request (a Chris / `cswenor`)

- **Idioma:** **inglés** (decisión 2026-07-05; antes indefinido).
- **Estructura fija e inalterable:**

```markdown
Problem: <what was broken or missing, one or two sentences>
What I did: <the change, verifiable and concrete>
Better solution?: <honest note: is there a cleaner long-term fix, or is this it>
```

- **Tono:** formal, claro, verificable. Sin relleno.
- **Alcance:** una nota por cada PR (bugfix o feature) subido a Tolkien.

### 3.5 Notas de Zoho Desk

- **Idioma:** inglés (regla explícita preexistente).
- **Estructura:** estado del ticket (p. ej. On Hold) + nota corta al solicitante.
- **Firma obligatoria:** `— Nicolás (dev team)` (identidad prestada del agente).
- **Extensión:** breve; detalle bajo-medio.

### 3.6 Documento técnico ad-hoc / brief (patrón `docs/contexto-ui.md`)

- **Propósito:** contexto formal para un tercero o para un hito (rediseños, asesorías).
- **Estructura de referencia:** tablas de inventario + mapas/diagramas (ASCII válido) + sección honesta de deuda técnica.
- **Idioma:** español, salvo destinatario externo angloparlante.
- **Ubicación:** `docs/` en kebab-case.

### 3.7 Mensajes de commit

- **Idioma:** español; identificadores de código en inglés.
- **Regla:** mensajes descriptivos, un tema por commit.
- **Coautoría IA:** los commits generados por la IA incluyen `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

## 4. Bloque B — Convenciones nuevas 🆕 PROPUESTA

> Estos tipos no tienen práctica previa en Tolkien. Quedan definidos completos
> (decisión 2026-07-05) y pasan a "existentes" tras su primer uso validado.

### 4.1 Correo — 🆕 PROPUESTA

**Variantes según la matriz (§2):**

**a) Correo ejecutivo (Mark Bernstein u homólogos) — inglés**

```
Subject: <outcome-first, max 8 words>

Hi <Name>,

<Bottom line first: the conclusion or ask, 1–2 sentences.>

<Context: 2–4 sentences max. No jargon. Numbers over adjectives.>

<Clear next step or decision needed, with date if applicable.>

Best regards,
Nicolás Mosquera
```

- Regla dura: la conclusión SIEMPRE va antes que el contexto. Anexos técnicos van aparte, nunca en el cuerpo.

**b) Correo técnico interno (Julián García, equipo TI) — español**

```
Asunto: [Proyecto/Área] Tema concreto — acción esperada

Hola <Nombre>,

**Situación:** <1–2 líneas>
**Detalle técnico:** <lista o tabla; comandos/rutas en bloque de código>
**Impacto/Riesgo:** <si aplica>
**Siguiente paso:** <acción, responsable, fecha>

Saludos,
Niko
```

**c) Correo externo a cliente/proveedor — inglés**

- Sigue la plantilla ejecutiva (a) con tono formal; firma según registro de canales (§6).

**Reglas comunes de correo:**
- Un correo = un tema. Si hay dos temas, dos correos.
- Asunto accionable, nunca genérico ("Update" está prohibido).
- Extensión objetivo: ≤ 150 palabras ejecutivo, ≤ 300 técnico.

### 4.2 Informe — 🆕 PROPUESTA

**a) Informe ejecutivo — idioma según destinatario (Mark: inglés)**

```markdown
# <Título orientado a resultado>
**Fecha:** YYYY-MM-DD · **Autor:** Nicolás Mosquera · **Versión:** vNN

## Resumen ejecutivo
<3–5 líneas: qué pasó, qué significa, qué se recomienda.>

## Hallazgos clave
<Máximo 5 bullets, cada uno con dato + implicación.>

## Recomendación y siguiente paso
<Decisión solicitada, opciones si las hay, fecha límite.>

## Anexo técnico (opcional, separable)
```

**b) Informe técnico — español (default)**

```markdown
# <Título>
**Fecha:** YYYY-MM-DD · **Autor:** · **Versión:** vNN · **Alcance:**

## Resumen ejecutivo
<3–5 líneas: qué se analizó, qué se encontró, qué se recomienda — aunque el resto del informe sea técnico.>

## 1. Contexto y objetivo
## 2. Metodología / fuentes
## 3. Hallazgos (tabla obligatoria si hay ≥3 ítems comparables)
## 4. Análisis y riesgos
## 5. Recomendaciones (priorizadas)
## 6. Anexos (evidencia, comandos, logs)
```

- Regla dura: ningún informe sale sin resumen ejecutivo, aunque sea técnico.
- Todo informe generado se copia a `~/pool of documents/` (regla núcleo 6).

### 4.3 Minuta de reunión — 🆕 PROPUESTA

- **Idioma:** español (default interno); inglés si hay asistentes externos angloparlantes.
- **Nombre de archivo:** `YYYY-MM-DD_minuta_tema.md`.

```markdown
# Minuta — <Tema> — YYYY-MM-DD
**Asistentes:** · **Ausentes:** · **Duración:**

## Decisiones tomadas
| # | Decisión | Responsable | Fecha límite |

## Acuerdos y compromisos
| # | Acción | Responsable | Fecha límite | Estado |

## Temas abiertos (parking lot)

## Próxima reunión
```

- Regla dura: las decisiones se registran como hechos, no como narración. La sección de decisiones nunca puede quedar vacía si la reunión duró más de 15 minutos; si no hubo decisiones, se escribe explícitamente "Sin decisiones — reunión informativa".

---

## 5. Anti-patrones (qué NUNCA hacer)

| # | Anti-patrón | Aplica a |
|---|---|---|
| 1 | Mezclar idiomas dentro de un mismo documento o correo | Todos |
| 2 | Enviar contenido técnico con jerga a Mark Bernstein | Correos/informes ejecutivos |
| 3 | Informe sin resumen ejecutivo | Informes |
| 4 | Asunto de correo genérico ("Update", "Info", "Pregunta") | Correos |
| 5 | Alterar el bloque fijo de PR (`Problem/What I did/Better solution?`) | PRs a Tolkien |
| 6 | Publicar en canal externo sin la firma correcta del registro (§6) | Desk, Teams, futuros |
| 7 | Duplicar una regla en varios archivos sin declarar fuente única | CLAUDE.md, memoria |
| 8 | Dejar referencias a archivos inexistentes sin marcar `[HISTÓRICO — archivo eliminado]` | Todos |
| 9 | Generar un documento a pedido y no copiarlo a `~/pool of documents/` | Todos |
| 10 | Fechas en formato distinto a ISO `YYYY-MM-DD` | Todos |
| 11 | Inventar convenciones nuevas sin marcarlas 🆕 PROPUESTA | Este estándar |
| 12 | Redactar para audiencia externa sin consultar la matriz (§2) y el registro (§6) | Todos |

---

## 6. Registro de canales externos e identidad/firma

> Tabla mantenible. Todo canal nuevo de escritura externa DEBE registrarse aquí
> antes de su primer uso. Esta tabla reemplaza la detección "caso por caso".

| Canal | Identidad de publicación | Firma obligatoria | Idioma | Estado |
|---|---|---|---|---|
| Zoho Desk (notas/respuestas a tickets) | Agente prestado ("Chris") | `— Nicolás (dev team)` | Inglés | ✅ Activo |
| GitHub Tolkien (PRs, revisor `cswenor`) | Cuenta propia del repo | Bloque fijo de PR (§3.4), sin firma adicional | Inglés | ✅ Activo |
| Teams (bot "Tolkien") | Bot | `— Nicolás (dev team)` | Español | 🆕 PROPUESTA — plantilla mínima: mensaje ≤ 5 líneas, informativo, sin hilos de decisión (las decisiones van a minuta o correo) |
| Interfono (bus entre sesiones) | Sesión de Claude Code | Sin firma | Español | ✅ Activo |
| Email (Outlook / Microsoft Graph) | Buzón propio de Niko (identidad real) | Nombre real `Nicolás Mosquera` (sin `— (dev team)`) | Según audiencia (§2) | ✅ Activo — primer uso 2026-07-13 (correo TKT #603) |

**Regla:** si un documento va a un canal que no está en esta tabla, detenerse y preguntar antes de publicar.

---

## 7. Gobernanza de este documento

1. **Fuente única de verdad:** este archivo. `MEMORY.md` solo lo indexa; `CLAUDE.md` solo contiene la regla de activación (leerlo antes de generar documentos).
2. **Versionado:** cambios menores incrementan decimal (1.1); cambios de estructura o nuevas secciones incrementan entero (2.0). Toda versión nueva actualiza los metadatos (§0).
3. **Promoción de propuestas:** una convención 🆕 PROPUESTA pasa a "existente" cuando se usa por primera vez y Niko valida el resultado; se retira la etiqueta y se registra la fecha de promoción.
4. **Sincronización:** la regla "plan primero" vive únicamente en `~/.claude/CLAUDE.md`. Las copias en la regla 9 del CLAUDE.md del repo y en `feedback-ejecutar-sin-confirmar.md` deben convertirse en referencias a esa fuente (deuda pendiente al momento de la v1.0).
5. **Revisión programada:** auditar este estándar contra la práctica real al menos una vez por trimestre o tras incorporar un canal/tipo nuevo.

---

## 8. Casos de prueba de validación (Fase 5)

Ejecutar estos prompts en la consola tras cargar el estándar. El resultado se
compara contra la regla citada; cualquier desviación indica que el estándar no
se está aplicando y debe corregirse la integración (regla de activación en
CLAUDE.md) antes de culpar al contenido.

| # | Prompt de prueba | Resultado esperado | Regla que valida |
|---|---|---|---|
| 1 | "Redacta la nota de cierre del PR que arregla el bug X" | Nota en **inglés**, bloque fijo `Problem/What I did/Better solution?` intacto | §3.4 |
| 2 | "Escribe un correo a Mark informando el avance del proyecto Y" | Inglés, conclusión primero, ≤150 palabras, sin jerga, asunto accionable | §4.1a, §2 |
| 3 | "Genera la minuta de la reunión de hoy sobre Z" | Español, tablas de decisiones y compromisos con responsable y fecha, nombre `YYYY-MM-DD_minuta_z.md` | §4.3 |
| 4 | "Hazme un informe técnico del análisis W" | Español, estructura §4.2b, con resumen ejecutivo, copiado a `~/pool of documents/` con esquema de nombre correcto | §4.2, reglas núcleo 3 y 6 |
| 5 | "Publica una nota en el ticket de Desk" | Inglés, breve, firma exacta `— Nicolás (dev team)` | §3.5, §6 |

---

## Apéndice — Snippets de integración en Tolkien

**a) Línea para el índice `MEMORY.md`:**

```markdown
- `docs/estandar-documental.md` — Estándar documental completo (tipos, idiomas, plantillas, firmas). Leer ANTES de generar cualquier documento.
```

**b) Regla para `CLAUDE.md` del repo (sección de reglas duras):**

```markdown
- **Estándar documental:** antes de generar cualquier documento (informe,
  correo, nota, guía, minuta) o publicar en un canal externo, leer
  `docs/estandar-documental.md` y aplicarlo. Los canales externos y sus
  firmas están registrados en su sección 6; canal no registrado = preguntar
  antes de publicar.
```
