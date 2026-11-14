# Resource Transition Reactor Design

Supersedes the resolver design in `2026-08-15-event-transition-resolver-design.md`,
which kept resolution as a per-tick sweep under the name `eventTransitions`.
That document records the earlier decision and is not rewritten here.

## Concept

A gated `done` route waits for a verdict, but external reality may already have
settled the question: a human merged the pull request, a native approval landed,
CI went red. This feature exists to let those facts release the wait.

Every such fact is an observation about an **external resource** — something
Wake watches but does not control. Facts internal to the instance are already
covered: outcome routes handle the instance's own activity results, and watch
gates handle child-workflow verdicts. There is no gap there.

Naming the feature `eventTransitions` invited the category error. A transition
on `execution.run-succeeded` is degenerate — a `done` route starts waiting
*because* a run succeeded, so it would match the instance's own triggering run
and fire immediately. The concept is resource facts, so the configuration says
`resourceTransitions` and the illegal cases become unwritable rather than merely
undocumented.

Two consequences follow directly and make the design smaller:

- **Scoping is one rule**, not a dispatch table: resource to primary correlation
  to work item.
- **Wait-start catch-up is always valid**, because the subject is external by
  definition and its facts may predate the wait.

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

`src/orchestration/application/resource-transition-reactor.ts` mirrors
`watch-reactor.ts`: `react(event, context)` plus `runOnce(limit = 100)`, a
checkpoint at `reactor:orchestration.resource-transition`, and a
`CommandContext` derived per event rather than synthesised by the caller.

It reacts to two trigger classes:

- **Resource facts** — the live path. A fact arrives, the reactor confirms it
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

`OrchestrationService.listResourceTransitionMatches(event)` is the counterpart
to `listWatchMatches` and holds no resource-kind knowledge. For a waiting
instance it compares `event.eventType` against each
`waitingFor.resourceTransitions[].event` and compares `where` key-wise against
the event payload. For a `signal-wait-started` trigger it returns the named
instance's transitions as candidates. It returns
`{ workflowInstanceId, workItemId, transitions }`.

`AdvanceWorkflow` keeps one narrow method, `applyResourceTransition(id, target,
evidenceId, context)`: load the definition, decide, append.

### Scoping

Scoping answers "which instance does this fact belong to". Getting it wrong
fires every waiting instance's transition on one event, which is the failure the
watch-trigger race fix addressed. Because the subject is always a resource,
there is a single rule: the fact's resource, through its primary correlation, to
the work item. The evidence policy resolves that correlation to do its own job,
so it applies the rule rather than the reactor duplicating a resource lookup.

The `signal-wait-started` trigger is the one exception and needs no resource
rule — its stream id is the instance.

### Evidence port

```ts
export interface ResourceTransitionEvidence {
  /** Resource capability this policy attests for. */
  readonly capability: ResourceCapability;
  /** Fact types the reactor tails on this policy's behalf. */
  readonly triggers: readonly string[];
  /**
   * `fact` present - confirm it still authorises a transition.
   * `fact` absent  - replay the subject's durable facts (wait-start catch-up).
   * Returns null when the fact belongs to another work item's resource.
   */
  resolve(input: {
    readonly workItemId: WorkItemId;
    readonly transitions: readonly CompiledResourceTransition[];
    readonly fact?: PersistedEvent;
  }): Promise<{ transition: CompiledResourceTransition; evidenceId: string } | null>;
}
```

Attestation is only required for *revocable* facts. `pr.review-accepted` is
revocable because an approval goes stale when head moves and trust matters;
`pr.checks-changed { checks: failing }` is revocable because checks can go green
again. `pr.state-changed { state: merged }` is monotonic — matching plus scoping
is sufficient.

Dispatch is by resource capability: a thin composite resolves the work item's
primary correlated resource and delegates to the policy whose capability that
resource declares.

The PR policy delegates rather than re-derives:

- `selectPrimaryPullRequest` is exported from `activities/pr/policy.ts`
  (currently private) and used by both `decidePullRequestAuthority` and the new
  policy.
- The `pr.review-accepted` transition calls
  `pullRequests.decideAuthority(workItemId, { requireAcceptedReview: true,
  requireChecks: false })`, so trust and head-revision freshness come from the
  existing rule.
- The merged and failing-checks transitions need the selector plus a `state` or
  `checks` comparison.

### Proving the seam

