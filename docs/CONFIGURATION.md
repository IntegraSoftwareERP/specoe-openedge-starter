# Configuration — `project.config.yaml`

Referencia completa del archivo `project.config.yaml` del starter. El schema oficial (fuente de verdad) es el Zod en `integra-hub/.../validator/src/schema.ts`.

## Validar tu config

```bash
npx specoe-validate project.config.yaml
```

El validator retorna:

- `OK: ... es valido` con resumen de campos clave, o
- `ERROR: ... tiene N problemas de validacion` con la lista de issues por path.

---

## Concepto de tiers

| Tier  | Nombre      | Que significa                                                                                                                                                      |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | Obligatorio | Campos que **deben** estar o la validacion falla. Son el minimo para generar codigo funcional.                                                                     |
| **2** | Recomendado | Campos opcionales con defaults razonables. Ajustables al gusto del equipo.                                                                                         |
| **3** | LOCKED (IP) | Valores literales del framework Integra. **Inmutables** — desviarlos rompe skills/commands/agents. El schema Zod usa `z.literal()` para rechazar cualquier cambio. |

---

## Root

### `schema-version` — **Tier 1**

| Tipo   | Regex             | Descripcion                                             |
| ------ | ----------------- | ------------------------------------------------------- |
| string | `^\d+\.\d+\.\d+$` | SemVer del schema con el que se valida (ej. `"0.1.0"`). |

---

## TIER 1 — Obligatorio

### `project`

| Campo      | Tipo   | Validacion            | Descripcion                                           |
| ---------- | ------ | --------------------- | ----------------------------------------------------- |
| `name`     | string | min 1 char            | Nombre comercial del proyecto (ej. `"MiCliente ERP"`) |
| `vendor`   | string | min 1 char            | Empresa cliente / razon social                        |
| `email`    | string | formato email         | Email de contacto del proyecto                        |
| `locale`   | string | `^[a-z]{2}-[A-Z]{2}$` | ICU locale (ej. `es-AR`, `en-US`, `pt-BR`)            |
| `currency` | string | exactly 3 chars       | ISO 4217 de 3 letras (`ARS`, `USD`, `EUR`)            |

### `paths`

| Campo               | Tipo                | Descripcion                                                    |
| ------------------- | ------------------- | -------------------------------------------------------------- |
| `workspace-root`    | string              | Path absoluto al workspace del cliente                         |
| `repos.webservices` | string              | Nombre de carpeta del repo de WebServices                      |
| `repos.data`        | string              | Nombre de carpeta del repo de tt/ds defs                       |
| `repos.tests`       | string              | Nombre de carpeta del repo de tests ABLUnit                    |
| `repos.framework`   | string _(opcional)_ | Repo de framework base                                         |
| `repos.business`    | string _(opcional)_ | Repo de logica de negocio extendida                            |
| `repos.common`      | string _(opcional)_ | Repo de utilidades compartidas                                 |
| `repos.helpers`     | string _(opcional)_ | Repo de helpers del cliente                                    |
| `source-root`       | string              | Raiz del codigo ABL dentro de Webservices (ej. `"AppServer/"`) |
| `data-root`         | string              | Raiz de tt/ds dentro de Integra.Data (ej. `"Data/"`)           |
| `test-root`         | string              | Raiz de tests dentro de Integra.Test (ej. `"tests/"`)          |

### `database`

| Campo                  | Tipo   | Validacion        | Descripcion                                                     |
| ---------------------- | ------ | ----------------- | --------------------------------------------------------------- |
| `logical-name`         | string | min 1             | Nombre logico de la DB Progress                                 |
| `broker-port`          | number | 1024-65535        | Puerto del broker                                               |
| `multi-tenant-field`   | string | min 1             | Nombre del campo tenant en todas las tablas (framework Integra) |
| `collation.cpinternal` | string | min 1             | Codepage interno                                                |
| `collation.cpstream`   | string | min 1             | Codepage de stream I/O                                          |
| `collation.cpcase`     | string | min 1             | Case table                                                      |
| `collation.cpcoll`     | string | min 1             | Collation table                                                 |
| `collation.numsep`     | number | 0-255             | ASCII code del separador de miles (ej. 46 = `.`)                |
| `collation.numdec`     | number | 0-255             | ASCII code del separador decimal (ej. 44 = `,`)                 |
| `env-user`             | string | UPPER_SNAKE regex | Nombre de la ENV var con el usuario DB (ej. `"DB_USER"`)        |
| `env-password`         | string | UPPER_SNAKE regex | Nombre de la ENV var con el password DB                         |

### `pasoe`

