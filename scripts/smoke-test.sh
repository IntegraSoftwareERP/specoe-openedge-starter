#!/usr/bin/env bash
# smoke-test.sh -- SPEC-0023 F4 -- verificacion end-to-end del ambiente del starter (tier-aware: SaaS vs Suite).
#
# Uso:
#   ./scripts/smoke-test.sh                 # dry-run (default): checks locales, sin red
#   ./scripts/smoke-test.sh --live          # ademas: curl Hub + MCP Skill Server
#   ./scripts/smoke-test.sh --live --jwt <token>   # ademas: validacion de licencia
#
# Exit codes:
#   0 = PASS (todos los checks OK)
#   1 = FAIL (1 o mas checks fallaron)
#   2 = ERROR (problema ejecutando el script)

set -uo pipefail

LIVE=0
JWT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --live)  LIVE=1; shift ;;
    --jwt)   JWT="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) echo "[smoke-test] Argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

PASS=0
FAIL=0
SKIP=0
FAIL_MSGS=()

pass() {
  echo "  [PASS] $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  [FAIL] $1 -- $2"
  FAIL=$((FAIL + 1))
  FAIL_MSGS+=("$1 -- $2")
}

skip() {
  echo "  [SKIP] $1 -- $2"
  SKIP=$((SKIP + 1))
}

# ----- Tier detection (helper comun, mirror exacto en smoke-test.ps1 Get-Tier) -----
# Lee hub.api-url de project.config.yaml y deriva el tier para que el smoke-test
# adapte sus checks (ej. docker/Dockerfile.pasoe se SKIPea para SaaS, ya que el
# cliente SaaS no construye PASOE local).
#   - "saas"  si la URL apunta a un dominio integrasoftware.biz
#   - "suite" en cualquier otro caso (URL local, custom, ausente o invalida)
detect_tier() {
  local hub_url
  hub_url=$(grep -E '^\s*(api-url|url):' project.config.yaml 2>/dev/null | head -1 | sed 's/.*: *//;s/"//g;s/'"'"'//g;s/#.*//;s/ *$//')
  case "$hub_url" in
    *integrasoftware.biz*) echo "saas" ;;
    *) echo "suite" ;;
  esac
}

TIER=$(detect_tier)

echo "== smoke-test del starter -- $([ $LIVE -eq 1 ] && echo 'LIVE' || echo 'DRY-RUN') -- tier=$TIER =="
echo ""

# ----- 1. Prerrequisitos -----
echo "[1/5] Prerrequisitos de ambiente"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\)\..*/\1/')
  if [ "$NODE_MAJOR" -ge 20 ]; then
    pass "Node $(node -v)"
  else
    fail "Node >= 20" "detectado $(node -v), se requiere 20+"
  fi
else
  fail "Node 20+" "no instalado en PATH"
fi

if command -v docker >/dev/null 2>&1; then
  pass "Docker $(docker --version | awk '{print $3}' | tr -d ',') (opcional -- no requerido en tier SaaS)"
else
  skip "Docker" "no instalado -- OK en tier SaaS (solo requerido para Suite on-premise)"
fi

if command -v claude >/dev/null 2>&1; then
  pass "Claude Code ($(claude --version 2>/dev/null | head -1 || echo 'ok'))"
else
  fail "Claude Code" "no instalado en PATH -- ver https://claude.ai/code"
fi

if command -v openssl >/dev/null 2>&1; then
  pass "openssl disponible (para generar secretos)"
else
  fail "openssl" "no instalado -- necesario para generar JWT/VAULT keys"
fi

# ----- 2. Archivos del starter -----
echo ""
echo "[2/5] Archivos del starter"

[ -f project.config.yaml ] && pass "project.config.yaml" || fail "project.config.yaml" "no existe en la raiz"
[ -f setup.sh ]            && pass "setup.sh"            || fail "setup.sh" "falta"
if [ "$TIER" = "saas" ]; then
  skip "docker/Dockerfile.pasoe" "tier SaaS -- el cliente no construye PASOE local"
else
  [ -f docker/Dockerfile.pasoe ] && pass "docker/Dockerfile.pasoe (build CI/CD)" || fail "docker/Dockerfile.pasoe" "falta"
fi
[ -d .claude ]                              && pass ".claude/ existe"                         || fail ".claude/" "falta -- correr ./setup.sh"
[ -f .claude/skills/openedge-abl/SKILL.md ] && pass ".claude/skills/openedge-abl/SKILL.md"    || fail ".claude/skills/openedge-abl/SKILL.md" "falta -- correr ./setup.sh"

