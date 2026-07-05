#!/usr/bin/env bash
set -euo pipefail

container_name="${1:-wake-sandbox}"

docker exec -it "$container_name" gh auth login
docker exec -it "$container_name" gh auth setup-git

docker exec -it "$container_name" bash -lc '
set -euo pipefail
if [ ! -f /home/wake/.ssh/id_ed25519 ]; then
  mkdir -p /home/wake/.ssh
  chmod 700 /home/wake/.ssh
  ssh-keygen -t ed25519 -f /home/wake/.ssh/id_ed25519 -N ""
fi
cat /home/wake/.ssh/id_ed25519.pub
'

docker exec -it "$container_name" claude setup-token
