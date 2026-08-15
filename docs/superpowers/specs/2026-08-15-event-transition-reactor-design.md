# Event Transition Reactor Design

Supersedes the resolver design in `2026-08-15-event-transition-resolver-design.md`,
which kept event-transition resolution as a per-tick sweep. That document records
the earlier decision and is not rewritten here.

## Goal

Make event transitions react to the journal the way watches do, remove the
per-instance full-journal scans the sweep introduced, and put the
resource-specific parts behind a seam that a second event family can extend
without touching the reactor.

## Problem

`AdvanceWorkflow.resolveEventTransitions` sweeps every workflow instance each
tick. For each waiting instance it calls `PullRequestService.authorityInput`
and `journal.readAll(0)`, so the cost is the number of waiting instances times
the whole journal, every tick, re-derived from position 0 even though nothing
before the previous tick can newly qualify.

Because a sweep has no inherent ordering, the current code reconstructs journal
order by hand through `selectEarliestEventTransition`, `position`, and
`beforeEvidenceId`, and `AcceptSignal` carries a re-entrant
`resolveEventTransitions` callback so an incoming watch verdict cannot win
against an earlier qualifying fact. All of that is compensation for not being a
reactor.

The PR-specific matching also re-implements policy `activities` already owns.
The resolver's primary-resource filter duplicates `selectResource` and
`hasPrimaryCorrelationConflict`, and its approval check duplicates
`reviewAuthority`. Two copies of a trust and freshness rule is the most
dangerous part of the current shape.

## Design

### Reactor

`src/orchestration/application/event-transition-reactor.ts` mirrors
`watch-reactor.ts`: `react(event, context)` plus `runOnce(limit = 100)`, a
checkpoint at `reactor:orchestration.event-transition`, and a `CommandContext`
derived per event rather than synthesised by the caller.

It reacts to two trigger classes:

- **Domain facts** — the live path. A fact arrives, the reactor confirms it
  still authorises a transition, and applies it.
- **`orchestration.signal-wait-started`** — the catch-up path, for facts that
  predate the wait. `finishRoute` pushes this event into the same
  `repository.append` as the state change, so it is atomic and cannot be
  observed before the wait exists. This is the mechanism established for
  watches in the watch-trigger race fix.

At-least-once redelivery is safe for the same reason it is for watches. The
accepted-signal event id derives from `commandId:evidenceId`, the append is
sequence-guarded, and a replay finds the instance no longer waiting, so the
decision returns `ignored`.

### Generic matching in orchestration

`OrchestrationService.listEventTransitionMatches(event)` is the counterpart to
`listWatchMatches` and holds no resource knowledge. For a waiting instance it
compares `event.eventType` against each `waitingFor.eventTransitions[].event`
and compares `where` key-wise against the event payload. For a
`signal-wait-started` trigger it returns the named instance's transitions as
candidates. It returns `{ workflowInstanceId, workItemId, transitions }`.

`AdvanceWorkflow` keeps one narrow method, `applyEventTransition(id, target,
evidenceId, context)`: load the definition, decide, append.

### Scoping

Scoping answers "which instance does this fact belong to", and it must be a
declared rule per event family. Without it a single matching event fires every
waiting instance's transition, which is the failure the watch-trigger race fix
addressed. The reactor dispatches on the trigger's stream kind:

| Stream | Rule | Families |
| --- | --- | --- |
| resource | resource to primary correlation to `workItemId` | `pr.*` |
| run | run to `workflowInstanceId`, reusing `resolveRunWorkflowInstanceId` | `execution.*` |
| workflow-instance | stream id is the instance | `orchestration.signal-wait-started` |

### Evidence port

```ts
export interface EventTransitionEvidence {
  /** Fact types the reactor tails on this policy's behalf. */
  readonly triggers: readonly string[];
  /**
   * `fact` present - confirm it still authorises a transition.
   * `fact` absent  - replay the subject's durable facts (wait-start catch-up).
   */
  resolve(input: {
    readonly workItemId: WorkItemId;
    readonly transitions: readonly CompiledEventTransition[];
    readonly fact?: PersistedEvent;
  }): Promise<{ transition: CompiledEventTransition; evidenceId: string } | null>;
}
```

Attestation is only required for *revocable* facts. `pr.review-accepted` is
revocable because an approval goes stale when head moves and trust matters;
`pr.checks-changed { checks: failing }` is revocable because checks can go
green again. `pr.state-changed { state: merged }` and
`execution.run-succeeded` are monotonic and need no policy — matching plus
scoping is sufficient.

