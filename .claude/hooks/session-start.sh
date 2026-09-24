#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

if [ -f node_modules/.package-lock.json ] && [ node_modules/.package-lock.json -nt package-lock.json ]; then
  exit 0
fi

npm ci --no-audit --no-fund >&2
