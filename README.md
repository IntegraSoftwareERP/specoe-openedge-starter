# specoe-openedge-starter

**SpecOE AI Dev Accelerator** — starter template para equipos OpenEdge/Progress que quieren arrancar con Claude Code + skills + commands + agents conectados al **Hub SaaS de Integra Software**.

## Modelo de deploy

### SaaS (default)

Hub y Skill Server estan centralizados en **integra-kvm** (`hub.integrasoftware.biz`) y son provistos por Integra Software. El cliente solo necesita:

- Git
- Node.js 20+
- Claude Code CLI
- Licencia SpecOE (o trial)

**Sin Docker en el cliente. Sin infra a levantar localmente.**

### Suite on-premise (premium)

Para clientes que requieren correr Hub + Skill Server en su propia infraestructura (compliance, red aislada, personalizacion profunda). Incluye `docker-compose` + documentacion de deploy como entregable separado del tier.

Contactar a Integra Software: `soporte@integrasoftware.biz`

## Quickstart (SaaS)

```bash
# 1. Clonar el starter como base del proyecto del cliente
git clone <repo-url> mi-proyecto
cd mi-proyecto

# 2. Editar project.config.yaml con los valores del cliente
$EDITOR project.config.yaml

# 3. Setup (opcionalmente override del Hub con --hub)
./setup.sh                                         # Linux/Mac/GitBash
.\setup.ps1                                        # Windows PowerShell
# o para apuntar a otro Hub:
./setup.sh --hub https://hub.mi-org.com

# 4. Iniciar Claude Code desde la raiz del proyecto
claude
```

El SessionStart hook activa la licencia automaticamente contra el Hub configurado.

Detalle completo paso-a-paso: [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Estructura

```
specoe-openedge-starter/
├── project.config.yaml       Configuracion principal — editar valores del cliente
├── setup.sh / setup.ps1      Installer multiplataforma (acepta --hub / -Hub)
├── .claude/
│   ├── settings.json         Hooks pre-configurados (SessionStart license check + Stop telemetry)
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
│   ├── QUICKSTART.md
│   ├── CONFIGURATION.md      Referencia completa de project.config.yaml
│   └── TROUBLESHOOTING.md
├── examples/
│   └── sample-entity/        Ejemplo funcional de entity
└── scripts/
    ├── release.sh            Semantic versioning + tag
    ├── changelog.sh          Regenera CHANGELOG.md desde commits
    ├── test-starter.sh       Validacion de estructura del template
    └── smoke-test.sh / .ps1  Verificacion end-to-end del ambiente
```

> **Nota**: el directorio `docker/` contiene **solamente** artefactos de build de PASOE del cliente. **No** incluye `docker-compose.yml` del Hub — el Hub es centralizado (SaaS) por default.

## Licencia

Ver [docs/CONFIGURATION.md](docs/CONFIGURATION.md) seccion "Licenciamiento" para el flujo de activacion y gestion de seats.

Skills/commands/agents IP-criticos se sirven via **MCP Skill Server centralizado** (Integra Software). El skill `openedge-abl` esta incluido completo en el starter (gancho publico).

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
