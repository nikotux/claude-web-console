# Guía de instalación — Mi Consola (instancia independiente)

Esta guía es para levantar **tu propia** instancia de la consola en tu equipo,
100% independiente: tu red ZeroTier, tu carpeta de datos, tus credenciales de
Claude Code, tu propia identidad. Nada se comparte con otra instalación.

> Pensada para alguien que ya tiene acceso a la red ZeroTier (te lo dan aparte)
> y quiere su consola andando en pocos minutos.

---

## 1. Requisitos previos

Instalá esto **antes** de arrancar (la consola NO los instala por vos):

| Requisito | Para qué | Cómo verificar |
|-----------|----------|----------------|
| **Node.js ≥ 20** (probado v24) | correr el servidor | `node --version` |
| **git** | panel del proyecto + updates | `git --version` |
| **openssl** | generar el certificado TLS | `openssl version` |
| **tmux** (3.2+) | las terminales web | `tmux -V` |
| **Claude Code** | el chat / motores de IA | `claude --version` |
| **ZeroTier** con su interfaz `zt*` arriba | el acceso privado a la consola | `ip -o addr show \| grep zt` |

Herramientas de compilación para `node-pty` (una vez): en Debian/Ubuntu
`sudo apt install build-essential python3`.

---

## 2. Clonar e instalar dependencias

```bash
git clone <URL-DEL-REPO> ~/claude-web-console
cd ~/claude-web-console
npm install
```

> Podés clonarlo en otra carpeta; el instalador se adapta a la ruta real.

---

## 3. Instalación guiada (recomendado)

Un solo comando hace todo el trabajo pesado:

```bash
node bin/cwc-setup.js
```

El asistente:

1. **Verifica los requisitos** (si falta algo crítico, te avisa y frena).
2. **Genera el `.env`** con un token maestro nuevo, puerto y carpeta raíz.
3. **Fija tu identidad** (nombre, email, GitHub, firma) — la tuya, no la de
   otra instancia. Se guarda en `~/.cwc-data/instance.json`.
4. **Instala y arranca** el servicio systemd (sobrevive reinicios del equipo).
5. **Ofrece los hooks opcionales** de Claude Code (observador de estado,
   interfono entre sesiones, "la pelota").
6. **Crea tu primer usuario administrador**.

¿Solo querés chequear requisitos sin tocar nada?

```bash
node bin/cwc-setup.js --check
```

---

## 4. Acceso

Cuando el servicio esté arriba, entrá desde un dispositivo de tu red ZeroTier a:

```
https://<tu-ip-zerotier>:<puerto>      # ej. https://10.x.x.x:8092
```

La primera vez, aceptá el aviso de certificado self-signed (es normal: el cert
es auto-generado y atado a tu IP ZeroTier). Iniciá sesión con el usuario admin
que creaste.

---

## 5. Comandos útiles del servicio

```bash
systemctl --user status claude-web-console     # estado
journalctl --user -u claude-web-console -f     # logs en vivo
systemctl --user restart claude-web-console    # reiniciar
```

Agregar más usuarios después:

```bash
node bin/cwc-adduser.js <usuario> [--admin]
```

---

## 6. Tu identidad y datos de cliente

Todo lo que es propio de TU instalación (email, GitHub, firma, y —si usás el
módulo de tickets con Zoho Desk— el nombre del server MCP y los IDs de
departamento) vive en `~/.cwc-data/instance.json`, **fuera del código**. Lo
editás cómodo desde:

**⚙ Sistema → Variables de entorno** (necesitás ser admin).

Los **secretos** (el token maestro, las credenciales de Claude Code) NO están
ahí: siguen en `.env` y en `~/.claude`, y nunca se comparten ni se exportan.

---

## 7. Actualizar la consola

Las actualizaciones llegan por `git pull` desde el repo:

```bash
cd ~/claude-web-console
git pull
npm install                                    # si cambiaron dependencias
systemctl --user restart claude-web-console
```

Tu `.env`, tu `instance.json`, tus usuarios y todo `~/.cwc-data` quedan intactos
(no están versionados): la actualización solo trae código nuevo.

---

## 8. Si algo no arranca

| Síntoma | Qué mirar |
|---------|-----------|
| No abre la web | ¿ZeroTier arriba? `ip -o addr show \| grep zt` — el server espera la interfaz |
| "Falta CWC_TOKEN" | el `.env` no se generó; corré `node bin/cwc-setup.js` de nuevo |
| El chat no responde | ¿`claude --version` funciona? Claude Code es prerrequisito |
| No puedo entrar | ¿creaste un usuario? `node bin/cwc-adduser.js <user> --admin` y reiniciá |
| Logs | `journalctl --user -u claude-web-console -n 50 --no-pager` |