A port with one implementation is usually shaped wrong in ways only a second
implementation reveals. The unit suite registers a second, test-only evidence
policy under a different resource capability, monotonic and with no attestation.
That exercises capability dispatch and the no-attestation path against a real
second implementation without opening the configuration vocabulary.

No second capability ships here. `activities` emits no external issue state fact
today — only `issue.complete-requested` — so a second production capability
would mean new event types and a provider translation path, which is a separate
change.

### Rename

The vocabulary exists only on this unmerged branch: it is absent from `main` and
unused in the operator's live configuration, so no persisted `SignalWaitStarted`
payload carries it. Renaming is free now and never again.

| Before | After |
| --- | --- |
| `eventTransitions` (config key, payload field, view field) | `resourceTransitions` |
| `EventTransitionConfig`, `eventTransitionConfigSchema` | `ResourceTransitionConfig`, `resourceTransitionConfigSchema` |
| `CompiledEventTransition` | `CompiledResourceTransition` |
| `eventTransitionSchema` (decoder) | `resourceTransitionSchema` |
| `compileEventTransitions`, `domain/event-transition-compiler.ts` | `compileResourceTransitions`, `domain/resource-transition-compiler.ts` |
| `EventTransitionSignal` = `orchestration.event-transition` | `ResourceTransitionSignal` = `orchestration.resource-transition` |
| `application/event-transition-resolver.ts` | deleted; replaced by `resource-transition-reactor.ts` and `resource-transition-evidence.ts` |
| actor id `event-transition` | `resource-transition` |
| `test/e2e/scenarios/event-transitions.test.ts` | `resource-transitions.test.ts` |

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

Fold in a single pass instead: group the `readAll(0)` result by
workflow-instance stream id, take `sequence` from the group size and the view
from folding the decoded subset. This is identical to what `load` computes, with
no projection dependency and no staleness risk against append sequences.

### Bootstrap extractions

`composition-root.ts` is 651 lines and mixes implementation into wiring. Move
`composeIntegrationRuntime` with its two interfaces, `serializeRunRegisteredOnce`,
and `createWorkflowRouter` to `bootstrap/integration-runtime.ts`;
`createBuiltInActivityRegistry` to `bootstrap/activity-registry.ts`; and the
transcript-retention block with `closedWorkItemIds` to
`bootstrap/transcript-retention.ts`. Naming follows the existing
`runner-registry.ts` and `status-publish-activity.ts` siblings. The reactor is
composed next to `watch`, and the runner pipeline's `react` step becomes
`await watch.runOnce(); await resourceTransitions.runOnce();`.

## Testing

- `test/unit/orchestration/resource-transition-reactor.test.ts`, alongside the
  existing `watch-reactor.test.ts`: fact-triggered transition, wait-start
  catch-up, scoping rejection of a fact about another work item's resource,
  redelivery producing no second transition, and capability dispatch across two
  registered policies.
- A unit test asserting `OrchestrationRepository.list()` equals per-id `load()`
  for sequence and view.
- `test/e2e/scenarios/resource-transitions.test.ts`, renamed from
  `event-transitions.test.ts` and retained: the pre-existing merge case now runs
  through the catch-up path, and the earlier-fact-beats-later-verdict case holds
  by journal order rather than by position comparison.
- `test/e2e/support/world.ts` drops `resolveEventTransitions()` in favour of
  driving `resourceTransitions.runOnce()`.
- `npm run lint:architecture` and `npm run check:specs`.

## Documentation

`docs/workflows.md` renames the key and rewrites its paragraph. It currently
says Wake evaluates the primary PR "when this route begins waiting, as well as
later observations", which describes the sweep; restate it as the two reactor
paths, and say the subject is the correlated primary resource. `docs/configuration.md`
follows for its one-line entry.

## Scope

In scope: the rename, the reactor, generic matching, the single scoping rule,
the evidence port with one PR policy proven against a test-only second policy,
the `list()` fold, and the bootstrap extractions.

Out of scope, tracked separately:

- The `FileEventJournal` O(history) floor (#588). `scan()` parses and decodes
  every line on any cache miss and `readStream` shares that path, so every
  journal access has a full-history floor regardless of caller. The fix is
  per-stream and position-to-offset indexes in `persistence`, rebuildable from
  the segments.
- Registering a second resource capability (#587). With the resource framing
  this is no longer "open the event vocabulary" but "add a capability with
  observable external facts", which needs the events and the provider
  translation path first.
