#!/usr/bin/env bash
# SpecOE OpenEdge Starter — setup para Linux / macOS / Git Bash Windows.
#
# Uso:
#   ./setup.sh                    # todo: bundle de hooks (máquina) + config de la carpeta (room)
#   ./setup.sh --hub <url>        # override de hub.api-url
#   ./setup.sh --host-only        # solo la parte de máquina (pre-req + bundle + npm)
#   ./setup.sh --room-only        # solo la parte de carpeta (config + .mcp.json)
#
# --host-only / --room-only separan lo que se hace 1 vez por máquina de lo que se hace 1 vez
# por room (ver specoe-setup-host.sh + specoe-add-room.sh). Sin flags = todo (retrocompat).
#
# Modelo de deploy:
#   - Piloto interno (default): Hub en hub.integra.local (VPN de Integra). Sin Docker.
#   - Suite on-premise: cliente ejecuta Hub + Skill Server en su infra (contactar a Integra).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")" # ruta absoluta estable tras el cd (para --help)
cd "$SCRIPT_DIR"

log() { echo -e "\033[1;34m[specoe-setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[specoe-setup]\033[0m $*" >&2; }
err() { echo -e "\033[1;31m[specoe-setup]\033[0m $*" >&2; exit 1; }

# ----- 0. Parse argumentos -----

HUB_URL=""
DO_HOST=1 # parte de máquina: pre-req + bundle de hooks + npm install
DO_ROOM=1 # parte de carpeta: config + .mcp.json
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub)
      HUB_URL="$2"
      shift 2
      ;;
    --host-only) # solo la parte de máquina
      DO_ROOM=0
      shift
      ;;
    --room-only) # solo la parte de carpeta
      DO_HOST=0
      shift
      ;;
    --help | -h)
      sed -n '2,/^set -euo pipefail/p' "$SELF" | sed '$d'
      exit 0
      ;;
    *)
      err "Argumento desconocido: $1 (usar --help)"
      ;;
  esac
done

[ "$DO_HOST" = 1 ] || [ "$DO_ROOM" = 1 ] || err "--host-only y --room-only son excluyentes."

# ----- 1. Prereqs -----

log "Verificando prerrequisitos..."

command -v node >/dev/null 2>&1 || err "node no encontrado. Instalar Node.js 20+."
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\)\..*/\1/')
[ "$NODE_MAJOR" -ge 20 ] || err "Node $NODE_MAJOR detectado. Se requiere 20+."

command -v claude >/dev/null 2>&1 || warn "Claude Code no encontrado en PATH. Instalar desde https://claude.ai/code"

# El project.config.yaml solo hace falta para la parte de carpeta (room).
if [ "$DO_ROOM" = 1 ]; then
  [ -f project.config.yaml ] || err "project.config.yaml no existe en este directorio."
fi

# ----- 1.5. Instalar bundle .claude — solo host (parte de máquina) -----
if [ "$DO_HOST" = 1 ]; then
# Copia hooks + scripts del bundle a ~/.claude/. TODO el codigo del producto va con
# install_force (pisa siempre): un dev con el bundle viejo debe recibir los fixes. Se detectó
# que lo que iba con install_if_absent (package.json/lock + hooks de auth) NO llegaba
# a maquinas ya instaladas (patrón recurrente: primero el role-check, despues el license-check,
# despues el package.json). No hay config del usuario acá — las credenciales/licencia viven en
# el keyring/cache — asi que forzar es seguro.

log "Instalando .claude bundle..."

CLAUDE_HOME="$HOME/.claude"
BUNDLE_DIR="$SCRIPT_DIR/.claude-bundle"

if [ ! -d "$BUNDLE_DIR" ]; then
  warn ".claude-bundle no existe en el starter — saltando install. Si Claude Code no autentica al Hub, contactar a Integra Software."
else
  mkdir -p "$CLAUDE_HOME/hooks" "$CLAUDE_HOME/scripts"

  # install_force — copia SIEMPRE (pisa el archivo del dev con la version del bundle).
  install_force() {
    local src="$1"
    local dst="$2"
    if [ ! -f "$src" ]; then
      warn "  [MISSING] $src — bundle incompleto"
      return
    fi
    cp "$src" "$dst"
    log "  [FORCE]   $dst"
  }

  # detectar cambio de deps ANTES de pisar el package.json: si el del
  # bundle difiere del instalado (o no habia), corremos npm install si o si. Asi una dep
  # nueva (ej. undici del fix del CA) llega tambien a maquinas con el bundle previo — el
  # gate por-dep no alcanzaba porque el npm install corria con el package.json viejo.
  DEPS_CHANGED=0
  if ! cmp -s "$BUNDLE_DIR/hooks/package.json" "$CLAUDE_HOME/hooks/package.json" 2>/dev/null; then
    DEPS_CHANGED=1
  fi

  # TODO el codigo del producto va force (un dev con un bundle viejo recibe los fixes;
  # install_if_absent no llegaba a bundles ya poblados).
  install_force "$BUNDLE_DIR/hooks/package.json"                  "$CLAUDE_HOME/hooks/package.json"
  install_force "$BUNDLE_DIR/hooks/package-lock.json"             "$CLAUDE_HOME/hooks/package-lock.json"
  install_force "$BUNDLE_DIR/hooks/specoe-role-check.mjs"         "$CLAUDE_HOME/hooks/specoe-role-check.mjs"
  install_force "$BUNDLE_DIR/hooks/specoe-license-check.mjs"      "$CLAUDE_HOME/hooks/specoe-license-check.mjs"
  install_force "$BUNDLE_DIR/hooks/specoe-room-bootstrap.mjs"     "$CLAUDE_HOME/hooks/specoe-room-bootstrap.mjs"

  # Dependencias de los hooks. Corremos npm install si cambiaron las deps (DEPS_CHANGED) o si
  # falta node_modules / alguna dep clave (@modelcontextprotocol/sdk del bootstrap, undici del
  # CA dispatcher). DEPS_CHANGED cubre cualquier dep FUTURA sin tocar este gate.
  if [ -f "$CLAUDE_HOME/hooks/package.json" ]; then
    if [ "$DEPS_CHANGED" -eq 1 ] || [ ! -d "$CLAUDE_HOME/hooks/node_modules" ] || [ ! -d "$CLAUDE_HOME/hooks/node_modules/@modelcontextprotocol/sdk" ] || [ ! -d "$CLAUDE_HOME/hooks/node_modules/undici" ]; then
      log "  Instalando dependencias de los hooks (npm install)..."
      (cd "$CLAUDE_HOME/hooks" && npm install --silent) || warn "  npm install fallo — los hooks pueden no funcionar hasta resolverlo"
    fi
  fi
