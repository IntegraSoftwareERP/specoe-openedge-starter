# Quickstart

Objetivo: de repo vacio a **primera entidad generada en < 20 minutos**.

Este quickstart documenta el flujo **SaaS** (default) — Hub y Skill Server centralizados en Integra Software. Si tu organizacion contrato la Suite on-premise, ver [Suite on-premise](#suite-on-premise) al final.

## Prerrequisitos (verificacion rapida)

- **Node.js 20+** — `node --version`
- **Git** — `git --version`
- **Claude Code** — `claude --version` (instalar desde https://claude.ai/code)
- **OpenEdge 12.x** — para correr PASOE local en el cliente (build de tu app)
- **Licencia SpecOE** (o trial — se gestiona con Integra Software)

> **No se requiere Docker en el cliente** para el tier SaaS. El Hub es remoto.

---

## Paso 0 — Credenciales del Hub (~3 min)

El starter se conecta al **Hub SaaS de Integra Software** (`hub.integrasoftware.biz`) para validar licencia y servir skills via MCP. Las credenciales se almacenan en el **keyring del SO** (Windows Credential Manager / macOS Keychain / Linux Secret Service) — **nunca en texto plano**.

```bash
# 1. Crear archivo temporal con tus credenciales (provistas por Integra Software)
cat > ~/.claude/integra-hub.env <<EOF
INTEGRA_HUB_EMAIL=<tu-email>
INTEGRA_HUB_PASSWORD=<tu-password-inicial>
INTEGRA_HUB_URL=https://hub.integrasoftware.biz/api/v1
EOF

# 2. Migrar al keyring del SO (seguro)
node ~/.claude/scripts/migrate-hub-credentials.mjs

# 3. Verificar — el script renombra el .env a .env.migrated-<timestamp> si OK
ls ~/.claude/integra-hub.env*
```

> **Nota**: este paso lo haces **una sola vez por maquina**. Si ya migraste antes, salta al Paso 1. Si el paso 2 falla, ver [TROUBLESHOOTING.md](TROUBLESHOOTING.md#credenciales-del-hub-keyring).

---

## Paso 1 — Clonar y configurar (~5 min)

```bash
git clone <repo-url> mi-proyecto
cd mi-proyecto

# Editar project.config.yaml — minimo 4 campos obligatorios:
#   project.name, project.vendor, database.logical-name, pasoe.instance-name
$EDITOR project.config.yaml
```

Referencia completa de todos los campos: [CONFIGURATION.md](CONFIGURATION.md).

---

## Paso 2 — Setup (~2 min)

```bash
# Default: usa el hub.api-url del yaml (default: hub.integrasoftware.biz)
./setup.sh                 # Linux/Mac/GitBash
.\setup.ps1                # Windows PowerShell

# Opcional: apuntar a otro Hub (staging, otra instancia SaaS)
./setup.sh --hub https://hub.mi-org.com
.\setup.ps1 -Hub https://hub.mi-org.com
```

El script:

1. Verifica prerequisitos (Node 20+, claude CLI)
2. Actualiza `hub.api-url` en el yaml si pasaste `--hub`
3. Valida los 4 campos obligatorios de `project.config.yaml`
4. Detecta license key (del yaml o de `SPECOE_LICENSE_KEY` env var)
5. Prepara el directorio `.claude/` local

Si falla, el mensaje `[specoe-setup]` te indica el campo o prereq faltante.

---

## Paso 3 — Verificar conectividad al Hub (~2 min)

Correr el smoke test en modo `--live` para verificar que el Hub responde:

```bash
./scripts/smoke-test.sh --live                    # Linux/Mac/GitBash
.\scripts\smoke-test.ps1 -Live                    # Windows PowerShell
```

Output esperado: **RESULTADO: PASS** con `Hub responde 2xx en <api-url>/health`.

Si tenes un token JWT de prueba, tambien validar licencia contra Hub:

```bash
./scripts/smoke-test.sh --live --jwt <TU-TOKEN>
```

Si el Hub no responde o el JWT no valida, ir a [TROUBLESHOOTING.md](TROUBLESHOOTING.md#conectividad-al-hub-saas).

---

## Paso 4 — Iniciar Claude Code y primera entidad (~8 min)

```bash
# Desde la raiz del proyecto
claude
```

Al iniciar, el **SessionStart hook** (`specoe-license-check.mjs`) valida tu licencia contra el Hub configurado. Ves:

- `[license] OK — tier: solo/team/enterprise` → todo bien, skills cargados
- `[license] FAIL — <razon>` → ver [TROUBLESHOOTING.md](TROUBLESHOOTING.md#licencia-specoe)

### Generar tu primera entidad

```
/nueva-entidad examples/sample-entity/spec.pdf
```

Claude va a:

1. Leer el PDF de especificacion
2. Cargar el skill `integra-pasoe` desde el MCP Skill Server (bajo demanda)
3. Generar `Clases/Entitys/<Area>/<Nombre>.cls` + `.i` + test ABLUnit
4. Correr las validaciones del framework Integra contra el output

Output esperado: 3 archivos nuevos + `1-Operacion Exitosa` en los logs del hook Stop.

---

## Paso 5 — Verificacion end-to-end (~1 min)

Checklist final (si todos los items pasan, **LISTO**):

- [ ] Keyring del SO tiene tus credenciales (ver `Administrar credenciales` en Windows Control Panel → `integra-hub-claude-code`)
- [ ] `smoke-test --live` retorna PASS
- [ ] Claude Code arranca sin errores en el SessionStart hook
- [ ] `/nueva-entidad` genero los 3 archivos esperados sin errores

Si algun item falla, ir a la seccion especifica de [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Tiempo total estimado

| Paso                                               | Tiempo      |
| -------------------------------------------------- | ----------- |
| 0. Credenciales Hub (solo primera vez por maquina) | ~3 min      |
| 1. Clonar + config                                 | ~5 min      |
| 2. Setup                                           | ~2 min      |
| 3. Verificar Hub                                   | ~2 min      |
| 4. Claude + primera entidad                        | ~8 min      |
| 5. Verificacion final                              | ~1 min      |
| **Total**                                          | **~21 min** |

Si tardaste mas de 25, algo fallo. La causa mas comun en SaaS es conectividad al Hub (DNS, firewall, VPN). [TROUBLESHOOTING.md](TROUBLESHOOTING.md#conectividad-al-hub-saas) cubre los escenarios tipicos.

---

## Offline

Si la red al MCP Skill Server falla:

- **Cache local de 24h** — los skills ya consultados siguen funcionando.
- **Tras 24h sin conexion**: solo el skill libre `openedge-abl` disponible. Los skills IP-criticos (`integra-pasoe`, commands `nueva-entidad`/`sdd-ticket`/`openedge-review`, agents `abl-developer`/`react-developer`) requieren conexion.

---

## Suite on-premise

Si tu organizacion contrato el **tier Suite on-premise**, el flujo incluye:

- `docker-compose.yml` + `Caddyfile` + runbooks de deploy del Hub y Skill Server
- Certificados TLS (Let's Encrypt o internos)
- Gestion de secretos (`LICENSE_JWT_SECRET`, `INTEGRA_VAULT_KEY`, etc.)

El entregable se provee **separado de este starter** y requiere licencia premium. Contactar a Integra Software: `soporte@integrasoftware.biz` con asunto **"Suite on-premise"** para coordinar.

---

## Siguientes pasos

- [CONFIGURATION.md](CONFIGURATION.md) — referencia completa de `project.config.yaml`
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — problemas comunes y recuperacion
- `examples/sample-entity/` — ejemplo completo de entidad generada

---

_Ultima actualizacion: SPEC-0020 / fix/arch-hub-centralizado-only (Master Plan Integra HUB 2.0)_
