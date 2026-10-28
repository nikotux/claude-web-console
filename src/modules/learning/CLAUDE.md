<!-- cwc:ficha-modulo -->
# src/modules/learning — librería compartida

El módulo Aprendizaje se archivó el **2026-10-28** por **console:PLAN-3480**.
Esta carpeta es una LIBRERÍA: conserva únicamente `store.js` y esta ficha.
No tiene `index.js`, registro, rutas HTTP, frontend ni runners propios.
Ver `_archived/ARCHIVED.md` para el inventario y la reversión.

## Contrato vivo

`src/modules/chat/index.js` importa `appendChatContext` como
`appendLearningChatContext`. Al cerrar chats históricos con `learningId`,
agrega su resumen determinístico al contexto del tema, best-effort y sin IA.
Se conservan `learningId` en el shell y su aceptación por el backend de Chat.

`store.js` no importa `session-log.js` ni ningún archivo archivado. Usa
`core/pad-service-client.js` para las colecciones locales
`temas-de-aprendizaje` y `rutas-de-aprendizaje`, `core/atomic-write.js`
para el log y `core/user-space.js` para resolver dueño y directorio por
operación. No congelar rutas del host ni cambiar el aislamiento por usuario.

Los helpers de análisis, contexto, explicaciones y registro de session ids
quedaron archivados. `tokens/index.js` sigue leyendo el histórico
`learning-session-ids.json` best-effort; los datos de runtime no se movieron.
Estas colecciones ya no se precalientan: la caché puede refrescarlas si un
consumidor vivo las pide.
