# Resource Transition Reactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-tick event-transition sweep with a checkpointed reactor that mirrors the watch pattern, behind a capability-keyed evidence port, and rename the feature to say what it is about — external resource facts.

**Architecture:** A journal-tailing reactor triggers on external resource facts and on `orchestration.signal-wait-started` (the wait-start catch-up). Orchestration performs generic matching with no resource-kind knowledge; a capability-dispatched evidence policy confirms the fact still authorises the transition, delegating trust and correlation rules to `activities` rather than re-deriving them. Capability dispatch is composed in `bootstrap`, the only module that may see both `resources` and `orchestration`.

**Tech Stack:** TypeScript, Zod, Vitest, Wake event journal and projections.

**Spec:** `docs/superpowers/specs/2026-08-15-resource-transition-reactor-design.md`

## Global Constraints

- `orchestration/module.json` declares dependencies `kernel`, `work`, `activities`, `execution`. It **must not** gain `resources`. Anything needing `resources` belongs in `bootstrap`.
- Each module exposes only its `index.ts`. Do not deep-import across modules.
- Compare closed concepts through exported vocabulary values (`ActivityEventType`, `PullRequestState`, `PullRequestCheckState`, `OrchestrationEventType`, `WorkflowStatus`). No magic strings for event types, stream kinds, statuses, outcomes, or config keys.
- Persisted events must be decoded before folding. Selectors return `null` for another namespace.
- Keep comments short and rationale-focused. Do not narrate obvious code.
- Run the focused test named in each task before committing. `npm run verify` is for the final task only.
- Commit at the end of every task. Never use `--no-verify`.

---

### Task 1: Rename event transitions to resource transitions

Pure rename, no behaviour change. Doing it first means every later task writes the final names once.

**Files:**
- Modify: `src/orchestration/contracts/config.ts`
- Modify: `src/orchestration/contracts/event-decoder.ts:150-175`
- Modify: `src/orchestration/contracts/events.ts:281,312`
- Modify: `src/orchestration/contracts/views.ts:38`
- Modify: `src/orchestration/domain/transition.ts:38-62`
- Modify: `src/orchestration/domain/workflow-graph.ts:11`
- Modify: `src/orchestration/domain/workflow-instance-events.ts:269-271`
- Modify: `src/orchestration/domain/approval-defaults.ts:20`
- Modify: `src/orchestration/domain/compiler.ts:151-197`
- Rename: `src/orchestration/domain/event-transition-compiler.ts` → `src/orchestration/domain/resource-transition-compiler.ts`
- Modify: `src/orchestration/application/event-transition-resolver.ts` (renamed symbols only; deleted in Task 7)
- Modify: `src/orchestration/application/advance-workflow.ts`, `accept-signal.ts`, `orchestration-service.ts`
- Modify: `src/bootstrap/composition-root.ts:67,202,555`
- Rename: `test/e2e/scenarios/event-transitions.test.ts` → `test/e2e/scenarios/resource-transitions.test.ts`
- Modify: `test/e2e/support/world.ts`, `test/unit/orchestration/compiled-contracts.test.ts`
- Modify: `docs/workflows.md`, `docs/configuration.md`

**Interfaces:**
- Produces: the names every later task uses — `resourceTransitions` (config key, `SignalWaitStarted` payload field, `SignalExpectationView` field), `ResourceTransitionConfig`, `resourceTransitionConfigSchema`, `CompiledResourceTransition`, `resourceTransitionSchema`, `compileResourceTransitions`, `ResourceTransitionSignal`.

- [ ] **Step 1: Apply the rename across `src`**

Use these exact replacements. `git mv` the compiler file first so history follows.

