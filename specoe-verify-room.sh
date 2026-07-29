#!/usr/bin/env bash
# specoe-verify-room.sh — ¿este room quedó SERVIDO? Veredicto binario, sin pasos manuales.
#
# SPEC-0164 P4 / T4.2. Wrapper fino sobre ~/.claude/scripts/verify-room-serving.mjs:
# resuelve el Node del sistema, apunta a la carpeta del room y propaga el exit code.
#
# Uso:
#   ./specoe-verify-room.sh                # verifica la carpeta actual
#   ./specoe-verify-room.sh <carpeta>      # verifica esa carpeta (room)
#   ./specoe-verify-room.sh --dir <carpeta>
#
# Exit 0 = los cinco chequeos en verde (canal TLS al Hub, JWT de licencia, .mcp.json con
# JWT real, contrato del room bajado con el JWT del cache, y server specoe conectable
# sirviéndole EL MISMO contrato de rol al JWT del .mcp.json — TKT-0225). Cualquier otro
# exit = NO servido, y la salida nombra el chequeo que falló.
#
# Vive en la RAÍZ del starter a propósito, no en scripts/: `.syncignore` excluye `/scripts/`
# del espejo público que clona el dev (docs/QUICKSTART-VSCODE.md), así que un verificador
# ahí no llegaría nunca a la máquina donde tiene que correr. Este wrapper es una de las doce
# entradas que la carpeta del room conserva (SPEC-0167 P3, Q3).
#
# Su parte Node vive en `~/.claude/scripts/` — el bundle de hooks, que es material de MÁQUINA
# y lo instala el setup del host. Antes se resolvía en `$SCRIPT_DIR/.claude-bundle/scripts/`, o
# sea dentro de la carpeta del room: con el recorte de SPEC-0167 P3 ese directorio ya no está
# ahí y el verificador cortaba por construcción. No se conserva un subárbol del bundle en el
# room a propósito — sería reintroducir un árbol de imports para mantener a mano dentro de la
# carpeta, que es justo lo que ese recorte vino a sacar (decisión del Arquitecto, ronda 2).

set -euo pipefail

log() { echo -e "\033[1;34m[specoe-verify]\033[0m $*"; }
err() {
  echo -e "\033[1;31m[specoe-verify]\033[0m $*" >&2
  exit 1
}

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
ROOM_DIR="$PWD"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      ROOM_DIR="${2:-}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      ROOM_DIR="$1"
      shift
      ;;
  esac
done

[ -n "$ROOM_DIR" ] || err "Falta la carpeta del room. Uso: ./specoe-verify-room.sh [<carpeta>]"
[ -d "$ROOM_DIR" ] || err "No existe la carpeta '$ROOM_DIR'."
ROOM_DIR="$(cd "$ROOM_DIR" && pwd)"

# El motor vive en el bundle de la MÁQUINA (~/.claude/scripts), no en la carpeta del room.
# SPECOE_VERIFIER_DIR: override para test aislado (apunta al bundle del repo).
VERIFIER_DIR="${SPECOE_VERIFIER_DIR:-$HOME/.claude/scripts}"
[ -f "$VERIFIER_DIR/verify-room-serving.mjs" ] \
  || err "Falta $VERIFIER_DIR/verify-room-serving.mjs: esta máquina no tiene el bundle de hooks instalado (o es anterior a SPEC-0167).
  El motor del verificador es material de MÁQUINA: lo instala specoe-setup-host.sh — vive en el starter con el que preparaste la máquina, NO en esta carpeta.
  Si no lo tenés a mano: git clone --depth 1 ${SPECOE_STARTER_REPO:-https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git} specoe-starter && cd specoe-starter && ./specoe-setup-host.sh
  Cuando termine, volvé a esta carpeta y corré ./specoe-verify-room.sh"

NODE_BIN="$(specoe_node_bin)"
command -v "$NODE_BIN" >/dev/null 2>&1 || err "Node no está en el PATH. Instalá Node 22.19+ (o 24.x/26.x)."

# Ruta del room en formato nativo: en Git Bash node.exe lee las rutas Unix (/c/...) como
# rutas Windows y no encuentra nada. El .mjs se invoca por nombre relativo, parados en su
# directorio, por el mismo motivo (mismo patrón que specoe-add-room.sh con sdd-login.mjs).
ROOM_ARG="$ROOM_DIR"
if command -v cygpath >/dev/null 2>&1; then
  ROOM_ARG="$(cygpath -w "$ROOM_DIR")"
fi

log "Verificando el room $ROOM_DIR"
cd "$VERIFIER_DIR"
exec "$NODE_BIN" verify-room-serving.mjs "$ROOM_ARG"
