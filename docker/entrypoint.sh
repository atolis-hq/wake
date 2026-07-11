#!/usr/bin/env bash
set -uo pipefail

mkdir -p /wake/logs

if [ "${WAKE_UI_ENABLED:-false}" = "true" ]; then
  echo "wake ui: starting on 0.0.0.0:${WAKE_UI_PORT:-4317}"
  node /app/dist/src/main.js ui \
    --wake-root /wake \
    --host 0.0.0.0 \
    --port "${WAKE_UI_PORT:-4317}" \
    ${WAKE_UI_TOKEN:+--token "${WAKE_UI_TOKEN}"} \
    >> /wake/logs/ui.log 2>&1 &
fi

exec sleep infinity
