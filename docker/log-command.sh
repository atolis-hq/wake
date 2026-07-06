#!/usr/bin/env bash
set -euo pipefail

label="${WAKE_SANDBOX_LABEL:-sandbox.exec}"
host_wake_root="${WAKE_SANDBOX_HOST_WAKE_ROOT:-/wake}"
container_wake_root="${WAKE_SANDBOX_CONTAINER_WAKE_ROOT:-/wake}"
prompts_root="${WAKE_SANDBOX_PROMPTS_ROOT:-/wake/prompts}"
container_home="${WAKE_SANDBOX_CONTAINER_HOME:-/home/wake}"
host_container_home="${WAKE_SANDBOX_HOST_CONTAINER_HOME:-}"
container_mount="${WAKE_SANDBOX_CONTAINER_MOUNT:-/wake}"
container_name="${WAKE_SANDBOX_CONTAINER_NAME:-wake-sandbox}"
working_dir="${WAKE_SANDBOX_CWD:-}"

mirror_stdout() {
  local line="$1"
  printf '%s\n' "${line}"
  if [ -w /proc/1/fd/1 ]; then
    printf '%s\n' "${line}" > /proc/1/fd/1 || true
  fi
}

mirror_stderr() {
  local line="$1"
  printf '%s\n' "${line}" >&2
  if [ -w /proc/1/fd/2 ]; then
    printf '%s\n' "${line}" > /proc/1/fd/2 || true
  fi
}

scrub() {
  sed -E \
    -e 's/([A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASS|KEY)[A-Za-z0-9_]*=)[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/(gho|ghp|github_pat)_[A-Za-z0-9_]+/[REDACTED]/g'
}

emit_check() {
  local description="$1"
  shift
  local output
  set +e
  output="$("$@" 2>&1)"
  local status=$?
  set -e
  if [ -n "${output}" ]; then
    while IFS= read -r line; do
      [ -n "${line}" ] && mirror_stdout "[${label}] ${description}: ${line}"
    done < <(printf '%s\n' "${output}" | scrub)
  else
    mirror_stdout "[${label}] ${description}: (no output)"
  fi
  mirror_stdout "[${label}] ${description}: exit_code=${status}"
}

if [ "${1:-}" != "--" ]; then
  mirror_stderr "[${label}] expected -- before the wrapped command"
  exit 64
fi
shift

if [ "$#" -eq 0 ]; then
  mirror_stderr "[${label}] no wrapped command was provided"
  exit 64
fi

if [ -n "${working_dir}" ]; then
  cd "${working_dir}"
fi

mirror_stdout "[${label}] begin ts=$(date -u +%FT%TZ) cwd=$(pwd) command=$*"
mirror_stdout "[${label}] paths hostWakeRoot=${host_wake_root} containerWakeRoot=${container_wake_root} promptsRoot=${prompts_root} containerHome=${container_home} hostContainerHome=${host_container_home} containerMount=${container_mount} containerName=${container_name}"

emit_check "wake-config" test -f "${container_mount}/config.json"
emit_check "prompts-root" test -d "${prompts_root}"
emit_check "workspaces-root" test -d "${container_mount}/workspaces"
emit_check "repos-root" test -d "${container_mount}/repos"
emit_check "gh-auth-status" gh auth status
emit_check "claude-auth-status" claude auth status

set +e
"$@" \
  > >(while IFS= read -r line; do mirror_stdout "[${label}] stdout: ${line}"; done) \
  2> >(while IFS= read -r line; do mirror_stderr "[${label}] stderr: ${line}"; done)
status=$?
set -e

mirror_stdout "[${label}] end exit_code=${status}"
exit "${status}"
