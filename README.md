# specoe-openedge-starter

**SpecOE AI Dev Accelerator** — starter template para equipos OpenEdge/Progress que quieren arrancar con Claude Code + skills + commands + agents conectados al **Hub SaaS de Integra Software**.

## Modelo de deploy

### SaaS (default)

Hub y Skill Server estan centralizados en el servidor gestionado por Integra Software. El cliente solo necesita:

- Git (Git for Windows incluye **Git Bash**)
- Node.js del rango certificado: **22.19.0 a 26.x, con Node 23 afuera** (probado hasta 26.5.0)
- **VSCode + extensión Claude Code** (Anthropic)
- Licencia SpecOE (o trial)

**Sin Docker en el cliente. Sin infra a levantar localmente.**

### Suite on-premise (premium)

Para clientes que requieren correr Hub + Skill Server en su propia infraestructura (compliance, red aislada, personalizacion profunda). Incluye `docker-compose` + documentacion de deploy como entregable separado del tier.

Contactar a Integra Software: `soporte@integrasoftware.biz`

## Quickstart (SaaS)

Flujo **VSCode / thin-client**: instalás el host una vez por máquina, un room por rol y
abrís cada room en VSCode. Todos los comandos van en **Git Bash** (en Windows, no PowerShell/CMD).

> **Dos carpetas distintas, no confundirlas.** Los comandos de instalación de acá abajo
> (`specoe-setup-host.sh`, `specoe-room-*.sh`, `install-specoe.sh`) se corren en la **carpeta
> del starter** — la que clonás en el paso 1. La **carpeta del room** que crea el paso 3 lleva
> solo lo que el room usa para operar y para re-provisionarse (`setup.sh`, `specoe-add-room.sh`,
> `specoe-launch-thinclient.sh`, `specoe-gate-messages.sh`, `specoe-verify-room.sh`,
> `project.config.yaml`, `.claude/`, `README.md`, `VERSION`, `docs/QUICKSTART-VSCODE.md`):
> el instalador de máquina y el bundle de hooks **no** están adentro del room a propósito
> (SPEC-0167). Si estás parado en un room y necesitás el setup del host, volvé a la carpeta
> del starter (o clonalo de nuevo) — no lo busques en la carpeta del room.

```bash
# 1. Bajar el starter
git clone https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git
cd specoe-openedge-starter

# 2. Host — una sola vez por máquina (salta una elevación UAC, aceptala)
./specoe-setup-host.sh

# 3. Room — uno por rol, con tu license key del rol
./specoe-room-ccdev.sh <TU-KEY>
# también: specoe-room-discovery.sh · specoe-room-engineering.sh · specoe-room-adversarial.sh

# 4. Abrir el room en VSCode
code cc-dev-room
```

Con la carpeta abierta, la extensión **Claude Code** arranca la sesión: el SessionStart hook
valida tu licencia, activa el seat y puebla el JWT del skill-server. Verificá que quedó servido:
`/mcp` → `specoe` **connected** + `.mcp.json` con un **JWT** real (no `${SPECOE_SKILL_JWT}`).

Detalle completo paso-a-paso: [docs/QUICKSTART-VSCODE.md](docs/QUICKSTART-VSCODE.md).

## Quién hace cada paso

Esta tabla es el inventario completo de pasos operativos del thin-client con su **dueño ejecutable**.
Sirve para dos cosas: saber a qué herramienta ir cuando algo falta, y ver de un vistazo qué quedó
irreducible y por qué. Ningún paso queda sin dueño.

Los dueños posibles son cuatro:

- **PLUGIN** — se ejecuta desde el plugin VSCode Integra Hub.
- **INSTALADOR_MAQUINA** — lo hace `specoe-setup-host.sh`, una vez por máquina.
- **IRREDUCIBLE_UAC** — paso elevado dentro del instalador de máquina. **No puede vivir en el
  plugin**: una extensión de VSCode no escala privilegios de administrador. Son exactamente dos, y
  están en la tabla con esa restricción nombrada.
