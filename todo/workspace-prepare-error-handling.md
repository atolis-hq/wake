# Handle workspace-prepare failures instead of retrying forever

Found during code review of feat/claude-invoker.

`src/adapters/git/git-workspace-manager.ts` hardcodes the `main` branch in
`ensureCanonicalClone` (`git checkout main`, `git reset --hard origin/main`)
and in `prepareWorkspace`'s `git clone --local --branch main ...`. If a
configured repo's default branch isn't literally `main`, every one of these
git commands fails and `prepareWorkspace`/`prepareReadOnlyClone` throws.

`src/core/tick-runner.ts`'s `runTick()` has no try/catch around the
`await deps.workspaceManager.prepareWorkspace(...)` /
`prepareReadOnlyClone(...)` call - only a bare `finally { lock.release() }`
around the whole function. When the call throws:
- the run record written moments earlier as `running` is never finalized to
  `failed`/`completed`,
- no `wake.run.completed` event is ever appended,
- `policy.needsWakeAction()` (src/core/policy-engine.ts) keeps returning
  `true` for that issue, since `wake.lastRunId` never gets set.

Net effect: the exact same failing git operation is retried on every
subsequent tick, forever, with no backoff and no terminal `failed` state.

When picked up:
- Wrap the workspace-prepare call (and probably the whole run body) in a
  try/catch in `runTick()`; on failure, write the run record as `failed`,
  append a `wake.run.completed` event with `sentinel: 'FAILED'`, so the
  normal attempt-cap/failed-stage handling applies instead of an infinite loop.
- Stop hardcoding `main` - detect the actual default branch (e.g.
  `git remote show origin` or `git symbolic-ref refs/remotes/origin/HEAD`),
  or make it configurable per repo in `WakeConfig.sources.github.repos`.
