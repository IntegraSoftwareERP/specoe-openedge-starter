# Quickstart — SPECOE en VSCode (piloto Integra)

Flujo para dejar un dev trabajando en VSCode servido por SPECOE, con **VSCode + extensión
Claude Code**. Automatiza con `install-specoe.sh` los pasos que antes eran manuales
(hosts, CA de Caddy, keyring, config).

> **Audiencia**: dev de Integra en el piloto. Trabajás contra el Hub por MCP + la UI de
> intranet, servido por SPECOE — ya no con los rooms locales hardcodeados.

---

## Lo que te da Integra

- Tu **license key** de SPECOE (según tu rol: DISCOVERY / ENGINEERING / CC_DEV / …).
- Tu **usuario del Hub** (email + password). Lo vas a usar en **dos** lados: el **login SDD** que el
  setup del host te pide por prompt (paso 1.6), y la UI del Hub por intranet.
- El `install-specoe.sh` (o el link para bajarlo).

---

## Pre-requisitos (una vez por máquina)

Estos tres los instalás vos; el resto lo hace el script.

1. **Node del rango certificado: 22.19.0 a 26.x** (Node 23 queda afuera) — https://nodejs.org (LTS).
   Verificá: `node --version` → `v22.19.0` o mayor, sin pasar de `v26`. El instalador aborta fuera
   del rango: abajo de 22.19 el canal TLS de los hooks directamente no existe (ver tabla del final).
2. **Git para Windows** (incluye **Git Bash**) — https://git-scm.com/download/win.
3. **VSCode** — https://code.visualstudio.com — con la **extensión Claude Code** y el **CLI `code` en el PATH**:
   - VSCode → Extensions (Ctrl+Shift+X) → buscar **"Claude Code"** (Anthropic) → Install.
   - Arrancá Claude Code **una vez** (para que cree `~/.claude/`): abrí la extensión o corré `claude --help` en Git Bash.
   - **El CLI `code`**: verificá con `code --version` en Git Bash. Si no lo encuentra, abrí VSCode →
     Ctrl+Shift+P → **"Shell Command: Install 'code' command in PATH"**, cerrá y volvé a abrir Git Bash.
     (En el instalador de Windows es la opción **"Add to PATH"**.) El instalador del room lo necesita
     para instalarte el **plugin Integra Hub**, y si no está **aborta**.

> **El plugin Integra Hub NO lo instalás vos.** Viene dentro del starter (`vendor/integra-hub-vscode.vsix`)
> y lo instala el instalador del room, que además le deja apuntada la URL del Hub. Si querés instalarlo
> a mano igual —porque algo falló—, mirá "Si algo falla" al final.

> Windows: los comandos van en **Git Bash**, no en PowerShell/CMD.

> **Acceso al repo**: el starter es un repo **público**. El clone del paso 0 resuelve **sin
> credenciales de GitHub** — no hace falta `gh auth login` ni un Personal Access Token.

---

## Instalación

Todo en **Git Bash**: primero **bajás el starter**, después el **host** una vez por máquina, y
**un room por rol**.

### 0) Bajar el starter

```bash
git clone https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git
cd specoe-openedge-starter
```

Los scripts (`specoe-setup-host.sh`, `specoe-room-*.sh`) viven en esa carpeta — los pasos
siguientes se corren desde ahí.

> **Ojo si estás leyendo esto DENTRO de una carpeta de room.** El room conserva este
> quickstart, pero no el instalador de máquina: `specoe-setup-host.sh`, `specoe-room-*.sh`,
> `install-specoe.sh`, `certs/`, `docker/` y `examples/` quedan fuera del room a propósito
> (SPEC-0167). Esos comandos se corren en la **carpeta del starter**, la de este paso 0.
> Lo que sí corre dentro del room: `./setup.sh --room-only`, `./setup.sh --login`,
> `./specoe-add-room.sh <ROL> <KEY>`, `./specoe-launch-thinclient.sh <ROL> <TENANT>`,
> `./specoe-verify-room.sh` y `bash specoe-gate-messages.sh <CODIGO>`.

