# Changelog

All notable changes to this project. Automatic — regenerado por `./scripts/changelog.sh`.

## 0.2.3 — 2026-07-28 (SPEC-0164 — conectividad thin-client → Hub desde VSCode)

**CAMBIO DE CONTRATO DEL HOOK DE LICENCIA (ADR-002) — leer antes de actualizar.**
`specoe-license-check.mjs` ya no sale 0 siempre: **a partir de esta versión el arranque del
room puede bloquearse**. Bloquea únicamente cuando intentó validar y **no hay cache de grace**
(`continue: false` + exit 2). Con cache de menos de 24 h arranca igual y lo dice en pantalla;
una carpeta sin licencia sigue arrancando (no es un room roto, es una sesión sin SpecOE).
El bloqueo lleva siempre los cuatro datos del diagnóstico (errno real, URL del Hub resuelta con
su fuente, fuente de CA que ganó, acción concreta) y la vía de escape ejecutable: la variable
`SPECOE_ALLOW_DEGRADED_START` o el archivo `.claude/specoe-allow-degraded-start` en el room.
Si el diagnóstico sale incompleto **no bloquea** — un bloqueo mudo deja al dev sin sesión y sin
dato, que es peor que no bloquear.

**CAMBIO DE MECANISMO DEL CA (ADR-001) — una máquina ya instalada NO se actualiza sola.**
No hay migración: hay que **reinstalar el bundle** (`./setup.sh` o `specoe-setup-host.sh`), que
es lo que copia los hooks nuevos a `~/.claude/hooks/`. Hasta hacerlo, la máquina sigue con el
mecanismo viejo.

- Canal TLS único en `.claude-bundle/hooks/ca-channel.mjs`, importado por el hook de licencia,
  el bootstrap del room y `sdd-login.mjs`. Reemplaza al dispatcher global de undici, que medido
  en Node v26.5.0 **el `fetch` global no honra**: la función era un no-op que además logueaba
  éxito. Ahora se muta el default CA store del proceso, armado desde `system` + `bundled` + el
  CA de Caddy — `default` deja el trust de Windows afuera y rompe toda máquina con SSL scanning
  del antivirus.
- Se elimina `env.NODE_EXTRA_CA_CERTS` de `.claude/settings.json`, y `setup.sh` deja de
  inyectarla en la línea de comando del login: era el segundo mecanismo de CA del starter.
  Encima llevaba `${env:USERPROFILE}` adentro —interpolación de VSCode que Node descarta con un
  warning— y bajo la extensión de VSCode esa variable **no le llega al hook**. El CA queda
  definido en un solo lugar y se lee del archivo.
- El hook de licencia deja de mentir sobre por qué falla: distingue el corte de red pasajero de
  la instalación que nunca funcionó, y el bootstrap del room declara cuando arranca **sin
  contrato de gobierno** en vez de seguir en silencio.

**Verificador nuevo `specoe-verify-room.sh`** (raíz del starter) + `.claude-bundle/scripts/verify-room-serving.mjs`.
Cinco chequeos por efecto sobre un room ya instalado — canal TLS contra el Hub, JWT del cache
con `exp` vigente, `.mcp.json` con el JWT real, contrato del room bajado, y `specoe` conectable
por SSE con la URL y el header literales del `.mcp.json`. Sale 0 solo con los cinco en verde.

**Rango de Node certificado: 22.19.0 a 26.x, Node 23 afuera** (ADR-004). Medido, no elegido:
`tls.setDefaultCACertificates` —sobre la que se apoya el canal— no existe en 20.x, ni en 22.x
previo a 22.19.0, ni en 23.x. El preflight de `setup.sh` y `specoe-setup-host.sh` **aborta**
fuera del rango y comprueba además que la API exista en esa versión; antes pedía "20+ sin
techo", y la VM del incidente corría 26.5.0 dentro de lo declarado con el canal inexistente.

