# Quickstart

Objetivo: de repo vacio a **primera entidad generada en menos de 30 minutos**.

Este quickstart documenta el flujo del **piloto interno** (Hub corriendo en `hub.integra.local`, accesible via VPN de Integra). Si tu organizacion contrato la Suite on-premise, ver [Suite on-premise](#suite-on-premise) al final.

## Criterio de exito

> Este onboarding es exitoso si vas de `git clone` a tu primera entidad ABL generada en menos de 30 minutos sin necesidad de abrir TROUBLESHOOTING.md ni contactar soporte. Si abris TROUBLESHOOTING durante el setup, registralo en el feedback al final.

---

## Pre-requisitos

Antes de empezar necesitas:

- **Node 20+** instalado (verificar con `node --version`)
  - Si no tenes, usa `nvm`:
    ```bash
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
    nvm install 20 && nvm use 20
    ```
  - **NO usar `apt install nodejs`** — instala una version muy vieja en muchas distros.

- **Claude Code** instalado y arrancado al menos una vez.
  - Descargar desde https://claude.ai/code
  - Despues de instalar, arrancalo una vez (`claude --help`) para que cree `~/.claude/`. Si nunca lo arrancaste, este directorio no existe y los pasos siguientes no funcionan.

- **Git**, **openssl**, **npm** — vienen pre-instalados en la mayoria de los SO. Si te faltan, instalar con tu package manager.

- **OpenEdge 12.x** — para correr PASOE local con el build de tu app. Solo necesario para el step de generacion de entidad real (no para el setup).

- **Acceso a la red de Integra**:
  - VPN si trabajas remoto.
  - Credenciales del Hub (email + password inicial + license key) — provistas por Integra Software.

- **Windows**: necesitas un shell tipo Unix para ejecutar `setup.sh`. Tenes dos opciones:
  - **Git Bash** (recomendado): viene incluido en Git for Windows. Si ya tenes Git instalado, lo tenes. Busca "Git Bash" en el menu de inicio.
  - **WSL** (Windows Subsystem for Linux): si trabajas regularmente con herramientas Linux, esta es la mejor opcion. Instalacion: https://learn.microsoft.com/windows/wsl/install
  - **PowerShell o CMD NO funcionan** para el setup. Usa Git Bash o WSL.

> **No se requiere Docker en el cliente** para el piloto. El Hub vive en infraestructura de Integra.

---

## Paso 1 — Cloná el repo

```bash
git clone https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git mi-proyecto
cd mi-proyecto
```

---

## Paso 2 — Setup automático

```bash
chmod +x setup.sh   # el bit ejecutable se pierde en algunos clones
./setup.sh
```

> **Windows**: abrir Git Bash o WSL antes de correr esto (ver Pre-requisitos).

El script:

1. Verifica prerrequisitos (Node 20+, claude CLI).
2. Instala el bundle `.claude/` en tu `~/.claude/` (hooks de auth/license + script de migracion + dependencias del keyring). **Idempotente** — no pisa archivos existentes, reporta cada uno como `[INSTALL]` o `[SKIP]`.
3. Valida campos basicos de `project.config.yaml` (los reales se validan en Paso 5 con smoke-test).

> **Nota**: si ya corriste `setup.sh` antes en otro proyecto, los archivos del bundle aparecen como `[SKIP]` y el paso es practicamente instantaneo.

Si `setup.sh` falla, el mensaje `[specoe-setup]` te dice el campo o prereq faltante.

---

## Paso 3 — Configurar tu proyecto

Editar `project.config.yaml` con tu editor preferido:

```bash
nano project.config.yaml    # o vim, code, gedit, micro — usa el que tengas
```

Completa los 4 campos obligatorios siguiendo las instrucciones inline:

- `project.name`
- `project.vendor`
- `database.logical-name`
- `pasoe.instance-name`

Referencia completa de todos los campos en [CONFIGURATION.md](CONFIGURATION.md).

---

## Paso 4 — Credenciales del Hub

Integra Software te entrega: **email**, **password inicial**, **license key**. Con eso:

```bash
cat > ~/.claude/integra-hub.env <<EOF
INTEGRA_HUB_EMAIL=<tu-email-recibido>
INTEGRA_HUB_PASSWORD=<tu-password-inicial>
INTEGRA_HUB_URL=https://hub.integra.local/api/v1
EOF

node ~/.claude/scripts/migrate-hub-credentials.mjs
```

El script migra las credenciales del archivo `.env` al **keyring del SO** de forma segura (Windows Credential Manager / macOS Keychain / Linux Secret Service via `@napi-rs/keyring`). Si ves un mensaje OK, ya estan guardadas — el `.env` se renombra a `.env.migrated-<timestamp>` para evitar que quede en plaintext.

> **Politica de password**: si Integra Software te pide cambiar tu password (rotacion inicial o periodica), debe tener al menos **12 caracteres**, mezcla de **mayuscula**, **minuscula**, y al menos un **digito**.

Si la migracion falla, ver [TROUBLESHOOTING.md](TROUBLESHOOTING.md#credenciales-del-hub-keyring).

---

## Paso 5 — Validar el setup (smoke-test)

```bash
chmod +x scripts/smoke-test.sh   # si vino sin bit ejecutable
./scripts/smoke-test.sh --live
```

> **Windows**: ejecutar desde Git Bash o WSL (ver Pre-requisitos).

Output esperado: **RESULTADO: PASS** con `Hub responde 2xx en hub.integra.local/api/v1/health`.

Si tenes un token JWT de prueba, tambien validar licencia contra Hub:

```bash
./scripts/smoke-test.sh --live --jwt <TU-TOKEN>
```

Si el Hub no responde o el JWT no valida, ir a [TROUBLESHOOTING.md](TROUBLESHOOTING.md#conectividad-al-hub-saas).

---

## Paso 6 — Iniciar Claude Code y generar tu primera entidad

```bash
# Desde la raiz del proyecto
claude
```

Al iniciar, el **SessionStart hook** (`specoe-license-check.mjs`) valida tu licencia contra el Hub configurado:

- `[license] OK — tier: solo/team/enterprise` -> todo bien, skills cargados.
- `[license] FAIL — <razon>` -> ver [TROUBLESHOOTING.md](TROUBLESHOOTING.md#licencia-specoe).

### Generación de entidad

#### Flow recomendado: desde SPEC en Hub (post-MVP)

El flow completo SDD arranca desde una SPEC en el Hub:

```
/propose: quiero exponer la entidad Bancos, debe permitir CRUD con validaciones X, Y, Z
/design: [Claude propone arquitectura]
/implement: [Claude genera entidad]
```

\*Este flow estará disponible en una versión próxima. Mientras tanto, usá el flow PDF.\*

#### Flow actual: desde PDF de spec

```
/nueva-entidad <ruta-a-tu-spec.pdf>
```

> **Nota**: el starter no incluye un PDF de spec listo para usar (`examples/sample-entity/` solo contiene un `README.md` documentando el formato). Para el piloto, usa una spec real del cliente o un PDF de prueba que tengas a mano. El comando acepta path absoluto o relativo a la raiz del proyecto. Ejemplo: `/nueva-entidad ~/specs/Provincias.pdf`.

Claude va a:

1. Leer el PDF de especificacion.
2. Cargar el skill `integra-pasoe` desde el MCP Skill Server (bajo demanda).
3. Generar `Clases/Entitys/<Area>/<Nombre>.cls` + `.i` + test ABLUnit.
4. Correr las validaciones del framework Integra contra el output.

Output esperado: 3 archivos nuevos + `1-Operacion Exitosa` en los logs del hook Stop.

---

## Capacidades AI sobre legacy code (post-onboarding)

Una vez completado el setup, tres capacidades AI estan disponibles para devs con licencia tier **TEAM** o superior. Se invocan como commands desde Claude Code y aplican sobre archivos `.p`/`.cls`/`.i` o topics del codebase del cliente.

### `/code-archeology <path> [depth]` — analisis estructural

Lee un archivo legacy ABL Progress y produce documentacion estructurada en 4 secciones (technical / user / implementation / informal). Quality target 80% en archivos no calibrados.

```
/code-archeology AppServer/Clases/Entitys/Otros/Provincias.cls
/code-archeology Bussines/Path/file.p 1
```

Ideal para: entender QUE hace un modulo legacy sin leer el codigo entero. Output ~2500-5000 palabras con cita `archivo:lineas` en cada hallazgo.

### `/tribal-knowledge <path>` — captura del "por que"

Entrevista al dev senior sobre un modulo legacy (5-7 preguntas sobre patrones detectados) y persiste el conocimiento como KB articles estructurados en el Hub (kind, confidence, tags namespaced, sourceRefs JSON).

```
/tribal-knowledge Bussines/Sacpro/Tesoreria/Funciones/AnuloComprobanteTES.p
```

Pre-requisito: dev senior disponible para Q&A. Output: 5-7 KB articles con `confidence=INFERRED, status=DRAFT` (la promocion a `CONFIRMED, ACTIVE` es acto humano explicito post-sesion).

Ideal para: capturar conocimiento volatil del dev senior antes que se pierda. Onboarding compliance / audit.

### `/knowledge-accelerator <module-or-topic> [--mode=onboarding|brief] [--dev=<name>]` — 2 modos

Capacidad estrella V1 que orquesta `/code-archeology` + `/tribal-knowledge` + Hub multi-source aggregation, con dos personas:

- **`--mode=onboarding`** (default) — persona dev nuevo. Tutorial pedagogico con 5-10 hitos progresivos + checklist + glosario. Asume cero conocimiento previo.
- **`--mode=brief`** — persona dev senior. Reporte agregado tecnico denso de TODAS las fuentes Hub disponibles (KB + SPECs + Tickets + FuturePromises). Citations al Hub.

```
# Onboarding sobre modulo
/knowledge-accelerator Tesoreria --mode=onboarding --dev=Juan

# Brief sobre topic
/knowledge-accelerator "anulacion de comprobantes en Tesoreria" --mode=brief
```

Pre-requisitos cumplidos: las 3 capacidades estan productivas en el skill-server centralizado, integradas via MCP.

> Detalles operativos completos en los stubs locales `.claude/agents/<name>.md` y `.claude/commands/<name>.md`. El contenido completo (~400-500 lineas por agent) se sirve via MCP — no esta en el cliente, requiere licencia tier TEAM.

---

## Verificacion end-to-end

Checklist final (si todos los items pasan, **LISTO**):

- [ ] Keyring del SO tiene tus credenciales (en Windows: `Administrar credenciales` -> `integra-hub-claude-code`. En macOS: Keychain Access. En Linux: `secret-tool lookup`).
- [ ] `smoke-test --live` retorna PASS.
- [ ] Claude Code arranca sin errores en el SessionStart hook.
- [ ] `/nueva-entidad` genero los 3 archivos esperados sin errores.

Si algun item falla, ir a la seccion especifica de [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Tiempo total estimado

| Paso                                | Tiempo      |
| ----------------------------------- | ----------- |
| Pre-requisitos (verificar)          | ~2 min      |
| 1. Clonar el repo                   | ~1 min      |
| 2. Setup automatico                 | ~3 min      |
| 3. Configurar `project.config.yaml` | ~5 min      |
| 4. Credenciales del Hub             | ~3 min      |
| 5. Validar setup (smoke-test)       | ~2 min      |
| 6. Claude + primera entidad         | ~8 min      |
| Verificacion final                  | ~1 min      |
| **Total**                           | **~25 min** |

Si tardaste mas de 30, algo fallo. La causa mas comun es conectividad al Hub (DNS, firewall, VPN). [TROUBLESHOOTING.md](TROUBLESHOOTING.md#conectividad-al-hub-saas) cubre los escenarios tipicos.

---

## Offline

Si la red al MCP Skill Server falla:

- **Cache local de 24h** — los skills ya consultados siguen funcionando.
- **Tras 24h sin conexion**: solo el skill libre `openedge-abl` disponible. Los skills IP-criticos (`integra-pasoe`), commands productivos (`nueva-entidad`, `sdd-ticket`, `openedge-review`, `code-archeology`, `tribal-knowledge`, `knowledge-accelerator`) y agents (`abl-developer`, `react-developer`, `code-archeology`, `tribal-knowledge`, `knowledge-accelerator`) requieren conexion al MCP Skill Server.

---

## Suite on-premise

Si tu organizacion requiere correr Hub y Skill Server en su propia infraestructura (compliance, red aislada, personalizacion profunda), tenemos disponible el **tier Suite on-premise** como entregable separado del starter, con licencia premium.

Contactar a Integra Software: `soporte@integrasoftware.biz` con asunto **"Suite on-premise"** para coordinar.

---

## Onboarding cliente externo (piloto)

Si recibiste licencia trial como dev externo evaluando SpecOE, el flow detallado paso-a-paso vive en [RUNBOOK-ONBOARDING-CLIENTE-EXTERNO.md](RUNBOOK-ONBOARDING-CLIENTE-EXTERNO.md). El runbook expande este Quickstart con:

- **Pre-onboarding (lado Integra)**: provisioning del tenant en Hub backend + emisión de license JWT firmado con `LICENSE_JWT_SECRET` antes de entregar credenciales.
- **Validación de contenido IP** (`validate-content.sh`) — confirma que los skills/commands/agents del Skill Server productivo (`https://mcp.integra.local/sse`) son accesibles via `skill_get_content("integra-pasoe")` y otros canales esperados (post-Item 3 de F7).
- **Dev-mode fallback con tenant fake** — si el contenido IP aún no fue cargado al server productivo, levantar el skill server localmente en `--dev-mode` con tenant fake (`integra-piloto-test`) para QA del flow sin license JWT real. **NO sustituye** la validación E2E productiva (smoke 2/2 con JWT real está diferido a F7 Item 6 Sebastian onboarding por decisión B10 closeout).
- **Troubleshooting específico cliente externo** — VPN, JWT expirado, contenido IP no cargado, dev-mode fallback.
- **Checklist verificación end-to-end** + tiempo estimado por paso (~15-18 min total) + reporte feedback al operador.

Criterio onboarding éxito: `claude` arranca sin errores + `/nueva-entidad` genera 3 archivos con copyright header SpecOE en menos de 15 minutos sin contactar soporte.

---

## Siguientes pasos

- [CONFIGURATION.md](CONFIGURATION.md) — referencia completa de `project.config.yaml`
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — problemas comunes y recuperacion
- `examples/sample-entity/` — ejemplo completo de entidad generada

---

_Versión: 0.0.3 — 2026-04 (post-test-VM-limpia)_
