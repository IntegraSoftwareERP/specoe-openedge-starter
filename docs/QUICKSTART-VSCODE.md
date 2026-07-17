# Quickstart — SPECOE en VSCode (piloto Integra)

Flujo de **un comando** para dejar un dev trabajando en VSCode servido por SPECOE. El
[QUICKSTART.md](QUICKSTART.md) clásico es para la terminal (`claude` en Git Bash); esta
guía es para **VSCode + extensión Claude Code**, y automatiza con `install-specoe.sh` los
pasos que antes eran manuales (hosts, CA de Caddy, keyring, config).

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

1. **Node 20+** — https://nodejs.org (LTS). Verificá: `node --version` → `v20.x` o mayor.
2. **Git para Windows** (incluye **Git Bash**) — https://git-scm.com/download/win.
3. **VSCode** — https://code.visualstudio.com — con la **extensión Claude Code**:
   - VSCode → Extensions (Ctrl+Shift+X) → buscar **"Claude Code"** (Anthropic) → Install.
   - Arrancá Claude Code **una vez** (para que cree `~/.claude/`): abrí la extensión o corré `claude --help` en Git Bash.

> Windows: los comandos van en **Git Bash**, no en PowerShell/CMD.

---

## Instalación

Dos pasos, en **Git Bash**: el **host** una vez por máquina, y **un room por rol**.

### 1) Host — una sola vez por máquina

```bash
./specoe-setup-host.sh
```

Hace lo que se comparte entre todos tus rooms:

1. Chequea Node / Claude Code / Git.
2. Instala el bundle de hooks + dependencias (`npm install`).
3. **Salta una ventana de elevación (UAC) — aceptala.** Con esos permisos:
   - agrega `hub.integra.local` y `mcp.integra.local` al `hosts` (→ IP del piloto);
   - instala el **CA de Caddy** en el trust del sistema (para que el navegador confíe en la UI del Hub).
4. Copia el CA a `~/.claude/` (para los hooks Node).
5. **Verifica el host:** `ping` al server + un `fetch` de prueba al Hub con el CA → te dice si la máquina quedó lista.

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

En la sesión de Claude Code:

- Comando `/mcp` → el server **`specoe`** debe figurar **connected**.
- `cat .mcp.json` → el header `Authorization` tiene un **JWT** (no `${SPECOE_SKILL_JWT}`).
- Log: `~/.claude/logs/specoe-license-<fecha>.log` → líneas `fingerprint activado` + `license validated`.
- UI del Hub: entrá a `https://hub.integra.local` con tu usuario (sin warning de TLS = CA OK).

---

## Si algo falla

| Síntoma                                         | Causa probable                    | Fix                                                                                                                       |
| ----------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| MCP `specoe` no conecta                         | JWT no poblado                    | Reabrí VSCode (el hook lo puebla al arrancar). Revisá el log de licencia.                                                 |
| Warning de TLS en el navegador                  | CA no instalado                   | Re-corré el install (acepta el UAC) o importá `certs/caddy-root-ca.crt` a "Entidades de certificación raíz de confianza". |
| `unable to verify the first certificate` (Node) | `NODE_EXTRA_CA_CERTS` sin apuntar | Confirmá `~/.claude/caddy-local-root.crt` existe; reabrí VSCode.                                                          |
| `hub.integra.local` no resuelve                 | hosts sin entrada                 | Re-corré el install, o agregá `<IP> hub.integra.local` al hosts (admin).                                                  |
| `license expired` / `invalid signature`         | licencia vencida/mal firmada      | Pedí license nueva a Integra.                                                                                             |

Detalle completo: [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Runbook largo: [RUNBOOK-ONBOARDING-CLIENTE-EXTERNO.md](RUNBOOK-ONBOARDING-CLIENTE-EXTERNO.md).
