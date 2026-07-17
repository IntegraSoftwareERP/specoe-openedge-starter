#!/usr/bin/env bash
# specoe-add-room.sh — Instancia UN room de un rol, 1 vez por room (piloto Integra, TKT-0187).
#
# Núcleo de la parte por-rol. NO toca hosts / CA / pre-req / bundle — eso lo hace
# specoe-setup-host.sh (1 vez por máquina). Acá solo lo específico del room:
#   1. Clona/actualiza el starter en la carpeta del room.
#   2. setup.sh --room-only (config + .mcp.json), sin re-instalar el bundle.
#   3. Fija specoe.role en el project.config.yaml de la carpeta.
#   4. Guarda la licencia en el keyring bajo account=<ROL> (aislada por rol → multi-rol).
#
# Uso:
#   ./specoe-add-room.sh <ROL> <LICENSE_KEY> [--dir <carpeta>] [--hub <url>] [--repo <url>]
#     <ROL> = DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV
#   Los wrappers specoe-room-<rol>.sh llaman a este núcleo con el rol y el --dir por defecto.

set -euo pipefail

HUB_URL="https://hub.integra.local/api/v1"
STARTER_REPO="https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git"
DEST_DIR=""
ROLE=""
LICENSE_KEY=""

log()  { echo -e "\033[1;34m[specoe-room]\033[0m $*"; }
warn() { echo -e "\033[1;33m[specoe-room]\033[0m $*" >&2; }
err()  { echo -e "\033[1;31m[specoe-room]\033[0m $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)  DEST_DIR="$2"; shift 2 ;;
    --hub)  HUB_URL="$2";  shift 2 ;;
    --repo) STARTER_REPO="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) err "Opción desconocida: $1 (ver --help)" ;;
    *)
      if   [ -z "$ROLE" ];        then ROLE="$1"; shift
      elif [ -z "$LICENSE_KEY" ]; then LICENSE_KEY="$1"; shift
      else err "Argumento inesperado: $1"; fi
      ;;
  esac
done

[ -n "$ROLE" ]        || err "Falta el rol. Uso: ./specoe-add-room.sh <ROL> <LICENSE_KEY>"
[ -n "$LICENSE_KEY" ] || err "Falta la license key. Uso: ./specoe-add-room.sh <ROL> <LICENSE_KEY>"
case "$ROLE" in
  DISCOVERY|ENGINEERING|ADVERSARIAL|CC_DEV) : ;;
  *) err "Rol inválido: '$ROLE'. Valores: DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV" ;;
esac
# Default de carpeta según el rol (discovery-room, engineering-room, ...).
[ -n "$DEST_DIR" ] || DEST_DIR="$(echo "$ROLE" | tr 'A-Z_' 'a-z-')-room"

# El host se corre antes: avisamos si el bundle no está (pero no bloqueamos — setup.sh --room-only
# no lo necesita; el hook sí, al abrir Claude Code).
[ -f "$HOME/.claude/hooks/specoe-license-check.mjs" ] || \
  warn "El bundle de hooks no está en ~/.claude — corré specoe-setup-host.sh primero."

# ----- 1. Clonar/actualizar la carpeta del room -----
if [ -d "$DEST_DIR/.git" ]; then
  log "Actualizando '$DEST_DIR' (git pull --ff-only)..."
  git -C "$DEST_DIR" pull --ff-only || warn "  pull falló (cambios locales?). Sigo con lo que hay."
else
  log "Clonando el starter en '$DEST_DIR' (room $ROLE)..."
  git clone --depth 1 "$STARTER_REPO" "$DEST_DIR"
fi
[ -f "$DEST_DIR/setup.sh" ] || err "El starter no tiene setup.sh en '$DEST_DIR'. ¿Repo correcto?"

# ----- 2. Config de la carpeta (sin bundle) -----
log "Configurando la carpeta (setup.sh --room-only) con --hub $HUB_URL ..."
( cd "$DEST_DIR" && bash setup.sh --room-only --hub "$HUB_URL" )

# ----- 3. Fijar el rol en el yaml de la carpeta -----
log "Fijando specoe.role='$ROLE' en project.config.yaml..."
sed -i.bak "s|role: '[^']*'|role: '$ROLE'|" "$DEST_DIR/project.config.yaml" && rm -f "$DEST_DIR/project.config.yaml.bak"

# ----- 4. Licencia en el keyring, account = rol (aislada → multi-rol) -----
log "Guardando la license key en el keyring (account=$ROLE)..."
if ( cd "$HOME/.claude/hooks" 2>/dev/null && node -e "
const { Entry } = require('@napi-rs/keyring');
new Entry('specoe-license', process.argv[2]).setPassword(process.argv[1]);
console.log('ok');
" "$LICENSE_KEY" "$ROLE" >/dev/null 2>&1 ); then
  log "  License key guardada (account=$ROLE)."
else
  warn "  No pude escribir al keyring (¿bundle sin instalar? corré specoe-setup-host.sh). Fallback: exportá SPECOE_LICENSE_KEY."
fi

log ""
log "Room $ROLE listo en '$DEST_DIR'. Abrilo en VSCode: code \"$DEST_DIR\""
