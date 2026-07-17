#!/usr/bin/env bash
# specoe-room-adversarial.sh — Instancia el room ADVERSARIAL (wrapper de specoe-add-room.sh).
# Uso: ./specoe-room-adversarial.sh <LICENSE_KEY> [--dir <carpeta>] [--hub <url>]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/specoe-add-room.sh" ADVERSARIAL "$@"
