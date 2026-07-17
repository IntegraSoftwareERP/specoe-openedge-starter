# Runbook — Onboarding cliente externo

Procedimiento step-by-step para que un dev externo (cliente piloto, e.g. Sebastian) ejecute onboarding completo de SpecOE en menos de 15 minutos sin contactar soporte. Cada paso documenta comando, expected output, y troubleshooting.

> **Audiencia**: dev externo recibiendo licencia trial de SpecOE para evaluar el AI Dev Accelerator sobre OpenEdge.
>
> **Operador del Hub** (Integra Software): provisiona tenant + emite license JWT antes de entregar credenciales al cliente. Pasos del operador en sección [Pre-onboarding (lado Integra)](#pre-onboarding-lado-integra).

> **Quickstart resumido**: ver [QUICKSTART.md](QUICKSTART.md). Este runbook expande el flow para piloto cliente externo con detalle troubleshooting.

---

## Pre-onboarding (lado Integra)

Antes de entregar credenciales al cliente externo, el operador (Pablo / Integra Software) ejecuta:

### 1. Provision tenant en Hub backend

Mientras SPEC-0057 (Tenant provisioning UI) no merge, el provisioning es SQL manual contra la DB del Hub:

```sql
-- Conectado a integra-hub Postgres
INSERT INTO tenants (id, slug, project_name, tier, created_at)
VALUES (
  gen_random_uuid(),
  'cliente-externo-slug',          -- e.g. 'sebastian-test', 'cliente-piloto-acme'
  'Cliente Externo Display Name',  -- e.g. 'Acme ERP'
  'team',                          -- tier: solo | team | enterprise | dev
  NOW()
);
```

Capturar el `tenantId` (UUID) generado — se usa en el JWT.

### 2. Generar license JWT

JWT firmado con HS256 + `LICENSE_JWT_SECRET` (shared entre Hub y Skill Server). Payload mínimo:

```json
{
  "sub": "license-<tenantId>",
  "tenantId": "<uuid-del-tenant>",
  "tier": "team",
  "features": ["skill_get_content", "command_get_content", "agent_get_content"],
  "iss": "integra-hub",
  "aud": "specoe-skill-server",
  "exp": <unix-30-dias-en-el-futuro>
}
```

Firmar con `LICENSE_JWT_SECRET` (ver `.env.prod` del Hub backend, chmod 600).

### 3. Verificar que el contenido IP está cargado al MCP Skill Server productivo

Pre-requisito **F7 Item 3 DONE**. Validar con `validate-content.sh` (ver [Paso 7 del cliente](#paso-7-validar-contenido-ip-post-item-3)).

### 4. Entregar al cliente externo

- **email**: dirección registrada del cliente.
- **password inicial**: aleatorio (≥12 chars, mayúsc + minúsc + dígito).
- **license JWT**: el token firmado.
- **tenantId**: el UUID generado.
- **URL del Hub**: `https://hub.integra.local/api/v1` (piloto interno via VPN).
- **URL del MCP Skill Server**: `https://mcp.integra.local/sse`.
- Link a este runbook + [QUICKSTART.md](QUICKSTART.md).

---

## Onboarding del cliente externo

### Pre-requisitos

Verificar antes de empezar:

- **Node 20+**: `node --version` → `v20.x.x` o superior.
  - Si falta o es vieja: `nvm install 20 && nvm use 20`. NO usar `apt install nodejs`.
- **Claude Code**: descargar desde https://claude.ai/code. Arrancarlo una vez (`claude --help`) para crear `~/.claude/`.
- **Git, openssl, npm**: pre-instalados en mayoría de SO.
- **OpenEdge 12.x**: solo para generación real de entidad (no para setup).
- **Acceso de red al Hub**: VPN activa si trabajás remoto. Verificá:
  ```bash
  curl -sf -m 5 https://hub.integra.local/api/v1/health && echo "Hub OK"
  ```
- **Windows**: Git Bash o WSL. **PowerShell/CMD NO funcionan** para `setup.sh`.

### Paso 1 — Clonar el starter

```bash
git clone https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git mi-proyecto
cd mi-proyecto
```

**Expected output**:

```
Cloning into 'mi-proyecto'...
remote: Enumerating objects: ...
Resolving deltas: 100% (xxx/xxx), done.
```

**Troubleshooting**:

- `Permission denied (publickey)`: usá HTTPS clone URL, no SSH.
- `repository not found`: confirmá que tu email tiene acceso al repo (Integra Software te lo otorga).

### Paso 2 — Setup automático

```bash
chmod +x setup.sh
./setup.sh
```

**Expected output**:

```
[specoe-setup] Verificando prerrequisitos...
[specoe-setup] OK Node v20.x.x
[specoe-setup] OK Claude Code instalado
[specoe-setup] Instalando bundle .claude/ en ~/.claude/
[specoe-setup] [INSTALL] hooks/specoe-license-check.mjs
[specoe-setup] [INSTALL] hooks/integra-hub-auth.mjs
...
[specoe-setup] OK setup completado
```

**Troubleshooting**:

- `setup.sh: command not found`: estás en PowerShell/CMD en Windows. Cambiar a Git Bash o WSL.
- `[ERROR] Node version too old`: instalar Node 20+ con nvm.
- `[ERROR] Claude Code not found in PATH`: instalar desde https://claude.ai/code y reabrir terminal.

### Paso 3 — Configurar `project.config.yaml`

```bash
nano project.config.yaml   # o code, vim, gedit, micro
```

Completar 4 campos obligatorios:

```yaml
project:
  name: 'Mi Proyecto ERP'
  vendor: 'Mi Empresa SA'

database:
  logical-name: 'midb'

pasoe:
  instance-name: 'midb-mainpasoe'
```

Referencia completa: [CONFIGURATION.md](CONFIGURATION.md).

### Paso 4 — Credenciales del Hub

Integra Software te entregó: **email**, **password inicial**, **license JWT**, **URL del Hub**. Migrarlas al keyring del SO:

```bash
cat > ~/.claude/integra-hub.env <<EOF
INTEGRA_HUB_EMAIL=<tu-email>
INTEGRA_HUB_PASSWORD=<tu-password-inicial>
INTEGRA_HUB_URL=https://hub.integra.local/api/v1
EOF

node ~/.claude/scripts/migrate-hub-credentials.mjs
```

**Expected output**:

```
[migrate] Reading ~/.claude/integra-hub.env
[migrate] Storing in OS keyring (Windows Credential Manager / macOS Keychain / Linux Secret Service)
[migrate] OK email + password + url stored
[migrate] Renamed .env -> .env.migrated-<timestamp>
```

**Troubleshooting**:

- Linux headless sin D-Bus: el script usa cipher file `~/.claude/integra-hub.enc` (AES-256-GCM derivado de machine-id). OK si ves `[fallback] using cipher file`.
- `keyring access denied` en macOS: en System Preferences → Security & Privacy autorizar Claude Code.
- Detalle completo: [TROUBLESHOOTING.md](TROUBLESHOOTING.md#credenciales-del-hub-keyring).

### Paso 5 — Validar setup (smoke-test)

```bash
chmod +x scripts/smoke-test.sh
./scripts/smoke-test.sh --live --jwt <TU-LICENSE-JWT>
```

**Expected output**:

```
== smoke-test del starter -- LIVE -- tier=suite ==

[1/5] Prerrequisitos de ambiente
  [PASS] Node v20.x.x
  [PASS] Docker x.x.x (opcional ...)
  [PASS] Claude Code (...)
  [PASS] openssl disponible

[2/5] Archivos del starter
  [PASS] project.config.yaml
  [PASS] setup.sh
  [PASS] docker/Dockerfile.pasoe (build CI/CD)
  [PASS] .claude/ existe
  [PASS] .claude/skills/openedge-abl/SKILL.md

[3/5] Validacion de project.config.yaml
  [PASS] specoe-validate paso (schema Zod OK)

[4/5] Credenciales y MCP config
  [PASS] .mcp.json presente
  [PASS] Credenciales del Hub en keyring (hint file presente)

[5/5] Live checks (conectividad)
  [PASS] Hub responde 2xx en https://hub.integra.local/api/v1/health
  [PASS] JWT formato valido (3 segmentos)
  [PASS] JWT validado contra Hub

==================================================
  Total: 13 checks -- PASS: 13 | FAIL: 0 | SKIP: 0
==================================================
  RESULTADO: PASS
```

**Troubleshooting**:

- `[FAIL] Hub healthz`: VPN inactiva o `hub.integra.local` no resuelve. Verificá conectividad: `curl -v https://hub.integra.local/api/v1/health`.
- `[FAIL] JWT validacion`: token expirado o `LICENSE_JWT_SECRET` no matcha. Pedí JWT nuevo a Integra Software.
- Detalle: [TROUBLESHOOTING.md](TROUBLESHOOTING.md#conectividad-al-hub-saas).

### Paso 6 — Validar contenido IP (post-Item 3)

Pre-requisito: el operador Integra cargó contenido IP al MCP Skill Server productivo (F7 Item 3 DONE).

```bash
chmod +x scripts/validate-content.sh
./scripts/validate-content.sh --jwt <TU-LICENSE-JWT>
```

**Expected output (PARTIAL)**:

```
== validate-content -- MCP Skill Server checks contra https://mcp.integra.local/sse ==

[1/5] Server reachable (healthz)
  [PASS] Healthz responde 200 en https://mcp.integra.local/healthz

[2/5] JWT formato y presencia
  [PASS] JWT formato valido (3 segmentos HS256 separados por punto)

[3/5] SSE endpoint reachable con JWT
  [PASS] SSE responde con eventos (initial server event recibido)

[4/5] Validacion contenido IP via Claude Code (manual)
  [SKIP] requiere Claude Code para test E2E
  (instrucciones de comandos mcp__specoe__* listadas en output)

[5/5] Tier check via license JWT (manual)
  [SKIP] decode del JWT requiere base64 + jq

==================================================
  Total: 5 checks -- PASS: 3 | FAIL: 0 | SKIP: 2 (manual)
==================================================
  RESULTADO: PARTIAL (3/3 automated PASS, 2 requieren validacion manual via Claude Code)
```

El script automatiza la verificación de **conectividad + auth** (3/3 PASS automáticos). La validación del **contenido IP real** (Paso 4) requiere ejecutar comandos MCP desde Claude Code — el script lista los comandos exactos en el output. Replicar manualmente:

- `mcp__specoe__skill_get_content('integra-pasoe')` → SKILL.md (~3000+ chars, contiene "## Cuando activar" + "## Copyright header obligatorio").
- `mcp__specoe__skill_get_content('integra-pasoe', section='cls-template')` → template ABL `.cls` (contiene `/* Copyright 2026`).
- `mcp__specoe__skill_get_content('integra-pasoe', section='i-template')` → template ABL `.i`.
- `mcp__specoe__command_get_content('nueva-entidad')` → markdown command (tier TEAM o superior).
- `mcp__specoe__agent_get_content('abl-developer')` → markdown agent.

**Troubleshooting**:

- `[FAIL] Healthz`: VPN inactiva o URL incorrecta. Test: `curl -v https://mcp.integra.local/healthz`.
- `[FAIL] SSE connect`: token expirado o `LICENSE_JWT_SECRET` no matcha. Pedir JWT nuevo a Integra.
- En Claude Code, `mcp__specoe__skill_get_content('integra-pasoe')` retorna error o vacío: contenido IP aún no cargado al server productivo (Item 3 INBOX). Reportá al operador. Workaround: [dev-mode test fixtures](#dev-mode-test-fixtures).
- `command_get_content('nueva-entidad')` rechazado: tier `solo` no incluye commands productivos. Verificar tier en license JWT.

### Paso 7 — Iniciar Claude Code y generar primera entidad

```bash
claude
```

**SessionStart hook** valida la licencia:

```
[license] OK -- tier: team
[license] features: skill_get_content, command_get_content, agent_get_content
```

Generar entidad desde PDF de spec:

```
/nueva-entidad ~/specs/Provincias.pdf
```

Output esperado: 3 archivos generados (`Provincias.cls`, `Provincias.i`, `TestProvincias.cls`) con header copyright SpecOE (incluye `Source: <HUB_REF>` si la skill recibió contexto).

**Troubleshooting**:

- `[license] FAIL — license expired`: pedí JWT renovado a Integra.
- `[license] FAIL — invalid signature`: el JWT no fue firmado con el secret correcto. Reportar al operador.
- `/nueva-entidad: command not found`: skill server no expuso commands. Volver al Paso 6 validate-content.

---

## Dev-mode test fixtures

Si Items 3+4 (contenido IP cargado + Docker images publicadas) aún no DONE, o querés probar el flow **sin license JWT real**, podés correr el skill server localmente en `--dev-mode` con el tenant fake `integra-piloto-test` (fixture incluida en el monorepo).

### Setup local automatizado

El starter incluye el script helper `start-skill-server-dev-mode.sh` que automatiza el setup:

```bash
# Pre-requisito: clonar el monorepo specoe-platform (acceso interno Integra)
git clone https://github.com/IntegraSoftwareERP/specoe-platform.git ../specoe-platform

# Levantar skill server local en dev-mode con tenant fake
./scripts/start-skill-server-dev-mode.sh
```

El script:

1. Detecta el path al `skill-server` (busca en `../specoe-platform/packages/skill-server` por default; pasar `--skill-server <path>` para override).
2. Verifica que la tenant fixture `integra-piloto-test` existe (debe estar bajo `src/content-source/tenants/`).
3. Imprime las instrucciones exactas para configurar el starter cliente.
4. Arranca el server con `LICENSE_JWT_SECRET=dev-mode-secret-not-for-prod` + binding `127.0.0.1:3100` (Ctrl+C para detener).

### Configurar starter cliente para usar dev-mode

Seguir las instrucciones que imprime el script helper:

1. Editar `project.config.yaml` del starter:

   ```yaml
   hub:
     api-url: http://127.0.0.1:3100
   ```

2. Crear `~/.claude/integra-hub.env` con token fake (≥10 chars):

   ```bash
   cat > ~/.claude/integra-hub.env <<'EOF'
   INTEGRA_HUB_URL=http://127.0.0.1:3100
   INTEGRA_HUB_EMAIL=dev@integra-piloto-test.local
   INTEGRA_HUB_PASSWORD=dev-fake-token-1234567890
   EOF

   node ~/.claude/scripts/migrate-hub-credentials.mjs
   ```

3. Validar con:
   ```bash
   ./scripts/validate-content.sh --dev-mode --jwt dev-fake-token-1234567890
   ```

### Tenant fixture `integra-piloto-test`

Path: `packages/skill-server/src/content-source/tenants/integra-piloto-test/project.config.yaml`.

Incluye datos de ejemplo claramente identificados como **fixture dev-mode** (e.g. `project.name: 'Cliente Piloto TEST (dev-mode fixture)'`). NO confundir con tenant productivo real.

### Limitaciones del dev-mode (NO sustituye validación productiva)

- Cualquier token ≥10 chars es aceptado — sin validación criptográfica.
- `tenantId` hardcoded a `integra-default` en el `auth.ts` (no se deriva del token); el contenido se sirve desde el tenant config que matche.
- `tier` hardcoded a `dev` con `features: ['*']` — todas las herramientas accesibles sin tier check.
- Server bindeado a `127.0.0.1` obligatorio + guard hard-fail si `NODE_ENV=production`.
- **NO sustituye la validación E2E productiva** que F7 Item 6 (Sebastian onboarding) cubre con JWT real + fingerprint de cliente externo. Decisión B10 closeout (`cmoejhq0p0167mln5b1bnbgn4`) deliberada: _"el JWT real requiere fingerprint de cliente externo, mas significativo validarlo en el flujo real del piloto que sintetizar uno aqui"_. Smoke 2/2 (`tools/list` con JWT real) diferido a Item 6.

---

## Verificación end-to-end (checklist)

Si los siguientes items pasan, **onboarding LISTO**:

- [ ] Pre-requisitos verificados (Node 20+, Claude Code, VPN activa).
- [ ] `setup.sh` ejecutado sin errores.
- [ ] `project.config.yaml` configurado con 4 campos obligatorios.
- [ ] Credenciales en keyring del SO (`~/.claude/integra-hub-account.json` hint file presente).
- [ ] `smoke-test.sh --live --jwt <token>` retorna **PASS** (13/13 checks).
- [ ] `validate-content.sh --jwt <token>` retorna **PASS** (7/7 checks).
- [ ] `claude` arranca sin errores en SessionStart hook.
- [ ] `/nueva-entidad` genera 3 archivos esperados con copyright header SpecOE.

Si algún item falla, ir a [TROUBLESHOOTING.md](TROUBLESHOOTING.md) y reportar al operador Integra con output literal del error.

---

## Tiempo estimado total

| Paso                        | Tiempo         |
| --------------------------- | -------------- |
| Pre-requisitos verificados  | ~3 min         |
| 1. Clonar starter           | ~1 min         |
| 2. setup.sh                 | ~3 min         |
| 3. project.config.yaml      | ~3 min         |
| 4. Credenciales + keyring   | ~3 min         |
| 5. smoke-test --live        | ~1 min         |
| 6. validate-content         | ~1 min         |
| 7. Claude + primera entidad | ~3 min         |
| **Total**                   | **~15-18 min** |

Si tardaste más de 20 min, registrar en feedback al operador Integra.

---

## Reportar feedback

Post-onboarding, reportar a Integra Software:

- Bloqueos encontrados (con paso + comando + output literal).
- Tiempos por paso (vs estimación).
- Sugerencias de mejora del runbook.

Email: `soporte@integrasoftware.biz` con asunto `[piloto-onboarding-feedback] <tu-email>`.

---

## Referencias

- [QUICKSTART.md](QUICKSTART.md) — versión resumida del onboarding.
- [CONFIGURATION.md](CONFIGURATION.md) — referencia completa `project.config.yaml`.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — escenarios típicos + recovery.
- SPEC-0001 F7 (Hub) — phase plan + criterios de aceptación.
- SPEC-0029 F7/F9 (Hub) — copyright header + Hub Reference Header (forensic stable).