- **CLI_PRESERVADO** — equivalente por scripts, que se mantiene como camino soportado (máquinas
  solo-CLI, automatización).

| #   | Paso                                                             | Frecuencia                      | Dueño                                                                                                       |
| --- | ---------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Exportar `INTEGRA_SDD_ROLE` en cada arranque de room             | cada arranque                   | PLUGIN (env en `createTerminal`) + CLI_PRESERVADO (`specoe-launch-thinclient.sh`)                           |
| 2   | Exportar `INTEGRA_SDD_IDENTITY_MODE` en cada arranque            | cada arranque                   | PLUGIN + CLI_PRESERVADO (launcher); además persiste en `.mcp.json` como config estable del room             |
| 3   | Exportar el tenant de la sesión (`INTEGRA_ACT_AS_TENANT`)        | cada arranque                   | PLUGIN + CLI_PRESERVADO (launcher)                                                                          |
| 4   | Clonar/actualizar la carpeta del room (starter sparse)           | una vez por room                | PLUGIN (orquesta `specoe-add-room.sh`) + CLI_PRESERVADO                                                     |
| 5   | Fijar `specoe.role` (y `specoe.tenant`) en `project.config.yaml` | una vez por room                | PLUGIN (via script orquestado) + CLI_PRESERVADO                                                             |
| 6   | Guardar la licencia del rol en el keyring                        | una vez por room                | PLUGIN (via script orquestado; claves tenant-scoped) + CLI_PRESERVADO                                       |
| 7   | Generar el `.mcp.json` del room                                  | una vez por room                | PLUGIN (via `setup.sh --room-only` orquestado; sin rol hardcodeado) + CLI_PRESERVADO                        |
| 8   | Escribir `integraHub.baseUrl` en settings del room               | una vez por room                | PLUGIN (via script orquestado) + CLI_PRESERVADO                                                             |
| 9   | Registrar el room en el roster del plugin                        | una vez por room                | PLUGIN — **paso ELIMINADO por autodetección**: la carpeta es el roster                                      |
| 10  | Verificar la identidad SDD / el room servido                     | una vez por room (y ante dudas) | PLUGIN (muestra el resultado) + CLI_PRESERVADO (`specoe-verify-room.sh`)                                    |
| 11  | Preflight de prerequisitos (Node, Claude Code, Git)              | una vez por máquina             | INSTALADOR_MAQUINA                                                                                          |
| 12  | Instalar el bundle de hooks + `npm install`                      | una vez por máquina             | INSTALADOR_MAQUINA                                                                                          |
| 13  | Copiar el CA a `~/.claude` (canal de los hooks)                  | una vez por máquina             | INSTALADOR_MAQUINA                                                                                          |
| 14  | Verificación del canal del host (ping + fetch con CA)            | una vez por máquina             | INSTALADOR_MAQUINA                                                                                          |
| 15  | Login SDD (una credencial, una identidad)                        | una vez por máquina y tenant    | PLUGIN (login unificado, «Integra Hub: Login») + CLI_PRESERVADO (`setup.sh --login` / paso 7 del host-flow) |
| 16  | Instalar el `.vsix` del plugin                                   | una vez por máquina             | INSTALADOR_MAQUINA — **bootstrap**: el plugin no puede instalarse a sí mismo                                |
| 17  | Entradas en `hosts` (`hub`/`mcp.integra.local`)                  | una vez por máquina             | **IRREDUCIBLE_UAC** — dentro del instalador de máquina; **una extensión no escala privilegios**             |
| 18  | CA de Caddy al trust del sistema                                 | una vez por máquina             | **IRREDUCIBLE_UAC** — ídem: escribir en el trust del sistema exige elevación, y una extensión no la tiene   |

> Los pasos 1–10 son por-room o por-arranque y los cubre el plugin (con su equivalente CLI siempre
> disponible). Los 11–18 son por-máquina y los cubre `specoe-setup-host.sh` en **una sola corrida**.
> Los únicos dos que no pueden mudarse al plugin son el 17 y el 18, y es por la elevación.

