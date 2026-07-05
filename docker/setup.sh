#!/usr/bin/env bash
set -euo pipefail

if [ ! -f /home/wake/.ssh/id_ed25519 ]; then
  mkdir -p /home/wake/.ssh
  chmod 700 /home/wake/.ssh
  ssh-keygen -t ed25519 -f /home/wake/.ssh/id_ed25519 -N ""
fi

gh auth login
gh auth setup-git

cat /home/wake/.ssh/id_ed25519.pub

claude setup-token