| Campo              | Tipo                | Validacion      | Descripcion                                                    |
| ------------------ | ------------------- | --------------- | -------------------------------------------------------------- |
| `oe-version`       | string              | `^\d+\.\d+$`    | OpenEdge major.minor (ej. `"12.8"`)                            |
| `instance-name`    | string              | min 1           | Instancia PASOE                                                |
| `working-dir`      | string              | min 1           | Working directory de PASOE                                     |
| `webapp`           | string              | min 1           | WebApp registrada en PASOE                                     |
| `rest-transport`   | string              | empieza con `/` | Path del REST transport (ej. `"/WebServices/rest/IntegraERP"`) |
| `ports.dev-http`   | number              | 1024-65535      | HTTP local dev                                                 |
| `ports.dev-https`  | number              | 1024-65535      | HTTPS local dev                                                |
| `ports.test-https` | number              | 1024-65535      | HTTPS entorno test                                             |
| `ports.prod-https` | number              | 1024-65535      | HTTPS produccion                                               |
| `openedge-home`    | string _(opcional)_ | —               | Path del install de OpenEdge                                   |
| `pasoe-home`       | string _(opcional)_ | —               | Path de PASOE servers                                          |

### `git`

| Campo                     | Tipo                | Validacion                 | Descripcion                                                                        |
| ------------------------- | ------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `main-branch`             | string              | min 1                      | Branch principal del repo                                                          |
| `feature-branch-template` | string              | contiene `{ticket-number}` | Template de nombres de branch (ej. `"feat/{ticket-number}-{slug}"`)                |
| `commit-style`            | enum                | `conventional` \| `custom` | Estilo de commits                                                                  |
| `repo-url-template`       | string _(opcional)_ | —                          | URL base del repo para generar links (ej. `"https://github.com/MiCliente/{repo}"`) |

---

## TIER 2 — Recomendado

### `conventions` _(opcional, con defaults)_

| Campo                       | Tipo    | Default                                  | Descripcion                                                                |
| --------------------------- | ------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `entity-prefix`             | string  | `""`                                     | Prefijo de clases entity (ej. `"E"` → `EClient.cls`)                       |
| `temp-table-prefix`         | string  | `"tt"`                                   | Prefijo de temp-tables locales (NO del framework)                          |
| `dataset-prefix`            | string  | `"ds"`                                   | Prefijo de datasets locales (NO del framework)                             |
| `include-path-template`     | string  | `"Data/Clases/Entitys/{area}/{class}.i"` | Template de path para includes generados                                   |
| `code-charset`              | enum    | `"ascii"`                                | `ascii` \| `utf-8`. El framework Integra usa ASCII por compatibilidad      |
| `field-names`               | enum    | `"full"`                                 | `full` \| `abbreviated`. Siempre `full` para mantener convenciones Integra |
| `table-name-prefix-in-code` | boolean | `false`                                  | `true` agrega prefijo de DB a nombres de tabla en el codigo                |

### `areas` _(opcional — array, no objeto)_

Array de storage areas definidas para el cliente:

```yaml
areas:
  - name: 'clienteapp'
    description: 'Area de storage para tablas de aplicacion'
  - name: 'clienteidx'
    description: 'Area para indices'
  - name: 'cliente_blob'
    description: 'Area para BLOBs y adjuntos del Hub'
```

Cada item: `name` (string, min 1) + `description` (string, opcional).

### `hub` _(opcional)_

| Campo               | Tipo                   | Descripcion                                                                  |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `api-url`           | string                 | URL base del Integra Hub                                                     |
| `auth.method`       | enum                   | `env` \| `oauth` \| `static` (ver warning abajo)                             |
| `auth.env-user`     | string _(condicional)_ | **Requerido si** `auth.method = "env"`. Nombre de la ENV var con el email    |
| `auth.env-password` | string _(condicional)_ | **Requerido si** `auth.method = "env"`. Nombre de la ENV var con el password |

> :warning: `auth.method = "static"` emite warning en el validator — deja credenciales en texto plano. Usar `env` (keyring via SPEC-0005) o `oauth`.

### `frontend` _(opcional)_

| Campo     | Tipo                   | Descripcion                               |
| --------- | ---------------------- | ----------------------------------------- |
| `enabled` | boolean                | `true` si el cliente tiene frontend React |
| `stack`   | object _(condicional)_ | **Requerido si** `enabled = true`         |

Si `stack` esta definido, **todos** sus campos son obligatorios:

| Campo                      | Tipo   | Descripcion                           |
| -------------------------- | ------ | ------------------------------------- |
| `stack.framework`          | string | Framework (ej. `"React"`)             |
| `stack.version`            | string | Version del framework                 |
| `stack.build-tool`         | string | Build tool (ej. `"Vite"`)             |
| `stack.build-tool-version` | string | Version del build tool                |
| `stack.language`           | enum   | `javascript` \| `typescript`          |
| `stack.http-client`        | string | Cliente HTTP (ej. `"axios"`)          |
| `stack.router`             | string | Router (ej. `"react-router-dom"`)     |
| `stack.router-version`     | string | Version del router                    |
| `stack.charts`             | string | Libreria de charts (ej. `"recharts"`) |

### `engram-central` _(opcional — requiere Gitea + SPEC-0003)_

