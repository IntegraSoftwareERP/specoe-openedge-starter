#!/usr/bin/env bash
# specoe-room-discovery.sh — Instancia el room DISCOVERY (wrapper de specoe-add-room.sh).
# Uso: ./specoe-room-discovery.sh <LICENSE_KEY> [--dir <carpeta>] [--hub <url>]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/specoe-add-room.sh" DISCOVERY "$@"
