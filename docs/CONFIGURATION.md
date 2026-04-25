# Configuration — `project.config.yaml`

Referencia completa del archivo `project.config.yaml` del starter.

> **Importante — alcance del validator client-side**
>
> El package publico `@specoe/config-tools` (CLI `specoe-validate`) valida **solo Tier 1**. Tier 2 y Tier 3 se validan **server-side** cuando el yaml se sube al Integra Hub.
>
> Esto es deliberado por proteccion IP: el CLI no expone la estructura interna de Tier 2/3. Cuando corres `npx specoe-validate`, los campos top-level conocidos de Tier 2/3 (`framework`, `conventions`, `areas`, `hub`, `frontend`, `engram-central`) se reportan como notice `tier-2-3-deferred` y se difieren al Hub.
>
> Implicancia practica: un yaml que pasa `specoe-validate` puede fallar al subirlo al Hub si tiene errores en Tier 2/3. Los errores que veras client-side son **siempre** sobre Tier 1.

## Validar tu config

```bash
npx specoe-validate project.config.yaml
```

El validator retorna:

- `OK: ... es valido` con resumen de campos clave, o
- `ERROR: ... tiene N problemas de validacion` con la lista de issues por path.

---

## Concepto de tiers

| Tier  | Nombre      | Que significa                                                                                                                                                                                                                                    |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | Obligatorio | Campos que **deben** estar o la validacion falla. Son el minimo para generar codigo funcional.                                                                                                                                                   |
| **2** | Recomendado | Campos opcionales con defaults razonables. Ajustables al gusto del equipo.                                                                                                                                                                       |
| **3** | LOCKED (IP) | Valores literales del framework Integra. **Inmutables** — desviarlos rompe skills/commands/agents. Validados **server-side** al subir al Hub (con `z.literal()`). Client-side se reportan como notice `tier-2-3-deferred`, sin chequear valores. |

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

### `hub` _(requerido para SaaS)_

> **Requerido en deployments SaaS**: el Hub es el centro del producto -- skills, license, audit trail. Una version offline futura permitira omitir esta seccion, pero hoy todo cliente del piloto la necesita configurada. Para SaaS estandar, copiar los defaults del template y completar las env vars.

| Campo               | Tipo                   | Descripcion                                                                  |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `api-url`           | string                 | URL base del Integra Hub                                                     |
| `auth.method`       | enum                   | `env` \| `oauth` \| `static` (ver warning abajo)                             |
| `auth.env-user`     | string _(condicional)_ | **Requerido si** `auth.method = "env"`. Nombre de la ENV var con el email    |
| `auth.env-password` | string _(condicional)_ | **Requerido si** `auth.method = "env"`. Nombre de la ENV var con el password |

> :warning: `auth.method = "static"` emite warning **server-side** al subir al Hub — deja credenciales en texto plano. Usar `env` (keyring via SPEC-0005) o `oauth`. Client-side el CLI difiere `hub.*` y no chequea este valor.

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

### `engram-central` _(opcional)_

Feature avanzada, no requerida para el piloto. Contactar a Integra Software si la necesitas.

---

## TIER 3 — LOCKED (IP — NO EDITAR)

> **No se valida client-side** — los campos abajo son referencia documental. El CLI `specoe-validate` reporta `framework` como notice `tier-2-3-deferred` y no chequea sus valores. **Server-side el Hub rechaza cualquier desviacion** del valor literal exacto.
>
> NO EDITAR esta seccion de todos modos: los skills, commands y agents de SpecOE asumen estos valores literales en runtime. Cambiar uno rompe la generacion de codigo aunque pase la validacion local.

### `framework` — **todos los campos son literales fijos** (server-side)

Cualquier desviacion del valor exacto hace que el Hub rechace el yaml al subirlo (server-side, no client-side).

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

## Validaciones cross-field — client-side (Tier 1)

El schema ejecuta **una unica** validacion cross-field client-side via `superRefine` despues del chequeo por campo:

| Regla                                           | Comportamiento                   |
| ----------------------------------------------- | -------------------------------- |
| `pasoe.ports.dev-http == pasoe.ports.dev-https` | **Error** — deben ser diferentes |

Es la unica regla cross-field que cruza dos campos de Tier 1 (`pasoe.ports.dev-http` y `pasoe.ports.dev-https`). Cualquier otra validacion que cruce campos vive server-side (ver siguiente seccion).