A family with neither a registered policy nor a monotonic declaration is a
compile error, not a silent pass. Dispatch is by resource capability: a thin
composite resolves the work item's primary correlated resource and delegates to
the policy whose capability that resource declares.

The PR policy delegates rather than re-derives:

- `selectPrimaryPullRequest` is exported from `activities/pr/policy.ts`
  (currently private) and used by both `decidePullRequestAuthority` and the new
  policy.
- The `pr.review-accepted` transition calls `pullRequests.decideAuthority(workItemId,
  { requireAcceptedReview: true, requireChecks: false })`, so trust and
  head-revision freshness come from the existing rule.
- The merged and failing-checks transitions need the selector plus a `state` or
  `checks` comparison.

### Second event family

`execution.run-succeeded` joins the configuration union. It is monotonic, so it
exercises the no-policy path, and it is run-scoped, so it exercises a different
scoping rule from the PR family. Those are the two axes most likely to be wrong
in a seam with a single implementation.

### Removed

`selectEarliestEventTransition`, `position`, `beforeEvidenceId`, the
`AcceptSignal` re-entrant callback, `AdvanceWorkflow`'s resolver constructor
argument, `OrchestrationService.resolveEventTransitions`, and the fifth
positional constructor argument on `createOrchestrationService`. Journal order
replaces the hand-rolled ordering.

### OrchestrationRepository.list

`list()` reads `readAll(0)` to collect instance ids and then calls `load(id)`
per instance. `load` uses `readStream`, which in `FileEventJournal` is also a
full `scan()`, so the call costs one plus N full-history parses and every one of
those N returns data the first scan already held. `listAllLoaded`,
`listWaiting`, `listAll`, `listPendingActivations`, and `listWatchMatches` all
sit on it, and the watch reactor calls the last one per event.

Fold in a single pass instead: group the `readAll(0)` result by workflow-instance
stream id, take `sequence` from the group size and the view from folding the
decoded subset. This is identical to what `load` computes, with no projection
dependency and no staleness risk against append sequences.

### Bootstrap extractions

`composition-root.ts` is 651 lines and mixes implementation into wiring. Move
`composeIntegrationRuntime` with its two interfaces, `serializeRunRegisteredOnce`,
and `createWorkflowRouter` to `bootstrap/integration-runtime.ts`;
`createBuiltInActivityRegistry` to `bootstrap/activity-registry.ts`; and the
transcript-retention block with `closedWorkItemIds` to
`bootstrap/transcript-retention.ts`. Naming follows the existing
`runner-registry.ts` and `status-publish-activity.ts` siblings. The reactor is
composed next to `watch`, and the runner pipeline's `react` step becomes
`await watch.runOnce(); await eventTransitions.runOnce();`.

## Testing

- `test/unit/orchestration/event-transition-reactor.test.ts`, alongside the
  existing `watch-reactor.test.ts`: fact-triggered transition, wait-start
  catch-up, scoping rejection of a fact belonging to another instance, and
  redelivery producing no second transition.
- A unit test asserting `OrchestrationRepository.list()` equals per-id `load()`
  for sequence and view.
- `test/e2e/scenarios/event-transitions.test.ts` retained: the pre-existing
  merge case now runs through the catch-up path, and the earlier-fact-beats-later
  -verdict case holds by journal order rather than by position comparison.
  A new scenario covers the `execution.run-succeeded` family.
- `test/e2e/support/world.ts` drops `resolveEventTransitions()` in favour of
  driving `eventTransitions.runOnce()`.
- `npm run lint:architecture` and `npm run check:specs`.

## Documentation

`docs/workflows.md` gains `execution.run-succeeded` in the `eventTransitions`
description and states the scoping rule per family, since the configuration
schema changes. `docs/configuration.md` follows if its `eventTransitions` entry
names the permitted events.

## Scope

In scope: the reactor, generic matching, scoping dispatch, the evidence port
with one PR policy, `execution.run-succeeded` as a second family, the `list()`
fold, and the bootstrap extractions.

Out of scope, tracked separately:

- The `FileEventJournal` O(history) floor. `scan()` parses and decodes every
  line on any cache miss and `readStream` shares that path, so every journal
  access has a full-history floor regardless of caller. The fix is per-stream
  and position-to-offset indexes in `persistence`, rebuildable from the
  segments.
- Broadening the configuration vocabulary beyond the closed union. That needs an
  event-family registry composed in bootstrap and passed into `compileWorkflow`,
  with compile-time validation of event names and `where` keys, so an unknown
  event fails at config load rather than silently never matching. The scoping
  dispatch and the no-policy path built here are its structural prerequisites.
