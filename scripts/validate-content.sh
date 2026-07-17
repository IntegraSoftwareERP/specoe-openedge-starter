#!/usr/bin/env bash
# validate-content.sh -- SPEC-0001 F7 Item 6 PREP -- valida que el contenido IP
# del MCP Skill Server productivo es accesible para el cliente externo.
#
# Uso:
#   ./scripts/validate-content.sh --jwt <token>                         # default: https://mcp.integra.local/sse
#   ./scripts/validate-content.sh --jwt <token> --url <skill-server>    # custom endpoint
#   ./scripts/validate-content.sh --dev-mode --jwt dev-fake-1234567890  # local --dev-mode
#
# Exit codes:
#   0 = PASS (todos los checks OK)
#   1 = FAIL (1 o mas checks fallaron)
#   2 = ERROR (problema ejecutando el script)

set -uo pipefail

JWT=""
URL="https://mcp.integra.local/sse"
DEV_MODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --jwt)       JWT="$2"; shift 2 ;;
    --url)       URL="$2"; shift 2 ;;
    --dev-mode)  DEV_MODE=1; URL="http://127.0.0.1:3100/sse"; shift ;;
    --help|-h)   sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "[validate-content] Argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

# Derivar healthz URL del SSE URL: <base>/sse -> <base>/healthz
HEALTHZ="${URL%/sse}/healthz"

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

echo "== validate-content -- MCP Skill Server checks contra $URL =="
if [ "$DEV_MODE" -eq 1 ]; then
  echo "   modo: dev (127.0.0.1:3100, tenant fake aceptado)"
fi
echo ""

# ----- [1/5] Server reachable (healthz) -----
echo "[1/5] Server reachable (healthz)"

HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTHZ" 2>/dev/null || echo "000")
case "$HTTP_CODE" in
  200) pass "Healthz responde 200 en $HEALTHZ" ;;
  000) fail "Healthz" "$HEALTHZ no responde (timeout 5s o DNS fail) -- VPN activa? URL correcta?" ;;
  *)   fail "Healthz" "$HEALTHZ retorna HTTP $HTTP_CODE (esperado 200)" ;;
esac

# ----- [2/5] JWT presente y formato valido -----
echo ""
echo "[2/5] JWT formato y presencia"

if [ -z "$JWT" ]; then
  fail "JWT" "no se paso --jwt <token> -- requerido para acceder al server productivo (en dev-mode usar token fake >= 10 chars)"
elif echo "$JWT" | grep -qE '^[A-Za-z0-9_./+=-]{10,}$'; then
  if [ "$DEV_MODE" -eq 1 ]; then
    pass "Token formato OK (dev-mode acepta cualquier string >= 10 chars)"
  elif echo "$JWT" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'; then
    pass "JWT formato valido (3 segmentos HS256 separados por punto)"
  else
    fail "JWT formato" "no parece JWT productivo (3 segmentos) -- usar --dev-mode si es token fake"
  fi
else
  fail "JWT formato" "token muy corto o caracteres invalidos"
fi

# ----- [3/5] SSE endpoint reachable con auth -----
echo ""
echo "[3/5] SSE endpoint reachable con JWT"

if [ -z "$JWT" ]; then
  skip "SSE check" "skipped por JWT ausente"
else
  # Connect SSE durante 2s, captar primer evento del server (initial endpoint event).
  # MCP SSE transport emite event con session URL al conectar.
  SSE_OUT=$(curl -sS -N --max-time 2 \
    -H "Authorization: Bearer $JWT" \
    -H "Accept: text/event-stream" \
    "$URL" 2>/dev/null | head -c 1000 || echo "")

  if echo "$SSE_OUT" | grep -qE "^(event:|data:|:)"; then
    pass "SSE responde con eventos (initial server event recibido)"
  elif [ -z "$SSE_OUT" ]; then
    fail "SSE connect" "no se recibio output (timeout 2s, auth rejected, o conexion cerrada)"
  else
    fail "SSE format" "respuesta no es formato SSE -- ver primeros bytes: $(echo "$SSE_OUT" | head -c 100)"
  fi
