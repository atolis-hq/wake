#!/usr/bin/env bash
set -uo pipefail

mkdir -p /wake/logs

write_ngrok_public_url() {
  local output_file="/wake/control-plane-ui-url"

  rm -f "${output_file}"
  for _ in $(seq 1 30); do
    local public_url
    public_url="$(
      node -e '
const http = require("node:http");
const req = http.get("http://127.0.0.1:4040/api/tunnels", (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => {
    try {
      const tunnels = JSON.parse(body).tunnels ?? [];
      const tunnel = tunnels.find((entry) => typeof entry.public_url === "string" && entry.public_url.startsWith("https://"))
        ?? tunnels.find((entry) => typeof entry.public_url === "string");
      if (tunnel !== undefined) {
        process.stdout.write(tunnel.public_url);
      }
    } catch {}
  });
});
req.on("error", () => {});
req.setTimeout(1000, () => req.destroy());
' || true
    )"

    if [ -n "${public_url}" ]; then
      printf '%s\n' "${public_url}" > "${output_file}"
      echo "wake ui: ngrok tunnel available at ${public_url}"
      return 0
    fi

    sleep 1
  done

  echo "wake ui: ngrok tunnel started but public URL was not discovered; see /wake/logs/ngrok.log"
}

if [ "${WAKE_UI_ENABLED:-false}" = "true" ]; then
  echo "wake ui: starting on 0.0.0.0:${WAKE_UI_PORT:-4317}"
  node /app/dist/src/main.js ui \
    --wake-root /wake \
    --host 0.0.0.0 \
    --port "${WAKE_UI_PORT:-4317}" \
    ${WAKE_UI_TOKEN:+--token "${WAKE_UI_TOKEN}"} \
    >> /wake/logs/ui.log 2>&1 &

  if [ "${WAKE_UI_TUNNEL_ENABLED:-false}" = "true" ]; then
    if [ -n "${NGROK_AUTHTOKEN:-}" ]; then
      ngrok config add-authtoken "${NGROK_AUTHTOKEN}" >> /wake/logs/ngrok.log 2>&1
    fi

    echo "wake ui: starting ngrok tunnel for 127.0.0.1:${WAKE_UI_PORT:-4317}"
    ngrok http "127.0.0.1:${WAKE_UI_PORT:-4317}" --log=stdout >> /wake/logs/ngrok.log 2>&1 &
    write_ngrok_public_url &
  fi
fi

if [ "${WAKE_START_ENABLED:-false}" = "true" ]; then
  echo "wake start: starting resident loop"
  node /app/dist/src/main.js start \
    --wake-root /wake \
    >> /wake/logs/start.log 2>&1 &
  echo "$!" > /wake/logs/start.pid
fi

exec sleep infinity
