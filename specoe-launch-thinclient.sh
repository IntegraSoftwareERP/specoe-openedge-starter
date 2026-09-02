#!/usr/bin/env bash
# specoe-launch-thinclient.sh — Abre una shell con el entorno SDD del thin-client
# listo para operar contra el Hub (SPEC-0157: identidad por USUARIO).
#
# Modelo por usuario: la identidad es el token de TU usuario (guardado en el
# keyring por el login de setup.sh/specoe-setup-host.sh) + el enrolamiento del
# equipo. Acá NO viaja ningún secreto de rol ni cuid de tenant: el tenant lo
# resuelve el server a partir del token, y el rol es un CLAIM de la SESIÓN
# (x-sdd-role, sin firma): viaja por INTEGRA_SDD_ROLE exportada en el entorno del
# proceso — el .mcp.json del room NO lo porta (SPEC-0187 P2), el subproceso MCP lo
# hereda de esta shell. El Hub lo autoriza server-side contra los roles concedidos
# a tu usuario. Declarar un rol no concedido rebota 403 SDD_ROLE_NOT_GRANTED —
# por eso este script no necesita validar nada más.
#
# Uso:
#   ./specoe-launch-thinclient.sh <ROL>
#     <ROL> = DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV
#
# Deja una shell interactiva con INTEGRA_SDD_ROLE + INTEGRA_SDD_IDENTITY_MODE
# exportados: desde ahí corré `code .` o `claude` — ambos heredan el entorno.

set -euo pipefail

log()  { echo -e "\033[1;34m[specoe-thinclient]\033[0m $*"; }
warn() { echo -e "\033[1;33m[specoe-thinclient]\033[0m $*" >&2; }
err()  { echo -e "\033[1;31m[specoe-thinclient]\033[0m $*" >&2; exit 1; }

# node.exe en Git Bash bypassa winpty (TKT-0200); en WSL el node.exe de Windows entra por el
# interop y lee las rutas Unix como Windows → MODULE_NOT_FOUND, así que ahí va node. (TKT-0217)
specoe_node_bin() {
  if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
    echo node
  elif command -v node.exe >/dev/null 2>&1; then
    echo node.exe
  else
    echo node
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROLE="${1:-}"
[ -n "$ROLE" ] || err "Falta el rol. Uso: ./specoe-launch-thinclient.sh <ROL>"
case "$ROLE" in
  DISCOVERY|ENGINEERING|ADVERSARIAL|CC_DEV) : ;;
  *) err "Rol invalido: '$ROLE'. Valores: DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV" ;;
esac

export INTEGRA_SDD_ROLE="$ROLE"
export INTEGRA_SDD_IDENTITY_MODE="USER"

