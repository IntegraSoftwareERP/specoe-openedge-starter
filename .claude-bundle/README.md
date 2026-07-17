# .claude-bundle

Archivos que `setup.sh` instala en `~/.claude/` del dev al correr el starter por primera vez. Sin esto, los comandos del flow SpecOE no funcionan.

> **Windows**: ejecutar `setup.sh` desde Git Bash o WSL. PowerShell/CMD no funcionan. Ver `docs/QUICKSTART.md` Pre-requisitos.

## Que incluye

- `hooks/credentials.mjs` — manejo seguro de credenciales del Hub (keyring del SO)
- `hooks/integra-hub-auth.mjs` — auth de Claude Code contra el Hub
- `hooks/specoe-license-check.mjs` — validacion de licencia SpecOE (SessionStart hook)
- `hooks/specoe-role-check.mjs` — fail-fast de rol SDD: avisa al instante si faltan `INTEGRA_SDD_ROLE`/`INTEGRA_ACT_AS_SECRET` (SessionStart hook, SPEC-0113 P4)
- `hooks/package.json` + `hooks/package-lock.json` — manifest de dependencias del keyring
- `scripts/migrate-hub-credentials.mjs` — migracion legacy `.env` -> keyring (Paso 0)

## Idempotencia

`setup.sh` **NO pisa archivos existentes**. Si ya tenes un `~/.claude/hooks/credentials.mjs`, se mantiene. Cada archivo se reporta como `[INSTALL]` (copiado) o `[SKIP]` (existia).

**Excepcion (SPEC-0113 P4)**: `specoe-role-check.mjs` se **fuerza** (`[FORCE]`, overwrite) en cada `setup.sh` — el fail-fast de rol debe llegar tambien a los devs que ya tenian `~/.claude/hooks/` poblado. Es el unico hook con overwrite; el resto sigue siendo no-overwrite.

Para forzar reinstalacion: borrar `~/.claude/hooks/` y `~/.claude/scripts/` manualmente antes de correr `setup.sh`.

## Por que esta empaquetado aca

Test VM-limpia (2026-04-25) detecto que el QUICKSTART asume estos archivos pre-instalados — y no estan distribuidos en ningun otro lado. El bundle es la fuente unica de verdad para devs nuevos.

## Lo que NO esta en el bundle

Por ser herramientas internas del equipo Integra, NO se distribuyen aca:

- `hooks/telemetry-session.mjs` (telemetria interna)
- `hooks/credentials.test.mjs` (tests)
- `hooks/integra-hub-auth.mjs.pre-SPEC-0005` (backup)
- `scripts/cc-spec.sh` (wrapper interno SPEC/TKT)