| Campo                   | Tipo           | Default              | Descripcion                                   |
| ----------------------- | -------------- | -------------------- | --------------------------------------------- |
| `gitea-url`             | string _(URL)_ | —                    | URL del Gitea del equipo (formato URL valido) |
| `gitea-ssh`             | string         | —                    | SSH remote (formato `git@host`)               |
| `gitea-org`             | string         | —                    | Organizacion en Gitea                         |
| `sync-interval-minutes` | number         | `10`                 | Cada cuanto sincronizar (1-1440)              |
| `local-path`            | string         | `"~/engram-central"` | Path local del engram sync                    |
| `include-sessions`      | boolean        | `true`               | Incluir sessions en sync                      |
| `include-prompts`       | boolean        | `false`              | Incluir prompts (consume mas storage)         |
| `secret-scan`           | boolean        | `true`               | Escanear secrets antes de push                |

---

## TIER 3 — LOCKED (IP — NO EDITAR)

### `framework` — **todos los campos son literales fijos**

Cualquier desviacion del valor exacto hace que el schema Zod rechace el yaml.

| Campo                     | Valor literal exacto                       |
| ------------------------- | ------------------------------------------ |
| `_locked`                 | `true` (boolean literal)                   |
| `base-class`              | `Base.Entitys.BaseEntityHandler`           |
| `rest-handler`            | `Base.Entitys.BaseRestHandler`             |
| `security-base`           | `Base.Entitys.BaseSecurity`                |
| `dataset-name`            | `dsIntegra`                                |
| `state-tempname`          | `ttEstados`                                |
| `lookup-tempname`         | `ttLookupResult`                           |
| `help-tempname`           | `ttHelp`                                   |
| `validate-method`         | `ValidarNegocio`                           |
| `lookup-method`           | `AgregarLookup`                            |
| `help-method`             | `AgregarCampoHelp`                         |
| `session-validator`       | `ValidSession`                             |
| `success-setter`          | `SetEstadoOk`                              |
| `error-setter`            | `SetEstadoError`                           |
| `session-param`           | `pcSessionID`                              |
| `success-code-prefix`     | `1-`                                       |
| `error-code-prefix`       | `0-`                                       |
| `auth-service`            | `FrameWork.Services.authenticationService` |
| `session-context-service` | `FrameWork.Services.sessioncontextService` |

---

## Validaciones cross-field (super-refine)

El schema ejecuta 4 validaciones adicionales despues del chequeo por campo:

| #   | Regla                                                             | Comportamiento                                                  |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `hub.auth.method = "static"`                                      | **Warning** — credenciales en texto plano, usar `env` u `oauth` |
| 2   | Puertos duplicados entre `pasoe.ports.*` y `database.broker-port` | **Error** — todos los puertos deben ser unicos                  |
| 3   | `pasoe.ports.dev-http == pasoe.ports.dev-https`                   | **Error** — deben ser diferentes                                |
| 4   | `hub.auth.method = "env"` sin `env-user` o `env-password`         | **Error** — env var names son requeridos                        |
| 5   | `frontend.enabled = true` sin `frontend.stack`                    | **Error** — stack completo es requerido                         |

---

## Workflow tipico

```bash
# 1. Copiar template
cp project.config.yaml project.config.yaml.tu-edicion

# 2. Editar tu version
$EDITOR project.config.yaml.tu-edicion

# 3. Validar
npx specoe-validate project.config.yaml.tu-edicion

# 4. Si OK, reemplazar el original
mv project.config.yaml.tu-edicion project.config.yaml
```

---

## Troubleshooting de errores comunes

| Error del validator                                         | Causa comun                                             | Solucion                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `schema-version Required`                                   | Falta la primera linea                                  | Agregar `schema-version: "0.1.0"` al top del yaml                |
| `project.email no es un email valido`                       | Email sin `@` o TLD                                     | Usar formato `usuario@dominio.com`                               |
| `project.locale debe ser formato ICU`                       | Formato `"es_AR"` o `"ES-AR"`                           | Usar minuscula-MAYUSCULA: `es-AR`, `en-US`                       |
| `rest-transport debe empezar con /`                         | Path sin `/` inicial                                    | Agregar `/` al inicio (ej. `/WebServices/rest/...`)              |
| `Puertos duplicados detectados`                             | `dev-http` y `dev-https` iguales, o pisan `broker-port` | Usar puertos distintos en cada entorno                           |
| `feature-branch-template debe contener {ticket-number}`     | Template sin placeholder                                | Incluir `{ticket-number}` literal en el template                 |
| `framework._locked debe ser literalmente true`              | Se modifico un campo de framework                       | **NO EDITAR** la seccion `framework` — usar el template tal cual |
| `env-user debe ser un nombre de variable de entorno valido` | Valor con minusculas o chars raros                      | Usar UPPER_SNAKE_CASE (ej. `"DB_USER"`, no `"dbUser"`)           |

---

## Referencias

- Schema oficial (fuente de verdad): `integra-hub/.../validator/src/schema.ts`
- Validator CLI: `npx specoe-validate project.config.yaml`
- QUICKSTART: [QUICKSTART.md](QUICKSTART.md)
- Troubleshooting: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

_Ultima actualizacion: SPEC-0020 S05 (Master Plan Integra HUB 2.0) — alineado a schema Zod `@specoe/config-tools` v0.1.0_