fi
fi # cierra: if DO_HOST (parte de máquina — bundle + npm)

# ===== Parte de carpeta (room) =====
if [ "$DO_ROOM" = 1 ]; then

# ----- 2. Override hub.api-url si se paso --hub -----

if [ -n "$HUB_URL" ]; then
  log "Actualizando hub.api-url a $HUB_URL en project.config.yaml..."
  # Reemplaza la linea 'api-url: ...' dentro de la seccion hub
  # Soporta tanto "api-url:" como "  api-url:" indentado
  if grep -qE "^\s*api-url:" project.config.yaml; then
    sed -i.bak -E "s|^(\s*)api-url:.*|\1api-url: \"$HUB_URL\"|" project.config.yaml
    rm -f project.config.yaml.bak
  else
    warn "No se encontro 'api-url:' en project.config.yaml. Agregar manualmente bajo 'hub:'."
  fi
fi

# ----- 3. Validar config -----

log "Validando project.config.yaml..."

# Validator ligero en bash — chequea que campos obligatorios no esten vacios.
for field in "project.name" "project.vendor" "database.logical-name" "pasoe.instance-name"; do
  value=$(grep -E "^\s*${field##*.}:" project.config.yaml | head -1 | sed 's/.*: *//;s/"//g' || true)
  if [ -z "$value" ] || [ "$value" = '""' ]; then
    err "Campo obligatorio vacio: $field — editar project.config.yaml"
  fi
done

log "Config basica: campos obligatorios presentes."
warn "  ATENCION: este check solo verifica que los campos NO esten vacios."
warn "  Si project.config.yaml tiene los valores de template ('MiCliente ERP', 'oepas1', etc.) sin editar,"
warn "  este check pasa pero el resto del flow puede fallar. Editar el yaml en Paso 3 y validar real con smoke-test (Paso 5)."

# ----- 4. License -----

LICENSE_KEY="${SPECOE_LICENSE_KEY:-$(grep -E '^\s*key:' project.config.yaml | head -1 | sed 's/.*key: *//;s/"//g' || true)}"
if [ -z "$LICENSE_KEY" ]; then
  warn "No hay license key en env ni en yaml. Modo 'solo skills libres' activado."
  warn "Para licencia completa, setear license.key o SPECOE_LICENSE_KEY."
else
  log "License detectada: ${LICENSE_KEY:0:12}..."
fi

# ----- 5. Setup Claude Code hooks -----

log "Configurando .claude/ local..."
mkdir -p .claude

if [ ! -f .claude/settings.json ]; then
  warn ".claude/settings.json no existe — se esperaba estar en el starter. Saltando."
fi

# ----- 5.5. Generar .mcp.json -----
# El starter renderizado al repo publico NO trae .mcp.json (lleva el bearer del skill-server),
# asi que sin este paso Claude Code no conecta al MCP `specoe`. Generamos el bootstrap con
# PLACEHOLDERS (sin secreto en disco): el SessionStart hook specoe-license-check.mjs lo puebla
# con el JWT fresco en cada arranque (fix #3). Idempotente: no pisa un .mcp.json ya presente.

if [ ! -f .mcp.json ]; then
  log "Generando .mcp.json (bootstrap del MCP skill-server)..."
  cat > .mcp.json <<'EOF'
{
  "mcpServers": {
    "specoe": {
      "type": "sse",
      "url": "${SPECOE_SKILL_SERVER_URL:-https://mcp.integra.local/sse}",
      "headers": {
        "Authorization": "Bearer ${SPECOE_SKILL_JWT}"
      }
    }
  }
}
EOF
  log "  [CREATE]  .mcp.json (el JWT lo puebla el hook al abrir Claude Code)"
else
  log "  [SKIP]    .mcp.json (ya existe)"
fi

fi # cierra: if DO_ROOM (parte de carpeta — config + .mcp.json)

# ----- 6. Next steps -----

log "Setup base completado."
if [ "$DO_ROOM" = 0 ]; then
  log "  (host-only: bundle de hooks + dependencias instalados en ~/.claude)"
else
  log ""
  log "Proximos pasos:"
  log "  1. Revisar y completar project.config.yaml"
  log "  2. Activar license (el SessionStart hook lo hace automaticamente al abrir Claude Code)"
  log "  3. Iniciar Claude Code: claude"
  log "  4. Ver docs/QUICKSTART-VSCODE.md para el arranque en VSCode"
  log ""
  HUB_SHOW=$(grep -E '^\s*api-url:' project.config.yaml | head -1 | sed 's/.*api-url: *//;s/"//g' || true)
  log "Hub: ${HUB_SHOW:-<no configurado>}"
  log "(default piloto interno: hub.integra.local. Suite on-premise: contactar a Integra Software)"
fi