fi

# ----- [4/5] Verificacion manual via Claude Code (skip + instructions) -----
echo ""
echo "[4/5] Validacion contenido IP via Claude Code (manual)"
skip "skill_get_content/command_get_content/agent_get_content" "requiere Claude Code para test E2E"
echo ""
echo "    Para validar el contenido IP cargado, ejecutar en una sesion de Claude Code"
echo "    autenticada con el JWT del cliente externo:"
echo ""
echo "      mcp__specoe__skill_get_content('integra-pasoe')"
echo "        -> debe retornar SKILL.md de integra-pasoe (~3000+ chars)"
echo "        -> debe contener seccion '## Cuando activar'"
echo "        -> debe contener seccion '## Copyright header obligatorio (SPEC-0029 F7'"
echo ""
echo "      mcp__specoe__skill_get_content('integra-pasoe', section='cls-template')"
echo "        -> debe retornar template ABL .cls"
echo "        -> debe contener '/* Copyright 2026 ...'"
echo ""
echo "      mcp__specoe__skill_get_content('integra-pasoe', section='i-template')"
echo "        -> debe retornar template ABL .i"
echo ""
echo "      mcp__specoe__command_get_content('nueva-entidad')"
echo "        -> debe retornar markdown del command (tier TEAM o superior)"
echo ""
echo "      mcp__specoe__agent_get_content('abl-developer')"
echo "        -> debe retornar markdown del agent"

# ----- [5/5] Tier check via license JWT (manual) -----
echo ""
echo "[5/5] Tier check via license JWT (manual)"
skip "tier verification" "decode del JWT requiere base64 + jq para parsear payload"
echo ""
echo "    Para verificar tu tier desde el JWT:"
echo ""
echo "      echo '$JWT' | cut -d. -f2 | base64 -d 2>/dev/null | jq '.tier'"
echo ""
echo "    Tiers esperados:"
echo "      'solo'       -> solo skill_get_content (skills libres + integra-pasoe)"
echo "      'team'       -> skills + commands + agents productivos"
echo "      'enterprise' -> todo + standards corporativos"
echo "      'dev'        -> all-features (solo dev-mode local)"

# ----- Summary -----
echo ""
echo "=================================================="
TOTAL=$((PASS + FAIL + SKIP))
echo "  Total: $TOTAL checks -- PASS: $PASS | FAIL: $FAIL | SKIP: $SKIP (manual)"
echo "=================================================="

if [ "$FAIL" -eq 0 ]; then
  if [ "$SKIP" -gt 0 ]; then
    echo "  RESULTADO: PARTIAL ($PASS/$((PASS+FAIL)) automated PASS, $SKIP requieren validacion manual via Claude Code)"
  else
    echo "  RESULTADO: PASS ($PASS/$PASS)"
  fi
  exit 0
else
  echo "  RESULTADO: FAIL ($FAIL/$((PASS+FAIL)))"
  echo ""
  echo "  Checks que fallaron:"
  for msg in "${FAIL_MSGS[@]}"; do
    echo "    - $msg"
  done
  echo ""
  echo "  Troubleshooting:"
  echo "    - Si Healthz falla: VPN activa? URL correcta? Server productivo running?"
  echo "    - Si SSE falla con JWT productivo: token expirado o LICENSE_JWT_SECRET no matcha (pedir JWT nuevo a Integra)"
  echo "    - Si Items 3+4 de F7 INBOX (contenido IP no cargado al server productivo):"
  echo "      usar dev-mode local con tenant fake -> ver RUNBOOK-ONBOARDING-CLIENTE-EXTERNO.md"
  echo ""
  echo "  Ver docs/TROUBLESHOOTING.md para resolucion detallada."
  exit 1
fi
