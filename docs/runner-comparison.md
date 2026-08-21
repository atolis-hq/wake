# Runner comparison

Wake chooses runners through `execution.agentRunners` and ordered
`execution.runnerPools`; a workflow stage names a pool, not a CLI. Every
runner implements the same Execution `Runner` contract: it starts an external
execution, exposes cancellation, returns a normalized transport result, and is
protected by the configured wall-clock timeout. See
[Configuration](configuration.md) for runner definitions and pools.

## Shared behaviour

Claude, Codex, Cursor, command, and fake runners all receive the rendered
prompt, optional model/effort, workspace details, a resume session identifier,
and the same cancellation signal. Wake records the selected runner, its model
metadata, lifecycle, reported session identity, raw runner result, and final
normalized Activity outcome in durable Run facts.

Process runners time out after 10 minutes without stdout or stderr activity
(`runnerTimeouts.idleMs: 600000`) or after 2 hours in total
(`runnerTimeouts.hardMs: 7200000`), then allow 30 seconds for graceful
cancellation before escalation. A timeout or non-zero process exit is a failed
transport result, not a successful workflow outcome. The Activity translates a successful runner response into `DONE`,
`REJECTED`, `BLOCKED`, or `FAILED`; Orchestration then applies the configured
workflow route.

## CLI capability matrix

| Capability | Claude (`claude-cli`) | Codex (`codex-cli`) | Cursor (`cursor-cli`) |
| --- | --- | --- | --- |
| Structured output | `--output-format json` | `exec --json` JSONL | `--output-format json` |
| Resume | `--resume <session>` | `exec ... resume <session>` | `--resume=<session>` |
| Model | `--model` | `--model` | `--model` |
| Effort | `--effort` | `-c model_reasoning_effort=<value>` | No adapter flag |
| `maxTurns` | `--max-turns` | No adapter flag | No adapter flag |
| `allowedTools` | `--allowedTools` | No adapter flag | No adapter flag |
| Read-only workspace | Prompt/tool policy only | `--sandbox workspace-write` | `--mode ask` |
| Branch workspace | Prompt/tool policy only | `--sandbox danger-full-access` | `--force` |
| Session id parsing | JSON `session_id` | JSONL `thread.started.thread_id` | JSON `session_id` |
| Token usage parsing | JSON `usage` and cost | JSONL `turn.completed.usage` | JSON `usage` |

`allowedTools` and `maxTurns` in a prompt template are therefore portable
metadata but are enforced at the CLI boundary only by Claude. Codex and Cursor
still receive the prompt instruction and are bounded by the outer execution
timeout. Choose a runner pool based on the enforcement level your stage needs,
not merely model preference.

## Workspace policy

Wake owns workspace acquisition; a runner only receives the resulting path and
mode. `workspace: none` does not pass a workspace mode. For a read-only or
branch workspace, Codex maps the mode to its sandbox setting and Cursor maps it
to `ask` or `--force`. Claude does not derive a filesystem sandbox mode from
the workspace setting; use its allowed-tool policy and a prompt that states the
boundary.

No runner is entitled to choose a workspace, pool, workflow transition, or
provider action. Keep those decisions in workflow configuration.

## Resume and fallback

Execution may select a compatible terminal session for a primary-stage
Activation when its session policy permits resumption. A compatible session is
from the same CLI adapter kind; a `fresh` policy never resumes one. If the
first runner is quota-paused, Wake falls sideways to the next configured member
of that same pool. It never silently changes to a different pool.

## `command` and `fake`

`command` runs exactly the configured executable and argument list, without
adding a CLI protocol. Use it for a runner that already conforms to Wake's
expected result contract or for controlled integration environments.

`fake` is a deterministic zero-token runner intended for local tests, initial
Wake-home scaffolds, and configuration verification. Keeping it in a pool is a
safe way to exercise workflow composition before enabling a real CLI.

## Sandbox credentials

Mount only credential files that a runner needs through
`host.sandbox.extraMounts`; do not bind-mount an entire CLI configuration
directory. The generated `SETUP.md` explains the supported narrow mounts and
their read-only trade-offs. Run `wake sandbox setup` to configure credentials
inside the sandbox and `wake smoke` to exercise the configured default pool.