- `setup.sh` copia el CA local del starter de forma **incondicional**: antes solo lo instalaba
  si el destino no existía, así que un `.crt` viejo o de otro emisor sobrevivía invisible.
- `setup.sh` instala `ca-channel.mjs` en el bundle (allowlist de `install_force`) — sin eso los
  hooks importan un módulo que el instalador no copia.
- Guías: `QUICKSTART-VSCODE.md` y `TROUBLESHOOTING.md` dejan de recomendar el fix por variable
  de entorno que la medición invalidó.

## 0.2.2 — 2026-07-23 (TKT-0217 — instalación en máquina limpia sin pasos manuales)

- `.gitattributes` (raíz del starter, se sincroniza a la raíz del repo público): `*.sh eol=lf`.
  En Windows con `core.autocrlf=true` el checkout dejaba los `.sh` en CRLF y el shebang
  quedaba `#!/usr/bin/env bash\r` → `/usr/bin/env: 'bash\r': No such file or directory`.
  Había que pasarles `sed -i 's/\r$//'` a mano antes de poder correr nada.
- Selección del binario de Node consciente de WSL (`setup.sh`, `specoe-add-room.sh`,
  `specoe-launch-thinclient.sh`). `node.exe` se sigue prefiriendo en Git Bash (bypassa
  winpty, TKT-0200) pero en WSL entra por el interop y lee las rutas Unix como Windows
  → `Cannot find module 'C:\home\...'` en `sdd-login.mjs`. En WSL va el `node` de la distro,
  y el chequeo de prerrequisitos lo dice explícito si no está instalado.
- `setup.sh` instala el CA local desde el `certs/` del propio starter cuando falta
  `~/.claude/caddy-local-root.crt`; antes el login moría con
  `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` sin decir de dónde sacarlo. Si el TLS falla igual,
  el error nombra el comando exacto para instalarlo.
- `setup.sh --login` ya no exige haber corrido `--host-only` antes: si falta el bundle,
  corre la parte de máquina y sigue al login.

## 0.2.1 — 2026-07-23 (SPEC-0157 P6 — fix sync del bundle al espejo)

- `.syncignore`: ancla `scripts/` a la raíz (`/scripts/`). El patrón sin anclar excluía
  también `.claude-bundle/scripts/` del espejo público: el bundle llegaba sin
  `provision-secrets.mjs` ni `sdd-login.mjs` y el login SDD del starter público
  no podía instalarse (verde-falso detectado por la verificación del espejo de T6.3).

## 0.2.0 — 2026-07-23 (SPEC-0157 P6 — identidad por usuario)

- Login SDD por usuario: `setup.sh --login` / `specoe-setup-host.sh` piden Hub URL + email + clave,
  llaman `POST /auth/sdd/login`, enrolan el equipo y guardan UserSddToken + machineId
  (y token robot si vino) en el keyring del SO — cero secretos en archivos.
- `.mcp.json` del room en modo USER: `INTEGRA_SDD_IDENTITY_MODE=USER` + `INTEGRA_SDD_ROLE`
  (rol como config de la carpeta, claim sin firma autorizado server-side). Se eliminan
  credenciales robot y cuid de tenant de todos los artefactos generados.
- `specoe-launch-thinclient.sh` sin `<TENANT_ID>` ni credenciales: solo el rol.
- `specoe-gate-messages.sh`: mapeo de cada código 403 del gate SDD (ADR-006) a instrucción
  accionable en castellano (+ test `scripts/test-gate-messages.sh`).

## 0.1.0 — 2026-04-18 (initial scaffold)

- Structure del starter con .claude/ + docker/ + docs/ + scripts/ + examples/
- Template `project.config.yaml` con todos los campos obligatorios
- Installer bash + PowerShell con validacion basica
- Stubs de skills/commands/agents/standards apuntando a MCP Skill Server
- docker-compose.yml con Hub local (placeholder hasta images publicas)
- Docs QUICKSTART, CONFIGURATION, TROUBLESHOOTING
- Scripts release, changelog, test-starter
