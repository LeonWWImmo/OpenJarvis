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

MODEL="${1:-${OPENJARVIS_MODEL:-qwen3.5:4b}}"
docker compose --env-file "${ENV_FILE}" -f "${ROOT_DIR}/compose.yml" exec ollama ollama pull "${MODEL}"
