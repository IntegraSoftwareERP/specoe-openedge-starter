# Quickstart

Objetivo: de repo vacio a **primera entidad generada en < 20 minutos**.

Este quickstart documenta el flujo **SaaS** (default) — Hub y Skill Server centralizados en Integra Software. Si tu organizacion contrato la Suite on-premise, ver [Suite on-premise](#suite-on-premise) al final.

## Criterio de éxito del piloto

> Este onboarding es exitoso si vas de `git clone` a tu primera entidad ABL generada en menos de 30 minutos sin necesidad de abrir TROUBLESHOOTING.md ni contactar soporte. Si abrís TROUBLESHOOTING durante el setup, registralo en el feedback al final.

## Prerrequisitos (verificacion rapida)

- **Node.js 20+** — `node --version`
- **Git** — `git --version`
- **Claude Code** — `claude --version` (instalar desde https://claude.ai/code)
- **OpenEdge 12.x** — para correr PASOE local en el cliente (build de tu app)
- **Licencia SpecOE** (o trial — se gestiona con Integra Software)

> **No se requiere Docker en el cliente** para el tier SaaS. El Hub es remoto.

---

## Paso 0 — Setup inicial (~3 min)

`setup.sh` (o `setup.ps1` en Windows) instala automaticamente las herramientas necesarias en `~/.claude/` (hooks de auth/license + script de migracion). El instalador es **idempotente** — no pisa archivos existentes, reporta cada uno como `[INSTALL]` o `[SKIP]`.

> **Pre-condicion**: tenes que haber clonado el starter primero (Paso 1). Si todavia no lo hiciste, salta a Paso 1 y volve aca.

```bash
./setup.sh                 # Linux/Mac/GitBash
.\setup.ps1                # Windows PowerShell
```

Eso:

1. Copia hooks (`credentials.mjs`, `integra-hub-auth.mjs`, `specoe-license-check.mjs`) a `~/.claude/hooks/`
2. Copia el script `migrate-hub-credentials.mjs` a `~/.claude/scripts/`
3. Instala dependencias del keyring (`@napi-rs/keyring`, `node-machine-id`) si no estan ya instaladas

### Si tenes credenciales `.env` legacy

Si venis de una version anterior con `~/.claude/integra-hub.env` en texto plano, migralas al keyring del SO:

```bash
node ~/.claude/scripts/migrate-hub-credentials.mjs
```

El script renombra el `.env` a `.env.migrated-<timestamp>` si OK. Si no tenes `.env` legacy (primer onboarding), saltea este sub-paso — `setup.sh` ya dejo el flow listo.

> **Nota**: este Paso 0 lo haces **una sola vez por maquina**. Si ya corriste `setup.sh` antes en otro proyecto del starter, todos los archivos se reportan como `[SKIP]` y este paso es practicamente instantaneo. Si algo falla, ver [TROUBLESHOOTING.md](TROUBLESHOOTING.md#credenciales-del-hub-keyring).

---

## Paso 1 — Clonar y configurar (~5 min)

```bash
git clone https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git mi-proyecto
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

## Generación de entidad

### Flow recomendado: desde SPEC en Hub (post-MVP)

El flow completo SDD arranca desde una SPEC en el Hub:

```
/propose: quiero exponer la entidad Bancos, debe permitir CRUD con validaciones X, Y, Z
/design: [Claude propone arquitectura]
/implement: [Claude genera entidad]
```

\*Este flow estará disponible en una versión próxima. Mientras tanto, usá el flow PDF.\*

### Flow actual: desde PDF de spec

```
/nueva-entidad <ruta-a-tu-spec.pdf>
```

> **Nota**: el starter no incluye un PDF de spec listo para usar (`examples/sample-entity/` solo contiene un `README.md` documentando el formato). Para el piloto, usa una spec real del cliente o un PDF de prueba que tengas a mano. El comando acepta path absoluto o relativo a la raiz del proyecto. Ejemplo: `/nueva-entidad C:\Specs\Provincias.pdf`.

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
| 0. Setup inicial (solo primera vez por maquina)    | ~3 min      |
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

Si tu organizacion requiere correr Hub y Skill Server en su propia infraestructura (compliance, red aislada, personalizacion profunda), tenemos disponible el **tier Suite on-premise** como entregable separado del starter, con licencia premium.

Contactar a Integra Software: `soporte@integrasoftware.biz` con asunto **"Suite on-premise"** para coordinar.

---

## Siguientes pasos

- [CONFIGURATION.md](CONFIGURATION.md) — referencia completa de `project.config.yaml`
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — problemas comunes y recuperacion
- `examples/sample-entity/` — ejemplo completo de entidad generada

---

_Versión: 0.1.0 — 2026-04_
