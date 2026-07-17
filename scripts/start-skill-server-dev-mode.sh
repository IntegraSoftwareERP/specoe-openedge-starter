#!/usr/bin/env bash
# start-skill-server-dev-mode.sh -- SPEC-0001 F7 Item 6 PREP -- helper para
# levantar el MCP Skill Server localmente en --dev-mode con tenant fake.
#
# Uso:
#   ./scripts/start-skill-server-dev-mode.sh                # default: tenant integra-piloto-test
#   ./scripts/start-skill-server-dev-mode.sh --tenant <id>  # tenant custom
#   ./scripts/start-skill-server-dev-mode.sh --port 3200    # puerto alternativo
#
# IMPORTANTE: el dev-mode acepta cualquier token >= 10 chars sin validacion
# criptografica. NO sustituye la validacion E2E productiva (smoke 2/2 con JWT
# real esta diferido a F7 Item 6 Sebastian onboarding per B10 closeout).

set -uo pipefail

TENANT="integra-piloto-test"
PORT="3100"
SKILL_SERVER_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant)         TENANT="$2"; shift 2 ;;
    --port)           PORT="$2"; shift 2 ;;
    --skill-server)   SKILL_SERVER_DIR="$2"; shift 2 ;;
    --help|-h)        sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "[start-dev-mode] Argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

# Resolver path al skill-server. Asumir que el monorepo specoe-platform esta
# clonado al lado o configurar via --skill-server.
if [ -z "$SKILL_SERVER_DIR" ]; then
  for candidate in \
    "$(pwd)/../specoe-platform/packages/skill-server" \
    "$(pwd)/packages/skill-server" \
    "$HOME/Integra/specoe-platform/packages/skill-server"; do
    if [ -d "$candidate" ]; then
      SKILL_SERVER_DIR="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi

if [ -z "$SKILL_SERVER_DIR" ] || [ ! -d "$SKILL_SERVER_DIR" ]; then
  echo "[start-dev-mode] ERROR: skill-server dir no encontrado." >&2
  echo "  Probe: ../specoe-platform/packages/skill-server, ./packages/skill-server, ~/Integra/specoe-platform/packages/skill-server" >&2
  echo "  Pasar explicito: --skill-server /path/to/specoe-platform/packages/skill-server" >&2
  echo "" >&2
  echo "  Para clonar el monorepo (requiere acceso interno Integra):" >&2
  echo "    git clone https://github.com/IntegraSoftwareERP/specoe-platform.git" >&2
  exit 2
fi

# Verificar tenant fixture existe
TENANT_CONFIG="$SKILL_SERVER_DIR/src/content-source/tenants/$TENANT/project.config.yaml"
if [ ! -f "$TENANT_CONFIG" ]; then
  echo "[start-dev-mode] ERROR: tenant fixture '$TENANT' no encontrado en $TENANT_CONFIG" >&2
  echo "  Tenants disponibles:" >&2
  ls -1 "$SKILL_SERVER_DIR/src/content-source/tenants/" 2>/dev/null | sed 's/^/    - /' >&2
  exit 2
fi

echo "== start-skill-server-dev-mode =="
echo "  skill-server dir: $SKILL_SERVER_DIR"
echo "  tenant fixture:   $TENANT"
echo "  port:             $PORT"
echo ""

# Instrucciones para configurar el starter cliente
echo "Para conectar el starter (este repo) al skill server local en dev-mode:"
echo ""
echo "  1. Editar project.config.yaml del starter:"
echo ""
echo "     hub:"
echo "       api-url: http://127.0.0.1:$PORT"
echo ""
echo "  2. Crear ~/.claude/integra-hub.env con token fake:"
echo ""
echo "     INTEGRA_HUB_URL=http://127.0.0.1:$PORT"
echo "     INTEGRA_HUB_EMAIL=dev@$TENANT.local"
echo "     INTEGRA_HUB_PASSWORD=dev-fake-token-1234567890"
echo ""
echo "     node ~/.claude/scripts/migrate-hub-credentials.mjs"
echo ""
echo "  3. Validar con:"
echo "     ./scripts/validate-content.sh --dev-mode --jwt dev-fake-token-1234567890"
echo ""
echo "Arrancando skill-server en --dev-mode (Ctrl+C para detener)..."
echo ""

# Arrancar skill-server con secret fake + binding 127.0.0.1
cd "$SKILL_SERVER_DIR"

if [ ! -d "node_modules" ]; then
  echo "[start-dev-mode] node_modules no existe, ejecutando npm install..."
  cd "$SKILL_SERVER_DIR/../.." && npm install --workspaces && cd "$SKILL_SERVER_DIR"
fi

LICENSE_JWT_SECRET=dev-mode-secret-not-for-prod \
SKILL_SERVER_PORT="$PORT" \
SKILL_SERVER_HOST="127.0.0.1" \
exec npm run dev