# SPEC-0187 P7 — el tenant de la sesion, desde la declaracion del room. Es el selector que
# resuelve QUE identidad y QUE licencia del keyring usa esta sesion: sin el, una maquina con dos
# tenants no sabe cual de las dos identidades es la de esta carpeta.
#
# La env es INTEGRA_SDD_TENANT y NO INTEGRA_ACT_AS_TENANT (Step 0 de la fase, AP8): el valor de
# esa otra es el Tenant.id del contrato scoped —el Hub rebota 403 ACT_AS_TENANT_MISMATCH si no
# coincide con el tenant del JWT del firmante— y lo que dimensiona estas claves es el tenantSlug,
# que es otro campo. Reusar el nombre andaba de casualidad en integra-piloto (donde id y slug
# coinciden) y rompia en el primer cliente con cuid.
#
# Sin `specoe.tenant` declarado no se exporta nada: la sesion queda en modo single-tenant y las
# lecturas caen a las claves legacy — que es el piloto instalado, y no se rompe.
# shellcheck source=specoe-yaml.sh
#
# TKT-0317 — por el mismo canal viaja `specoe.work-repo`: el repo donde vive el CODIGO de este
# room. Esta carpeta no lo es (es un clon shallow del starter) y las herramientas de aislamiento
# del agente operan sobre el cwd, asi que sin este dato apuntan al repo equivocado. Se exporta
# como INTEGRA_SDD_WORK_REPO para que el hook de arranque lo tenga aunque el yaml no se pueda
# leer; sin declarar no se exporta nada y el hook lo dice al arrancar la sesion.
#
# SPEC-0208 P5 — la clave admite N rutas (escalar o lista) y la env las lleva TODAS, unidas por
# el separador declarado en specoe-yaml.sh como SPECOE_WORK_REPO_SEP. Ese separador es `|` y la
# eleccion no es de estilo: `|` es uno de los caracteres que Windows PROHIBE en un nombre de
# archivo (junto a \ / : * ? " < >), asi que no puede aparecer dentro de una ruta y no puede
# partir una al medio — `;` y `,` si son legales en Windows y lo harian. El lector del hook
# (specoe-room-bootstrap.mjs, WORK_REPO_SEPARATOR) parte por el MISMO caracter: si alguno de los
# dos lados lo cambia solo, el room lee una ruta sola con basura adentro en vez de N rutas.
if [ -f "$SCRIPT_DIR/specoe-yaml.sh" ]; then
  source "$SCRIPT_DIR/specoe-yaml.sh"
  ROOM_TENANT="$(specoe_yaml_get "$SCRIPT_DIR/project.config.yaml" specoe.tenant)"
  if [ -n "$ROOM_TENANT" ]; then
    export INTEGRA_SDD_TENANT="$ROOM_TENANT"
  fi
  ROOM_WORK_REPO=""
  while IFS= read -r _room_repo; do
    [ -n "$_room_repo" ] || continue
    if [ -n "$ROOM_WORK_REPO" ]; then
      ROOM_WORK_REPO="${ROOM_WORK_REPO}${SPECOE_WORK_REPO_SEP}${_room_repo}"
    else
      ROOM_WORK_REPO="$_room_repo"
    fi
  done < <(specoe_yaml_get_list "$SCRIPT_DIR/project.config.yaml" specoe.work-repo)
  if [ -n "$ROOM_WORK_REPO" ]; then
    export INTEGRA_SDD_WORK_REPO="$ROOM_WORK_REPO"
  fi
else
  warn "Falta $SCRIPT_DIR/specoe-yaml.sh: no puedo leer specoe.tenant ni specoe.work-repo, la sesion arranca sin declarar tenant ni repo de trabajo."
  warn "  → Actualizá el starter de esta carpeta (git -C \"$SCRIPT_DIR\" pull --ff-only). Si esta maquina tiene identidad de un solo tenant, no cambia nada."
fi

# Chequeo accionable del material de identidad (no bloquea: el borde real es el
# 401/403 del Hub — esto es UX para no descubrirlo recién adentro de la sesión).
NODE_BIN="$(specoe_node_bin)"
if [ -f "$HOME/.claude/scripts/sdd-login.mjs" ]; then
  if ! ( cd "$HOME/.claude/scripts" && "$NODE_BIN" sdd-login.mjs status >/dev/null 2>&1 ); then
    warn "Identidad SDD incompleta: no está el token de usuario y/o el machineId en el keyring."
    warn "  → Hacé el login primero desde la carpeta del room: ./setup.sh --login . Sin eso el Hub responde 401."
  fi
else
  # SPEC-0167 P3 (T3.3): el instalador de MÁQUINA no está en la carpeta del room, así que la
  # remediación no puede nombrarlo con './' — apunta al canal de host, que sí existe.
  warn "Bundle sin instalar (~/.claude/scripts/sdd-login.mjs ausente)."
  warn "  → Corré specoe-setup-host.sh — vive en el starter con el que preparaste la máquina, NO en la carpeta del room. Si no lo tenés a mano: git clone --depth 1 ${SPECOE_STARTER_REPO:-https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git} specoe-starter && cd specoe-starter && ./specoe-setup-host.sh"
fi

log "=== Sesion SDD thin-client: rol $ROLE (identidad por usuario) ==="
log "INTEGRA_SDD_ROLE=$ROLE  INTEGRA_SDD_IDENTITY_MODE=USER  INTEGRA_SDD_TENANT=${INTEGRA_SDD_TENANT:-<sin declarar: modo single-tenant>}"
log "INTEGRA_SDD_WORK_REPO=${INTEGRA_SDD_WORK_REPO:-<sin declarar: el room no sabe donde vive su codigo>}"
log "Si el Hub responde 403, traducí el código: bash \"$SCRIPT_DIR/specoe-gate-messages.sh\" <CODIGO> $ROLE"
log "Shell lista. Abri tu sesion desde aca: 'code .' o 'claude' heredan el entorno."

exec "${SHELL:-bash}" -i
