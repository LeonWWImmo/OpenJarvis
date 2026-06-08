#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

OPENJARVIS_DATA_DIR="${OPENJARVIS_DATA_DIR:-/data/openjarvis}"
OLLAMA_DATA_DIR="${OLLAMA_DATA_DIR:-/data/ollama}"

sudo mkdir -p \
  "${OPENJARVIS_DATA_DIR}/config" \
  "${OPENJARVIS_DATA_DIR}/brain/obsidian" \
  "${OPENJARVIS_DATA_DIR}/logs" \
  "${OLLAMA_DATA_DIR}"

if [[ ! -f "${OPENJARVIS_DATA_DIR}/config/config.toml" ]]; then
  sudo cp "${ROOT_DIR}/config.example.toml" "${OPENJARVIS_DATA_DIR}/config/config.toml"
fi

sudo chown -R "$(id -u):$(id -g)" "${OPENJARVIS_DATA_DIR}" "${OLLAMA_DATA_DIR}"

echo "Initialized:"
echo "  ${OPENJARVIS_DATA_DIR}"
echo "  ${OLLAMA_DATA_DIR}"
