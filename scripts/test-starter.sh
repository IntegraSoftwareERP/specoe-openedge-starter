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
check "setup.ps1 existe" test -f setup.ps1
check "README.md existe" test -f README.md
check ".gitignore existe" test -f .gitignore

# .claude
check ".claude/settings.json existe" test -f .claude/settings.json
check ".claude/CLAUDE.md existe" test -f .claude/CLAUDE.md
check ".claude/skills/openedge-abl/SKILL.md existe" test -f .claude/skills/openedge-abl/SKILL.md
check ".claude/skills/integra-pasoe/SKILL.md existe" test -f .claude/skills/integra-pasoe/SKILL.md
check ".claude/commands/sdd-ticket.md existe" test -f .claude/commands/sdd-ticket.md
check ".claude/commands/nueva-entidad.md existe" test -f .claude/commands/nueva-entidad.md
check ".claude/agents/abl-developer.md existe" test -f .claude/agents/abl-developer.md

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

# CLAUDE.md tiene placeholders (confirmar que NO esta ya renderizado)
check "CLAUDE.md tiene placeholder {{project.name}}" grep -q "{{project.name}}" .claude/CLAUDE.md

# settings.json tiene hook SessionStart
check "settings.json tiene hook SessionStart" grep -q "SessionStart" .claude/settings.json
check "settings.json tiene hook Stop" grep -q "Stop" .claude/settings.json

echo ""
echo "== RESULTADO: $PASS pasaron, $FAIL fallaron =="

[ "$FAIL" -eq 0 ]
