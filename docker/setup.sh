#!/usr/bin/env bash
set -euo pipefail

echo "Wake sandbox setup starting."

prompt_yes_no() {
  local message="$1"
  local reply
  read -r -p "${message} [y/N] " reply
  case "$reply" in
    [Yy]|[Yy][Ee][Ss])
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [ ! -f /home/wake/.ssh/id_ed25519 ]; then
  mkdir -p /home/wake/.ssh
  chmod 700 /home/wake/.ssh
  ssh-keygen -t ed25519 -f /home/wake/.ssh/id_ed25519 -N ""
fi

if prompt_yes_no "Configure GitHub auth?"; then
  gh auth login
  gh auth setup-git
else
  echo "Skipping GitHub auth setup."
fi

cat /home/wake/.ssh/id_ed25519.pub

if prompt_yes_no "Configure Claude auth?"; then
  claude auth login --claudeai
else
  echo "Skipping Claude auth setup."
fi
