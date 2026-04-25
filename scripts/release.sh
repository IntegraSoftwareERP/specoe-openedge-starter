#!/usr/bin/env bash
# release.sh — semantic versioning + git tag.
#
# CONTEXTO: este script esta disenado para correr desde la raiz del repo
# publico `specoe-openedge-starter` (clonado por el cliente). NO correrlo
# desde el monorepo `specoe-platform/packages/starter-template/` — el `git
# tag` taggearia el monorepo con un nombre equivocado (el workflow F3 de
# SPEC-0024 usa `starter-vX.Y.Z` para releases del monorepo -> publico).
#
# Para release del starter desde el monorepo:
#   cd specoe-platform
#   git tag -a starter-v0.1.0 -m "Release 0.1.0"
#   git push origin starter-v0.1.0
# El workflow .github/workflows/sync-starter.yml hace el sync automatico.
#
# Uso (standalone):
#   ./scripts/release.sh [patch|minor|major]

set -euo pipefail

# Guard: detectar si corremos en el monorepo y salir con error.
if [ -f "../../package.json" ] && grep -q '"@specoe/platform"' "../../package.json" 2>/dev/null; then
  echo "ERROR: este script no debe correrse desde el monorepo specoe-platform." >&2
  echo "       Para release del starter en el monorepo, ver comentario al inicio del script." >&2
  exit 2
fi

BUMP="${1:-patch}"
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "Uso: ./scripts/release.sh [patch|minor|major]" >&2; exit 1 ;;
esac

# Leer version actual del package.json si existe, sino de VERSION file.
if [ -f package.json ]; then
  CURRENT=$(node -p "require('./package.json').version")
else
  CURRENT="${CURRENT:-0.0.0}"
  [ -f VERSION ] && CURRENT=$(cat VERSION)
fi

IFS='.' read -r MAJOR MINOR PATCH <<<"$CURRENT"
case "$BUMP" in
  patch) PATCH=$((PATCH + 1));;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac
NEW="${MAJOR}.${MINOR}.${PATCH}"

echo "Release: $CURRENT -> $NEW"

# Actualizar VERSION file
echo "$NEW" > VERSION

# Si hay package.json, actualizar ahi tambien
if [ -f package.json ]; then
  node -e "const p=require('./package.json'); p.version='$NEW'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n');"
fi

# Regenerar changelog
./scripts/changelog.sh > CHANGELOG.md || echo "(changelog.sh no disponible o fallo)"

# Commit + tag
git add VERSION CHANGELOG.md package.json 2>/dev/null || true
git commit -m "chore(release): $NEW"
git tag -a "v$NEW" -m "Release $NEW"

echo "Listo. Push con:"
echo "  git push && git push --tags"