### 1) Host — una sola vez por máquina

```bash
./specoe-setup-host.sh
```

Hace lo que se comparte entre todos tus rooms:

1. Chequea Node (rango certificado 22.19.0–26.x, Node 23 afuera) / Claude Code / Git. Fuera del
   rango **aborta**: en esas versiones el canal TLS de los hooks no existe.
2. Instala el bundle de hooks + dependencias (`npm install`).
3. **Salta una ventana de elevación (UAC) — aceptala.** Con esos permisos:
   - agrega `hub.integra.local` y `mcp.integra.local` al `hosts` (→ IP del piloto);
   - instala el **CA de Caddy** en el trust del sistema (para que el navegador confíe en la UI del Hub).
4. Copia el CA a `~/.claude/` (para los hooks Node).
5. **Verifica el host** por el **mismo canal que usa el room** (importa `ca-channel.mjs`, el
   mecanismo único de CA): `ping` al server + un `fetch` de prueba al Hub. Si el canal no da,
   **aborta** — no imprime "Host listo". El mensaje te dice qué quedó aplicado (bundle, hosts, CA)
   y con qué comando retomar sin volver a pedir elevación: `./specoe-setup-host.sh --skip-elevation`.
6. **Login SDD — es interactivo y te va a pedir tres cosas por pantalla.** El script llama a
   `./setup.sh --login`, que enrola esta máquina contra el Hub y guarda tu token de usuario + el
   `machineId` en el keyring del sistema. Te pregunta, en este orden:
   - **URL del Hub** — con default entre corchetes; en el piloto alcanza con **Enter**.
   - **Email de tu usuario del Hub** — el mismo de "Lo que te da Integra".
   - **Clave** — no se ve mientras la tipeás y nunca viaja por la línea de comandos.

   Si el login falla, el host **no queda listo**. Se retoma solo con `./setup.sh --login`, sin
   volver a pedir elevación.

> **Después del host quedan uno o dos pasos que NO los hace el script.**
> Los hace **un admin del tenant** en el Hub, y el instalador te dice en pantalla cuál te toca:
>
> - **Aprobar este equipo.** Si el login dejó la máquina en estado `PENDING`, **un admin del tenant**
>   la aprueba en **Administración → SDD → Equipos autorizados**. Hasta que eso pase, el MCP
>   `integra-hub` no opera. El script lo imprime como _"único paso humano restante"_.
> - **Concederte los roles SDD.** Si el login informa `Roles SDD de tu usuario: <ninguno>`,
>   **un admin del tenant** te los concede en **Administración → SDD → Roles por usuario**.
>
> Los dos son pedidos a otra persona, no algo que puedas resolver en tu máquina. Pedilos apenas
> termine el host: son lo que más suele demorar el arranque.

### 2) Room — una vez por rol

Un script por room (corré solo los roles que uses):

```bash
./specoe-room-discovery.sh   <TU-KEY-DISCOVERY>
./specoe-room-engineering.sh <TU-KEY-ENGINEERING>
./specoe-room-adversarial.sh <TU-KEY-ADVERSARIAL>
./specoe-room-ccdev.sh       <TU-KEY-CCDEV>
```

Cada uno crea su carpeta (`discovery-room`, `cc-dev-room`, …), fija el rol en el `project.config.yaml`
y guarda la licencia en el keyring bajo `account=<ROL>`. Los roles quedan **aislados**: JWT cacheado
por carpeta, licencia por rol — no se pisan. Abrís cada carpeta en su propia ventana de VSCode.

> **El primer room de la máquina son DOS pasadas del mismo comando, y es a propósito.** El
> `project.config.yaml` viene con valores de template, y el instalador **corta** en vez de seguir con
> ellos: antes fallaba varios pasos después, lejos de la causa.
>
> **Primera pasada** — crea la carpeta, fija el rol, guarda la licencia en el keyring y **corta**
> enumerando los campos que faltan editar. Que corte es lo esperado; la licencia **ya quedó
> persistida**, no se pierde.
>
> **Editá ahí el `project.config.yaml`** — el de la carpeta del room recién creada — con los datos de
> tu proyecto. Son cinco campos: `project.name`, `project.vendor`, `paths.workspace-root`,
> `database.logical-name` y `pasoe.instance-name`. El rol y la URL del Hub los escribe el
> instalador: esos no los toques.
>
> **Segunda pasada** — volvé a correr **el mismo comando**. Ahora el check pasa y el room queda
> instalado.