# ----- 3. Config validation -----
echo ""
echo "[3/5] Validacion de project.config.yaml"

# Intentar specoe-validate si esta disponible
if command -v npx >/dev/null 2>&1 && npx --no-install specoe-validate --help >/dev/null 2>&1; then
  if npx --no-install specoe-validate project.config.yaml >/dev/null 2>&1; then
    pass "specoe-validate paso (schema Zod OK)"
  else
    fail "specoe-validate" "el yaml no pasa el schema (correr 'npx specoe-validate project.config.yaml' para detalle)"
  fi
else
  skip "specoe-validate" "no disponible -- instalar @specoe/config-tools para validacion completa"
  # Fallback minimo: chequear 4 campos obligatorios
  for field in "project:" "paths:" "database:" "pasoe:"; do
    if grep -q "^${field}" project.config.yaml; then
      pass "Seccion '${field%:}' presente"
    else
      fail "Seccion '${field%:}'" "no encontrada en project.config.yaml"
    fi
  done
fi

# ----- 4. Credenciales y .mcp.json -----
echo ""
echo "[4/5] Credenciales y MCP config"

# .mcp.json existencia (no commiteado, per-dev)
if [ -f .mcp.json ]; then
  pass ".mcp.json presente"
elif [ -f .mcp.json.example ]; then
  skip ".mcp.json" "no existe aun -- copiar desde .mcp.json.example"
else
  skip ".mcp.json" "sin template .example tampoco"
fi

# Keyring: hint file de SPEC-0005
if [ -f "$HOME/.claude/integra-hub-account.json" ]; then
  pass "Credenciales del Hub en keyring (hint file presente)"
elif [ -f "$HOME/.claude/integra-hub.enc" ]; then
  pass "Credenciales del Hub en cipher file (fallback Linux headless)"
elif [ -f "$HOME/.claude/integra-hub.env" ]; then
  skip "Credenciales del Hub" "aun en .env plaintext -- correr 'node ~/.claude/scripts/migrate-hub-credentials.mjs'"
else
  fail "Credenciales del Hub" "no hay keyring ni .env -- ver QUICKSTART paso 0"
fi

# ----- 5. Live checks -----
echo ""
if [ "$LIVE" -eq 1 ]; then
  echo "[5/5] Live checks (conectividad)"

  # Leer hub api-url del yaml (robusto: primera ocurrencia de api-url o url)
  HUB_URL=$(grep -E "^\s*(api-url|url):" project.config.yaml | head -1 | sed 's/.*: *//;s/"//g;s/#.*//;s/ *$//')
  if [ -z "$HUB_URL" ]; then
    fail "Hub URL" "no se pudo extraer de project.config.yaml"
  else
    if curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HUB_URL/health" 2>/dev/null | grep -q "^2"; then
      pass "Hub responde 2xx en $HUB_URL/health"
    else
      fail "Hub healthz" "$HUB_URL/health no responde 2xx (timeout 5s)"
    fi
  fi

  # JWT check
  if [ -n "$JWT" ]; then
    # Validacion de formato: 3 segmentos separados por punto
    if echo "$JWT" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'; then
      pass "JWT formato valido (3 segmentos)"
      # Opcional: validar contra Hub si tenemos URL
      if [ -n "$HUB_URL" ]; then
        if curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
          -H "Authorization: Bearer $JWT" "$HUB_URL/license/validate" 2>/dev/null | grep -q "^2"; then
          pass "JWT validado contra Hub"
        else
          fail "JWT validacion" "Hub rechazo el token (ver logs del Hub)"
        fi
      fi
    else
      fail "JWT formato" "debe ser 3 segmentos separados por punto"
    fi
  else
    skip "JWT validation" "no se paso --jwt <token>"
  fi
else
  echo "[5/5] Live checks -- SKIPPED (usar --live para habilitar)"
  skip "Hub healthz" "dry-run mode"
  skip "JWT validation" "dry-run mode"
fi

# ----- Summary -----
echo ""
echo "=================================================="
TOTAL=$((PASS + FAIL + SKIP))
echo "  Total: $TOTAL checks -- PASS: $PASS | FAIL: $FAIL | SKIP: $SKIP"
echo "=================================================="

if [ "$FAIL" -eq 0 ]; then
  echo "  RESULTADO: PASS"
  exit 0
else
  echo "  RESULTADO: FAIL"
  echo ""
  echo "  Checks que fallaron:"
  for msg in "${FAIL_MSGS[@]}"; do
    echo "    - $msg"
  done
  echo ""
  echo "  Ver docs/TROUBLESHOOTING.md para resolucion de cada caso."
  exit 1
fi
