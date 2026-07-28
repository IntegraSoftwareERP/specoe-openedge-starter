#!/usr/bin/env bash
# specoe-verify-room.sh — ¿este room quedó SERVIDO? Veredicto binario, sin pasos manuales.
#
# SPEC-0164 P4 / T4.2. Wrapper fino sobre .claude-bundle/scripts/verify-room-serving.mjs:
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
# ahí no llegaría nunca a la máquina donde tiene que correr. Su parte Node vive en
# `.claude-bundle/scripts/`, subdirectorio al que esa exclusión anclada a la raíz no alcanza.

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

VERIFIER_DIR="$SCRIPT_DIR/.claude-bundle/scripts"
[ -f "$VERIFIER_DIR/verify-room-serving.mjs" ] \
  || err "Falta $VERIFIER_DIR/verify-room-serving.mjs — el bundle del starter está incompleto."

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