> Opciones: `--dir <carpeta>`, `--hub <url>`. Debajo, `specoe-add-room.sh <ROL> <key>` es el núcleo
> común (los 4 scripts de arriba son wrappers finos que le fijan el rol).

### Atajo all-in-one (1 rol / 1 máquina)

Si sólo querés **un** rol en esta máquina, un solo comando hace host + room:

```bash
./install-specoe.sh <TU-KEY> --role CC_DEV
```

Es un composer de los dos scripts de arriba. Para multi-rol conviene el host 1 vez + un room por rol
(no repetís hosts/CA/bundle en cada uno).

Le aplica todo lo del camino largo: el **login SDD interactivo** del paso 1.6, los pasos del **admin
del tenant**, y las **dos pasadas** por el `project.config.yaml` del paso 2.

---

## Abrir en VSCode

Abrí la carpeta del room (una por rol):

```bash
code cc-dev-room   # o discovery-room, engineering-room, adversarial-room
```

El `project.config.yaml` ya lo editaste en el paso 2 — es lo que destraba la segunda pasada del
instalador. Acá no queda nada de config por hacer.

1. Con la carpeta abierta, la extensión **Claude Code** arranca la sesión:
   - el SessionStart hook valida tu licencia, activa el seat y **puebla el JWT del skill-server**;
   - el room queda **servido por SPECOE** — tus skills/commands bajan por el MCP `specoe`.
2. La extensión **Integra Hub** ya está instalada: el instalador del room la instaló desde el
   `.vsix` que trae el starter. Su ícono aparece en la **Activity Bar** (barra lateral izquierda) y
   ya apunta al Hub — el instalador dejó `integraHub.baseUrl` en el `.vscode/settings.json` de la
   carpeta del room. **No hay nada que configurar acá.**
   - Lo único que queda a tu criterio es el **roster de rooms** (`integraHub.rooms`): es config
     tuya, el instalador no la toca. El TreeView de Rooms arranca vacío hasta que la cargues, y eso
     es lo esperado.
   - Cada room apunta a su propio Hub: el valor va en el settings **de la carpeta**, no en el global
     de tu usuario, así que dos rooms pueden hablar con Hubs distintos sin pisarse.
3. **No toques ninguna variable de entorno a mano.** Si te pide `export`, algo falló — ver abajo.

---

## Verificar que quedó servido

Corré el verificador desde la carpeta del starter (el clon de este repo), pasándole la carpeta del room:

```bash
./specoe-verify-room.sh ../cc-dev-room     # o la carpeta del room que quieras verificar
./specoe-verify-room.sh                    # sin argumentos: verifica la carpeta actual
```

Dictamina solo, sin pasos manuales, con **cinco chequeos** que comprueban el EFECTO (no que un archivo exista):

| #   | Chequeo             | Qué comprueba                                                                                                                                                                                |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `canal-tls-hub`     | el handshake TLS contra el Hub **abre** (un `.crt` de otro emisor da rojo acá)                                                                                                               |
| 2   | `jwt-licencia`      | el JWT de licencia está en el cache de la carpeta y **no venció**                                                                                                                            |
| 3   | `mcp-json-jwt`      | el `.mcp.json` declara `specoe` con un **JWT real**, no `${SPECOE_SKILL_JWT}`                                                                                                                |
| 4   | `contrato-room`     | el **contrato del room baja** del skill-server en esta corrida, con el JWT del cache de la carpeta                                                                                           |
| 5   | `specoe-conectable` | el skill-server **acepta la sesión** con la url y el header del `.mcp.json` —lo que hace que `/mcp` muestre `specoe` **connected**— **y le sirve el mismo contrato de rol** que al chequeo 4 |

