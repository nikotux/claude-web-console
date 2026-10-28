<!-- cwc:ficha-modulo -->
# public/js/modules/lab — ficha del proyecto

Sección admin del sidebar para herramientas experimentales. Nace plegada y persiste su estado en `cwc.lab.open`.

- **Abrir omp:** crea `POST /api/terminal/sessions` con `cwd: "lab-omp"` y `agent: "omp"`; el tipo de sesión es admin-only y el gate real vive en el backend.
- **Abrir Orca:** abre una ventana vacía de forma síncrona para evitar el bloqueo de popups, pide la clave con `GET /api/lab/orca` (admin-only) y navega a noVNC en `http://<host>:6080`. La clave viaja en el fragmento `#password=...`, que el navegador usa para completar noVNC y nunca envía al servidor web.
- **Servicios del escritorio:** cuatro unidades systemd de usuario arrancan con el host: `orca-vnc.service` (Xvnc local), `orca-openbox.service` (gestor de ventanas), `orca-app.service` (Orca IDE, vuelve a abrirse si se cierra) y `orca-novnc.service` (puente web en la IP ZeroTier). `systemctl --user restart orca-vnc` reinicia el escritorio completo por las relaciones `PartOf`.
- **Clave VNC:** el archivo cifrado que consume Xvnc vive en `~/.config/tigervnc/orca-passwd`; la copia que lee el backend para autocompletar noVNC vive en `~/.cwc-data/lab/orca-vnc.pass`. Ambos deben conservar permisos `0600` y la clave nunca se registra en logs.
