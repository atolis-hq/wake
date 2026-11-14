# Subscription-Only Real-Time Runtime Design

## Status

Approved on 2026-08-29.

## Objective

Make durable subscriptions the only activation-scheduling architecture and
advance every runtime projection through an independent, event-driven durable
subscription. A slow or failed projection must not delay unrelated read models,
and normal deployments must not silently retain the legacy inline scheduler.

"Real time" in this design means backend projection and API freshness driven by
journal-change notification with bounded fallback. The web client's existing
three-second refresh policy is unchanged.

## Decisions

### Activation scheduling

- Remove `controlPlane.activationScheduler` from configuration, generated
  configuration, and current-state documentation.
- Always compose the durable activation-scheduler subscriber.
- Remove inline activation scheduling from the runner pipeline.
- Resident operation starts the scheduler subscriber independently of the
  runner loop.
- One-shot CLI and API ticks produce schedule/reactor facts and then invoke the
  same subscriber through its bounded `poke` operation before delivery.
- Retain the scheduler's global cross-process critical section. It remains the
  capacity and duplicate-dispatch correctness boundary.
- Existing configuration containing `controlPlane.activationScheduler` is
  invalid after this change. Operators must delete the temporary stanza before
  deploying this version.

### Projection subscriptions

- Every definition in `runtimeProjectionDefinitions` becomes one independently
  supervised `DurableSubscription`.
- Preserve the existing consumer identity `projection:<definition.name>`.
  Existing durable checkpoints therefore continue without a replay migration.
- Each subscriber has its own keyed lock, checkpoint, retry state, and health
  snapshot. Distinct projections may consume concurrently.
- Bootstrap owns the complete registration list and concrete lifecycle.
  Domain modules continue to own and export only their projection definitions;
  they do not depend on Persistence subscription mechanics.
- Remove the resident `runProjectionPump`, the global projection-runner lock,
  and centralized registered-projection pass from production runtime paths.

## Persistence components

### Durable subscription host

The existing Persistence-owned host remains responsible for bounded journal
reads, retry/backoff, checkpoint advancement, keyed serialization, health, and
abort. It gains a bounded single-pass operation used by one-shot commands and
projection-specific freshness barriers. The resident loop and the single-pass
operation share the same checkpoint-load, handle, checkpoint-save primitive.

### Projection batch applier

A generic Persistence-owned batch applier receives one projection definition,
one projection store, and a batch of envelopes. For each selected envelope it:

1. reads the current keyed projection value;
2. skips the fold when the stored `lastGlobalPosition` already includes the
   envelope;
3. otherwise applies `initial`/`project` and writes the new value stamped with
   the envelope position.

The subscription host checkpoints only after the complete batch succeeds. A
crash after projection writes but before checkpoint save replays the batch;
the stored-position guard makes that replay idempotent. Events not selected by
the definition still advance the consumer checkpoint.

### Projection rebuild service

Rebuilding a projection acquires the same `projection:<name>` keyed lock used
by its live subscriber for the entire clear, checkpoint reset, and bounded
journal replay. This prevents a live pass from saving an obsolete checkpoint
after reset. Rebuilds may process definitions sequentially for predictable
operator behavior; normal live consumption is concurrent.

## Runtime flow

### Resident start

1. Start all projection subscriptions.
2. Start the activation-scheduler subscription.
3. Start intake and the non-scheduling runner pipeline.
4. Journal appends wake all current consumers; each independently reads from
   its own durable position.
5. Shutdown aborts and awaits every subscription before closing surfaces.

The runner loop continues to own schedules, reactors, agent-run publication,
and delivery. Those processes are not projections and retain their existing
durable checkpoints.

### One-shot tick

A one-shot tick does not leave resident loops running. It therefore performs
bounded projection passes explicitly:

1. catch projections up before pipeline work;
2. run schedules and reactors;
3. catch projections up for newly produced facts;
4. invoke the activation-scheduler subscriber through `poke` before delivery;
5. run delivery with its projection freshness requirement satisfied;
6. catch projections up in `finally`, including when delivery fails.

The one-shot result is the scheduler subscriber's advancement result. There is
no inline scheduler fallback.

### Delivery freshness

Delivery reads pending intents from a projection. A projection-store write does
not append a journal event, so it cannot wake the runner loop. Before
`deliverNext`, the runtime must run a bounded pass for the delivery projection
or otherwise prove that projection has reached the relevant journal position.
This explicit barrier prevents a newly appended intent from waiting for the
subscription fallback timer.

## Health and failure behavior

- Scheduler and every projection subscriber expose starting, healthy,
  degraded, and stopped health with checkpoint and failure count.
- One degraded projection does not stop or serialize healthy siblings.
- Subscription failures retry with bounded backoff and replay from the last
  successful checkpoint.
- Health surfaces identify the affected projection consumer rather than
  reporting only a generic projection check.
- Filesystem notification is an accelerator. Durable global position and
  bounded fallback remain the correctness mechanism.

## Compatibility and migration

- Journal and projection file formats are unchanged.
- Existing `projection:<name>` checkpoints are reused without renaming.
- The temporary activation-scheduler mode is intentionally removed rather
  than deprecated. Strict config validation rejects it.
- Binary rollback remains possible by deploying the prior build. Durable
  subscription checkpoints do not alter or discard journal facts.
- Administrative projection rebuild remains supported while Wake is running
  because it shares the subscriber's per-consumer lock.

## Testing requirements

- Configuration rejects the removed scheduler-mode key and generated config
  omits it.
- Resident and one-shot paths can dispatch only through the scheduler
  subscriber.
- Every runtime projection definition maps to a distinct durable consumer with
  its existing checkpoint identity.
- A blocked or failing projection does not delay a healthy sibling.
- Replayed projection batches are idempotent after a simulated checkpoint
  failure.
- Rebuild and live consumption of the same projection serialize, while an
  unrelated projection continues.
- New orchestration and execution facts update work, resource, orchestration,
  execution, board, delivery, activity, conversation, control-plane, and
  analytics projections without manually invoking the legacy runner.
- Delivery does not wait for fallback after a new intent.
- Tick and resident scheduling remain behaviorally equivalent.
- Startup and abort await scheduler and projection subscription lifecycles.

## Exclusions

- No SSE, WebSocket, or browser push protocol is introduced.
- Reactors are not converted into projections or folded into this host.
- Domain projection definitions and event contracts are not redesigned.
- The activation scheduler's global capacity lock is not removed.
