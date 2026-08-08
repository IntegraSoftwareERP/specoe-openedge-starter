#!/usr/bin/env bash
# install-specoe.sh — Atajo ALL-IN-ONE del thin-client SPECOE para VSCode (piloto Integra).
#
# Hace host + UN room en un solo comando. Es un COMPOSER de los scripts separados (no duplica):
#   specoe-setup-host.sh   → 1 vez por máquina (pre-req + hosts + CA + bundle + verificación
#                            + plugin VSCode (.vsix — SPEC-0187 P9: es por máquina, no por room;
#                            sin VSCode se salta) + login SDD: pide TU email + clave del Hub y
#                            enrola el equipo — SPEC-0157)
#   specoe-add-room.sh     → 1 vez por room  (carpeta + specoe.role + .mcp.json con el rol + licencia del rol)
#
# Identidad por usuario: el login guarda el token en el keyring; NINGÚN secreto
# de rol ni cuid de tenant queda en archivos. Si el equipo queda PENDING, el
# único paso humano restante es que un admin del tenant lo apruebe en el Hub.
#
# Para MULTI-ROL o multi-máquina, usá los scripts separados directamente:
#   ./specoe-setup-host.sh                          # 1 vez
#   ./specoe-room-ccdev.sh   <key-ccdev>            # por room
#   ./specoe-room-discovery.sh <key-discovery>      # por room
# (correr el host 1 sola vez evita repetir hosts/CA/bundle en cada room).
#
# Uso:
#   ./install-specoe.sh <SPECOE_LICENSE_KEY> --role <ROL> [opciones]
#     <ROL> = DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV
#   Opciones: --dir <carpeta> · --ip <ip> · --hub <url> · --repo <url> · --skip-elevation

set -euo pipefail

ROLE=""
LICENSE_KEY=""
DEST_ARGS=()   # args que van al add-room (--dir/--hub/--repo)
HOST_ARGS=()   # args que van al setup-host (--ip/--repo/--skip-elevation)
REPO_URL=""

log()  { echo -e "\033[1;34m[specoe-install]\033[0m $*"; }
err()  { echo -e "\033[1;31m[specoe-install]\033[0m $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --dir)  DEST_ARGS+=(--dir "$2"); shift 2 ;;
    --hub)  DEST_ARGS+=(--hub "$2"); HOST_ARGS+=(--hub "$2"); shift 2 ;; # room config + login SDD
    --ip)   HOST_ARGS+=(--ip "$2");  shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --skip-elevation) HOST_ARGS+=(--skip-elevation); shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -*) err "Opción desconocida: $1 (ver --help)" ;;
    *)
      if [ -z "$LICENSE_KEY" ]; then LICENSE_KEY="$1"; shift
      else err "Argumento inesperado: $1"; fi
      ;;
  esac
done

[ -n "$LICENSE_KEY" ] || err "Falta la license key. Uso: ./install-specoe.sh <KEY> --role <ROL>"
[ -n "$ROLE" ]        || err "Falta --role <ROL>. Para el flujo separado (multi-rol) usá specoe-setup-host.sh + specoe-room-<rol>.sh"

# El --repo aplica a ambos (host clona el starter base; add-room clona la carpeta del room).
[ -n "$REPO_URL" ] && { HOST_ARGS+=(--repo "$REPO_URL"); DEST_ARGS+=(--repo "$REPO_URL"); }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----- 1. Host (1 vez por máquina) -----
log "== Preparando el host =="
bash "$SCRIPT_DIR/specoe-setup-host.sh" "${HOST_ARGS[@]}"

# ----- 2. Room del rol -----
log "== Instanciando el room $ROLE =="
bash "$SCRIPT_DIR/specoe-add-room.sh" "$ROLE" "$LICENSE_KEY" "${DEST_ARGS[@]}"

log ""
log "Listo. Abrí el room en VSCode y quedará servido por SPECOE (sin exports)."
