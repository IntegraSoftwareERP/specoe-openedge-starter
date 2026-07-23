#!/usr/bin/env bash
# specoe-launch-thinclient.sh — Abre una shell con el entorno SDD del thin-client
# listo para operar contra el Hub (SPEC-0157: identidad por USUARIO).
#
# Modelo por usuario: la identidad es el token de TU usuario (guardado en el
# keyring por el login de setup.sh/specoe-setup-host.sh) + el enrolamiento del
# equipo. Acá NO viaja ningún secreto de rol ni cuid de tenant: el tenant lo
# resuelve el server a partir del token, y el rol es un CLAIM declarado por la
# carpeta/sesión (x-sdd-role, sin firma) que el Hub autoriza server-side contra
# los roles concedidos a tu usuario. Declarar un rol no concedido rebota 403
# SDD_ROLE_NOT_GRANTED — por eso este script no necesita validar nada más.
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

# Chequeo accionable del material de identidad (no bloquea: el borde real es el
# 401/403 del Hub — esto es UX para no descubrirlo recién adentro de la sesión).
NODE_BIN="$(specoe_node_bin)"
if [ -f "$HOME/.claude/scripts/sdd-login.mjs" ]; then
  if ! ( cd "$HOME/.claude/scripts" && "$NODE_BIN" sdd-login.mjs status >/dev/null 2>&1 ); then
    warn "Identidad SDD incompleta: no está el token de usuario y/o el machineId en el keyring."
    warn "  → Hacé el login primero: ./setup.sh --login (o ./specoe-setup-host.sh). Sin eso el Hub responde 401."
  fi
else
  warn "Bundle sin instalar (~/.claude/scripts/sdd-login.mjs ausente) — corré specoe-setup-host.sh primero."
fi

log "=== Sesion SDD thin-client: rol $ROLE (identidad por usuario) ==="
log "INTEGRA_SDD_ROLE=$ROLE  INTEGRA_SDD_IDENTITY_MODE=USER"
log "Si el Hub responde 403, traducí el código: bash \"$SCRIPT_DIR/specoe-gate-messages.sh\" <CODIGO> $ROLE"
log "Shell lista. Abri tu sesion desde aca: 'code .' o 'claude' heredan el entorno."

exec "${SHELL:-bash}" -i