| Before | After |
| --- | --- |
| `eventTransitions` | `resourceTransitions` |
| `EventTransitionConfig` | `ResourceTransitionConfig` |
| `eventTransitionConfigSchema` | `resourceTransitionConfigSchema` |
| `CompiledEventTransition` | `CompiledResourceTransition` |
| `eventTransitionSchema` | `resourceTransitionSchema` |
| `compileEventTransitions` | `compileResourceTransitions` |
| `EventTransitionSignal` | `ResourceTransitionSignal` |
| `'orchestration.event-transition'` | `'orchestration.resource-transition'` |
| `'event-transition'` (actor id in `advance-workflow.ts`) | `'resource-transition'` |
| `createPrimaryPullRequestEventTransitionResolver` | `createPrimaryPullRequestResourceTransitionResolver` |
| `EventTransitionResolver` | `ResourceTransitionResolver` |
| `EventTransitionResolution` | `ResourceTransitionResolution` |
| `selectEarliestEventTransition` | `selectEarliestResourceTransition` |
| `resolveEventTransitions` | `resolveResourceTransitions` |
| `Unknown eventTransitions target` | `Unknown resourceTransitions target` |
| `eventTransitions are only valid on done` | `resourceTransitions are only valid on done` |

Also `git mv src/orchestration/application/event-transition-resolver.ts src/orchestration/application/resource-transition-resolver.ts` and update the export in `src/orchestration/index.ts`.

- [ ] **Step 2: Apply the rename across `test` and `docs`**

`git mv test/e2e/scenarios/event-transitions.test.ts test/e2e/scenarios/resource-transitions.test.ts`, then apply the same table to `test/` and to the `eventTransitions` row and YAML example in `docs/workflows.md` and the entry in `docs/configuration.md`.

- [ ] **Step 3: Verify nothing is left behind**

Run: `git grep -in "eventtransition\|event-transition" -- src test docs`
Expected: no matches except inside `docs/superpowers/` (historical plans and the superseded design, which must not be rewritten).

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/compiled-contracts.test.ts` then `npx tsc -p tsconfig.json --noEmit`
Expected: both PASS. A rename changes no behaviour.

- [ ] **Step 5: Commit**

```bash
git add -A src test docs
git commit -m "refactor: rename event transitions to resource transitions"
```

---

### Task 2: Fold OrchestrationRepository.list into a single pass

Independent of the rest. `list()` currently costs one plus N full-history journal parses because `load(id)` calls `readStream`, which is also a full `scan()` in `FileEventJournal`.

**Files:**
- Modify: `src/orchestration/application/orchestration-repository.ts:46-53`
- Test: `test/unit/orchestration/orchestration-repository.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `OrchestrationRepository.list(): Promise<readonly { sequence: number; view: WorkflowInstanceView | null }[]>` — unchanged signature and semantics.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from 'vitest';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { OrchestrationRepository } from '../../../src/orchestration/application/orchestration-repository.js';
import { workflowInstanceId } from '../../../src/orchestration/contracts/identifiers.js';

it('lists every instance with the same sequence and view load reports', async () => {
  const journal = new InMemoryEventJournal();
  const repository = new OrchestrationRepository(journal);
  await seedTwoInstances(journal); // see Step 3

  const listed = await repository.list();
  expect(listed).toHaveLength(2);
  for (const entry of listed) {
    const loaded = await repository.load(entry.view!.workflowInstanceId);
    expect(entry.sequence).toBe(loaded.sequence);
    expect(entry.view).toStrictEqual(loaded.view);
  }
});
```

- [ ] **Step 2: Add the seeding helper**

Seed by starting two instances through `StartWorkflow`, mirroring the setup in `test/unit/orchestration/orchestration-service.test.ts:61` — read that file and reuse its `compileWorkflow` fixture rather than hand-writing envelopes, so the folded views are real.

- [ ] **Step 3: Run the test to confirm it passes against the current implementation**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/orchestration-repository.test.ts`
Expected: PASS. This is a characterisation test — it pins the behaviour the refactor must preserve, so it passes before and after.

- [ ] **Step 4: Replace the N+1 with a single pass**

```ts
async list() {
  const events = await this.journal.readAll(0);
  const streams = new Map<string, typeof events>();
  for (const event of events) {
    if (!isWorkflowInstanceStream(event.stream)) continue;
    const existing = streams.get(event.stream.id);
    if (existing === undefined) streams.set(event.stream.id, [event]);
    else existing.push(event);
  }
  // `sequence` counts every event on the stream, matching readStream, while the
  // fold sees only owned orchestration events — exactly what load() computes.
  return [...streams.values()].map((streamEvents) => ({
    sequence: streamEvents.length,
    view: foldWorkflowInstance(
      streamEvents
        .map(selectWorkflowOrchestrationEvent)
        .filter(
          (event): event is WorkflowOrchestrationEvent =>
            event !== null && isWorkflowInstanceStream(event.stream),
        ),
    ),
  }));
}
```

