---
name: eta
description: "📅 Obtiene y registra una ETA cuando se le pasa un bloqueo a otra persona — pago, decisión, documento o respuesta de un tercero — porque el ítem no está entregado hasta tener una fecha confirmada."
cwc-share: catalog
cwc-default: true
---

# 📅 Conseguir y registrar una ETA

Aplicás la regla normativa **CONVE-807**, dictada por Chris (cswenor) en su reunión con Niko del 2026-07-21. Es una regla de Chris, no una propuesta propia.

## Regla normativa

1. **La fecha la propone quien pide y la confirma quien ejecuta.** Proponé una fecha concreta en forma de pregunta —por ejemplo, “¿te sirve el jueves 23, o preferís otra?”— y esperá la respuesta para que la otra persona pueda ajustarla. Chris lo dijo así: *“you tell me when you think it will be done by. If you tell me something too far, I'll tell you that's too far away.”*
2. **Registrá esa fecha como `dueDate` del ticket, nunca solo como comentario.** Un comentario no dispara seguimiento; `dueDate` hace que el sistema marque `overdue` o `past due` automáticamente. Chris: *“when that day comes around, the ticketing system will flag it. What thing is overdue? What thing is past due?”*
3. **Si la persona no da fecha, perseguí cada dos días.** Cuando confirme una fecha, no la molestes hasta ese día.
4. **Nombrá el beneficio explícitamente:** “la registro y no te vuelvo a escribir hasta entonces”. Chris lo formuló así: *“I don't want that monkey on my back. I want to give you the monkey.”*
5. **Cuando llegue el día, reclamá contra su propio compromiso.** Eso habilita escalar con evidencia: *“Camilo said he'd get this done by this day. He didn't.”*

## Cómo aplicarla

1. Proponé una fecha concreta y pedí confirmación.
2. Mientras no haya confirmación, calculá una fecha provisional de persecución a dos días hábiles y registrala en Zoho Desk:

   ```bash
   node bin/cwc-desk.js update <n> --dueDate="YYYY-MM-DDTHH:mm:ss.sssZ"
   ```

3. Cuando la persona responda, reemplazá la fecha provisional por la fecha comprometida usando el mismo comando.
4. Agregá un comentario que explique el acuerdo si aporta contexto, pero nunca lo uses en lugar de `dueDate`.
5. En la fecha acordada, comprobá el estado y reclamá o escalá citando el compromiso.

La regla también aplica al tablero interno de **Pendientes**. El ítem de Pad
lleva el campo `dueDate` en formato `YYYY-MM-DD`: se define desde el tablero,
en **Fecha comprometida (ETA)**, o por MCP:

```text
pad_item action=update ref=PEND-n field=["dueDate=YYYY-MM-DD"]
```

El tablero deriva el estado según el día local y marca automáticamente las
tareas vencidas; `dueDate` sigue siendo el dato persistido y el marcado no.

Aplicá la regla también fuera del equipo: proveedores, administraciones y clientes.

## Antipatrón que motivó la regla

El pago al técnico de subwoofers, ticket #606, se pidió a Accounting el 16-jul sin fecha. El 21-jul seguía sin respuesta, sin ETA y sin ningún mecanismo que lo marcara vencido.

## Cierre

Cerrá siempre con la línea `🎾 Pelota: …`.

---
*Fuente de verdad: `PLAYB-2182`.*
