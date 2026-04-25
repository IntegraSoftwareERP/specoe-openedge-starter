#!/usr/bin/env bash
# SpecOE OpenEdge Starter — setup para Linux / macOS / Git Bash Windows.
#
# Uso:
#   chmod +x setup.sh
#   ./setup.sh                                # default: usa hub.api-url del yaml
#   ./setup.sh --hub https://hub.mi-org.com   # override: apunta a otra instancia
#
# Modelo de deploy:
#   - SaaS (default): Hub y Skill Server provistos por Integra Software
#     (hub.integrasoftware.biz). Sin Docker en el cliente.
#   - Suite on-premise: cliente ejecuta Hub + Skill Server en su infra.
#     Contactar a Integra Software para detalles del tier.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log() { echo -e "\033[1;34m[specoe-setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[specoe-setup]\033[0m $*" >&2; }
err() { echo -e "\033[1;31m[specoe-setup]\033[0m $*" >&2; exit 1; }

# ----- 0. Parse argumentos -----

HUB_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub)
      HUB_URL="$2"
      shift 2
      ;;
    --help|-h)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      err "Argumento desconocido: $1 (usar --help)"
      ;;
  esac
done

# ----- 1. Prereqs -----

log "Verificando prerrequisitos..."

command -v node >/dev/null 2>&1 || err "node no encontrado. Instalar Node.js 20+."
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\)\..*/\1/')
[ "$NODE_MAJOR" -ge 20 ] || err "Node $NODE_MAJOR detectado. Se requiere 20+."

command -v claude >/dev/null 2>&1 || warn "Claude Code no encontrado en PATH. Instalar desde https://claude.ai/code"

[ -f project.config.yaml ] || err "project.config.yaml no existe en este directorio."

# ----- 1.5. Instalar bundle .claude (SPEC-0023 F6) -----
# Idempotente: copia hooks + scripts del bundle a ~/.claude/. NO pisa archivos existentes.
# Sin esto, los comandos del flow SpecOE (license check, hub auth, migrate credentials) no funcionan.

log "Instalando .claude bundle..."

CLAUDE_HOME="$HOME/.claude"
BUNDLE_DIR="$SCRIPT_DIR/.claude-bundle"

if [ ! -d "$BUNDLE_DIR" ]; then
  warn ".claude-bundle no existe en el starter — saltando install. Si Claude Code no autentica al Hub, contactar a Integra Software."
else
  mkdir -p "$CLAUDE_HOME/hooks" "$CLAUDE_HOME/scripts"

  install_if_absent() {
    local src="$1"
    local dst="$2"
    if [ ! -f "$src" ]; then
      warn "  [MISSING] $src — bundle incompleto"
      return
    fi
    if [ ! -f "$dst" ]; then
      cp "$src" "$dst"
      log "  [INSTALL] $dst"
    else
      log "  [SKIP]    $dst (ya existe)"
    fi
  }

  install_if_absent "$BUNDLE_DIR/hooks/credentials.mjs"               "$CLAUDE_HOME/hooks/credentials.mjs"
  install_if_absent "$BUNDLE_DIR/hooks/integra-hub-auth.mjs"          "$CLAUDE_HOME/hooks/integra-hub-auth.mjs"
  install_if_absent "$BUNDLE_DIR/hooks/specoe-license-check.mjs"      "$CLAUDE_HOME/hooks/specoe-license-check.mjs"
  install_if_absent "$BUNDLE_DIR/hooks/package.json"                  "$CLAUDE_HOME/hooks/package.json"
  install_if_absent "$BUNDLE_DIR/hooks/package-lock.json"             "$CLAUDE_HOME/hooks/package-lock.json"
  install_if_absent "$BUNDLE_DIR/scripts/migrate-hub-credentials.mjs" "$CLAUDE_HOME/scripts/migrate-hub-credentials.mjs"

  # Instalar dependencias del keyring si nunca se hizo (idempotente: skipea si node_modules existe).
  if [ -f "$CLAUDE_HOME/hooks/package.json" ] && [ ! -d "$CLAUDE_HOME/hooks/node_modules" ]; then
    log "  Instalando dependencias del keyring (npm install)..."
    (cd "$CLAUDE_HOME/hooks" && npm install --silent) || warn "  npm install fallo — los hooks pueden no funcionar hasta resolverlo"
  fi
fi

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

log "Config basica OK. (Para validacion completa, usar specoe-validate — ver docs/CONFIGURATION.md)"

# ----- 4. License -----

LICENSE_KEY="${SPECOE_LICENSE_KEY:-$(grep -E '^\s*key:' project.config.yaml | head -1 | sed 's/.*key: *//;s/"//g')}"
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

# ----- 6. Next steps -----

log "Setup base completado."
log ""
log "Proximos pasos:"
log "  1. Revisar y completar project.config.yaml"
log "  2. Activar license (el SessionStart hook lo hace automaticamente al abrir Claude Code)"
log "  3. Iniciar Claude Code: claude"
log "  4. Ver docs/QUICKSTART.md para el primer entity de ejemplo"
log ""
log "Hub: \${$(grep -E '^\s*api-url:' project.config.yaml | head -1 | sed 's/.*api-url: *//;s/"//g') :-<no configurado>}"
log "(default SaaS: hub.integrasoftware.biz. Suite on-premise: contactar a Integra Software)"
