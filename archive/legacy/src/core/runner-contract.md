# Runner Adapter Contract

`AgentRunner` is intentionally small. Adapters own CLI-specific behavior and
map it into `AgentRunResult`; core code must not string-match raw stdout or
stderr from individual CLIs.

Every adapter invocation must enforce both cost caps available to that CLI:
the prompt-template `maxTurns` equivalent when the CLI supports one, and a
wall-clock timeout enforced by Wake. If a CLI cannot express `maxTurns`, its
adapter must compensate with a tighter wall-clock cap and document the gap.

Adapters classify failed invocations as:

- `task`: the agent ran and reported it could not complete the task.
- `quota`: rate limits, spend caps, auth exhaustion, or equivalent capacity
  failures.
- `infra`: missing binaries, crashes, timeouts, malformed output, or other
  execution problems unrelated to task quality.

Raw CLI output may be stored in `metadata` for debugging. Routing, lifecycle,
retry, and quota logic must use structured fields such as `failureClass`,
`model`, `cli`, `session_id`, and the parsed Wake result envelope.
