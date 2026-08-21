# Self-update — Component Specification

## Type, purpose, and scope

Policy/process. Self-update advances this Wake installation's own source
checkout — and, when a Docker rollout is configured, the sandbox container
built from it — to a requested or latest version tag, verifying the result
is healthy before committing to it and automatically reverting when it is
not.

## Ubiquitous language

- **Update ledger** — the durable record of the last tag confirmed healthy,
  any tag currently pending (an update left mid-flight), and every tag
  already known to be bad.
- **Rollout** — the optional Docker-side half of an update (build+swap the
  sandbox container onto the new tag, roll it back, best-effort record a
  failure) alongside the mandatory source-checkout half; absent for a
  non-sandboxed self-update.
- **Bad tag** — a tag a prior update attempt failed on, at any stage from
  quiesce through rollback; skipped by later attempts unless the caller
  forces a retry.

**Maintenance lease** is the durable single-owner record that pauses Wake
while an update drains, changes source, and verifies or recovers it. An
**attempt lock** owns the whole maintenance attempt; its stale check considers
recorded local PID liveness, so a live slow update cannot be taken over and a
crashed owner can be reclaimed.

## Responsibilities and boundaries

This component owns the maintenance-then-update-then-verify-then-commit-or-
rollback sequence, its durable maintenance lease, and the ledger that makes
it resumable after a crash mid-update. It does
not own how a source checkout is performed (the source-update port's own
git plumbing), how a Docker rollout builds and swaps a container (composed
by the CLI surface application from Docker primitives), or exposing this as
a CLI command.

## Core policies, invariants, and behaviours

- `update(tag)` MUST first recover any update left pending by a prior
  invocation that did not complete: check the source back out to the last
  known-healthy tag and confirm it is healthy again before proceeding; a
  failed recovery check MUST throw rather than continue toward the newly
  requested tag.
- Unless the caller forces it, `update(tag)` MUST be a no-op returning
  `false` when `tag` is already the last known-healthy tag or is already
  recorded bad.
- The source checkout MUST be clean before an update begins; `update` MUST
  throw immediately, without marking anything pending, when it is not.
- Once begun, `update` MUST record `tag` as pending before performing the
  checkout, so a crash between checkout and confirming health leaves a
  recoverable trace rather than an ambiguous ledger state.
- A configured rollout's deploy MUST run only after the source checkout
  succeeds, and a deploy failure MUST be captured rather than thrown, so it
  is evaluated as a failed health check (triggering rollback) instead of
  aborting before rollback has a chance to run.
- Health MUST short-circuit to failed whenever a deploy failure was
  captured, without even consulting the source's own health check;
  otherwise health MUST reflect the source's own post-checkout check.
- On failed health, rollback MUST check the source back out to the prior
  tag and, when a rollout is configured, roll the container back to that
  same prior tag.
- Whatever tag was attempted MUST be recorded bad when `update` ultimately
  throws, and — when a rollout is configured — the failure MUST be
  best-effort recorded to the failure log with whichever error actually
  caused the rollback (the captured deploy error, if there was one); a
  failure-log write error MUST NOT mask or replace the original thrown
  error.
- `updateLatest(force)` MUST try candidate tags newest-first, skipping any
  already-bad tag unless forcing, and MUST stop at the first tag `update`
  actually applies. If the newest untried candidate is already the current
  healthy tag, `updateLatest` MUST report that tag with `updated: false`
  rather than trying older candidates; if every candidate is exhausted with
  nothing applied, it MUST report the newest candidate tag with
  `updated: false`. With no candidate tags at all, `updateLatest` MUST
  throw.

- Before any recovery or forward checkout, an update with a composed quiesce
  port MUST acquire maintenance. The existing Bootstrap pause checks then
  stop intake/polling, projection advancement, schedules, reactions, direct
  and host-driven advancement, recovery, reconciliation, and delivery. The
  only work observed in the maintenance window is existing active Run views.
- Lease phases are `quiescing` -> `updating` -> `rolling-back`, with `failed`
  reachable from an active phase. State contains attempt id, tag, start time,
  and operator-visible failure. Only healthy update or verified recovery
  clears the lease; failure retains it and the complete runtime pause.
- In `quiescing`, the updater waits for every active or ambiguous Run view to
  empty for the configured positive drain timeout. It then requests durable
  `maintenance` cancellation only for started, not already-cancelled Runs,
  waits the configured cancellation timeout, and fails without checkout if
  any active/ambiguous view remains. A cancellation write collision is safe
  only when rereading the public view proves the Run has become terminal.
- Restarting `updating` or `rolling-back` restores and verifies the last
  healthy source (and rollout when configured), records the interrupted tag
  bad, and clears maintenance without repeating a forward checkout. Recovery
  failure leaves a visible failed lease.
- Each resident-loop iteration re-discovers candidate tags. A bad `v2` is
  skipped on later ordinary iterations, but newly published `v3` can replace
  v2's failed lease and is attempted once. The same tag retries only with
  `--force`.

**Update ledger**

- `read` MUST report the last tag written healthy, or `null` if none has
  ever been recorded; `write` MUST replace it and MUST clear any pending
  marker, while preserving the bad-tag set.
- `recover` MUST report the last known-healthy tag to check out back to
  when a pending marker is present, clearing that marker either way; if no
  tag has ever been confirmed healthy, `recover` MUST report nothing to
  check out even when a pending marker was present — there is no
  known-good state to fall back to.
- `recordBad`/`isBad` MUST track a deduplicated set of unusable tags,
  independent of the pending/healthy markers.

**Maintenance lease state**

- `acquire` atomically retains an active attempt despite another caller's
  requested tag. It replaces a failed attempt only for a different candidate
  tag or an explicit forced retry.
- Lease state writes are atomic and phase/clear/fail operations check attempt
  ownership. The short state lock only serializes mutation; the full attempt
  lock covers quiesce/update/recovery and is not stale-reclaimed while its
  recorded local PID is alive.

**Self-update failure log**

- `record` MUST persist the failing tag, an error message (the stack when
  the error carries one), and a timestamp, written atomically so a
  concurrent reader never observes a partial file.
- `clear` MUST remove a persisted failure; a later successful deploy for
  any tag MUST clear a stale prior failure so the operator health screen
  stops reporting it.
- `read` MUST report `null` when no failure has been recorded, not an
  error.

## Dependencies and system role

- CLI surface application (depends on this component) — the only caller;
  supplies the source-update port, the update ledger, and, for a sandboxed
  installation, the Docker rollout port built from
  `host.development.repoRoot` and the sandbox image.
- API surface application (depends on this component's failure log) — the
  `system.health` check reads the failure log directly to report a
  `self-update` health check.
- Version resolution (depended on by the CLI's rollout wiring, not by this
  component directly) — resolves the tag/build-version string a Docker
  rollout is built and tagged with.

- Bootstrap composition root (co-composes maintenance) maps a present lease
  into the existing runtime pause supplier; no parallel scheduler is added.

## Decisions, exclusions, and deferred capability

- The maintenance lease is operational JSON under `.wake`, not a journal
  fact: it controls the installation that owns the journal and must survive
  process replacement before normal services resume.
- Self-update requires `host.development.mode: source` and a configured
  `host.development.repoRoot`; there is no packaged-install self-update
  path composed here.
- The update ledger and failure log are both plain JSON files under the
  Wake root, not journal-backed facts — a self-update's own history is
  operational state, not domain history.
