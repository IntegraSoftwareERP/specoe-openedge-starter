# Changelog

All notable changes to this project. Automatic — regenerado por `./scripts/changelog.sh`.

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
