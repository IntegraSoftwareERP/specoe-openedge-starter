# Quickstart — SPECOE en VSCode (piloto Integra)

Flujo para dejar un dev trabajando en VSCode servido por SPECOE, con **VSCode + extensión
Claude Code**. Automatiza con `install-specoe.sh` los pasos que antes eran manuales
(hosts, CA de Caddy, keyring, config).

> **Audiencia**: dev de Integra en el piloto. Trabajás contra el Hub por MCP + la UI de
> intranet, servido por SPECOE — ya no con los rooms locales hardcodeados.

---

## Lo que te da Integra

- Tu **license key** de SPECOE (según tu rol: DISCOVERY / ENGINEERING / CC_DEV / …).
- Tu **usuario del Hub** (email + password) para entrar a la UI por intranet.
- El `install-specoe.sh` (o el link para bajarlo).

---

## Pre-requisitos (una vez por máquina)

Estos tres los instalás vos; el resto lo hace el script.

1. **Node del rango certificado: 22.19.0 a 26.x** (Node 23 queda afuera) — https://nodejs.org (LTS).
   Verificá: `node --version` → `v22.19.0` o mayor, sin pasar de `v26`. El instalador aborta fuera
   del rango: abajo de 22.19 el canal TLS de los hooks directamente no existe (ver tabla del final).
2. **Git para Windows** (incluye **Git Bash**) — https://git-scm.com/download/win.
3. **VSCode** — https://code.visualstudio.com — con la **extensión Claude Code**:
   - VSCode → Extensions (Ctrl+Shift+X) → buscar **"Claude Code"** (Anthropic) → Install.
   - Arrancá Claude Code **una vez** (para que cree `~/.claude/`): abrí la extensión o corré `claude --help` en Git Bash.

> Windows: los comandos van en **Git Bash**, no en PowerShell/CMD.

> **Acceso al repo**: el clone del starter (paso 0) es un repo **privado** de Integra. En una
> máquina limpia `git clone` te va a pedir autenticación de GitHub. Resolvelo una vez con
> `gh auth login` (GitHub CLI) o un **Personal Access Token** con scope `repo`. Sin acceso, pedíselo a Integra.

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
siguientes se corren desde ahí. Si el clone pide auth, ver **Acceso al repo** en Pre-requisitos.

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

> Opciones: `--dir <carpeta>`, `--hub <url>`. Debajo, `specoe-add-room.sh <ROL> <key>` es el núcleo
> común (los 4 scripts de arriba son wrappers finos que le fijan el rol).

### Atajo all-in-one (1 rol / 1 máquina)

Si sólo querés **un** rol en esta máquina, un solo comando hace host + room:

```bash
./install-specoe.sh <TU-KEY> --role CC_DEV
```

Es un composer de los dos scripts de arriba. Para multi-rol conviene el host 1 vez + un room por rol
(no repetís hosts/CA/bundle en cada uno).

---

## Abrir en VSCode

Abrí la carpeta del room (una por rol):

```bash
code cc-dev-room   # o discovery-room, engineering-room, adversarial-room
```

1. Editá `project.config.yaml` con los datos de tu proyecto (nombre, DB, PASOE).
2. Con la carpeta abierta, la extensión **Claude Code** arranca la sesión:
   - el SessionStart hook valida tu licencia, activa el seat y **puebla el JWT del skill-server**;
   - el room queda **servido por SPECOE** — tus skills/commands bajan por el MCP `specoe`.
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

> **Por qué el 5 pide el contrato y no le alcanza con que la sesión abra** (TKT-0225): el room usa dos JWT —el del cache de la carpeta, con el que el hook baja el contrato, y el del `.mcp.json`, con el que corren los tools MCP—. El hook de licencia los escribe juntos, pero una edición a mano del `.mcp.json` los separa, y un JWT de producto abre la sesión igual. Antes, con los dos tokens divergentes, los cinco chequeos podían dictaminar `SERVIDO` con la sesión corriendo como **producto**. Ahora el 5 pide `room_contract_get` con el token del `.mcp.json` y exige el mismo contrato que bajó el 4: producto no tiene contrato de room y otro rol devuelve otro texto, así que las dos divergencias dan rojo. Se compara el **contrato servido**, no el claim `sddRole` del JWT: en USER-mode el rol lo resuelve el server y el claim puede faltar sin que nada esté roto.

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

Si algo no cierra después de revisar la tabla de arriba, contactá a Integra Software: `soporte@integrasoftware.biz`.
