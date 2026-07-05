# Clean up implement-stage workspaces (with a retention delay)

Found during code review of feat/claude-invoker.

`cleanupWorkspace` is defined on the `WorkspaceManager` contract
(src/core/contracts.ts) and implemented by both
`src/adapters/git/git-workspace-manager.ts` and
`src/adapters/fake/fake-workspace-manager.ts`, but nothing in
`src/core/tick-runner.ts` or `src/main.ts` ever calls it. Every completed
`implement` run's `git clone --local` under `.wake/workspaces/<repo>/<issue>`
is left on disk permanently - unbounded disk growth over the life of a
resident Wake process.

Discussed with the user (2026-07-05): don't just delete the workspace right
after the run finishes. A human may still want to `cd` into it and
`claude --resume <session_id>` per the resume instructions Wake posts in its
GitHub comment (see `formatWakeComment` in
src/adapters/github/github-issues-work-source.ts) - deleting immediately
would break that flow. Two requirements for the eventual fix:

1. **Only clean up once truly certain the workspace is no longer needed** -
   e.g. the issue has reached a terminal stage (`done`/`failed`/closed) AND
   there's no reasonable chance of a resume still being useful.
2. **Add a configurable retention delay** (e.g.
   `runner.workspaceRetentionMs` or similar) - clean up workspaces only after
   they've been idle/terminal for at least that long, so a human has a
   real window to jump in and resume the exact session before it's swept.

Shape when picked up:
- A periodic sweep (not an immediate post-run cleanup) that scans
  `.wake/workspaces/`, checks each issue's current stage + how long ago it
  went terminal, and calls `cleanupWorkspace` only past the retention window.
- Needs the same treatment for the canonical clones under `.wake/repos/` if
  those are ever pruned too (lower priority - one clone per repo, not per
  issue, so it grows much more slowly).
