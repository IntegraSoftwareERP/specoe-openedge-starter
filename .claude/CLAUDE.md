# {{project.name}} — Claude Code instructions

Proyecto: **{{project.name}}** ({{project.vendor}})
Database: `{{database.logical-name}}` (broker port `{{database.broker-port}}`)
PASOE: `{{pasoe.instance-name}}` @ ABL v{{pasoe.oe-version}}, HTTPS dev en `{{pasoe.ports.dev-https}}`

## Workspace

```
{{paths.source-root}}      Codigo ABL (AppServer)
{{paths.data-root}}        Temp-tables + datasets
{{paths.test-root}}        ABLUnit tests
```

## Skills, commands, agents, standards

Los skills IP-protegidos (`integra-pasoe`, commands `sdd-ticket`/`nueva-entidad`/`openedge-review`, agents `abl-developer`/`react-developer`, standards) se cargan dinamicamente desde el MCP Skill Server de SpecOE. Los stubs locales en `.claude/` son solo descriptores — el contenido completo se consulta bajo demanda via `mcp__specoe__*_get_content(nombre)`.

El skill `openedge-abl` es libre (referencia ABL general) e incluido completo.

## Flujo

1. Abris Claude Code desde la raiz del proyecto.
2. SessionStart hook valida la licencia contra SpecOE Hub y setea el tier disponible.
3. Cada skill/command/agent invocado consulta al MCP Skill Server con la licencia del session context.
4. Stop hook registra telemetria de consumo en Hub.

## Convenciones client-side

- Entity prefix: `{{conventions.entity-prefix}}` (ej. `{{conventions.entity-prefix}}Client.cls`)
- Dataset prefix: `{{conventions.dataset-prefix}}`
- Temp-table prefix: `{{conventions.temp-table-prefix}}`

Los valores "locked" del framework SpecOE (naming de base classes, datasets, metodos de sesion, etc.) son Tier 3 del `project.config.yaml` — NO se listan aca por diseno. Viven server-side y el Skill Server los aplica cuando genera codigo.

## Areas de base de datos

Las areas custom del proyecto se definen en la seccion `areas:` de `project.config.yaml`. El MCP Skill Server las lee cuando genera codigo con `{area}` en paths.

## Links

- Hub API: {{hub.api-url}}
- Soporte: soporte@integrasoftware.biz
