# Safely reintroduce label-driven stage sync

Found during code review of feat/claude-invoker.

`src/core/projection-updater.ts`'s `ticket.upsert`/`fake.issue.upsert`
handling used to re-derive `wake.stage` from the issue's GitHub labels on
every re-sync, even for an existing projection. That caused a real bug: Wake
posting its own status comment bumps the GitHub issue's `updatedAt`, which
triggers a re-sync, which re-derived stage from labels (the issue has no
`wake:*` labels) and reset progress back to `queue` - an infinite refine
loop (see commit a4babcf... actually the earlier fix, before the unblock
work).

The fix removed label-derivation entirely once a projection exists (only the
very first sync, when `current === null`, still calls `stageFromLabels`).
This closes the loop bug but as a side effect, a human manually editing
labels on an already-synced issue (e.g. adding `wake:blocked` to pause it, or
moving a labeled issue back to `wake:queue` to force a redo) now has zero
effect - silently ignored, no error or log.

When picked up, the safer fix is to only re-derive stage from labels when
the label set has *actually changed* since last sync (not just because the
issue's `updatedAt` moved for an unrelated reason like a new comment):
- Store the last-seen label set in `context` (e.g. `context.lastSeenLabels`).
- On `ticket.upsert` for an existing projection, compare incoming labels
  against `lastSeenLabels`; only re-derive `wake.stage` from
  `stageFromLabels()` if they differ, and update `lastSeenLabels` either way.
- This restores the human-relabel-to-override escape hatch without
  reintroducing the self-triggered regression loop.
