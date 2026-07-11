#!/usr/bin/env bash
set -uo pipefail

mkdir -p /wake/logs

if [ "${WAKE_UI_ENABLED:-false}" = "true" ]; then
  if [ -z "${WAKE_UI_TOKEN:-}" ]; then
    echo "wake ui: WAKE_UI_ENABLED=true but WAKE_UI_TOKEN is unset; refusing to bind 0.0.0.0 without a token. Skipping auto-start." >&2
  else
    echo "wake ui: starting on 0.0.0.0:${WAKE_UI_PORT:-4317}"
    node /app/dist/src/main.js ui \
      --wake-root /wake \
      --host 0.0.0.0 \
      --port "${WAKE_UI_PORT:-4317}" \
      --token "${WAKE_UI_TOKEN}" \
      >> /wake/logs/ui.log 2>&1 &
  fi
fi

exec sleep infinity