## Validaciones server-side (informativo)

Las siguientes 4 reglas se ejecutan **solo cuando el yaml se sube al Hub**. El CLI `specoe-validate` no las ve (los campos involucrados son Tier 2/3 y se difieren). Estan documentadas aca para que el dev sepa que esperar al hacer el upload:

| Regla                                                             | Comportamiento                                                  | Tier involucrado                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `hub.auth.method = "static"`                                      | **Warning** — credenciales en texto plano, usar `env` u `oauth` | Tier 2 (`hub`)                                               |
| Puertos duplicados entre `pasoe.ports.*` y `database.broker-port` | **Error** — todos los puertos deben ser unicos                  | Tier 1 cruzado con Tier 1 (pero no implementado client-side) |
| `hub.auth.method = "env"` sin `env-user` o `env-password`         | **Error** — env var names son requeridos                        | Tier 2 (`hub`)                                               |
| `frontend.enabled = true` sin `frontend.stack`                    | **Error** — stack completo es requerido                         | Tier 2 (`frontend`)                                          |

> **Nota sobre puertos duplicados**: aunque ambos campos involucrados (`pasoe.ports.*` y `database.broker-port`) son Tier 1, esta validacion **no esta implementada en el `superRefine` del schema client-side** hoy. Si dos puertos chocan, el client-side la deja pasar y el Hub la rechaza al upload. Tracking: ver SPEC-0023 F2 para potencial follow-up.

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

> Los errores abajo pueden venir del CLI (client-side, Tier 1) o del Hub (server-side, Tier 2/3 + cross-field). La columna **Origen** indica donde aparece cada uno.

| Error                                                                      | Origen     | Causa comun                                        | Solucion                                                         |
| -------------------------------------------------------------------------- | ---------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `schema-version Required`                                                  | client     | Falta la primera linea                             | Agregar `schema-version: "0.1.0"` al top del yaml                |
| `project.email no es un email valido`                                      | client     | Email sin `@` o TLD                                | Usar formato `usuario@dominio.com`                               |
| `project.locale debe ser formato ICU`                                      | client     | Formato `"es_AR"` o `"ES-AR"`                      | Usar minuscula-MAYUSCULA: `es-AR`, `en-US`                       |
| `rest-transport debe empezar con /`                                        | client     | Path sin `/` inicial                               | Agregar `/` al inicio (ej. `/WebServices/rest/...`)              |
| `pasoe.ports.dev-http y pasoe.ports.dev-https deben ser diferentes`        | client     | Mismo numero de puerto en `dev-http` y `dev-https` | Usar puertos distintos                                           |
| `feature-branch-template debe contener {ticket-number}`                    | client     | Template sin placeholder                           | Incluir `{ticket-number}` literal en el template                 |
| `database.env-user debe ser un nombre de variable de entorno valido`       | client     | Valor con minusculas o chars raros                 | Usar UPPER_SNAKE_CASE (ej. `"DB_USER"`, no `"dbUser"`)           |
| `Puertos duplicados detectados` (cruzando `pasoe.ports.*` y `broker-port`) | **server** | Dos puertos iguales en el yaml                     | Usar puertos distintos en cada entorno                           |
| `framework.<campo> debe ser literalmente <valor>`                          | **server** | Se modifico un campo de Tier 3                     | **NO EDITAR** la seccion `framework` — usar el template tal cual |
| `hub.auth.env-user es requerido si auth.method = env`                      | **server** | `method=env` pero faltan los `env-*` names         | Agregar `auth.env-user` y `auth.env-password`                    |
| `frontend.stack es requerido si frontend.enabled = true`                   | **server** | `enabled=true` sin definir `stack`                 | Definir el bloque `stack` completo o cambiar `enabled` a `false` |

---

## Referencias

- Schema oficial (fuente de verdad): `specoe-platform/packages/validator/src/schema.ts`
- Whitelist de Tier 2/3 conocidos: `specoe-platform/packages/validator/src/tier-2-3-keys.ts`
- Validator CLI: `npx specoe-validate project.config.yaml`
- QUICKSTART: [QUICKSTART.md](QUICKSTART.md)
- Troubleshooting: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

_Ultima actualizacion: SPEC-0023 F2 — reconciliacion validator/doc, marcado client-side vs server-side (Piloto Docs Onboarding 2026-04-28)_