Note the type of `streams` — `readonly` arrays cannot be pushed to; declare the map value as a mutable array of the journal's envelope type.

- [ ] **Step 5: Run the test again**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/orchestration-repository.test.ts test/unit/orchestration/orchestration-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/application/orchestration-repository.ts test/unit/orchestration/orchestration-repository.test.ts
git commit -m "perf(orchestration): fold instance listing into one journal pass"
```

---

### Task 3: Export the primary pull-request selector from activities

The transition policy must not re-derive primary-resource correlation. Make the existing rule reusable.

**Files:**
- Modify: `src/activities/pr/policy.ts:82-120`
- Modify: `src/activities/index.ts` (no change needed — `./pr/policy.js` is already exported)
- Test: `test/unit/activities/pull-request-selector.test.ts` (create)

**Interfaces:**
- Produces:
```ts
export function selectPrimaryPullRequest(
  input: PullRequestAuthorityInput,
  workItemId: string,
): { readonly resource: PullRequestResourceView; readonly pullRequest: PullRequestView } | null;
```
Returns `null` when the work item has no single non-conflicted primary PR-like resource with exactly one matching pull-request view. Task 4 consumes it.

- [ ] **Step 1: Write the failing test**

```ts
it('returns null when the work item has two primary pull-request resources', async () => {
  expect(selectPrimaryPullRequest(inputWithTwoPrimaries(), 'work-1')).toBeNull();
});

it('returns the single non-conflicted primary pull request', async () => {
  const selected = selectPrimaryPullRequest(inputWithOnePrimary(), 'work-1');
  expect(selected?.pullRequest.resourceId).toBe('resource-1');
});
```

Build the `PullRequestAuthorityInput` fixtures literally — `{ work, resources, pullRequests, acceptedSignals }` per `src/activities/pr/contracts.ts:135`. Give the resource `capabilities: [BuiltInResourceCapability.Mergeable]` so `isPullRequestLikeResource` accepts it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/activities/pull-request-selector.test.ts`
Expected: FAIL — `selectPrimaryPullRequest` is not exported.

- [ ] **Step 3: Extract and export the selector**

Add the exported function to `policy.ts`, implemented by calling the existing private `selectResource` and `selectPullRequest` and mapping their `Denial` results to `null`:

```ts
export function selectPrimaryPullRequest(
  input: PullRequestAuthorityInput,
  workItemId: string,
): { readonly resource: PullRequestResourceView; readonly pullRequest: PullRequestView } | null {
  const resource = selectResource(input, workItemId, ActivityResourceRole.Primary);
  if (isDenial(resource)) return null;
  const pullRequest = selectPullRequest(input, resource, workItemId);
  return isDenial(pullRequest) ? null : { resource, pullRequest };
}
```

`decidePullRequestAuthority` must keep returning its specific denial codes, so leave its existing `selectResource`/`selectPullRequest` calls in place rather than routing it through the null-returning wrapper — the wrapper is for callers that only need the happy path.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/activities/`
Expected: PASS, including existing authority tests.

- [ ] **Step 5: Commit**

```bash
git add src/activities/pr/policy.ts test/unit/activities/pull-request-selector.test.ts
git commit -m "refactor(activities): export the primary pull-request selector"
```

---

### Task 4: Resource transition evidence port and pull-request policy

**Files:**
- Create: `src/orchestration/application/resource-transition-evidence.ts`
- Create: `src/orchestration/application/pull-request-transition-evidence.ts`
- Modify: `src/orchestration/index.ts`
- Test: `test/unit/orchestration/pull-request-transition-evidence.test.ts` (create)

**Interfaces:**
- Consumes: `selectPrimaryPullRequest` from Task 3; `CompiledResourceTransition` from Task 1.
- Produces:
```ts
export type ResourceTransitionFact = Parameters<typeof selectActivityEvent>[0];

