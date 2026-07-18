# Runbook SP9-2 — Plan de ZeroTier según nº de miembros

> Runbook ops de PLAN-595 (SP9). Fuente: DOC-514. CERO código — es una decisión de cuenta/facturación externa. `src/core/zerotier.js` SOLO detecta la IP; el plan NO se toca desde el repo.

## BLUF
Cada dispositivo de usuario = 1 nodo/miembro en la red ZeroTier. El plan free topa **~25 nodos**. Cuando el equipo crece, subir el plan de ZeroTier — es lo único "de conexión" que se dimensiona.

## Tabla miembros/dispositivos → plan
| Ancla | Nº de dispositivos (miembros ZT) | Plan ZeroTier | Acción |
|---|---|---|---|
| 🟢 | ≤ ~20 | Free (tope ~25) | nada; margen cómodo |
| 🟡 | ~20–24 | Free, cerca del tope | **alerta**: planear upgrade antes de topar |
| 🔴 | ≥ 25 | Free insuficiente | subir a plan pago de ZeroTier Central |

Nota: cada usuario suele tener >1 dispositivo (laptop + teléfono) → contar dispositivos, no personas. 5 personas × 2 dispositivos = 10 nodos.

## Señal de alerta
Monitorear el conteo de "Members" en ZeroTier Central de la red de la consola. Al acercarse a ~20 nodos activos, iniciar el upgrade (no esperar a topar: un nodo nuevo que no entra = un dispositivo que no puede llegar a la consola, porque el server bindea SOLO a la IP ZeroTier — regla dura #1).

## Quién/cómo se sube
- Es una acción en la cuenta de ZeroTier Central (my.zerotier.com) del dueño de la red — facturación externa, no toca la máquina ni el repo.
- Referencia de contexto: `src/core/zerotier.js` detecta la IP `zt*` para el bind; NO gestiona el plan ni los miembros.
