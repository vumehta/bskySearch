#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

if [ -z "${BROWSER_TEST_EXECUTABLE:-}" ] && [ -x /opt/pw-browsers/chromium ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export BROWSER_TEST_EXECUTABLE=/opt/pw-browsers/chromium' >> "$CLAUDE_ENV_FILE"
fi

if [ -f node_modules/.package-lock.json ] && [ node_modules/.package-lock.json -nt package-lock.json ] \
  && npm ls --all >/dev/null 2>&1; then
  exit 0
fi

npm ci --no-audit --no-fund >&2
