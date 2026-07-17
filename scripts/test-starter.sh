#!/usr/bin/env bash
# test-starter.sh — validacion E2E de la estructura del starter.
# Uso:
#   ./scripts/test-starter.sh

set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "== Validando estructura del starter =="
echo ""

# Archivos obligatorios
check "project.config.yaml existe" test -f project.config.yaml
check "setup.sh existe y es ejecutable" test -x setup.sh
check "README.md existe" test -f README.md
check ".gitignore existe" test -f .gitignore

# .claude — modelo diskless (SPEC-0133 P5): el room NO lleva IP en disco.
# El contrato del room y sus skills/commands/agents/standards bajan del MCP Skill
# Server en SessionStart (specoe-room-bootstrap.mjs) — no viven en el working dir.
check ".claude/settings.json existe" test -f .claude/settings.json
check ".claude/CLAUDE.md NO existe (diskless)" test ! -f .claude/CLAUDE.md
check ".claude/skills NO existe en disco (diskless)" test ! -d .claude/skills
check ".claude/commands NO existe en disco (diskless)" test ! -d .claude/commands
check ".claude/agents NO existe en disco (diskless)" test ! -d .claude/agents
check ".claude/standards NO existe en disco (diskless)" test ! -d .claude/standards

# Wiring MCP room->skill-server por SSE (SPEC-0133 P5 / T5.2)
check ".mcp.json existe" test -f .mcp.json
check ".mcp.json wire el skill-server specoe" grep -q '"specoe"' .mcp.json
check ".mcp.json usa transporte sse" grep -q '"type": "sse"' .mcp.json

# Docker (solo Dockerfile.pasoe para build CI/CD — Hub es SaaS por default)
check "docker/Dockerfile.pasoe existe" test -f docker/Dockerfile.pasoe

# Docs
check "docs/QUICKSTART.md existe" test -f docs/QUICKSTART.md
check "docs/CONFIGURATION.md existe" test -f docs/CONFIGURATION.md
check "docs/TROUBLESHOOTING.md existe" test -f docs/TROUBLESHOOTING.md

# Scripts
check "scripts/release.sh existe" test -f scripts/release.sh
check "scripts/changelog.sh existe" test -f scripts/changelog.sh

# Examples
check "examples/sample-entity/README.md existe" test -f examples/sample-entity/README.md

# Placeholders presentes en project.config.yaml (usuario los edita)
check "project.config.yaml tiene seccion 'project'" grep -q "^project:" project.config.yaml
check "project.config.yaml tiene seccion 'pasoe'" grep -q "^pasoe:" project.config.yaml
check "project.config.yaml tiene seccion 'paths'" grep -q "^paths:" project.config.yaml

# settings.json tiene los hooks del flujo SpecOE
check "settings.json tiene hook SessionStart" grep -q "SessionStart" .claude/settings.json
check "settings.json tiene hook Stop" grep -q "Stop" .claude/settings.json
check "settings.json registra el hook room-bootstrap (diskless)" grep -q "specoe-room-bootstrap.mjs" .claude/settings.json

# CI parity (SPEC-0133 P5) — el CI (ci.yml) corre lint + format y hace fail-fast; correrlos
# aca evita pushear con el CI en rojo (nos comio prettier en P2 y eslint en P5). El format usa
# --end-of-line auto a proposito: en Windows el working copy es CRLF (core.autocrlf, sin
# .gitattributes) y un check crudo daria falsos positivos; el CI corre en Linux (LF). Aca
# validamos CONTENIDO, no el EOL local.
echo ""
echo "== CI parity: lint + format =="
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ -f "$REPO_ROOT/package.json" ] && [ -d "$REPO_ROOT/node_modules" ]; then
  check "eslint sin errores (npm run lint)" bash -c "cd '$REPO_ROOT' && npm run lint"
  check "prettier limpio en el starter (contenido)" bash -c "cd '$REPO_ROOT' && npx prettier --check --end-of-line auto 'packages/starter-template/**/*.{mjs,cjs,js,json,md,yaml,yml,ts}'"
else
  echo "  ⚠ saltado: node_modules del root no instalado (correr desde el monorepo)"
fi

echo ""
echo "== RESULTADO: $PASS pasaron, $FAIL fallaron =="

[ "$FAIL" -eq 0 ]
