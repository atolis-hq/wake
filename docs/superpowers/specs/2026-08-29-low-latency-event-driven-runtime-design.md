# Low-latency event-driven runtime design

## Decision

Wake will make durable subscriptions the normal progress mechanism for the
latency-sensitive workflow path. The first vertical slice covers journal
wake-up, execution-completion reaction, and activation scheduling. The
existing runner pipeline remains temporarily as a reconciliation and migration
safety path for schedules, publication, delivery, and reactors that have not
yet moved to independent consumers.

The implementation will not treat repeated whole-pipeline ticks as the target
architecture. A bounded rerun may remain as recovery behaviour, but normal
progress is caused by new durable journal positions waking independently
checkpointed consumers.

## Current problem

An internal conversation message already records the conversation entry and
the replacement `orchestration.activity-requested` fact synchronously. With an
idle in-process runtime and available capacity, a diagnostic fake-runner probe
reached runner start in about 18 milliseconds. The domain transition is not the
source of the reported tens-of-seconds delay.

The current runtime still introduces artificial latency in four ways:

1. `JournalChangeSignal.waitForChange` can be armed after the relevant
   notification has already occurred. Its safety fallback is 30 seconds.
2. The signal revision is process-local. A second `FileEventJournal` instance
   can read an externally appended event directly while its cached views remain
   unchanged for the same 30-second fallback period.
3. `RunnerPipeline` serializes projections, schedules, advancement, reactors,
   publication, delivery, and final catch-up behind one Promise queue.
4. `advanceOnce` performs workspace recovery, active-run recovery, transcript
   maintenance, and child reconciliation before considering a pending
   activation.

`controlPlane.maxConcurrentRuns` is a separate, legitimate capacity boundary.
It defaults to one and can delay unrelated interactive work for the full
duration of another Run. This delay must be reported as capacity blocking, not
misclassified as event-propagation latency.

## Durable cursor and wake-up contract

The durable journal global position, not a process-local notification counter,
is the observation cursor. `EventJournal` will expose an operation equivalent
to:

```ts
waitForEventsAfter(
  globalPosition: number,
  signal: AbortSignal,
  fallbackMs: number,
): Promise<void>;
```

The operation has these semantics:

- return immediately when the journal already contains a position greater
  than `globalPosition`;
- arm the advisory notification mechanism and then recheck the durable
  position, closing the append-before-wait race;
- resolve on local append, cross-process filesystem change, abort, or bounded
  fallback;
- never make correctness depend on the notification;
- coalesce notifications while waking every current subscriber.

The filesystem implementation shares one lazily managed watcher across all
waiters for a journal instance. The watcher observes the event index/manifest
boundary and causes the durable-position recheck. The in-memory implementation
uses its current event count and process-local broadcast.

`cachedJournalView` and `ProjectionRunner` will use the durable latest global
position for freshness. A process-local revision may remain as a fast path,
but it may not suppress a durable-position check for 30 seconds.

## Durable subscription host

Persistence will provide a reusable host whose correctness model is:

```text
load consumer checkpoint
read journal events after checkpoint
  no events -> waitForEventsAfter(checkpoint)
  events    -> invoke consumer batch handler
               save checkpoint after successful handling
repeat until aborted
```

Each subscription has an independent checkpoint and can run concurrently with
every other subscription. A handler failure leaves the batch uncheckpointed;
the supervisor reports the failure and restarts or retries according to a
bounded policy. Handlers must use stable event identities or existing
idempotent application commands so replay after output-before-checkpoint failure
is safe.

The host owns journal tailing, checkpoint movement, wake-up, cancellation, lag,
and failure reporting. The consuming module owns event selection, business
reaction, idempotency, and any required partition key.

## First live consumers

### Execution completion

The completion consumer observes terminal `execution.run-*` facts and applies
the existing unresolved-terminal reconciliation decisions immediately. It
accepts successful outcomes, applies runner-quota retry policy, and resolves
execution failures using the existing Orchestration application services.

The consumer serializes decisions per `workflowInstanceId`. Different workflow
instances may react concurrently. Existing deterministic event IDs and
accepted-outcome checks preserve idempotency.

### Activation scheduling

The scheduler consumer observes durable facts that can change dispatchability:

- `orchestration.activity-requested`;
- terminal Run facts that release capacity;
- control-plane dispatch and runner pause/resume facts;
- WorkItem eligibility changes relevant to frozen or deleted work.

