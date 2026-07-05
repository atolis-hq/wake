# Add a wall-clock timeout to agent runs

`docs/implementation.md` lists this as an MVP safety rail: "a hard wall-clock
timeout kills a run and counts it as a failed attempt". It is not implemented.

Currently `runClaudeCommand` in `src/adapters/claude/claude-runner.ts` spawns
the `claude` CLI with no timeout, so a stage run takes as long as the
underlying process takes, with no cap from Wake's side.

Not urgent today, but worth doing before this runs unattended for real
(a hung or runaway invocation would otherwise block the tick loop
indefinitely, since `tick-runner.ts` awaits `runner.run()` with no bound).

Rough shape when picked up:
- Configurable timeout in `WakeConfig` (e.g. `runner.claude.timeoutMs`).
- Kill the child process on expiry, treat the run as `FAILED`, and record
  the timeout as the reason in the run record.
