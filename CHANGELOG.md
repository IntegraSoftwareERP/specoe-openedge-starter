# Changelog

All notable changes to this project. Automatic — regenerado por `./scripts/changelog.sh`.

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