export interface ResourceTransitionEvidenceInput {
  readonly workItemId: WorkItemId;
  readonly transitions: readonly CompiledResourceTransition[];
  readonly fact?: ResourceTransitionFact;
}

export interface ResourceTransitionEvidenceResolution {
  readonly transition: CompiledResourceTransition;
  readonly evidenceId: string;
}

export interface ResourceTransitionEvidence {
  /** Fact types the reactor tails on this policy's behalf. */
  readonly triggers: readonly string[];
  resolve(
    input: ResourceTransitionEvidenceInput,
  ): Promise<ResourceTransitionEvidenceResolution | null>;
}

export function createPullRequestTransitionEvidence(
  journal: EventJournal,
  pullRequests: PullRequestService,
): ResourceTransitionEvidence;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('confirms a merged fact about this work item primary pull request', async () => {
  const resolved = await evidence.resolve({
    workItemId,
    transitions: [mergedTransition],
    fact: mergedFact,
  });
  expect(resolved?.evidenceId).toBe(mergedFact.eventId);
});

it('rejects a fact about another work item resource', async () => {
  expect(
    await evidence.resolve({ workItemId, transitions: [mergedTransition], fact: otherResourceFact }),
  ).toBeNull();
});

it('rejects a merged fact when the pull request is no longer merged', async () => {
  // observe the PR back to open after the merged fact
  expect(
    await evidence.resolve({ workItemId, transitions: [mergedTransition], fact: mergedFact }),
  ).toBeNull();
});

it('recalls a durable merged fact when no fact is supplied', async () => {
  const resolved = await evidence.resolve({ workItemId, transitions: [mergedTransition] });
  expect(resolved?.evidenceId).toBe(mergedFact.eventId);
});

it('rejects an approval whose revision is behind the current head', async () => {
  expect(
    await evidence.resolve({ workItemId, transitions: [approvalTransition], fact: staleApproval }),
  ).toBeNull();
});
```

Build the fixtures with the real services — `createWorkService`, `createResourceService`, `createPullRequestService` over an `InMemoryEventJournal` — following `test/e2e/support/world.ts:90-107`. Do not mock `PullRequestService`; the trust rules under test live inside it.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/pull-request-transition-evidence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the port module**

`resource-transition-evidence.ts` contains only the types listed under **Produces** above. No implementation, no `resources` import.

- [ ] **Step 4: Write the pull-request policy**

```ts
const triggers = [
  ActivityEventType.PrReviewAccepted,
  ActivityEventType.PrStateChanged,
  ActivityEventType.PrChecksChanged,
];

export function createPullRequestTransitionEvidence(
  journal: EventJournal,
  pullRequests: PullRequestService,
): ResourceTransitionEvidence {
  return {
    triggers,
    async resolve({ workItemId, transitions, fact }) {
      const input = await pullRequests.authorityInput(workItemId);
      const selected = selectPrimaryPullRequest(input, workItemId);
      if (selected === null) return null;
      const resourceId = selected.pullRequest.resourceId;
      // Scoping: a fact about another work item's resource is not evidence here.
      const candidates =
        fact === undefined
          ? await journal.readStream(resourceStream(resourceId))
          : [fact];
      return firstMatch(candidates, transitions, selected, input, resourceId);
    },
  };
}
```

`firstMatch` walks candidates in journal order, skips any whose `selectActivityEvent(...)?.stream.id !== resourceId`, and returns the first whose transition matches. Port the three per-fact rules from `resource-transition-resolver.ts:110-154` verbatim — they are correct — with one change: the `PrReviewAccepted` case calls

```ts
(await pullRequests.decideAuthority(workItemId, {
  target: ActivityResourceRole.Primary,
  requireAcceptedReview: true,
  requireChecks: false,
})).allowed
```

instead of re-deriving trust and revision freshness.

Keep the `// eslint-disable-next-line complexity` comment on the matcher with its existing rationale.

- [ ] **Step 5: Export from the module index**

