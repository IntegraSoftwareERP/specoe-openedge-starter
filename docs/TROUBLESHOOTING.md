# Troubleshooting

Guia de problemas conocidos y su resolucion. Organizada por momento del flujo en el que aparecen.

Este doc asume **tier SaaS** (default). Si tu organizacion contrato Suite on-premise, ver [Troubleshooting Suite on-premise](#troubleshooting-suite-on-premise) al final.

## Indice

- [Prerrequisitos faltantes](#prerrequisitos-faltantes)
- [Estructura del starter rota](#estructura-del-starter-rota)
- [Credenciales del Hub (keyring)](#credenciales-del-hub-keyring)
- [Licencia SpecOE](#licencia-specoe)
- [Conectividad al Hub (SaaS)](#conectividad-al-hub-saas)
- [JWT en `.claude/settings.json`](#jwt-en-claudesettingsjson)
- [Claude Code (skills, cache, commands)](#claude-code-skills-cache-commands)
- [Validacion de `project.config.yaml`](#validacion-de-projectconfigyaml)
- [Problemas dev-specific (Windows)](#problemas-dev-specific-windows)
- [Troubleshooting Suite on-premise](#troubleshooting-suite-on-premise)

## Mapa rapido -- mensaje del smoke-test → seccion

Si corriste `./scripts/smoke-test.sh` (o `.ps1`) y viste un FAIL, este mapa te lleva directo a la seccion que cubre cada caso:

| Mensaje del smoke-test (literal o tipo)                          | Seccion                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `[FAIL] Node 20+ -- no instalado en PATH`                        | [Prerrequisitos faltantes](#prerrequisitos-faltantes)                                   |
| `[FAIL] Node >= 20 -- detectado vXX, se requiere 20+`            | [Prerrequisitos faltantes](#prerrequisitos-faltantes)                                   |
| `[FAIL] Claude Code -- no instalado en PATH`                     | [Prerrequisitos faltantes](#prerrequisitos-faltantes)                                   |
| `[FAIL] openssl -- no instalado`                                 | [Prerrequisitos faltantes](#prerrequisitos-faltantes)                                   |
| `[FAIL] project.config.yaml -- no existe en la raiz`             | [Estructura del starter rota](#estructura-del-starter-rota)                             |
| `[FAIL] setup.sh -- falta`                                       | [Estructura del starter rota](#estructura-del-starter-rota)                             |
| `[FAIL] .claude/ -- falta -- correr ./setup.sh`                  | [Estructura del starter rota](#estructura-del-starter-rota)                             |
| `[FAIL] .claude/skills/openedge-abl/SKILL.md -- falta`           | [Estructura del starter rota](#estructura-del-starter-rota)                             |
| `[FAIL] docker/Dockerfile.pasoe -- falta` (solo si tier=suite)   | [Estructura del starter rota](#estructura-del-starter-rota)                             |
| `[FAIL] specoe-validate -- el yaml no pasa el schema`            | [Validacion de project.config.yaml](#validacion-de-projectconfigyaml)                   |
| `[FAIL] Seccion 'X' -- no encontrada en project.config.yaml`     | [Validacion de project.config.yaml](#validacion-de-projectconfigyaml)                   |
| `[FAIL] Credenciales del Hub -- no hay keyring ni .env`          | [Credenciales del Hub (keyring)](#credenciales-del-hub-keyring) (ver QUICKSTART paso 0) |
| `[FAIL] Hub URL -- no se pudo extraer de project.config.yaml`    | [Validacion de project.config.yaml](#validacion-de-projectconfigyaml)                   |
| `[FAIL] Hub healthz -- $HUB_URL/health no responde 2xx`          | [Conectividad al Hub (SaaS)](#conectividad-al-hub-saas)                                 |
| `[FAIL] JWT formato -- debe ser 3 segmentos separados por punto` | [JWT en .claude/settings.json](#jwt-en-claudesettingsjson)                              |
| `[FAIL] JWT validacion -- Hub rechazo el token`                  | [Licencia SpecOE](#licencia-specoe) o [JWT](#jwt-en-claudesettingsjson)                 |

> Si el mensaje del smoke-test no aparece arriba, mira la seccion mas cercana al momento del flujo en el que aparecio (setup, runtime, etc.) o ver [Si el problema no esta aca](#si-el-problema-no-esta-aca) al final.

---

## Prerrequisitos faltantes

Errores en el bloque `[1/5] Prerrequisitos de ambiente` del smoke-test. Aparecen antes que cualquier otro check fallido -- fixearlos primero.

### `Node 20+ -- no instalado en PATH` o `detectado vXX, se requiere 20+`

**Fix**:

- Linux/Mac (con `nvm`): `nvm install 20 && nvm use 20`
- Windows: descargar instalador LTS desde https://nodejs.org/ (versión 20.x) y reiniciar la terminal.
- Verificar: `node -v` debe mostrar `v20.x.x` o superior.

### `Claude Code -- no instalado en PATH`

**Fix**: instalar desde https://claude.ai/code siguiendo las instrucciones de la pagina (Mac/Windows/Linux). Verificar con `claude --version`.

### `openssl -- no instalado -- necesario para generar JWT/VAULT keys`

**Fix**:

- Linux: `apt install openssl` / `dnf install openssl` (suele venir preinstalado).
- Mac: `brew install openssl` (suele venir preinstalado).
- Windows: viene con Git for Windows (`C:\Program Files\Git\usr\bin\openssl.exe`). Si Git Bash esta en el PATH, openssl tambien.

---

## Estructura del starter rota

Errores en el bloque `[2/5] Archivos del starter` del smoke-test. Indican que el clone esta incompleto o el setup nunca corrio.

### `project.config.yaml -- no existe en la raiz`

**Causa**: clonaste el starter en un subdirectorio en vez de la raiz, o borraste el archivo.

**Fix**: re-clonar el starter o copiar `project.config.yaml.example` (si existe) a `project.config.yaml`. Despues correr `./setup.sh`.

### `setup.sh -- falta`

**Causa**: clone incompleto.

**Fix**: re-clonar el repo. `setup.sh` ship con el starter, no se genera.

### `.claude/ -- falta -- correr ./setup.sh`

**Causa**: corriste el smoke-test antes que `setup.sh`.

**Fix**:

```bash
./setup.sh                 # Linux/Mac/GitBash
.\setup.ps1                # Windows PowerShell
```

`setup.sh` materializa la carpeta `.claude/` con agents, commands, skills y standards desde el package interno.

### `.claude/skills/openedge-abl/SKILL.md -- falta`

**Causa**: `setup.sh` no termino de materializar el skill `openedge-abl` (corrida parcial o falla a mitad). Tambien puede pasar si el dev borro el archivo a mano.

**Fix**: re-correr `./setup.sh` (o `.\setup.ps1` en Windows) -- el script es idempotente para `.claude/`. Si el archivo sigue ausente, ver [`setup.sh` corrió pero falló a mitad](#setupsh-corrió-pero-falló-a-mitad) abajo.

### `setup.sh` corrió pero falló a mitad

**Sintoma**: corriste `./setup.sh`, viste un error en `[specoe-setup]`, y ahora el smoke-test reporta cosas raras (`.claude/` vacio, `settings.json` ausente, archivos parciales).

**Causa**: `setup.sh` corre con `set -euo pipefail` -- aborta al primer error sin hacer rollback ni cleanup. Los archivos parciales quedan en el filesystem.

**Fix (recovery)**:

1. Identificar el punto de falla en el output del setup. Mensajes `[specoe-setup]` indican el paso (validacion config, license, materializar `.claude/`).
2. Si la falla fue en validacion del yaml (`Campo obligatorio vacio: ...`): editar `project.config.yaml` y re-correr `./setup.sh` -- no hace falta limpiar nada.
3. Si la falla fue en materializar `.claude/` o despues: borrar el directorio y re-correr.

```bash
rm -rf .claude
./setup.sh
```

`setup.sh` es idempotente para `.claude/` (re-crea desde cero). NO borrar `project.config.yaml` ni nada fuera de `.claude/`.

**Si el error persiste** tras re-correr: el clone puede estar incompleto. Ver [setup.sh -- falta](#setupsh--falta) y [project.config.yaml -- no existe en la raiz](#projectconfigyaml--no-existe-en-la-raiz) arriba.

### `docker/Dockerfile.pasoe -- falta` (solo tier Suite)

> **Aplica solo si `tier=suite`** en la cabecera del smoke-test (cuando `hub.api-url` NO apunta a `integrasoftware.biz`). Para tier SaaS este check se SKIPea -- el cliente SaaS no construye PASOE local.

**Causa**: clone incompleto o el `.gitignore` del cliente excluye `docker/` por error. El `Dockerfile.pasoe` es necesario para el build CI/CD del WAR de PASOE en deployments Suite on-premise.

**Fix**: verificar que `git ls-files docker/` lista el Dockerfile. Si no, re-clonar el starter. NO redacta el Dockerfile a mano -- es parte del scaffold.

---

## Credenciales del Hub (keyring)

### `migrate-hub-credentials.mjs` falla

**Sintoma**: al correr `node ~/.claude/scripts/migrate-hub-credentials.mjs`, el script reporta error y **NO** renombra el `.env`.

| Error                                     | Causa                                            | Solucion                                                                                                                |
| ----------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `No existe ~/.claude/integra-hub.env`     | No creaste el legacy `.env` con tus credenciales | Crear el archivo con `INTEGRA_HUB_EMAIL=...`, `INTEGRA_HUB_PASSWORD=...`, `INTEGRA_HUB_URL=...` (ver QUICKSTART paso 0) |
| `Ya existe entry en keyring para <email>` | Ya migraste antes                                | Agregar `--force` si queres sobreescribir, o no correr de nuevo                                                         |
| `Validacion fallo: Hub login fallo 401`   | Email/password incorrectos                       | Verificar con el admin del Hub                                                                                          |
| `Validacion fallo: fetch failed`          | Hub no accesible                                 | Ver [Conectividad al Hub (SaaS)](#conectividad-al-hub-saas)                                                             |
| `@napi-rs/keyring no instalado`           | Dep faltante en `~/.claude/hooks/`               | Correr `cd ~/.claude/hooks && npm install`                                                                              |

### Rollback de la migracion

Si la migracion rompio algo, podes volver al estado previo:

```bash
node ~/.claude/scripts/migrate-hub-credentials.mjs --rollback
```

Esto restaura el `~/.claude/integra-hub.env` desde el backup mas reciente.

### Keyring no funciona en WSL / Linux headless

**Sintoma**: `keyring disponible pero sin permiso o sin D-Bus`.

En Linux sin entorno grafico (servers, WSL), D-Bus Secret Service no esta disponible. El script automaticamente cae al **cipher file** (`~/.claude/integra-hub.enc`) -- AES-256-GCM con clave derivada de `machine-id + user`. No requiere accion manual.

---

## Licencia SpecOE

### License check falla al iniciar Claude Code

**Sintoma**: mensaje `[WARN] SpecOE license invalida` o `[license] FAIL -- <razon>` al abrir Claude.

Pasos:

1. Verificar que `SPECOE_LICENSE_KEY` esta seteada o que `license.key` en yaml existe.
2. Verificar conectividad al Hub: `curl $hub.api-url/health`.
3. Ver logs: `tail -20 $HOME/.claude/logs/specoe-license-$(date +%Y-%m-%d).log`.
4. Si red OK pero **401**: re-activar con `curl -X POST $hub.api-url/license/activate ...` o contactar `soporte@integrasoftware.biz`.
5. Si red OK pero **409 "seats exceeded"**: liberar un seat con `/deactivate` en otra maquina.

### Cache stale -- skills protegidos no responden

**Sintoma**: `mcp__specoe__skill_get_content("integra-pasoe")` devuelve error tras horas sin conexion.

Pasos:

1. Verificar que el MCP Skill Server responde: `curl $hub.api-url/health`.
2. Ver cache: `cat $HOME/.claude/specoe-license-cache.json | jq .validatedAt`.
3. Forzar re-validacion: borrar el cache y re-abrir Claude Code.

---

## Conectividad al Hub (SaaS)

En tier SaaS, el Hub vive en `hub.integra.local` (u otra instancia provista por Integra). Los problemas de conectividad son los mas comunes porque dependen de la red del cliente.

### DNS no resuelve el Hub

**Sintoma**: `curl $hub.api-url/health` falla con `Could not resolve host`.

**Causa**: DNS corporativo bloquea el dominio, o no hay internet, o el `hub.api-url` en el yaml es incorrecto.

**Fix**:

```bash
# 1. Verificar que el dominio resuelve
nslookup hub.integra.local
# 2. Verificar DNS del sistema
cat /etc/resolv.conf   # Linux/Mac
Get-DnsClientServerAddress   # PowerShell

# 3. Si DNS corporativo bloquea, coordinar con IT el whitelisting
# 4. Verificar el yaml
grep -A 1 'hub:' project.config.yaml
```

Alternativa: usar IP publica directamente (solo para diagnostico, NO persistir).

### Red corporativa bloquea HTTPS

**Sintoma**: `curl $hub.api-url/health` cuelga (timeout) o da `Connection refused`.

**Causa**: firewall/proxy corporativo bloquea trafico saliente a dominios no autorizados.

**Fix**:

```bash
# 1. Verificar que el puerto 443 sale
curl -v https://hub.integra.local/api/v1/health --max-time 10

# 2. Si hay proxy corporativo, setear variables de entorno
export HTTPS_PROXY=http://proxy.mi-empresa.com:8080
export HTTP_PROXY=http://proxy.mi-empresa.com:8080
export NO_PROXY=localhost,127.0.0.1

# 3. Para whitelisting coordinar con IT:
#    - hub.integra.local (Hub API + Frontend)
#    - mcp.integra.local (Skill Server -- si aplica)
```

### Cert TLS no confiable

**Sintoma**: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` o `self signed certificate in certificate chain`.

**Causa**: en el tier SaaS Let's Encrypt esto **no deberia pasar** -- si pasa, hay MITM (proxy corporativo SSL inspection) o el cert expiro.

**Fix**:

```bash
# 1. Verificar el cert del Hub
openssl s_client -connect hub.integra.local:443 -servername hub.integra.local </dev/null 2>/dev/null | openssl x509 -noout -dates

# 2. Si hay SSL inspection del proxy corporativo, agregar su root CA al trust store:
#    - Windows: Manage Computer Certificates → Trusted Root CA → Import
#    - Linux: /etc/ssl/certs/ca-certificates.crt

# 3. NUNCA usar NODE_TLS_REJECT_UNAUTHORIZED=0 -- risco de seguridad grave
```

### Hub responde 401 / 403

**Sintoma**: `curl $hub.api-url/health` funciona, pero Claude Code recibe `401` o `403` al hacer license check.

**Causa**: credenciales invalidas o token JWT expirado/mal formado.

**Fix**: ver [Licencia SpecOE](#licencia-specoe) y [JWT en `.claude/settings.json`](#jwt-en-claudesettingsjson).

### Hub responde 503 / 502

**Sintoma**: `curl $hub.api-url/health` retorna `503 Service Unavailable`.

**Causa**: el Hub remoto tiene un problema -- mantenimiento, downtime, deploy en curso.

**Fix**:

1. Verificar el status publico en https://status.integrasoftware.biz (si existe).
2. Contactar `soporte@integrasoftware.biz`.
3. Mientras tanto, modo offline: los skills cacheados siguen funcionando 24h.

---

## JWT en `.claude/settings.json`

### Format incorrecto impide arranque de hooks

**Sintoma**: SessionStart hook falla con:

```
[error] JWT malformed
[error] jwt must have 3 parts
```

**Causa**: el hook espera un JWT completo (3 partes separadas por `.`). Si pegaste solo el `payload` o solo la primer parte, falla.

**Fix**: verificar que el valor en `.claude/settings.json` bajo `env.SPECOE_LICENSE_JWT` (o similar segun tu config) tenga:

```
<header-base64>.<payload-base64>.<signature-base64>
```

Debe incluir **los 3 segmentos y los 2 puntos**.

Pegalo con comillas simples si tu shell escapo caracteres especiales:

```json
{
  "env": {
    "SPECOE_LICENSE_JWT": "eyJhbGciOi...pegar-token-completo...xXxXx"
  }
}
```

---

## Claude Code (skills, cache, commands)

### Claude Code no ve los skills/commands

**Sintoma**: `/nueva-entidad` no aparece en autocomplete.

Pasos:

1. Iniciar Claude desde la **raiz** del starter (donde vive `.claude/`).
2. `ls .claude/skills/ .claude/commands/ .claude/agents/` -- deben existir.
3. Si falta alguno, re-clonar el starter o ejecutar `./setup.sh`.
4. Reiniciar Claude Code (Ctrl+D, volver a correr `claude`).

---

## Validacion de `project.config.yaml`

### `setup.sh` dice "Campo obligatorio vacio"

**Sintoma**: `Campo obligatorio vacio: project.name`.

Revisar que el campo tenga valor NO vacio NO con comillas solas:

```yaml
# mal
project:
  name: ""

# mal
project:
  name:

# bien
project:
  name: "MiCliente ERP"
```

### `npx specoe-validate` reporta multiples errores

**Sintoma**: `tiene N problemas de validacion` con lista por path.

Ver [CONFIGURATION.md](CONFIGURATION.md#troubleshooting-de-errores-comunes) -- tabla con errores comunes (client-side y server-side) marcados por origen.

---

## Problemas dev-specific (Windows)

### EPERM al correr `npx prisma generate` o `prisma migrate`

**Sintoma** (en Windows):

```
EPERM: operation not permitted,
rename '.prisma/client/query_engine-windows.dll.node.tmp...'
```

**Causa**: Prisma no puede sobreescribir el binding `.node` mientras el backend Node lo tiene abierto.

**Fix**:

```powershell
Get-Process node | Stop-Process -Force
cd C:\Integra\integra-hub\backend
npx prisma generate
npx prisma migrate dev --name <name>
```

### Git line endings (CRLF vs LF)

**Sintoma**: `diff -rq` marca archivos como distintos pero el contenido parece igual.

**Causa**: Windows escribe CRLF en checkout; el repo remoto tiene LF. Git los normaliza al commit.

**Fix** -- si no necesitas inspeccionar el archivo byte-wise:

```bash
# ignorar whitespace en diff
diff -b archivo1 archivo2
```

Si el proyecto usa `.gitattributes`, verificar:

```
* text=auto eol=lf
```

---

## Troubleshooting Suite on-premise

> **Esta seccion aplica solamente al tier Suite on-premise.** Si estas en SaaS (default), esto no te concierne y podes ignorarlo. Contactar `soporte@integrasoftware.biz` si tenes dudas sobre tu tier.

El tier Suite incluye `docker-compose.yml` + `Caddyfile` + runbooks de deploy del Hub y Skill Server en tu propia infra. Los siguientes problemas son comunes durante el deploy on-premise.

Fuente de verdad: `integra-hub/docs/DEPLOYMENT.md` seccion "Post-deploy recovery runbooks".

### Gotcha 1 -- `LICENSE_JWT_SECRET` faltante → backend crashloop

**Sintoma**: `docker compose logs backend` muestra:

```
Configuration key "LICENSE_JWT_SECRET" does not exist
```

El container `backend` queda en `Restarting (1)` indefinidamente.

**Causa**: SPEC-0016 F3 agrego validacion explicita al boot. El backend valida 5 secretos obligatorios -- si falta **cualquiera**, crash. `LICENSE_JWT_SECRET` debe ser distinto de `JWT_SECRET` (separacion de scope).

**Fix**:

```bash
echo "LICENSE_JWT_SECRET=$(openssl rand -base64 48)" >> .env
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

Verificar en `docker-compose.prod.yml` que `backend.environment` incluya `LICENSE_JWT_SECRET` -- `--env-file` NO forwardea vars al container a menos que esten listadas ahi.

### Gotcha 2 -- `INTEGRA_VAULT_KEY` con formato invalido

**Sintoma**:

```
INTEGRA_VAULT_KEY is not set. Generate one with `openssl rand -hex 32`
```

O variante: `INTEGRA_VAULT_KEY must be exactly 64 hex characters`.

**Causa**: la key se usa para AES-256 del vault interno. Debe ser **exactamente** 64 caracteres hex (32 bytes). Si usas `openssl rand -base64 32`, obtenes 44 chars base64 -- invalido.

**Fix**:

```bash
echo "INTEGRA_VAULT_KEY=$(openssl rand -hex 32)" >> .env
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

### Gotcha 3 -- `DOMAIN` vacio → Caddy restart loop silencioso

**Sintoma**: `docker compose ps` muestra `caddy` en `Restarting (1)`. Logs:

```
Error: adapting config using caddyfile: /etc/caddy/Caddyfile:14: unrecognized global option: header
```

Usualmente precedido por:

```
WARN[0000] The "DOMAIN" variable is not set. Defaulting to a blank string.
```

**Causa**: Caddy v2 substituye `{$DOMAIN:hub.integra.local}` con el default **solo cuando `DOMAIN` no esta definido**. Si `DOMAIN` existe pero es string vacio (ej. `DOMAIN=` en el `.env`), Caddy substituye `""` y el Caddyfile arranca con ` {` como linea -- eso abre un "global options block" en vez de un site block, y el `header Strict-Transport-Security ...` siguiente es invalido a nivel global. Caddy aborta.

**Fix** -- setear `DOMAIN` explicitamente, aunque sea el mismo default:

```bash
echo "DOMAIN=hub.integra.local" >> .env
docker compose -f docker-compose.prod.yml --env-file .env up -d caddy
```

**Prevencion**: el `.env.example` ahora ship con `DOMAIN=hub.integra.local` seteado, un fresh deploy ya no cae aca.

### Gotcha 4 -- TLS cert de Caddy no importado → clientes Node fallan

**Sintoma**: tu `.mcp.json` apunta a `https://hub.mi-infra.local/...` y el MCP server de Node lanza:

```
unable to verify the first certificate
UNABLE_TO_VERIFY_LEAF_SIGNATURE
```

**Causa**: en dev local / staging interno, Caddy emite cert self-signed desde su CA interna. Node no confia en esa CA por default -- rechaza la conexion TLS.

**Fix -- Opcion A (recomendado)**: importar la CA de Caddy al trust store del SO:

```bash
docker run --rm -v caddy_data:/data caddy:2-alpine caddy trust
```

**Fix -- Opcion B (per-dev, temporal)**: exportar el cert a un archivo y apuntarlo con `NODE_EXTRA_CA_CERTS` en el `.mcp.json`:

```json
{
  "env": {
    "NODE_EXTRA_CA_CERTS": "${env:USERPROFILE}/.claude/caddy-local-root.crt"
  }
}
```

**Permanente**: usar dominio publico con Let's Encrypt (como el tier SaaS).

### Gotcha extra -- Prisma migration P3009 (`tokenHash`)

**Sintoma**: `Error P3009: migrate found failed migrations`.

**Causa**: la migration `20260422200000_hash_refresh_tokens` agrega `tokenHash NOT NULL` que falla si hay rows previas. Prisma la marca como `failed` y bloquea deploys posteriores.

**Fix**:

```bash
docker exec -it integra-hub-db psql -U integra -d integra_hub
```

```sql
DELETE FROM "RefreshToken";
UPDATE "_prisma_migrations"
   SET rolled_back_at = NOW()
 WHERE migration_name = '20260422200000_hash_refresh_tokens';
\q
```

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

Los tokens son ephemeral (7d TTL) -- los usuarios re-loguean una vez.

### Gotcha extra -- Postgres auth P1000

**Sintoma**: `Error: P1000: Authentication failed against database server`.

**Causa**: `postgres:16-alpine` solo usa `POSTGRES_PASSWORD` **la primera vez** que inicializa el volumen `pg_data`. Si regeneraste `.env.prod` con un password nuevo, postgres sigue con el viejo.

**Fix (no destructivo)**:

```bash
docker exec -it integra-hub-db psql -U integra -d integra_hub
```

```sql
\password integra
-- Ingresar el password nuevo de .env.prod dos veces
\q
```

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

---

## Si el problema no esta aca

1. Buscar en [CONFIGURATION.md](CONFIGURATION.md) si el error es de validacion de yaml.
2. Revisar los logs del componente especifico:
   - `$HOME/.claude/logs/` (license, hooks)
   - `tail -f` en el service en tiempo real
3. Contactar soporte: `soporte@integrasoftware.biz`.

---

_Ultima actualizacion: SPEC-0023 F3 -- auditoria + quick-jump + secciones de prerequisitos/estructura (Piloto Docs Onboarding 2026-04-28)_