On a relevant batch it queries current durable readiness and invokes a focused
scheduler application extracted from `advanceOnce`. The scheduler retains the
existing selection policy, activation validation, activation claim, capacity
recheck, workspace acquisition, Run creation, and runner-start semantics.

The small capacity-selection and activation-claim boundary remains serialized
globally. Unrelated workflow transition processing, projections, publication,
delivery, and maintenance do not share that serialization boundary. Existing
`advanceOnce` calls use the same scheduler instance during migration, so manual
ticks and the subscription cannot over-dispatch each other.

## Runtime supervision

Bootstrap constructs the consumers and starts them concurrently with intake
and the HTTP surface. It supervises failures, coordinates cancellation, and
exposes consumer health. Bootstrap does not impose a global consumer order.

The resident runtime initially contains:

```text
WakeRuntimeSupervisor
  |- projection pump
  |- execution-completion subscription
  |- activation-scheduler subscription
  |- legacy reconciliation runner
  `- intake resident
```

The legacy runner continues schedules and the not-yet-migrated reactors. Its
dispatch call delegates to the same scheduler and is redundant but safe. Once
the two live consumers are proven, a later migration removes completion and
scheduling from the legacy path.

## Ordering and concurrency

Required serialization is explicit:

| Scope | Reason |
| --- | --- |
| Journal append | Assign one authoritative global position. |
| Workflow instance | Preserve deterministic transition and stream sequence. |
| Activation | Prevent duplicate claims and Runs. |
| Capacity allocation | Enforce machine-wide and runner limits. |
| Workspace | Prevent unsafe concurrent mutation of one workspace. |

Different workflow instances, projections, publication, delivery, and
maintenance otherwise progress independently.

The first slice preserves the configured global capacity default. It records
capacity-blocked observations separately from propagation latency. A subsequent
scheduler-policy change may add interactive priority, runner/provider pools,
and reserved capacity without changing the subscription architecture.

## Observability

The critical path emits structured timing observations for:

```text
conversation.message.recorded
workflow.transition.persisted
activation.runnable
scheduler.observed
activation.capacity.blocked
activation.claimed
workspace.acquire.started/completed
runner.start.requested
runner.process.started
runner.first.output
```

Correlation fields include the available conversation, WorkItem, workflow
instance, stage, activation, Run, and workspace identities. Tests use injected
observers and event barriers; production logging or OpenTelemetry export is a
composition concern.

## Failure and recovery

- A crash before checkpoint leaves the input replayable.
- A crash after output but before checkpoint repeats an idempotent command.
- A missed filesystem notification is repaired by the durable-position check
  and bounded fallback.
- A scheduler crash after activation claim is repaired by existing execution
  and workspace recovery.
- A capacity-blocked activation is reconsidered when a terminal Run fact is
  recorded and by reconciliation after restart.
- Tick and `advanceOnce` remain operator-accessible recovery tools throughout
  migration.

## Migration and rollback

1. Introduce the durable wait contract without changing business reactions.
2. Introduce and test the generic subscription host.
3. Extract the focused scheduler while keeping `advanceOnce` as its caller.
4. Start the scheduler subscription; retain tick scheduling as a safety path.
5. Start the execution-completion subscription; retain completion
   reconciliation as an idempotent safety path.
6. Measure idle, cascading, concurrent-workflow, and slow-unrelated-stage
   scenarios.
7. Migrate remaining checkpointed reactors independently.

Rollback stops the new consumers and returns normal progress to the unchanged
reconciliation pipeline. No durable event or workflow representation changes
are required for the first vertical slice.

## Acceptance criteria

- Append-before-wait and append-during-processing cannot sleep until the
  fallback.
- A second filesystem journal instance wakes a waiting resident promptly.
- Multiple subscribers receive one append and advance independent checkpoints.
- A resumable internal conversation with capacity starts the fake runner in
  one event-driven burst without invoking the full Runner pipeline.
- A terminal Run can produce and dispatch the next activation without a global
  pipeline pass.
- A slow unrelated pipeline delivery or maintenance stage does not delay the
  scheduler consumer.
- Independent workflows dispatch concurrently when configured capacity allows;
  the same activation and unsafe workspace do not.
- Existing tick/recovery behaviour and durable replay remain valid.
