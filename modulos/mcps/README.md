# MCP

Censo operativo de los servidores MCP declarados en el taller. Descubre
`~/.claude.json`, `.mcp.json` o las fuentes configuradas, persiste el último estado
y sondea cada servidor con timeout propio dentro de un pool acotado.

## Superficie

- `GET /api/mcps`: último censo conocido; el sondeo normal continúa en segundo plano.
- `GET /api/mcps/detalle?nombre=...&fuente=...`: declaración, historial y metadata relacionada.
- `GET /api/mcps/alertas`: estados no `ok` y derivas desde la última carga observada.
- `POST /api/mcps/sondear`: re-sondeo de `{nombre, fuente}` o de todo el censo.
- Panel `/mcps` en la zona `centro`, incorporado por la delegación de UI.

## Diseño operativo

Una fuente ilegible y una sonda fallida son resultados por ítem; ninguna aborta el
resto. HTTP/SSE usa `nucleo.http.pedir`, stdio usa `nucleo.proceso`, y el único
intervalo pertenece a `nucleo.reloj`. `detener` cancela el barrido y drena los
recursos en vuelo.

El censo no persiste ni devuelve valores de `env`, cabeceras o secretos. Conserva
sus claves y huellas SHA-256. La metadata de credenciales llega por el puente
opcional a `credenciales`; si no está disponible, el módulo sigue vivo.

Una sonda `ok` fija las huellas observadas al cargar. Si después cambia la
configuración o la versión de una credencial, el servidor mantiene su estado de
sondeo y suma `config_rotada` o `credencial_rotada`. La alerta indica que el runner
debe reiniciarse para releer el material vigente.

## Comprobación

```bash
node herramientas/ntux.js verificar
npm run prueba
```
