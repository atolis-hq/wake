# Workspace crash recovery design

**Status:** Approved

## Decision

Wake preserves legacy workspace recovery by making ownership durable before a
workspace clone is prepared. On startup/recovery it reclaims only workspaces
that durable Execution state proves are safe to remove.

## Ownership and recovery

Execution creates a managed ownership marker before cloning. It records the
Run ID, Work ID, repository identity, workspace path, and workspace mode.
The marker bridges the interval before `execution.run-started` is durably
appended.

The recovery sweep reads ownership markers and the journal-backed Run views:

- a terminal Run's marked workspace is reclaimed;
- a marker whose Run was never started is reclaimed, because no agent can
  have been launched;
- a Started or Ambiguous Run's workspace is retained;
- an unmarked or malformed directory is retained for operator inspection.

Cleanup uses the existing workspace release/delete mechanism. A failed delete
is recorded/visible and does not block other recovery or dispatch work. A
successful delete removes its ownership marker. Re-running recovery is
idempotent.

## Safety boundaries

The sweep never uses directory age. It never deletes a path outside the
managed workspace root, nor one which lacks a valid ownership marker. It
does not attempt to resolve ambiguous external execution; normal Execution
recovery owns that decision first.

No new user configuration is introduced. Existing workspace-root ownership,
Execution events, and transcript-retention behaviour remain authoritative.

## Tests

Composed tests must prove a crash after marker acquisition but before
`RunStarted` is reclaimed on restart; a terminal marked workspace is
reclaimed; Started/Ambiguous workspaces are retained; unknown directories are
retained; retry/restart is idempotent; and one cleanup failure does not block
subsequent safe reclamation.