Add `export * from './application/resource-transition-evidence.js';` and `export * from './application/pull-request-transition-evidence.js';` to `src/orchestration/index.ts`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/pull-request-transition-evidence.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/orchestration test/unit/orchestration/pull-request-transition-evidence.test.ts
git commit -m "feat(orchestration): add the resource transition evidence port"
```

---

### Task 5: Generic matching and application in orchestration

**Files:**
- Modify: `src/orchestration/application/advance-workflow.ts`
- Modify: `src/orchestration/application/orchestration-service.ts`
- Test: `test/unit/orchestration/resource-transition-matching.test.ts` (create)

**Interfaces:**
- Consumes: `CompiledResourceTransition` (Task 1).
- Produces:
```ts
export interface ResourceTransitionMatch {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly workItemId: WorkItemId;
  readonly transitions: readonly CompiledResourceTransition[];
}

// on AdvanceWorkflow and re-exported on OrchestrationService
listResourceTransitionMatches(event: PersistedEvent): Promise<readonly ResourceTransitionMatch[]>;
applyResourceTransition(
  id: WorkflowInstanceId,
  target: TransitionTarget,
  evidenceId: string,
  context: CommandContext,
): Promise<WorkflowInstanceView | null>;
```
Task 6 consumes both.

- [ ] **Step 1: Write the failing tests**

```ts
it('matches a waiting instance whose transition declares this event type', async () => {
  const matches = await advance.listResourceTransitionMatches(mergedFact);
  expect(matches).toHaveLength(1);
  expect(matches[0]!.transitions).toHaveLength(1);
});

it('does not match when the where predicate disagrees with the payload', async () => {
  // transition declares { state: merged }, fact carries { state: closed }
  expect(await advance.listResourceTransitionMatches(closedFact)).toStrictEqual([]);
});

it('returns every transition of the named instance for a signal-wait-started trigger', async () => {
  const matches = await advance.listResourceTransitionMatches(waitStarted);
  expect(matches[0]!.transitions).toHaveLength(2);
});

