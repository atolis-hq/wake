# Add better container-side debug logging for Wake runs

Implemented on 2026-07-06:
- forwarded sandbox commands now run through `/wake/docker/log-command.sh`, which emits command metadata, path resolution, readiness/auth checks, and command output into container logs
- `wake sandbox logs` now tails Docker logs for the durable sandbox container instead of Wake-managed log files
- Claude runner failures now include a container-log breadcrumb when available

Remaining follow-up, if needed:
- expand redaction rules if future auth/status commands emit new sensitive fields
- if a future control-plane UI needs richer activity history, prefer structured Wake events/run metadata over raw log-file retention

The current Docker sandbox flow is now usable, but it is still too opaque when
something goes wrong during `wake.sh start`, `wake.sh tick`, or `wake sandbox`
operations.

Recent bootstrap/debugging issues showed the gap:
- wrapper/runtime argument rewriting bugs surfaced only as terse `docker exec`
  failures,
- container auth problems (`gh`, `claude`) were only visible by manually
  `docker exec`-ing into the sandbox and probing state,
- Wake run failures often collapse to a `FAILED` sentinel without enough
  container-side context to see what command ran, which paths/config it used,
  or what environment shape it saw.

Not urgent for the current slice, but this should be added before relying on
the sandbox loop unattended.

When picked up:
- Add a dedicated container log file under `/wake/logs/` for sandbox lifecycle
  actions (`build`, `up`, `setup`, forwarded `tick` / `start` / `smoke`
  invocations).
- Record the exact forwarded command, effective working directory, and the
  resolved Wake config paths (`wakeRoot`, `promptsRoot`, sandbox mount paths).
- Log key auth/readiness checks in a scrubbed form:
  `gh auth status`, `claude auth status`, whether expected config files exist,
  and whether required workspaces/repos/prompts paths are present.
- Include run-level breadcrumbs for runner failures so a `FAILED` run record
  can point at the relevant container log location.
- Add a lightweight `wake sandbox logs` or equivalent helper for tailing the
  latest container-side debug log without needing a manual `docker exec`.
- Be careful to redact secrets and tokens. The goal is operational visibility,
  not dumping raw credential files or environment variables.
