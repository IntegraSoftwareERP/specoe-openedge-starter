# .claude-bundle

Archivos que `setup.sh` instala en `~/.claude/` del dev al correr el starter por primera vez. Sin esto, los comandos del flow SpecOE no funcionan.

> **Windows**: ejecutar `setup.sh` desde Git Bash o WSL. PowerShell/CMD no funcionan. Ver `docs/QUICKSTART-VSCODE.md` Pre-requisitos.

## Que incluye

- `hooks/specoe-license-check.mjs` — validacion de licencia SpecOE (SessionStart hook)
- `hooks/specoe-role-check.mjs` — fail-fast de rol SDD: avisa al instante si faltan `INTEGRA_SDD_ROLE`/`INTEGRA_ACT_AS_SECRET` (SessionStart hook)
- `hooks/specoe-room-bootstrap.mjs` — baja el contrato del room desde el Skill Server (SessionStart hook)
- `hooks/secrets.mjs` — canal de secretos por `(service, name)` (keyring nativo del SO / cipher-file fallback); resuelve el secreto act-as scoped del thin-client (SPEC-0148 P2)
- `hooks/credentials.mjs` — cripto compartida (`encryptBlob`/`decryptBlob`) que `secrets.mjs` reusa para su fallback cifrado; sin esto `secrets.mjs` no carga (SPEC-0148 P2)
- `hooks/package.json` + `hooks/package-lock.json` — manifest de dependencias de los hooks (incluye `@napi-rs/keyring`)
- `scripts/provision-secrets.mjs` — escritor del canal de secretos (CLI `act-as <ROL>`, valor por stdin -> `setSecret`); sin esto el canal solo se puede leer, no grabar (SPEC-0148 P7)
- `scripts/sdd-login.mjs` — login SDD por usuario (credenciales por ENV): canjea email/password por el material de identidad y lo deja en el canal (SPEC-0157 P6)
- `scripts/specoe-identity.mjs` — **CLI del canal de identidad SDD**: la interfaz estable para consumidores de afuera del bundle (SPEC-0187 P5). Ver abajo.

## Interfaz: `scripts/specoe-identity.mjs`

Entrypoint invocable del canal de identidad (keyring del SO). Es lo que consume el plugin VSCode por `child_process` con el Node del sistema, y el contrato que P7 extiende con la dimension tenant. **Consumilo por aca, no importes los modulos internos del bundle.**

```
node ~/.claude/scripts/specoe-identity.mjs <status|login|logout|session-token> [--tenant <slug>] [--print-token]
```

| Subcomando      | Que hace                                                                                         | Salida                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `status`        | presencia + datos NO secretos de la identidad de esta maquina                                    | `{ ok, identity:{ present, userId, machineId, userToken:bool }, tenants:[...] }`           |
| `login`         | credenciales por **stdin** (email y password, una por linea) o prompt; delega en `sdd-login.mjs` | `{ ok, machineId, machineStatus, tenantId, tenantSlug, roles, userIdStored, robot:{...} }` |
| `logout`        | borra los 3 secretos de `integra-sdd-identity` de ambos backends del canal                       | `{ ok, removed:[...] }`                                                                    |
| `session-token` | material para canjear un JWT de sesion contra `POST /auth/sdd/session`                           | `{ ok, token, machineId, fingerprint }`                                                    |

Reglas del contrato:

- **Toda** invocacion emite **un** objeto JSON con `schemaVersion: 1` y `command`: exito por **stdout**, fallo por **stderr** con `ok:false` + `code` estable. Decidí por `ok`/`code`, nunca por el texto del mensaje.
- **El password NUNCA por argv** — en la linea de comando queda en el history del shell y en la lista de procesos. Un flag tipo `--password` corta con exit `2` y `code: CREDENTIALS_BY_ARGV`.
- **El token no se imprime por default**: solo `session-token --print-token` lo pone en stdout. Sin el flag corta con exit `2` y `code: PRINT_TOKEN_REQUIRED`. Ningun otro subcomando acepta `--print-token`.
- Exit codes: `0` OK — `status` sale 0 aunque no haya identidad (es una consulta; mirá `identity.present`); `1` error operativo (sin identidad, Hub rechazo, canal roto); `2` error de uso.
- `--tenant <slug>` hoy es **pass-through declarativo**: viaja en la respuesta y todavia no cambia que claves se leen (`tenantScoping: "legacy"`). La resolucion tenant-scoped y `migrate` llegan en SPEC-0187 P7.
- URL del Hub para el `login`: `SDD_LOGIN_HUB_URL` (o `INTEGRA_HUB_API_URL`); si no estan, el default del bundle.

`sdd-login.mjs` sigue funcionando igual por su cuenta (mismos subcomandos, credenciales por ENV): el camino solo-CLI no cambia — `specoe-identity.mjs` reusa su motor, no lo reemplaza.

## Idempotencia

`setup.sh` **NO pisa archivos existentes**. Si ya tenes un `~/.claude/hooks/specoe-license-check.mjs`, se mantiene. Cada archivo se reporta como `[INSTALL]` (copiado) o `[SKIP]` (existia).

**Excepcion**: `specoe-role-check.mjs` se **fuerza** (`[FORCE]`, overwrite) en cada `setup.sh` — el fail-fast de rol debe llegar tambien a los devs que ya tenian `~/.claude/hooks/` poblado. Es el unico hook con overwrite; el resto sigue siendo no-overwrite.

Para forzar reinstalacion: borrar `~/.claude/hooks/` y `~/.claude/scripts/` manualmente antes de correr `setup.sh`.

## Por que esta empaquetado aca

Test VM-limpia (2026-04-25) detecto que el QUICKSTART asume estos archivos pre-instalados — y no estan distribuidos en ningun otro lado. El bundle es la fuente unica de verdad para devs nuevos.