it('ignores instances that are not waiting', async () => {
  expect(await advance.listResourceTransitionMatches(mergedFact)).toStrictEqual([]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/resource-transition-matching.test.ts`
Expected: FAIL — `listResourceTransitionMatches` is not a function.

- [ ] **Step 3: Implement matching on `AdvanceWorkflow`**

```ts
async listResourceTransitionMatches(
  event: PersistedEvent,
): Promise<readonly ResourceTransitionMatch[]> {
  const waitStart =
    event.eventType === OrchestrationEventType.SignalWaitStarted &&
    isWorkflowInstanceStream(event.stream)
      ? event.stream.id
      : undefined;
  return (await this.listAllLoaded()).flatMap(({ view }) => {
    if (view.status !== WorkflowStatus.Waiting) return [];
    const declared = view.waitingFor?.resourceTransitions;
    if (declared === undefined) return [];
    if (waitStart !== undefined)
      return view.workflowInstanceId === waitStart
        ? [{ workflowInstanceId: view.workflowInstanceId, workItemId: view.workItemId, transitions: declared }]
        : [];
    const transitions = declared.filter((transition) => matchesFact(transition, event));
    return transitions.length === 0
      ? []
      : [{ workflowInstanceId: view.workflowInstanceId, workItemId: view.workItemId, transitions }];
  });
}
```

```ts
// Generic: compare the declared predicate key-wise against the event payload.
// No resource-kind knowledge lives here — that is the evidence policy's job.
function matchesFact(transition: CompiledResourceTransition, event: PersistedEvent): boolean {
  if (transition.event !== event.eventType) return false;
  if (transition.where === undefined) return true;
  const payload = event.payload as Record<string, unknown>;
  return Object.entries(transition.where).every(([key, value]) => payload[key] === value);
}
```

- [ ] **Step 4: Implement `applyResourceTransition`**

Move the body of the current `resolveResourceTransitions` loop, minus the resolver call and the candidate filtering:

```ts
async applyResourceTransition(
  id: WorkflowInstanceId,
  target: TransitionTarget,
  evidenceId: string,
  context: CommandContext,
): Promise<WorkflowInstanceView | null> {
  const loaded = await this.repository.load(id);
  if (loaded.view === null || loaded.view.waitingFor === undefined) return loaded.view;
  const definition = await this.workflows.definitionForOperation(loaded.view, loaded.sequence, context);
  if (definition === null) return loaded.view;
  // The route target comes from the matched transition, not the wait's own
  // resume, so the decision is taken against the transition's destination.
  const decision = decideSignal(
    definition,
    { ...loaded.view, waitingFor: { ...loaded.view.waitingFor, resume: target } },
    {
      signal: {
        kind: loaded.view.waitingFor.signalKind,
        actorId: 'resource-transition',
        actorDecision: { authorized: true, evidenceId },
        providerEventId: evidenceId,
      },
      occurredAt: context.occurredAt,
      causationId: `${context.commandId}:${evidenceId}`,
      consent: true,
    },
  );
  if (decision.kind === 'append')
    await this.repository.append(id, loaded.sequence, decision.events);
  return (await this.repository.load(id)).view;
}
```

- [ ] **Step 5: Re-export both on `OrchestrationService`**

Add thin delegating methods next to `listWatchMatches`, matching its style.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/resource-transition-matching.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/orchestration test/unit/orchestration/resource-transition-matching.test.ts
git commit -m "feat(orchestration): match and apply resource transitions generically"
```

---

### Task 6: The resource transition reactor

**Files:**
- Create: `src/orchestration/application/resource-transition-reactor.ts`
- Modify: `src/orchestration/index.ts`
- Test: `test/unit/orchestration/resource-transition-reactor.test.ts` (create)

**Interfaces:**
- Consumes: `listResourceTransitionMatches` and `applyResourceTransition` (Task 5); `ResourceTransitionEvidence` (Task 4).
- Produces:
```ts
// Declared locally in the reactor, mirroring WatchOrchestrationPort in
// watch-reactor.ts:34 — the reactor states the narrow surface it needs rather
// than depending on the whole OrchestrationService.
interface ResourceTransitionOrchestrationPort {
  listResourceTransitionMatches(event: PersistedEvent): Promise<readonly ResourceTransitionMatch[]>;
  applyResourceTransition(
    workflowInstanceId: WorkflowInstanceId,
    target: TransitionTarget,
    evidenceId: string,
    context: CommandContext,
  ): Promise<unknown>;
}

export function createResourceTransitionReactor(
  orchestration: ResourceTransitionOrchestrationPort,
  evidence: ResourceTransitionEvidence,
  journal?: EventJournal,
  checkpoints?: CheckpointStore,
): { react(event: PersistedEvent, context: CommandContext): Promise<void>; runOnce(limit?: number): Promise<number> };
```

- [ ] **Step 1: Write the failing tests**

Model the harness on `test/unit/orchestration/watch-reactor.test.ts` — a hand-written port object plus `InMemoryEventJournal` / `InMemoryCheckpointStore`.

```ts
it('applies the transition the evidence policy confirms', async () => {
  await reactor.react(mergedFact, context);
  expect(applied).toStrictEqual([{ id: 'workflow-1', target: doneTarget, evidenceId: 'fact-1' }]);
});

it('applies nothing when the evidence policy declines', async () => {
  await reactor.react(mergedFact, context);
  expect(applied).toStrictEqual([]);
});

it('passes no fact for a signal-wait-started trigger so the policy recalls durable facts', async () => {
  await reactor.react(waitStarted, context);
  expect(seenFacts).toStrictEqual([undefined]);
});

it('passes the fact itself for a live resource fact', async () => {
  await reactor.react(mergedFact, context);
  expect(seenFacts).toStrictEqual([mergedFact]);
});

it('advances the checkpoint once per event', async () => {
  await reactor.runOnce();
  expect(await checkpoints.load('reactor:orchestration.resource-transition')).toBe(2);
});
```

Capability dispatch is not tested here — the composite that performs it lives in `bootstrap` and is covered by Task 7.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/resource-transition-reactor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the reactor**

```ts
const checkpoint = 'reactor:orchestration.resource-transition';

export function createResourceTransitionReactor(
  orchestration: ResourceTransitionOrchestrationPort,
  evidence: ResourceTransitionEvidence,
  journal?: EventJournal,
  checkpoints?: CheckpointStore,
) {
  return {
    async react(event: PersistedEvent, context: CommandContext): Promise<void> {
      // A wait-start trigger carries no external fact; the policy recalls the
      // subject's durable facts instead, catching up anything that predates
      // the wait.
      const fact =
        event.eventType === OrchestrationEventType.SignalWaitStarted ? undefined : event;
      for (const match of await orchestration.listResourceTransitionMatches(event)) {
        const resolved = await evidence.resolve({
          workItemId: match.workItemId,
          transitions: match.transitions,
          ...(fact === undefined ? {} : { fact }),
        });
        if (resolved === null) continue;
        await orchestration.applyResourceTransition(
          match.workflowInstanceId,
          resolved.transition.target,
          resolved.evidenceId,
          context,
        );
      }
    },
    async runOnce(limit = 100): Promise<number> {
      if (journal === undefined || checkpoints === undefined)
        throw new Error('ResourceTransitionReactor journal and checkpoints are required to run');
      const events = await journal.readAll(await checkpoints.load(checkpoint), limit);
      for (const event of events) {
        await this.react(event, commandContext(event));
        await checkpoints.save(checkpoint, event.globalPosition);
      }
      return events.length;
    },
  };
}
```

`commandContext` mirrors `watch-reactor.ts:112` with `commandId: \`${event.eventId}:resource-transition\`` and actor id `resource-transition`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/resource-transition-reactor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration test/unit/orchestration/resource-transition-reactor.test.ts
git commit -m "feat(orchestration): add the resource transition reactor"
```

---

### Task 7: Wire the reactor and delete the sweep

**Files:**
- Create: `src/bootstrap/resource-transition-evidence.ts`
- Delete: `src/orchestration/application/resource-transition-resolver.ts`
- Modify: `src/orchestration/application/advance-workflow.ts`, `accept-signal.ts`, `orchestration-service.ts`, `index.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Modify: `test/e2e/support/world.ts`
- Modify: `test/e2e/scenarios/resource-transitions.test.ts`
- Test: `test/unit/bootstrap/resource-transition-evidence.test.ts` (create)

**Interfaces:**
- Produces:
```ts
export function createCapabilityResourceTransitionEvidence(input: {
  readonly resources: ResourceService;
  readonly policies: readonly {
    readonly capability: ResourceCapability;
    readonly policy: ResourceTransitionEvidence;
  }[];
}): ResourceTransitionEvidence;
```
Lives in `bootstrap` because it needs `resources`, which `orchestration` must not depend on.

- [ ] **Step 1: Write the capability composite and its test**

The composite's `triggers` is the union of its policies' triggers. `resolve` reads `await resources.correlationsForWork(workItemId)`, filters to `ResourceCorrelationRole.Primary`, loads each resource with `resources.get`, and delegates to the first policy whose `capability` appears in that resource's `capabilities`. Returns `null` when no policy matches.

Test it with the real pull-request policy plus a **test-only second policy** under `BuiltInResourceCapability.Completable`: monotonic, no attestation, returning the first transition whose `event` equals the fact's type. Assert each policy is chosen for its own capability and neither is chosen for the other's.

- [ ] **Step 2: Run the composite test**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/bootstrap/resource-transition-evidence.test.ts`
Expected: PASS.

- [ ] **Step 3: Delete the sweep**

Remove from `advance-workflow.ts`: the `resourceTransitions` constructor argument, `resolveResourceTransitions`, and the now-unused `ActivityEventType` / `PullRequestCheckState` / `selectActivityEvent` imports if nothing else uses them. Remove `resolveResourceTransitions` from `orchestration-service.ts` and its fifth constructor argument, and remove the fourth constructor argument from `AcceptSignal` along with the guard clause at its `execute` entry. Delete `resource-transition-resolver.ts` and its `index.ts` export.

- [ ] **Step 4: Compose the reactor**

In `composition-root.ts`, replace the resolver argument to `createOrchestrationService` with nothing, and inside `composeIntegrationRuntime` add next to `watch`:

```ts
const resourceTransitions = createResourceTransitionReactor(
  input.orchestration,
  createCapabilityResourceTransitionEvidence({
    resources: input.resources,
    policies: [
      {
        capability: BuiltInResourceCapability.Mergeable,
        policy: createPullRequestTransitionEvidence(input.journal, input.pullRequests),
      },
    ],
  }),
  input.journal,
  input.checkpoints,
);
```

and change the `react` step to `await watch.runOnce(); await resourceTransitions.runOnce();`, deleting the hand-rolled `CommandContext` with `'event-transitions' as never`.

- [ ] **Step 5: Update the test world**

In `test/e2e/support/world.ts`, drop the resolver argument from `createOrchestrationService`, add a `resourceTransitionReactor` built the same way as production, replace `resolveEventTransitions()` with `resourceTransitions.runOnce()`, and update `advance()` to call it where `resolveEventTransitions()` was.

- [ ] **Step 6: Run the E2E scenarios**

Run: `npx vitest run --config vitest.e2e.config.ts test/e2e/scenarios/resource-transitions.test.ts`
Expected: PASS. The pre-existing-merge scenario now succeeds through the wait-start catch-up path and the later-verdict scenario through journal order.

- [ ] **Step 7: Commit**

```bash
git add -A src test
git commit -m "refactor(orchestration): replace the transition sweep with a reactor"
```

---

### Task 8: Bootstrap extractions

**Files:**
- Create: `src/bootstrap/integration-runtime.ts`, `src/bootstrap/activity-registry.ts`, `src/bootstrap/transcript-retention.ts`
- Modify: `src/bootstrap/composition-root.ts`

**Interfaces:**
- Produces: `composeIntegrationRuntime`, `IntegrationRuntime`, `IntegrationRuntimeInput` from `integration-runtime.ts`; `createBuiltInActivityRegistry` from `activity-registry.ts`; `createTranscriptRetention(transcriptStore, projections, config, clock)` from `transcript-retention.ts`.

- [ ] **Step 1: Move code without changing it**

Move `composeIntegrationRuntime`, `IntegrationRuntime`, `IntegrationRuntimeInput`, `serializeRunRegisteredOnce`, and `createWorkflowRouter` to `integration-runtime.ts`. Move `createBuiltInActivityRegistry` to `activity-registry.ts`. Move the `transcriptRetention` object literal and `closedWorkItemIds` to `transcript-retention.ts` behind `createTranscriptRetention`, returning the same `{ transcriptRetention, closedWorkItemIds }` shape `createAdvanceOnce` expects. Move `identity` and `composePersistence` only if `composition-root.ts` is still over 300 lines without them.

This is code motion. Change no logic and no comments — the rationale comments on `serializeRunRegisteredOnce` and `closedWorkItemIds` travel with the code.

- [ ] **Step 2: Verify the type check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Confirm the size goal**

Run: `wc -l src/bootstrap/composition-root.ts`
Expected: under 300 lines.

- [ ] **Step 4: Run the bootstrap and E2E suites**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/bootstrap/` then `npx vitest run --config vitest.e2e.config.ts test/e2e/scenarios/resource-transitions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/bootstrap
git commit -m "refactor(bootstrap): extract runtime composition from the root"
```

---

### Task 9: Documentation and full verification

**Files:**
- Modify: `docs/workflows.md`
- Modify: `docs/configuration.md`
- Modify: `src/orchestration/*.spec.md` and `src/bootstrap/*.spec.md` as `check:specs` reports

- [ ] **Step 1: Rewrite the workflows.md paragraph**

The current text says Wake evaluates the primary PR "when this route begins waiting, as well as later observations", which describes the sweep. Replace it with the two reactor paths — a fact observed while waiting, and a catch-up at wait-start for facts that predate it — and state that the subject is the work item's correlated primary resource, failing closed when that resource is missing or ambiguous. Keep the existing YAML example, renamed.

- [ ] **Step 2: Run the architecture and spec checks**

Run: `npm run lint:architecture` then `npm run check:specs`
Expected: `lint:architecture` PASS. If `check:specs` reports orchestration or bootstrap as stale, update the named `.spec.md` files to match current behaviour.

- [ ] **Step 3: Run full verification**

Run: `npm run verify`
Expected: PASS. Report the actual output; if anything fails, fix it before committing rather than narrowing the command.

- [ ] **Step 4: Commit**

```bash
git add -A docs src
git commit -m "docs: describe resource transitions as reactor paths"
```