`exit 0` solo si los cinco dan verde (`SPECOE-VERIFY veredicto: SERVIDO`). Si alguno falla, la salida nombra el chequeo y qué hacer.

> **Por qué el 5 pide el contrato y no le alcanza con que la sesión abra** (TKT-0225): el room usa dos JWT —el del cache de la carpeta, con el que el hook baja el contrato, y el del `.mcp.json`, con el que corren los tools MCP—. El hook de licencia los escribe juntos, pero una edición a mano del `.mcp.json` los separa, y un JWT de producto abre la sesión igual. Antes, con los dos tokens divergentes, los cinco chequeos podían dictaminar `SERVIDO` con la sesión corriendo como **producto**. Ahora el 5 pide `room_contract_get` con el token del `.mcp.json` y exige el mismo contrato que bajó el 4: producto no tiene contrato de room y otro rol devuelve otro texto, así que las dos divergencias dan rojo. Se compara el **contrato servido** y no solo el claim `sddRole`, porque el contrato es el efecto y el claim es apenas el medio.

> **Corrección** (TKT-0232): la versión anterior de esta nota decía que «en USER-mode el rol lo resuelve el server y el claim puede faltar sin que nada esté roto». **Es falso.** El skill-server resuelve el rol de una sola fuente —el claim `sddRole` del JWT— y no consulta nada más. Lo que cambia en USER-mode es de dónde sale el claim: el Hub lo **deriva** del usuario del seat que el arranque declara en `userContext`, en vez de leerlo de la licencia. O sea que el claim **tiene que estar** en los dos modos, y un JWT sin claim significa siempre lo mismo: el room corre con el **bundle producto**. Hasta 0.2.5 el hook de licencia no mandaba `userContext`, así que en USER-mode el claim faltaba **siempre** y ningún room recién instalado bajaba el bundle de su rol. Si tu JWT no trae el claim, mirá el chequeo 4: la salida nombra las dos causas posibles y qué hacer en cada modo.

El verificador **no** exige que el MCP `integra-hub` conecte: ese server no forma parte del arranque servido del room.

Verificación manual equivalente, si querés mirarlo vos mismo en la sesión de Claude Code:

- Comando `/mcp` → el server **`specoe`** debe figurar **connected**.
- `cat .mcp.json` → el header `Authorization` tiene un **JWT** (no `${SPECOE_SKILL_JWT}`).
- Log: `~/.claude/logs/specoe-license-<fecha>.log` → líneas `fingerprint activado` + `license validated`.
- UI del Hub: entrá a `https://hub.integra.local` con tu usuario (sin warning de TLS = CA OK).

---

## Si algo falla

