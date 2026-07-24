<!-- cwc:ficha-modulo -->
# src/modules/env-vars — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### env-vars/                 CAPA DE CONFIG DE INSTANCIA (identidad + cliente) — pestaña
"Variables de entorno" de ⚙ Sistema (PLAN-476/PEND-377, C1
fundacional del Programa Satélite). Separa del CÓDIGO lo que es
propio de CADA instalación (quién sos: email/GitHub/firma · qué
cliente: nombre del MCP, IDs de departamento Zoho, reviewer de
referencia) para que otra persona pueda correr su PROPIA instancia
sin heredar la identidad de Nico. El almacén es
`core/instance-config.js` (~/.cwc-data/instance.json, atómico,
AUTOGENERADO al primer arranque). Los DEFAULTS son placeholders
GENÉRICOS VACÍOS (scrub 2026-07-14 al derivar el repo limpio
`la-consola`): la identidad real de Nico vive en SU instance.json
(ya generado antes del scrub), así que su instancia sigue
byte-idéntica; una instalación nueva arranca vacía y se configura
por el wizard/panel. `config.instance` compone esa capa
(instance.json > DEFAULTS) vía deepMerge por UNION de claves — OJO:
el deepMerge original iteraba solo las claves de `base`, así que con
defaults vacíos habría PERDIDO zohoDepartments propios del
instance.json; el fix (union base∪over) lo conserva. saveInstance
REEMPLAZA zohoDepartments wholesale cuando el patch lo trae (el panel
envía el set entero; un merge nunca borraría una clave quitada). NUNCA incluye SECRETOS (capa aparte: CWC_TOKEN en .env,
credenciales en ~/.claude) ni identidad de EQUIPO (users.json, capa
3, multiusuario real = C3/PEND-382, fuera de alcance). Los
call-sites parametrizados leen `config.instance.*`:
tickets/derive.js (zohoDepartments) · tickets/desk-mcp-client.js
(mcpServerId + infisicalProjectId + KNOWN_DEPARTMENTS) ·
comms/shared.js (DEFAULT_SELF + contacto seed reviewer) ·
comms/gateway-shared.js (SIGNATURE + reviewer default) ·
tolkien/index.js (email del login local) · tickets/context-store.js
(reviewer en el prompt) · bin/cwc-comms-send-runner.js (firma). El
`contactId` del reviewer ('chris') es CLAVE INTERNA de lógica de
negocio (derive.js/dashboard.js "de quién es la pelota") —
deliberadamente NO parametrizado (cambiarlo exige tocar lógica, no
solo config). Backend admin-gated patrón projects/: GET
/api/env-vars (abierto, valores activos) · POST /api/env-vars
{patch} (admin, deep-merge con allowlist explícita, NUNCA acepta
campos de secretos, avisa needsRestart — los valores se leen al
importar los módulos, un cambio se aplica del todo al reiniciar) ·
GET /file (admin, ruta del instance.json). Front:
public/js/modules/system/env-vars-panel.js (secciones 🪪 Identidad
y 🏢 Cliente, editable inline, deps Zoho como filas clave→ID).
