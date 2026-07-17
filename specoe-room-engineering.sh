#!/usr/bin/env bash
# specoe-room-engineering.sh — Instancia el room ENGINEERING (wrapper de specoe-add-room.sh). TKT-0187.
# Uso: ./specoe-room-engineering.sh <LICENSE_KEY> [--dir <carpeta>] [--hub <url>]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/specoe-add-room.sh" ENGINEERING "$@"
