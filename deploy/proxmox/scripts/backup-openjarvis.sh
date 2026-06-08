#!/usr/bin/env bash
set -euo pipefail

DEST="${1:-$HOME/openjarvis-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SOURCE="${OPENJARVIS_DATA_DIR:-/data/openjarvis}"

mkdir -p "${DEST}"
sudo tar -czf "${DEST}/openjarvis-${STAMP}.tar.gz" "${SOURCE}"
echo "${DEST}/openjarvis-${STAMP}.tar.gz"