| Síntoma                                                                                                                                                                                   | Causa probable                                                                                                                            | Fix                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP `specoe` no conecta                                                                                                                                                                   | JWT no poblado                                                                                                                            | Reabrí VSCode (el hook lo puebla al arrancar). Revisá el log de licencia.                                                                                                                                                                             |
| Warning de TLS en el navegador                                                                                                                                                            | CA no instalado                                                                                                                           | Re-corré el install (acepta el UAC) o importá `certs/caddy-root-ca.crt` a "Entidades de certificación raíz de confianza".                                                                                                                             |
| `unable to verify the first certificate` (Node)                                                                                                                                           | El CA del piloto no está en `~/.claude/caddy-local-root.crt`, o el que hay es de otro emisor                                              | Re-corré `./specoe-setup-host.sh --skip-elevation`: reemplaza el `.crt` local por el del starter y verifica el canal. **No** exportes `NODE_EXTRA_CA_CERTS`: bajo la extensión de VSCode esa variable no le llega al hook — el CA se lee del archivo. |
| El hook no habla con el Hub y el instalador aborta por versión de Node                                                                                                                    | Node fuera del rango certificado (20.x, 22.18 o anterior, 23.x): no expone `tls.setDefaultCACertificates` y el canal TLS no puede armarse | Instalá una versión del rango: **22.19.0 a 26.x, Node 23 afuera**. Verificá con `node -v` y volvé a correr `./specoe-setup-host.sh --skip-elevation`.                                                                                                 |
| `hub.integra.local` no resuelve                                                                                                                                                           | hosts sin entrada                                                                                                                         | Re-corré el install, o agregá `<IP> hub.integra.local` al hosts (admin).                                                                                                                                                                              |
| `hub.integra.local` no resuelve y en el hosts la entrada aparece pegada al final de otra línea (típico con Norton / Avast / AVG: `... # gen digital helper server<IP> hub.integra.local`) | La instaló un starter viejo: el `hosts` no terminaba en salto de línea, así que la entrada quedó **después del `#` → comentada e inerte** | Re-corré el install con este starter: normaliza el archivo y vuelve a agregar la entrada sana. La línea pegada queda inerte, se puede borrar a mano (admin).                                                                                          |
| `license expired` / `invalid signature`                                                                                                                                                   | licencia vencida/mal firmada                                                                                                              | Pedí license nueva a Integra.                                                                                                                                                                                                                         |
| El instalador aborta con **`No encontre el CLI 'code' de VSCode en el PATH`**                                                                                                             | VSCode está instalado pero sin el CLI en el PATH (típico en Windows: en el instalador no se tildó "Add to PATH")                          | VSCode → Ctrl+Shift+P → **"Shell Command: Install 'code' command in PATH"**. Cerrá y volvé a abrir Git Bash y corré **el mismo comando**: el `.mcp.json` de la carpeta ya quedó escrito y la corrida retoma desde ahí.                                |
| El instalador aborta con **`Falta el plugin VSCode: no esta el artefacto 'vendor/integra-hub-vscode.vsix'`**                                                                              | O el starter es anterior al release que vendoriza el plugin, o esta carpeta es un room recortado que no conserva `vendor/`                | Actualizá el starter (`git pull --ff-only`) y reintentá. Para distinguir las dos causas, el propio mensaje del instalador trae el comando (`git sparse-checkout list`).                                                                               |
| El instalador aborta con **`El plugin NO quedó instalado`**                                                                                                                               | `code --install-extension` salió 0 pero la extensión no quedó — el instalador verifica el **efecto**, no el código de salida              | Corré a mano `code --install-extension vendor/integra-hub-vscode.vsix --force` para ver el error completo (ver abajo) y reportalo.                                                                                                                    |
| El instalador dice **`[SKIP] .vscode/settings.json existe y no pude leerlo como JSON`**                                                                                                   | Tu `settings.json` de la carpeta tiene comentarios o una coma de más: no es JSON estricto y el instalador **no lo pisa** a propósito      | Agregale la clave a mano: `"integraHub.baseUrl": "<url del Hub>"`. El resto de tu config queda intacta.                                                                                                                                               |
| El ícono de **Integra Hub** no aparece en la Activity Bar                                                                                                                                 | La extensión no quedó instalada, o VSCode venía abierto de antes                                                                          | Verificá con `code --list-extensions \| grep integrasoftwareerp`. Si figura, reabrí VSCode. Si no figura, corré `./setup.sh --room-only` en la carpeta del room.                                                                                      |

### Instalar el plugin a mano (solo si el instalador no pudo)

El mecanismo normal es el instalador — esto es la salida de emergencia. Desde la carpeta del room:

```bash
code --install-extension vendor/integra-hub-vscode.vsix --force
code --list-extensions | grep integrasoftwareerp   # tiene que listar integrasoftwareerp.integra-hub-vscode
```

Y si además te falta la URL del Hub, agregala en `<carpeta-del-room>/.vscode/settings.json`:

```json
{
  "integraHub.baseUrl": "https://hub.integra.local/api/v1"
}
```

Ese archivo está en el `.gitignore` del starter: no ensucia el `git status` del room.

Si algo no cierra después de revisar la tabla de arriba, contactá a Integra Software: `soporte@integrasoftware.biz`.
