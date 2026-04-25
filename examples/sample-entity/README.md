# Sample entity

Ejemplo de entity generada siguiendo el patron Integra.

## Contenido

- `Client.cls` — entity class con herencia de `BaseEntityHandler`
- `Client.i` — include con definicion de temp-tables
- `test-Client.p` — test ABLUnit

## Como se genero

Con el command `/nueva-entidad`:

```
/nueva-entidad <ruta-a-tu-spec.pdf>
```

> **Nota**: el starter no incluye un PDF de spec real. El comando acepta path absoluto o relativo a la raiz del proyecto. Para el piloto, usa una spec del cliente o un PDF de prueba.

El command lee el PDF de especificacion, consulta el skill `integra-pasoe` via MCP, y genera los 3 archivos
aplicando las convenciones de `project.config.yaml`.

## Valores aplicados

| Placeholder                         | Valor al renderizar                    |
| ----------------------------------- | -------------------------------------- |
| `{{project.name}}`                  | Ver `project.config.yaml` del proyecto |
| `{{conventions.entity-prefix}}`     | Ver `project.config.yaml`              |
| `{{conventions.temp-table-prefix}}` | Ver `project.config.yaml`              |
| `{{paths.source-root}}`             | Ver `project.config.yaml`              |

> Nota: este README es scaffold. Los archivos reales `Client.cls`, `Client.i`, `test-Client.p`
> se agregaran cuando el MCP Skill Server tenga el skill `integra-pasoe` en produccion.
