#!/usr/bin/env bash
# specoe-room-ccdev.sh — Instancia el room CC_DEV (wrapper de specoe-add-room.sh). TKT-0187.
# Uso: ./specoe-room-ccdev.sh <LICENSE_KEY> [--dir <carpeta>] [--hub <url>]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/specoe-add-room.sh" CC_DEV "$@"
