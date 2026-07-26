<!-- cwc:ficha-modulo -->
# src/modules/unifi — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### unifi/                    — Puente SOLO-LECTURA al UDM Pro (PLAN-774 inventario + PLAN-1795
deep-read para voz/llamadas). NUNCA escribe al router. client.js habla
con DOS APIs usando UNIFI_API_KEY (.env): la Integration
(/proxy/network/integration/v1) y la INTERNA de Network
(/proxy/network/api/s/<site>); esta última expone la config PROFUNDA —
getDeviceStats() lee stat/device (radio_table:
canal/ht(ancho)/tx_power/min_rssi + radio_table_stats:
cu_total=utilización de canal/tx_retries_pct/satisfaction; vap_table por
SSID), rest/networkconf de los WAN (wan_load_balance_type
weighted|failover-only, smartq_enabled) y stat/health (wan.uptime_stats
por WAN + www speedtest/latency). inventory-shared.js escanea la
ESTRUCTURA a Pad (colección infraestructura-de-red, upsert por uid,
retire-sweep de lo ausente; NO tocar en cambios de deep-read). BUG-1254:
el retiro ordena estable miembros primero y `kind==='red'` al final,
porque Pad materializa los links `implements` wifi/reserva → red como
PARENT/CHILD: retirar la red antes chocaba con `open_children` y quedaba
sin retirar EN SILENCIO. Red de seguridad: ante `open_children`/HTTP 409
reintenta UNA vez con `force:true`. GOTCHA de cliente: aunque Pad mande
`code` en el cuerpo, `core/pad-service-client.js` solo devuelve
`{ok,error,status}` y lo descarta; la detección efectiva es
`status===409`. El retorno conserva todas sus claves y suma
`errorDetails[]` (máximo 20), para que `errors` no sea un contador mudo.
audit-shared.js (PLAN-1795) es DETERMINÍSTICO (0 tokens, sin LLM):
getRadios()/getWan() derivan la telemetría y buildVoiceAudit() aplica
REGLAS de voz (2.4GHz cu_total>60→rojo / 40-60→amarillo,
tx_retries>10%, ancho 2.4≠20MHz, 5GHz cu>70, sin Smart Queue, multi-WAN
en balanceo 'weighted', min-rate 2.4 legacy ≤1 Mbps, >4 SSIDs activas,
WAN con disponibilidad<99%) → {semaforo verde|amarillo|rojo,
hallazgos[], resumen, datos}. snapshotToPad() hace upsert de UN item
(uid 'voz-audit') en la colección Pad NUEVA `auditoria-red` (prefix AR)
— DELIBERADAMENTE aislada de infraestructura-de-red para no ser barrida
por el retire-sweep del inventario — con tabla de hallazgos + historial
de las últimas 10 corridas. unifi-tool.js expone tools MCP de
solo-lectura al chat:
unifi_dispositivos/unifi_cliente/unifi_diagnosticar/unifi_salud/unifi_inventario
+ (PLAN-1795) unifi_radios/unifi_wan/unifi_auditoria. Rutas /api/unifi
(index.js): GET /devices · /clients · /health · /client · /radios ·
/wan · /audit + POST /scan (admin) · /audit-snapshot (admin).
FRONTEND: panel en ⚙ Sistema → grupo Diagnóstico → '🛰️ UniFi'
(public/js/modules/system/unifi-panel.js, mountUnifiPanel; molde de
dashboard-panel.js) — semáforo de optimización para llamadas + tablas
colapsables Hallazgos/Radios/WAN, botón Re-escanear (0 tokens, GET
/audit en vivo) y Guardar snapshot en Pad (admin, POST
/audit-snapshot); i18n en public/i18n/en/unifi.json.
bin/cwc-unifi-scan.js corre el inventario a Pad.
