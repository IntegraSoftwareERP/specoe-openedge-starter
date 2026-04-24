#!/usr/bin/env bash
# changelog.sh — regenera CHANGELOG.md desde commits convencionales.

set -euo pipefail

TAGS=$(git tag --sort=-version:refname | head -20)

echo "# Changelog"
echo ""
echo "All notable changes to this project. Automatic — regenerado por ./scripts/changelog.sh."
echo ""

PREV_TAG=""
for TAG in $TAGS; do
  if [ -z "$PREV_TAG" ]; then
    RANGE="$TAG"
  else
    RANGE="$TAG..$PREV_TAG"
  fi
  DATE=$(git log -1 --format=%ai "$TAG" | cut -d' ' -f1)
  echo "## $TAG — $DATE"
  echo ""
  git log "$RANGE" --pretty=format:"- %s" --no-merges 2>/dev/null | grep -vE "^- chore\(release\)" || true
  echo ""
  echo ""
  PREV_TAG="$TAG"
done

if [ -z "$TAGS" ]; then
  echo "## Sin tags todavia"
  echo ""
  echo "Commits en main/master:"
  git log --pretty=format:"- %s" --no-merges 2>/dev/null || echo "(sin commits)"
fi
