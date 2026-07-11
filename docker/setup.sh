#!/usr/bin/env bash
set -euo pipefail

echo "Wake sandbox setup starting."

codex_bootstrap_home="/home/wake/.codex"
codex_runtime_home="/home/wake/.codex-runtime"

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

prepare_codex_home() {
  mkdir -p "${codex_runtime_home}"

  if [ -f "${codex_bootstrap_home}/config.toml" ]; then
    cp "${codex_bootstrap_home}/config.toml" "${codex_runtime_home}/config.toml"
  fi

  if [ -f "${codex_bootstrap_home}/auth.json" ] && [ ! -f "${codex_runtime_home}/auth.json" ]; then
    cp "${codex_bootstrap_home}/auth.json" "${codex_runtime_home}/auth.json"
  fi

  export CODEX_HOME="${codex_runtime_home}"
}

prepare_codex_home

if [ ! -f /home/wake/.ssh/id_ed25519 ]; then
  mkdir -p /home/wake/.ssh
  chmod 700 /home/wake/.ssh
  ssh-keygen -t ed25519 -f /home/wake/.ssh/id_ed25519 -N ""
fi

if prompt_yes_no "Configure GitHub auth?"; then
  echo "Optional best practice: sign in with a dedicated GitHub identity for Wake-managed agent work,"
  echo "rather than your main personal account. Make sure it has only the repository access Wake needs."
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

if prompt_yes_no "Configure Codex auth?"; then
  codex login
else
  echo "Skipping Codex auth setup."
fi

if prompt_yes_no "Configure Cursor auth?"; then
  agent login
else
  echo "Skipping Cursor auth setup."
fi