<!-- Esta tabla está publicada DOS veces a propósito (README.md y docs/QUICKSTART-VSCODE.md).
     Si cambia el modelo de dueños, se actualizan las dos. -->

## Estructura

```
specoe-openedge-starter/
├── project.config.yaml         Configuracion principal — editar valores del cliente
├── specoe-setup-host.sh        Thin-client: setup del host (1 vez/máquina — hosts, CA, bundle)
├── specoe-room-ccdev.sh        Thin-client: crea el room CC-Dev (uno por rol)
├── specoe-room-discovery.sh    Thin-client: crea el room Discovery
├── specoe-room-engineering.sh  Thin-client: crea el room Engineering
├── specoe-room-adversarial.sh  Thin-client: crea el room Adversarial
├── specoe-add-room.sh          Thin-client: núcleo común de room (los specoe-room-*.sh lo envuelven)
├── install-specoe.sh           Thin-client: atajo all-in-one host + 1 room (1 rol/máquina)
├── setup.sh                    Installer clásico (uso interno de terminal)
├── .claude/
│   ├── settings.json         Hooks pre-configurados (SessionStart: license check + rol + room bootstrap)
│   ├── CLAUDE.md             Instrucciones parametrizadas por project.config.yaml
│   ├── skills/
│   │   ├── openedge-abl/     Skill LIBRE — referencia ABL general
│   │   └── integra-pasoe/    Skill PROTEGIDO (stub) — consulta MCP Skill Server
│   ├── commands/             Commands SDD (stubs protegidos)
│   ├── agents/               Agentes especializados (stubs protegidos)
│   └── standards/            Estandares de arquitectura (stubs protegidos)
├── docker/
│   ├── Dockerfile.pasoe      Pipeline CI/CD PASOE (build de la app del cliente)
│   └── gradle/build.gradle   Gradle para el build PASOE
├── docs/
│   └── QUICKSTART-VSCODE.md   Guía de arranque VSCode / thin-client
└── examples/
    └── sample-entity/        Ejemplo funcional de entity
```

> **Nota**: el directorio `docker/` contiene **solamente** artefactos de build de PASOE del cliente. **No** incluye `docker-compose.yml` del Hub — el Hub es centralizado (SaaS) por default.

## Licencia

El flujo de activacion y gestion de seats lo maneja Integra Software; tu license key llega con el onboarding. Ante dudas, escribí a `soporte@integrasoftware.biz`.

Skills/commands/agents IP-criticos se sirven via **MCP Skill Server centralizado** (Integra Software). El skill `openedge-abl` (referencia ABL general) esta incluido completo en el starter como skill publico.

## Contributing — este repo NO acepta PRs externos

Este repo (`specoe-openedge-starter`) es un **mirror automatico** del contenido que vive en el monorepo privado `specoe-platform/packages/starter-template/` de Integra Software. Cada release corre un pipeline de sync que **reemplaza el contenido del repo publico** con el del upstream (preservando solo `.git/`).

**Consecuencia**: cualquier PR mergeado directamente aca **se pierde en el proximo sync**. Por eso no aceptamos PRs externos.

### ¿Queres contribuir?

- **Bug report o feature request** → abri un issue en este repo. Lo trasladamos al upstream y se trackea en Integra Hub.
- **Correccion de typo / docs fix** → issue con la sugerencia; lo aplicamos en upstream.
- **Cambios grandes o codigo** → contactar a `soporte@integrasoftware.biz`. Contribuciones significativas requieren NDA por el modelo IP de SpecOE.

### ¿Por que este modelo?

- Canonical source es privado (`specoe-platform`). El starter publico es la parte compartida libremente (MIT).
- Sync unidireccional simplifica el pipeline y evita divergencia entre publico y upstream.
- Otras partes del producto (Skill Server, Hub, Agent Gateway) son proprietary y no viven aca.

## Soporte

- Integra Software: `soporte@integrasoftware.biz`
- Tier Suite on-premise: `soporte@integrasoftware.biz` con asunto "Suite on-premise"
- Documentacion: https://specoe.integra.local (TODO)
