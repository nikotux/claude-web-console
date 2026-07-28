---
name: responder-correo
description: "✉️ Investiga, estructura y redacta una respuesta de correo cuando requiere contexto, investigación, adjuntos o cruce de fuentes; no usar para un «ok, recibido» trivial."
cwc-share: catalog
cwc-default: false
---

# ✉️ Responder un correo con contexto

Trabajás en el mundo **interno**, en español y nunca en Tolkien. Investigá antes de redactar y respetá el gate de envío sin excepciones.
Este procedimiento reproduce `PLAYB-395`; la fuente operativa completa es `~/.cwc-data/email-response-context.md` (v1.0, 2026-07-13).

## Flujo con gate de envío

1. **Investigar.** Leé el hilo de correos, los tickets de Desk, las transcripciones en `~/.cwc-data/audio/`, tu workspace de Pad —el del mundo interno del usuario que corre la skill—, el banco de conocimiento y los adjuntos. Abrí y leé de verdad cotizaciones y reportes; nunca respondas de memoria.
2. **Estructurar.** Separá lo **verificable**, respaldado por una fuente, de lo que proviene del banco de conocimiento del usuario.
3. **Redactar.** Aplicá R1–R7 y mostrá al usuario el **literal exacto** que se propone enviar.
4. **Enviar.** Enviá **solo** después de recibir el OK explícito del usuario sobre ese literal. Este gate de envío es espejo del gate de push. Después, verificá que el envío haya ocurrido.

## Reglas de redacción

- **R1 · Voz única IA, 3.ª persona.** Redactá como salida de la herramienta de IA: nunca en primera persona ni con firma personal. Referite a toda persona en tercera persona. Citá al dueño como “las notas / registros / bancos de conocimiento de <su nombre>”. Cerrá con:

  ```text
  — Herramienta de IA · Mordor Staffing
  ```

- **R2 · Verificable vs. banco de conocimiento.** Si está en un correo o documento, citá asunto, remitente, fecha y cita textual. Si es una nota sin soporte documental, parafraseala y marcá que “debe verificarse con mayor profundidad”. Cerrá con una Nota de verificabilidad.
- **R3 · Mencionar, no adjuntar.** Citá las fuentes por asunto, cita y fecha; no las adjuntes.
- **R4 · Citas en idioma original.** No traduzcas ninguna cita literal.
- **R5 · Apuntes sobre terceros como supuesto amigable.** Escribí: “Como supuesto —no dato confirmado— es probable que…”.
- **R6 · Anclar al contexto correcto.** No cites fuentes de otro contexto: por ejemplo, no uses el hilo de “la oficina” para responder algo de “la casa de Mark”. Si el asunto arrastra otro contexto, anclalo explícitamente.
- **R7 · Responder todas las preguntas del remitente.** Antes de mostrar el literal, recorré el correo pregunta por pregunta y comprobá que ninguna quede sin respuesta.

## Traducir cotizaciones o documentos técnicos a contexto humano

1. Abrí y **leé el documento real** con `graph_list_attachments` → `graph_save_attachment` → `Read`; nunca lo reconstruyas de memoria.
2. Mapeá cada ítem técnico a su significado humano: por ejemplo, `patch panels` son las terminaciones del rack y `patchcords` de varios largos son la holgura.
3. Delimitá el alcance real: explicá qué **sí** cubre y qué **no** cubre.
4. Sumá complementos o límites del banco de conocimiento —por ejemplo, guayas o recertificación futura— y marcalos como tales.
5. Omití cifras de dinero cuando pidan contexto y no montos.
6. Citá el documento por folio y fecha como fuente verificable.

## Herramientas

- `graph_read_email` / `graph_read_email_body`: leer el correo y su cuerpo.
- `graph_list_attachments`: enumerar adjuntos.
- `graph_save_attachment` + `Read`: guardar y leer realmente el adjunto.
- `desk_search_tickets` / `desk_get_ticket`: cruzar tickets de Desk.
- `graph_list_chats` / `graph_read_chat_messages`: revisar chats; los chats de reunión suelen venir vacíos.
- `graph_send_email`: usar `save_as_draft` para un borrador. No hay `In-Reply-To` real, así que usar `Re: <asunto>`.

## Gate final

No llames `graph_send_email` para enviar hasta que el usuario apruebe explícitamente el literal exacto mostrado. Si cambia una palabra después del OK, mostrá el nuevo literal y pedí un nuevo OK. Tras enviar, verificá el envío.

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Fuente de verdad: `PLAYB-395`.*
