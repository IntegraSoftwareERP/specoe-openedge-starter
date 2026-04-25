# .claude-bundle

Archivos que `setup.sh` (o `setup.ps1`) instala en `~/.claude/` del dev al correr el starter por primera vez. Sin esto, los comandos del flow SpecOE no funcionan.

## Que incluye

- `hooks/credentials.mjs` — manejo seguro de credenciales del Hub (keyring del SO)
- `hooks/integra-hub-auth.mjs` — auth de Claude Code contra el Hub
- `hooks/specoe-license-check.mjs` — validacion de licencia SpecOE (SessionStart hook)
- `hooks/package.json` + `hooks/package-lock.json` — manifest de dependencias del keyring
- `scripts/migrate-hub-credentials.mjs` — migracion legacy `.env` -> keyring (Paso 0)

## Idempotencia

`setup.sh` y `setup.ps1` **NO pisan archivos existentes**. Si ya tenes un `~/.claude/hooks/credentials.mjs`, se mantiene. Cada archivo se reporta como `[INSTALL]` (copiado) o `[SKIP]` (existia).

Para forzar reinstalacion: borrar `~/.claude/hooks/` y `~/.claude/scripts/` manualmente antes de correr `setup.sh`.

## Por que esta empaquetado aca

Test VM-limpia (2026-04-25) detecto que el QUICKSTART asume estos archivos pre-instalados — y no estan distribuidos en ningun otro lado. El bundle es la fuente unica de verdad para devs nuevos.

## Lo que NO esta en el bundle

Por ser herramientas internas del equipo Integra, NO se distribuyen aca:

- `hooks/telemetry-session.mjs` (telemetria interna)
- `hooks/credentials.test.mjs` (tests)
- `hooks/integra-hub-auth.mjs.pre-SPEC-0005` (backup)
- `scripts/cc-spec.sh` (wrapper interno SPEC/TKT)
