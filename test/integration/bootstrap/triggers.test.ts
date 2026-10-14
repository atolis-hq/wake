import {
  EventActorKind,
  EventSourceKind,
  correlationId,
  createEventData,
} from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityOutcomeKind,
  AgentResultStatus,
  ExternalExecutionKind,
  RetrySafety,
  activityName,
} from '../../../src/activities/index.js';
import type { CompositionRootOptions } from '../../../src/bootstrap/index.js';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import {
  ControlEventType,
  ControlStreamKind,
  TriggerSkipReason,
  TriggerSourceKind,
  maximumTriggerDiagnostics,
  maximumTriggerSources,
  selectControlEvent,
  triggerCriticalSectionConsumer,
  triggerInvocationProjection,
  triggerProjectionName,
  type TriggerConfig,
  type TriggerView,
} from '../../../src/control-plane/index.js';
import {
  ExecutionEventType,
  RecoveryBlockReasonPrefix,
  RunRepository,
  isActiveRunStatus,
  runId,
  runStream,
} from '../../../src/execution/index.js';
import {
  OrchestrationEventType,
  orchestrationGroupId,
  selectOrchestrationEvent,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { createApiDispatcher, toWorkItemKey } from '../../../src/surfaces/index.js';
import { WorkEventType, selectWorkEvent, workItemId } from '../../../src/work/index.js';
import { FaultInjectingJournal } from '../../support/fault-injecting-journal.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(
  on: TriggerConfig['on'],
  gated = false,
  journal = new InMemoryEventJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') }),
  options: CompositionRootOptions = {},
  triggerIds: readonly string[] = ['oversight'],
) {
  const home = await mkdtemp(join(tmpdir(), 'wake-triggers-'));
  homes.push(home);
  const clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };
  const config =
    options.config ??
    parseRootConfig({
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: {
        default: 'inspect',
        workflows: {
          inspect: {
            stages: {
              start: {
                activity: 'agent',
                requiresApproval: false,
                with: { prompt: 'Inspect configured task' },
                on: { done: { then: 'done' } },
              },
            },
          },
        },
      },
      controlPlane: {
        triggers: triggerIds.map((id) => ({
          id,
          workflow: 'inspect',
          on,
          ...(gated ? { when: { capacityAvailable: true } } : {}),
        })),
      },
    });
  const root = await createCompositionRoot(home, {
    ...options,
    config,
    clock,
    journal,
    checkpoints: new InMemoryCheckpointStore(),
    projections: new InMemoryProjectionStore(),
  });
  const processors = root.processorRuntime.processors.filter((processor) =>
    processor.consumer.startsWith('reactor:control-plane.trigger:'),
  );
  return {
    clock,
    config,
    home,
    root,
    journal,
    consume: () => root.processorRuntime.catchUp('trigger sources', processors),
    context: {
      commandId: 'source',
      correlationId: correlationId('source'),
      occurredAt: clock.now().toISOString(),
      actor: { kind: EventActorKind.System, id: 'test' },
    },
  };
}

async function invocations(journal: InMemoryEventJournal) {
  return (await journal.readAll(0))
    .map(selectControlEvent)
    .flatMap((event) =>
      event?.event.eventType === ControlEventType.TriggerInvocationStarted
        ? [event.event.payload]
        : [],
    );
}

describe('composed workflow triggers', () => {
  it.each([
    { cron: '* * * * *' },
    { events: [WorkEventType.ObjectiveRevised] },
    { cron: '* * * * *', events: [WorkEventType.ObjectiveRevised] },
  ])('starts ordinary independent invocations for %j', async (on) => {
    const { root, journal, consume, context } = await fixture(on);
    await consume();
    expect(await invocations(journal)).toEqual([]);
    await root.runnerPipeline.run({ maxProgress: 1 });
    if (on.events) {
      const sourceItem = workItemId('work-00000000000000000000000001');
      await root.work.create({ workItemId: sourceItem, objective: 'source' }, context);
      await root.work.revise(
        { workItemId: sourceItem, objective: 'changed' },
        { ...context, commandId: 'revise' },
      );
      await consume();
    }
    const origins = await invocations(journal);
    expect(origins).toHaveLength(1);
    expect(new Set(origins.map((origin) => origin.workItemId)).size).toBe(origins.length);
    for (const origin of origins) {
      expect(origin).toMatchObject({ triggerId: 'oversight', workflowName: 'inspect' });
      if (origin.source.kind === TriggerSourceKind.Cron)
        expect(origin.source.slot).toBe('2026-08-10T00:01:00.000Z');
      else if (origin.source.kind === TriggerSourceKind.Event) {
        const source = origin.source;
        expect(origin.source.eventType).toBe(WorkEventType.ObjectiveRevised);
        expect(
          (await journal.readAll(0)).some((event) => event.event.eventId === source.eventId),
        ).toBe(true);
      }
      const workflow = await root.orchestration.get(workflowInstanceId(origin.workflowInstanceId));
      expect(workflow).toMatchObject({ workItemId: origin.workItemId });
      const work = await root.work.get(workItemId(origin.workItemId));
      expect(work?.objective).toBe('Trigger oversight: workflow inspect');
    }
    const events = await journal.readAll(0);
    expect(
      events
        .map(selectWorkEvent)
        .some((event) => event?.event.eventType === WorkEventType.ItemLinked),
    ).toBe(false);
    const started = events
      .map(selectOrchestrationEvent)
      .filter((event) => event?.event.eventType === OrchestrationEventType.InstanceStarted);
    expect(started).toHaveLength(origins.length);
    for (const event of started)
      expect(event?.event.payload).not.toHaveProperty('parentWorkflowInstanceId');
  });

  it('skips gated cron and event occurrences while runners are paused; eligibility alone does not start work', async () => {
    const { root, journal, consume, context } = await fixture(
      { cron: '* * * * *', events: [WorkEventType.ObjectiveRevised] },
      true,
    );
    await root.runnerControls.pause('fake', 'pause');
    await root.runnerPipeline.run({ maxProgress: 1 });
    const item = workItemId('work-00000000000000000000000001');
    await root.work.create({ workItemId: item, objective: 'source' }, context);
    await root.work.revise(
      { workItemId: item, objective: 'changed' },
      { ...context, commandId: 'revise' },
    );
    await consume();
    expect((await root.triggers.get()).diagnostics).toEqual([
      expect.objectContaining({
        triggerId: 'oversight',
        reason: TriggerSkipReason.Capacity,
        occurredAt: '2026-08-10T00:01:30.000Z',
        source: expect.objectContaining({ kind: TriggerSourceKind.Event }),
      }),
    ]);
    expect(await invocations(journal)).toEqual([]);
    await root.runnerControls.unpause('fake', 'resume');
    await consume();
    await root.runnerPipeline.run({ maxProgress: 1 });
    expect(await invocations(journal)).toEqual([]);
    await root.work.revise(
      { workItemId: item, objective: 'next' },
      { ...context, commandId: 'next' },
    );
    await consume();
    expect(await invocations(journal)).toHaveLength(1);
  });
  it.each(['two-events', 'cron-and-event'] as const)(
    'coordinates concurrent sources (%s)',
    async (mode) => {
      const on = {
        events: [WorkEventType.ObjectiveRevised],
        ...(mode === 'cron-and-event' ? { cron: '* * * * *' } : {}),
      };
      const { root, journal, consume, context } = await fixture(
        on,
        false,
        undefined,
        {},
        mode === 'two-events' ? ['first', 'second'] : ['oversight'],
      );
      const item = workItemId('work-00000000000000000000000001');
      await root.work.create({ workItemId: item, objective: 'source' }, context);
      await root.work.revise(
        { workItemId: item, objective: 'changed' },
        { ...context, commandId: 'revise' },
      );
      await Promise.all([consume(), root.runnerPipeline.run({ maxProgress: 1 })]);
      const origins = await invocations(journal);
      expect(origins).toHaveLength(mode === 'two-events' ? 2 : 1);
      expect(new Set(origins.map((origin) => origin.workItemId)).size).toBe(origins.length);
      expect(Object.values((await root.triggers.get()).coalesced)).toHaveLength(
        mode === 'two-events' ? 0 : 1,
      );
      await consume();
      expect(await invocations(journal)).toHaveLength(origins.length);
    },
  );

  it('does not replay historical source events when registering a trigger', async () => {
    const first = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    const item = workItemId('work-00000000000000000000000001');
    await first.root.work.create({ workItemId: item, objective: 'source' }, first.context);
    await first.root.work.revise(
      { workItemId: item, objective: 'historical' },
      { ...first.context, commandId: 'historical' },
    );
    const registered = await fixture(
      { events: [WorkEventType.ObjectiveRevised] },
      false,
      first.journal,
    );
    await registered.consume();
    expect(await invocations(first.journal)).toEqual([]);
  });

  it('honors current active-run headroom before an event invocation', async () => {
    const completion = deferred();
    const started = deferred();
    const { root, journal, consume, context } = await fixture(
      { events: [WorkEventType.ObjectiveRevised] },
      true,
      undefined,
      {
        decorateRunner(runner) {
          return {
            async start(request, signal) {
              const execution = await runner.start(request, signal);
              started.resolve();
              return { ...execution, result: completion.promise.then(() => execution.result) };
            },
          };
        },
      },
    );
    const item = workItemId('work-00000000000000000000000001');
    await root.work.create({ workItemId: item, objective: 'occupy capacity' }, context);
    await root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-active'),
        workItemId: item,
        workflowName: workflowName('inspect'),
        orchestrationGroupId: orchestrationGroupId('primary-active'),
      },
      { ...context, commandId: 'start-active' },
    );
    await root.advanceOnce({ maxProgress: 1 });
    await started.promise;
    try {
      expect(
        (await root.execution.list()).filter((run) => isActiveRunStatus(run.status)),
      ).toHaveLength(1);
      await root.work.revise(
        { workItemId: item, objective: 'source while full' },
        { ...context, commandId: 'full' },
      );
      await consume();
      expect(await invocations(journal)).toEqual([]);
    } finally {
      completion.resolve();
      await vi.waitFor(async () =>
        expect(
          (await root.execution.list()).filter((run) => isActiveRunStatus(run.status)),
        ).toHaveLength(0),
      );
    }
    await root.work.revise(
      { workItemId: item, objective: 'source with headroom' },
      { ...context, commandId: 'headroom' },
    );
    await consume();
    expect(await invocations(journal)).toHaveLength(1);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function source(f: Fixture, id: string) {
  const item = workItemId('work-00000000000000000000000001');
  await f.root.work.create(
    { workItemId: item, objective: 'external' },
    { ...f.context, commandId: 'external-create' },
  );
  await f.root.work.revise({ workItemId: item, objective: id }, { ...f.context, commandId: id });
  const event = (await f.journal.readAll(0)).find(
    (envelope) =>
      envelope.event.causationId === id &&
      envelope.event.eventType === WorkEventType.ObjectiveRevised,
  );
  if (event === undefined) throw new Error('Source event missing');
  return event;
}

async function restart(f: Fixture, options: CompositionRootOptions = {}) {
  return createCompositionRoot(f.home, {
    config: f.config,
    journal: f.journal,
    clock: f.clock,
    ...options,
  });
}

async function accept(
  f: Fixture,
  workflowId: string,
  kind:
    typeof ActivityOutcomeKind.Done | typeof ActivityOutcomeKind.Failed = ActivityOutcomeKind.Done,
) {
  const workflow = await f.root.orchestration.get(workflowInstanceId(workflowId));
  if (workflow?.pendingActivation === undefined) throw new Error('Invocation activation missing');
  return f.root.orchestration.acceptOutcome(
    {
      workflowInstanceId: workflow.workflowInstanceId,
      activationId: workflow.pendingActivation.activationId,
      outcome:
        kind === ActivityOutcomeKind.Failed
          ? { kind, data: { retrySafety: RetrySafety.SafeToRetry } }
          : { kind },
    },
    { ...f.context, commandId: `outcome:${workflow.pendingActivation.activationId}` },
  );
}

describe('durable trigger coordination', () => {
  it('retains single-flight when a blocked invocation resumes after clarification', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    await source(f, 'initial');
    await f.consume();
    const first = (await invocations(f.journal))[0]!;
    const workflow = await f.root.orchestration.get(workflowInstanceId(first.workflowInstanceId));
    if (workflow?.pendingActivation === undefined) throw new Error('Missing invocation activation');
    await f.root.orchestration.acceptOutcome(
      {
        workflowInstanceId: workflow.workflowInstanceId,
        activationId: workflow.pendingActivation.activationId,
        outcome: {
          kind: ActivityOutcomeKind.Blocked,
          data: { status: AgentResultStatus.NeedsClarification },
        },
      },
      { ...f.context, commandId: 'clarification-needed' },
    );
    await f.root.triggers.reconcile(f.context);
    await f.root.orchestration.resumeNeedsClarificationStage(workflow.workflowInstanceId, {
      ...f.context,
      commandId: 'clarification-reply',
    });
    await f.root.triggers.resume('oversight', { ...f.context, commandId: 'resume-clarified' });
    await source(f, 'while-clarifying');
    await f.consume();
    expect(await invocations(f.journal)).toHaveLength(1);
    expect((await f.root.triggers.get()).invocations[0]?.result).toBeUndefined();
    await accept(f, first.workflowInstanceId);
    await f.root.triggers.reconcile(f.context);
    expect(await invocations(f.journal)).toHaveLength(2);
  });

  it('retains single-flight across blocked invocation retries and pauses again on another failure', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    await source(f, 'initial');
    await f.consume();
    const first = (await invocations(f.journal))[0]!;
    const blocked = await accept(f, first.workflowInstanceId, ActivityOutcomeKind.Failed);
    expect(blocked.status).toBe('blocked');
    await f.root.triggers.reconcile(f.context);
    const reads = vi.spyOn(f.journal, 'readStream');
    await f.root.triggers.reconcile(f.context);
    await f.root.triggers.reconcile(f.context);
    expect(
      reads.mock.calls.filter(([stream]) => stream.kind === ControlStreamKind.Trigger),
    ).toEqual([]);
    reads.mockRestore();
    expect((await f.root.triggers.get()).invocations[0]?.result).toBeUndefined();
    const recovered = await restart(f);
    await recovered.orchestration.retryBlockedFailedStage(blocked.workflowInstanceId, {
      ...f.context,
      commandId: 'operator-retry',
    });
    await recovered.triggers.resume('oversight', { ...f.context, commandId: 'resume-retried' });
    const retried = { ...f, root: recovered };
    const event = await source(retried, 'while-retrying');
    await recovered.triggers.start(
      f.config.controlPlane.triggers[0]!,
      {
        kind: TriggerSourceKind.Event,
        eventId: event.event.eventId,
        eventType: event.event.eventType,
      },
      f.context,
      event,
    );
    expect(await invocations(f.journal)).toHaveLength(1);
    expect(Object.values((await recovered.triggers.get()).coalesced)).toHaveLength(1);
    await accept(retried, first.workflowInstanceId, ActivityOutcomeKind.Failed);
    await recovered.triggers.reconcile(f.context);
    let view = await recovered.triggers.get();
    expect(view.pauses.oversight).toBeDefined();
    expect(view.coalesced).toEqual({});
    expect(view.invocations[0]?.result).toBeUndefined();
    await recovered.orchestration.retryBlockedFailedStage(blocked.workflowInstanceId, {
      ...f.context,
      commandId: 'operator-retry-again',
    });
    await accept(retried, first.workflowInstanceId);
    await recovered.triggers.reconcile(f.context);
    view = await recovered.triggers.get();
    expect(view.invocations[0]?.result?.status).toBe('completed');
    expect(await invocations(f.journal)).toHaveLength(1);
  });

  // Bulk fsync-backed fixtures need time under full-suite filesystem contention.
  it('bounds pending reasons and operational projections and does not replay history on idle reconciliation', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    await source(f, 'initial');
    await f.consume();
    for (let index = 0; index < maximumTriggerSources + 4; index += 1) {
      await source(f, `pending-${index}`);
      await f.consume();
    }
    await f.root.projectionSubscriptions.catchUpOnce();
    const state = await f.root.projections.read<TriggerView>(triggerProjectionName, 'oversight');
    expect(state?.value.requests).toHaveLength(1);
    expect(state?.value.invocations).toHaveLength(1);
    expect(state?.value.coalesced.oversight?.sources).toHaveLength(maximumTriggerSources);
    const recorded = (await f.journal.readAll(0)).filter(
      (event) => event.event.eventType === ControlEventType.TriggerRequestRecorded,
    );
    expect(recorded).toHaveLength(maximumTriggerSources + 1);
    expect(recorded.every((event) => event.stream.kind === ControlStreamKind.Trigger)).toBe(true);
    const first = (await invocations(f.journal))[0]!;
    await accept(f, first.workflowInstanceId);
    await f.root.triggers.reconcile(f.context);
    await f.root.projectionSubscriptions.catchUpOnce();
    expect(await f.root.projections.list(triggerInvocationProjection.name)).toHaveLength(2);
    expect(
      (await f.root.projections.read<TriggerView>(triggerProjectionName, 'oversight'))?.value
        .invocations,
    ).toHaveLength(1);
    await f.root.triggers.reconcile(f.context);
    const read = vi.spyOn(f.journal, 'readAll');
    await f.root.triggers.reconcile(f.context);
    await f.root.triggers.reconcile(f.context);
    expect(read).not.toHaveBeenCalled();
  }, 30000);

  it('clears a shared pending request even when a sibling supplied the last reason', async () => {
    const f = await fixture(
      { events: [WorkEventType.ObjectiveRevised] },
      false,
      undefined,
      { triggerCoordinationKey: () => 'shared' },
      ['oversight', 'secondary'],
    );
    await source(f, 'initial');
    await f.consume();
    await source(f, 'mixed-reasons');
    await f.consume();
    expect((await f.root.triggers.get()).coalesced.shared?.triggerId).toBe('secondary');
    await f.root.triggers.pause('oversight', 'clear shared pending', {
      ...f.context,
      commandId: 'pause-shared',
    });
    expect((await f.root.triggers.get()).coalesced).toEqual({});
    await accept(f, (await invocations(f.journal))[0]!.workflowInstanceId);
    await f.root.triggers.reconcile(f.context);
    expect(await invocations(f.journal)).toHaveLength(1);
  });

  // Two catch-up passes fsync their checkpoints; allow contention in the full suite.
  it('bounds cron catch-up and persists consumed slots across restart', async () => {
    const f = await fixture({ cron: '* * * * *' });
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    vi.spyOn(f.clock, 'now').mockReturnValue(new Date('2026-08-11T00:01:30.000Z'));
    await f.root.triggers.pause('oversight', 'skip catch-up', {
      ...f.context,
      commandId: 'pause-catch-up',
    });
    const pausedPosition = await f.journal.latestGlobalPosition();
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    let view = await f.root.triggers.get();
    expect(view.requests).toHaveLength(1);
    expect(await f.journal.latestGlobalPosition()).toBe(pausedPosition);
    expect(
      (await f.root.processorState.read('reactor:control-plane.trigger:oversight', 'cron'))?.value,
    ).toEqual({
      slot: '2026-08-10T01:05:00.000Z',
    });
    const recovered = await restart(f);
    await recovered.runnerPipeline.run({ maxProgress: 1 });
    view = await recovered.triggers.get();
    expect(view.requests).toHaveLength(1);
    expect(await f.journal.latestGlobalPosition()).toBe(pausedPosition);
    expect(
      (await recovered.processorState.read('reactor:control-plane.trigger:oversight', 'cron'))
        ?.value,
    ).toEqual({
      slot: '2026-08-10T02:09:00.000Z',
    });
    expect(view.coalesced).toEqual({});
    expect(view.invocations).toHaveLength(1);
  }, 15_000);

  it('coordinates bound triggers together and suppresses events from the shared scope', async () => {
    const binding = { triggerCoordinationKey: () => 'shared-oversight' };
    const f = await fixture(
      { events: [WorkEventType.ObjectiveRevised, OrchestrationEventType.InstanceCompleted] },
      false,
      undefined,
      binding,
      ['oversight', 'secondary'],
    );
    await source(f, 'shared-source');
    await f.consume();
    expect(await invocations(f.journal)).toHaveLength(1);
    expect(Object.keys((await f.root.triggers.get()).coalesced)).toEqual(['shared-oversight']);
    const first = (await invocations(f.journal))[0]!;
    await accept(f, first.workflowInstanceId);
    await f.consume();
    expect(await invocations(f.journal)).toHaveLength(2);
    const recovered = await restart(f, binding);
    const view = await recovered.triggers.get();
    expect(view.invocations.map((invocation) => invocation.claim.coordinationKey)).toEqual([
      'shared-oversight',
      'shared-oversight',
    ]);
    expect(view.coalesced).toEqual({});
    await accept(f, view.invocations[1]!.claim.workflowInstanceId);
    await f.consume();
    await recovered.runnerPipeline.run({ maxProgress: 1 });
    expect(await invocations(f.journal)).toHaveLength(2);
  });

  it('coalesces repeated active sources, preserves all reasons, and starts once after completion and restart', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    await source(f, 'first');
    await f.consume();
    const first = (await invocations(f.journal))[0]!;
    await source(f, 'second');
    await source(f, 'third');
    await f.consume();
    expect(await invocations(f.journal)).toHaveLength(1);
    expect(Object.values((await f.root.triggers.get()).coalesced)[0]?.sources).toHaveLength(2);
    await accept(f, first.workflowInstanceId);
    const recovered = await restart(f);
    await recovered.runnerPipeline.run({ maxProgress: 1 });
    await recovered.runnerPipeline.run({ maxProgress: 1 });
    const view = await recovered.triggers.get();
    expect(view.invocations).toHaveLength(2);
    expect(view.invocations[0]?.result?.status).toBe('completed');
    expect(view.invocations[1]?.claim.sources).toHaveLength(2);
    expect(view.coalesced).toEqual({});
  });

  it('consumes a coalesced request when capacity becomes ineligible before eventual start', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, true);
    await source(f, 'first');
    await f.consume();
    const first = (await invocations(f.journal))[0]!;
    await source(f, 'pending');
    await f.consume();
    await f.root.runnerControls.pause('fake', 'pause');
    await accept(f, first.workflowInstanceId);
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    expect((await f.root.triggers.get()).coalesced).toEqual({});
    await f.root.runnerControls.unpause('fake', 'resume');
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    expect(await invocations(f.journal)).toHaveLength(1);
    await source(f, 'future');
    await f.consume();
    expect(await invocations(f.journal)).toHaveLength(2);
  });

  it('bounds latest diagnostics independently of invocation history and keeps them across restart', async () => {
    const f = await fixture({ cron: '* * * * *' });
    await f.root.processorState.write({
      consumer: triggerCriticalSectionConsumer,
      key: 'skip-diagnostics',
      value: Array.from({ length: maximumTriggerDiagnostics }, (_, index) => ({
        triggerId: 'removed-' + index,
        source: { kind: TriggerSourceKind.Cron, slot: '2026-08-10T00:00:00.000Z' },
        reason: TriggerSkipReason.Removed,
        occurredAt: '2026-08-10T00:00:00.000Z',
      })),
    });
    await f.root.triggers.start(
      { id: 'removed-259', workflow: 'inspect', on: { cron: '* * * * *' } },
      { kind: TriggerSourceKind.Cron, slot: '2026-08-10T00:01:00.000Z' },
      f.context,
    );
    const diagnostics = (await f.root.triggers.get()).diagnostics!;
    expect(diagnostics).toHaveLength(256);
    expect(diagnostics[0]!.triggerId).toBe('removed-1');
    expect(diagnostics.at(-1)).toMatchObject({
      triggerId: 'removed-259',
      reason: TriggerSkipReason.Removed,
    });
    expect((await (await restart(f)).triggers.get()).diagnostics).toEqual(diagnostics);
    expect(await invocations(f.journal)).toHaveLength(0);
    expect(await f.journal.latestGlobalPosition()).toBe(0);
  });

  it('exposes real diagnostics, controls, invocation links and removed history through the API', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    const dispatch = createApiDispatcher((await createSurfaceApplications(f.root)).api);
    const read = await dispatch.dispatch('GET', '/api/v1/triggers', undefined);
    expect(read).toMatchObject({
      status: 200,
      body: { data: [{ triggerId: 'oversight', status: 'enabled', nextOccurrence: null }] },
    });
    expect(await dispatch.dispatch('GET', '/api/v1/triggers/missing', undefined)).toMatchObject({
      status: 404,
    });
    expect(
      await dispatch.dispatch('POST', '/api/v1/triggers/oversight/commands/pause', {
        idempotencyKey: 'web-pause',
      }),
    ).toMatchObject({ status: 200 });
    await source(f, 'paused-api');
    await f.consume();
    expect(await dispatch.dispatch('GET', '/api/v1/triggers/oversight', undefined)).toMatchObject({
      status: 200,
      body: { data: { status: 'paused', latestSkip: { reason: TriggerSkipReason.Paused } } },
    });
    expect(await invocations(f.journal)).toHaveLength(0);
    expect(
      await dispatch.dispatch('POST', '/api/v1/triggers/oversight/commands/resume', {
        idempotencyKey: 'web-resume',
      }),
    ).toMatchObject({ status: 200 });
    expect(await invocations(f.journal)).toHaveLength(0);
    await source(f, 'after-api-resume');
    await f.consume();
    const invocation = (await invocations(f.journal))[0]!;
    const key = toWorkItemKey(invocation.workItemId);
    expect(await dispatch.dispatch('GET', '/api/v1/triggers/oversight', undefined)).toMatchObject({
      body: { data: { invocations: [{ workItemKey: key }] } },
    });
    expect(await dispatch.dispatch('GET', '/api/v1/work-items/' + key, undefined)).toMatchObject({
      body: { data: { triggerOrigin: 'oversight' } },
    });
    const removed = await restart(f, {
      config: parseRootConfig({
        ...f.config,
        controlPlane: { ...f.config.controlPlane, triggers: [] },
      }),
    });
    expect(
      await createApiDispatcher((await createSurfaceApplications(removed)).api).dispatch(
        'GET',
        '/api/v1/triggers/oversight',
        undefined,
      ),
    ).toMatchObject({
      body: { data: { status: 'removed', definition: null, invocations: [{ workItemKey: key }] } },
    });
    expect(
      await dispatch.dispatch('POST', '/api/v1/triggers/oversight/commands/pause', {
        idempotencyKey: 'bad',
        extra: true,
      }),
    ).toMatchObject({ status: 422 });
  });

  it('keeps pause durable across restart and remove/re-add, clearing pending without stopping active work', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    await source(f, 'first');
    await f.consume();
    const first = (await invocations(f.journal))[0]!;
    await source(f, 'pending');
    await f.consume();
    await f.root.triggers.pause('oversight', 'operator pause', {
      ...f.context,
      commandId: 'pause',
    });
    expect((await f.root.triggers.get()).coalesced).toEqual({});
    await source(f, 'paused');
    await f.consume();
    const removedConfig = parseRootConfig({
      ...f.config,
      controlPlane: { ...f.config.controlPlane, triggers: [] },
    });
    const removed = await restart(f, { config: removedConfig });
    await removed.runnerPipeline.run({ maxProgress: 1 });
    expect((await removed.triggers.get()).invocations).toHaveLength(1);
    expect(
      await removed.orchestration.get(workflowInstanceId(first.workflowInstanceId)),
    ).not.toBeNull();
    await accept(f, first.workflowInstanceId);
    const restored = await restart(f);
    await restored.runnerPipeline.run({ maxProgress: 1 });
    expect((await restored.triggers.get()).pauses).toEqual({ oversight: 'operator pause' });
    await restored.triggers.resume('oversight', { ...f.context, commandId: 'resume' });
    await restored.runnerPipeline.run({ maxProgress: 1 });
    expect(await invocations(f.journal)).toHaveLength(1);
    const event = await source(f, 'future');
    await restored.triggers.start(
      f.config.controlPlane.triggers[0]!,
      {
        kind: TriggerSourceKind.Event,
        eventId: event.event.eventId,
        eventType: event.event.eventType,
      },
      f.context,
      event,
    );
    expect(await invocations(f.journal)).toHaveLength(2);
  });

  it('serializes duplicate sources from competing composed hosts sharing a home', async () => {
    const journal = new FaultInjectingJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') });
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, false, journal);
    const second = await restart(f);
    const event = await source(f, 'duplicate');
    const config = f.config.controlPlane.triggers[0]!;
    const reason = {
      kind: TriggerSourceKind.Event,
      eventId: event.event.eventId,
      eventType: event.event.eventType,
    } as const;
    const reached = deferred(),
      release = deferred();
    journal.beforeAppend = {
      eventType: ControlEventType.TriggerInvocationClaimed,
      reached: () => reached.resolve(),
      release: release.promise,
    };
    const firstStart = f.root.triggers.start(config, reason, f.context, event);
    await reached.promise;
    const secondStart = second.triggers.start(config, reason, f.context, event);
    release.resolve();
    await Promise.all([firstStart, secondStart]);
    expect(await invocations(f.journal)).toHaveLength(1);
    expect((await second.triggers.get()).requests).toHaveLength(1);
    expect(
      (await f.journal.readAll(0))
        .map(selectWorkEvent)
        .filter((envelope) => envelope?.event.eventType === WorkEventType.ItemCreated),
    ).toHaveLength(2);
  });

  it.each([
    [ControlEventType.TriggerRequestRecorded, 'after'],
    [ControlEventType.TriggerInvocationClaimed, 'before'],
    [ControlEventType.TriggerInvocationClaimed, 'after'],
    [WorkEventType.ItemCreated, 'before'],
    [WorkEventType.ItemCreated, 'after'],
    [OrchestrationEventType.InstanceStarted, 'before'],
    [OrchestrationEventType.InstanceStarted, 'after'],
    [ControlEventType.TriggerInvocationStarted, 'before'],
    [ControlEventType.TriggerInvocationStarted, 'after'],
  ] as const)(
    'recovers the %s/%s crash window without duplicate WorkItems or fresh capacity admission',
    async (eventType, window) => {
      const journal = new FaultInjectingJournal({
        now: () => new Date('2026-08-10T00:01:30.000Z'),
      });
      const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, true, journal);
      const event = await source(f, 'crash');
      const config = f.config.controlPlane.triggers[0]!;
      const reason = {
        kind: TriggerSourceKind.Event,
        eventId: event.event.eventId,
        eventType: event.event.eventType,
      } as const;
      if (window === 'before') journal.failBefore = eventType;
      else journal.failAfter = eventType;
      // Owning services may recover ambiguous appends in the same call.
      await f.root.triggers
        .start(config, reason, f.context, event)
        .catch((error) => expect(String(error)).toContain('Injected storage failure'));
      const claimed = (await f.root.triggers.get()).invocations.length > 0;
      if (claimed) await f.root.runnerControls.pause('fake', 'pause-after-claim');
      const recovered = await restart(f);
      await recovered.runnerPipeline.run({ maxProgress: 1 });
      await recovered.runnerPipeline.run({ maxProgress: 1 });
      await recovered.triggers.start(config, reason, f.context, event);
      expect(await invocations(journal)).toHaveLength(1);
      const created = (await journal.readAll(0))
        .map(selectWorkEvent)
        .filter((envelope) => envelope?.event.eventType === WorkEventType.ItemCreated);
      expect(created).toHaveLength(2);
      expect((await recovered.triggers.get()).coalesced).toEqual({});
    },
  );

  it('orders pause and start under the same shared-home lock', async () => {
    const journal = new FaultInjectingJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') });
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, false, journal);
    const competing = await restart(f);
    const event = await source(f, 'race');
    const reached = deferred(),
      release = deferred();
    journal.beforeAppend = {
      eventType: ControlEventType.TriggerInvocationClaimed,
      reached: () => reached.resolve(),
      release: release.promise,
    };
    const start = f.root.triggers.start(
      f.config.controlPlane.triggers[0]!,
      {
        kind: TriggerSourceKind.Event,
        eventId: event.event.eventId,
        eventType: event.event.eventType,
      },
      f.context,
      event,
    );
    await reached.promise;
    const api = createApiDispatcher((await createSurfaceApplications(competing)).api);
    const pause = api.dispatch('POST', '/api/v1/triggers/oversight/commands/pause', {
      idempotencyKey: 'race-pause',
    });
    release.resolve();
    await Promise.all([start, pause]);
    expect(await invocations(journal)).toHaveLength(1);
    expect((await competing.triggers.get()).pauses.oversight).toBe('Operator pause');
    await source(f, 'after-pause');
    await f.consume();
    expect(await invocations(journal)).toHaveLength(1);
  });

  it('suppresses completion events from its own invocation while allowing unrelated completion sources', async () => {
    const f = await fixture({ events: [OrchestrationEventType.InstanceCompleted] });
    const item = workItemId('work-00000000000000000000000002');
    await f.root.work.create({ workItemId: item, objective: 'independent' }, f.context);
    await f.root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-independent'),
        workItemId: item,
        workflowName: workflowName('inspect'),
        orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
      },
      f.context,
    );
    await accept(f, 'workflow-independent');
    await f.consume();
    const first = (await invocations(f.journal))[0]!;
    await accept(f, first.workflowInstanceId);
    await f.consume();
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    expect(await invocations(f.journal)).toHaveLength(1);
    expect((await f.root.triggers.get()).coalesced).toEqual({});
  });

  it('retains the blocked slot without pausing for restart ambiguity across repeated recovery', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    const event = await source(f, 'restart-ambiguity');
    await f.root.triggers.start(
      f.config.controlPlane.triggers[0]!,
      {
        kind: TriggerSourceKind.Event,
        eventId: event.event.eventId,
        eventType: event.event.eventType,
      },
      f.context,
      event,
    );
    const invocation = (await invocations(f.journal))[0]!;
    const workflowId = workflowInstanceId(invocation.workflowInstanceId);
    const workflow = await f.root.orchestration.get(workflowId);
    const run = runId('restart-run');
    const startedAt = f.clock.now().toISOString();
    const draft = (
      eventType: (typeof ExecutionEventType)[keyof typeof ExecutionEventType],
      payload: unknown,
    ) =>
      createEventData({
        eventId: `${run}:${eventType}`,
        eventType,
        occurredAt: startedAt,
        correlationId: run,
        causationId: run,
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: runStream(run),
        payload,
      } as never);
    // A run left behind by a previous container: expired lease, uninspectable process identity.
    await new RunRepository(f.journal).append(run, 0, [
      draft(ExecutionEventType.RunStarted, {
        activationId: workflow!.pendingActivation!.activationId,
        activity: activityName('agent'),
        workflowInstanceId: workflowId,
        orchestrationGroupId: workflow!.orchestrationGroupId,
        attempt: 1,
        startedAt,
      }),
      draft(ExecutionEventType.RunLeaseClaimed, {
        owner: 'previous-container',
        acquiredAt: startedAt,
        expiresAt: startedAt,
      }),
      draft(ExecutionEventType.RunExternalExecutionReported, {
        kind: ExternalExecutionKind.Process,
        id: 'identity-from-previous-container',
        startedAt,
      }),
    ] as never);
    const config = parseRootConfig({
      ...f.config,
      execution: { ...f.config.execution, maxAmbiguityReconciliationAttempts: 1 },
    });
    let reason: string | undefined;
    for (let i = 0; i < 3; i++) {
      const root = await restart(f, { config });
      await root.recovery.recoverActive(`resident-${i}`);
      await root.runnerPipeline.run({ maxProgress: 1 });
      expect((await root.triggers.get()).pauses.oversight).toBeUndefined();
      const blocked = await root.orchestration.get(workflowId);
      expect(blocked?.status).toBe('blocked');
      expect(blocked?.blockReason).toContain(RecoveryBlockReasonPrefix);
      reason ??= blocked?.blockReason;
      expect(blocked?.blockReason).toBe(reason);
      expect(await invocations(f.journal)).toHaveLength(1);
    }
  });

  it('pauses on exhausted workflow failures and does not reset retry counters on resume', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    const config = parseRootConfig({
      ...f.config,
      orchestration: {
        ...f.config.orchestration,
        workflows: {
          inspect: {
            stages: {
              start: {
                activity: 'agent',
                requiresApproval: false,
                with: { prompt: 'Inspect' },
                on: { done: { then: 'done' }, failed: { retry: { max: 1 }, then: 'await-human' } },
              },
            },
          },
        },
      },
    });
    const root = await restart(f, { config });
    const failing = { ...f, root, config };
    const event = await source(failing, 'failure');
    await root.triggers.start(
      config.controlPlane.triggers[0]!,
      {
        kind: TriggerSourceKind.Event,
        eventId: event.event.eventId,
        eventType: event.event.eventType,
      },
      f.context,
      event,
    );
    const first = (await invocations(f.journal))[0]!;
    let workflow = await accept(failing, first.workflowInstanceId, ActivityOutcomeKind.Failed);
    expect(workflow.retryCounts).toEqual({ 'start:failed': 1 });
    workflow = await accept(failing, first.workflowInstanceId, ActivityOutcomeKind.Failed);
    await root.runnerPipeline.run({ maxProgress: 1 });
    expect((await root.triggers.get()).pauses.oversight).toBeDefined();
    await root.triggers.resume('oversight', { ...f.context, commandId: 'failure-resume' });
    await root.runnerPipeline.run({ maxProgress: 1 });
    expect((await root.orchestration.get(workflow.workflowInstanceId))?.retryCounts).toEqual({
      'start:failed': 1,
    });
    expect(await invocations(f.journal)).toHaveLength(1);
  });
});

describe('manual trigger commands', () => {
  it('starts with operator provenance and preserves original outcomes across retries and subsequent commands', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    const context = { ...f.context, actor: { kind: EventActorKind.Operator, id: 'operator' } };
    expect(await f.root.triggers.requestManual('oversight', context)).toMatchObject({
      disposition: 'started',
    });
    const workItemId = (await invocations(f.journal))[0]!.workItemId;
    expect(await f.root.triggers.requestManual('oversight', context)).toEqual({
      disposition: 'started',
      workItemId,
    });
    const requests = (await f.journal.readAll(0, 256))
      .map(selectControlEvent)
      .filter((event) => event?.event.eventType === ControlEventType.TriggerRequestRecorded);
    expect(requests.at(-1)?.event.payload).toMatchObject({
      disposition: 'started',
      manualOutcome: { disposition: 'started', workItemId },
    });
    const pendingContext = { ...context, commandId: 'pending-manual' };
    expect(await f.root.triggers.requestManual('oversight', pendingContext)).toMatchObject({
      disposition: 'coalesced',
      activeWorkItemId: workItemId,
    });
    const root = await restart(f);
    expect(await root.triggers.requestManual('oversight', context)).toMatchObject({
      disposition: 'started',
    });
    expect(await root.triggers.requestManual('oversight', pendingContext)).toMatchObject({
      disposition: 'coalesced',
    });
    expect(await invocations(f.journal)).toHaveLength(1);
    expect((await invocations(f.journal))[0]?.source).toEqual({
      kind: 'manual',
      commandId: context.commandId,
      operator: 'operator',
    });
    expect(Object.values((await root.triggers.get()).coalesced)[0]?.sources).toHaveLength(1);
  });

  it('reports a queued request cleared by pause as skipped on retry', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    await f.root.triggers.requestManual('oversight', f.context);
    const queued = { ...f.context, commandId: 'queued-before-pause' };
    expect(await f.root.triggers.requestManual('oversight', queued)).toMatchObject({
      disposition: 'coalesced',
      activeWorkItemId: (await invocations(f.journal))[0]!.workItemId,
    });
    await f.root.triggers.pause('oversight', 'Operator pause', {
      ...f.context,
      commandId: 'clear-queued',
    });
    const root = await restart(f);
    expect(await root.triggers.requestManual('oversight', queued)).toEqual({
      disposition: 'skipped',
      reason: TriggerSkipReason.Paused,
    });
    expect(await root.triggers.requestManual('oversight', queued)).toEqual({
      disposition: 'skipped',
      reason: TriggerSkipReason.Paused,
    });
    expect(await invocations(f.journal)).toHaveLength(1);
    expect((await root.triggers.get()).coalesced).toEqual({});
  });

  it.each(['paused', 'dispatch-paused', 'capacity-unavailable'] as const)(
    'durably returns %s even after eligibility changes',
    async (reason) => {
      const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, true);
      if (reason === 'paused')
        await f.root.triggers.pause('oversight', 'Operator pause', {
          ...f.context,
          commandId: 'pause',
        });
      if (reason === 'dispatch-paused') await f.root.controlPlane.pauseDispatch('pause-dispatch');
      if (reason === 'capacity-unavailable')
        await f.root.runnerControls.pause('fake', 'pause-runner');
      expect(await f.root.triggers.requestManual('oversight', f.context)).toEqual({
        disposition: 'skipped',
        reason,
      });
      await f.root.triggers.resume('oversight', { ...f.context, commandId: 'resume' });
      await f.root.controlPlane.resumeDispatch('resume-dispatch');
      if (reason === 'capacity-unavailable')
        await f.root.runnerControls.unpause('fake', 'resume-runner');
      const root = await restart(f);
      expect(await root.triggers.requestManual('oversight', f.context)).toEqual({
        disposition: 'skipped',
        reason,
      });
      expect(await invocations(f.journal)).toHaveLength(0);
    },
  );

  it('recovers a persisted manual request before claim without duplication', async () => {
    const journal = new FaultInjectingJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') });
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, false, journal);
    journal.failAfter = ControlEventType.TriggerRequestRecorded;
    await expect(f.root.triggers.requestManual('oversight', f.context)).rejects.toThrow(
      'Injected storage failure',
    );
    expect(await invocations(journal)).toHaveLength(0);
    const root = await restart(f);
    expect(await root.triggers.requestManual('oversight', f.context)).toMatchObject({
      disposition: 'started',
    });
    expect(await invocations(journal)).toHaveLength(1);
    expect(await root.triggers.requestManual('oversight', f.context)).toMatchObject({
      disposition: 'started',
    });
    expect(await invocations(journal)).toHaveLength(1);
  });

  it('exposes manual outcomes through the existing operator HTTP command path', async () => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    const dispatcher = createApiDispatcher((await createSurfaceApplications(f.root)).api);
    const path = '/api/v1/triggers/oversight/commands/run';
    const request = { idempotencyKey: 'manual-api' };
    const first = await dispatcher.dispatch('POST', path, request);
    expect(first).toMatchObject({
      status: 200,
      body: { data: { triggerOutcome: { disposition: 'started' } } },
    });
    expect(await dispatcher.dispatch('POST', path, request)).toMatchObject({
      status: 200,
      body: { data: { triggerOutcome: { disposition: 'started' } } },
    });
    expect(await invocations(f.journal)).toHaveLength(1);
    expect((await invocations(f.journal))[0]?.source).toMatchObject({
      kind: 'manual',
      operator: 'web',
    });
  });
});

it('serializes double manual submissions and later starts the coalesced manual request', async () => {
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
  expect(
    await Promise.all([
      f.root.triggers.requestManual('oversight', f.context),
      f.root.triggers.requestManual('oversight', f.context),
    ]),
  ).toMatchObject([{ disposition: 'started' }, { disposition: 'started' }]);
  expect(await invocations(f.journal)).toHaveLength(1);
  await f.root.triggers.requestManual('oversight', { ...f.context, commandId: 'coalesced' });
  await accept(f, (await invocations(f.journal))[0]!.workflowInstanceId);
  const root = await restart(f);
  await root.triggers.reconcile(f.context);
  expect(await invocations(f.journal)).toHaveLength(2);
  expect((await invocations(f.journal))[1]?.source).toMatchObject({
    kind: 'manual',
    commandId: 'coalesced',
  });
});

it('durably skips excess manual sources without discarding pending requests', async () => {
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
  await f.root.triggers.requestManual('oversight', f.context);
  for (let index = 0; index < maximumTriggerSources; index += 1)
    await f.root.triggers.requestManual('oversight', {
      ...f.context,
      commandId: 'pending:' + index,
    });
  const context = { ...f.context, commandId: 'over-limit' };
  expect(await f.root.triggers.requestManual('oversight', context)).toEqual({
    disposition: 'skipped',
    reason: TriggerSkipReason.PendingLimit,
  });
  const view = await f.root.triggers.get();
  expect(view.coalesced.oversight?.sources).toHaveLength(maximumTriggerSources);
  expect(view.diagnostics).toMatchObject([
    { source: { kind: 'manual', commandId: 'over-limit' }, reason: TriggerSkipReason.PendingLimit },
  ]);
  expect(await f.root.triggers.requestManual('oversight', context)).toEqual({
    disposition: 'skipped',
    reason: TriggerSkipReason.PendingLimit,
  });
});

it('preserves manual command identity when the configured coordination scope changes', async () => {
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
  expect(await f.root.triggers.requestManual('oversight', f.context)).toMatchObject({
    disposition: 'started',
  });
  const root = await restart(f, {
    config: {
      ...f.config,
      controlPlane: {
        ...f.config.controlPlane,
        triggers: f.config.controlPlane.triggers.map((trigger) => ({
          ...trigger,
          contextScope: 'changed-scope',
        })),
      },
    },
  });
  expect(await root.triggers.requestManual('oversight', f.context)).toMatchObject({
    disposition: 'started',
  });
  expect(await invocations(f.journal)).toHaveLength(1);
});

it('reports a durable skip if capacity changes between the manual request and claim', async () => {
  const journal = new FaultInjectingJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') });
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, true, journal);
  const competing = await restart(f);
  const reached = deferred(),
    release = deferred();
  journal.beforeAppend = {
    eventType: ControlEventType.TriggerRequestRecorded,
    reached: reached.resolve,
    release: release.promise,
  };
  const command = f.root.triggers.requestManual('oversight', f.context);
  await reached.promise;
  await competing.runnerControls.pause('fake', 'pause-capacity');
  release.resolve();
  expect(await command).toEqual({ disposition: 'skipped', reason: TriggerSkipReason.Capacity });
  await f.root.runnerControls.unpause('fake', 'resume-capacity');
  expect(await f.root.triggers.requestManual('oversight', f.context)).toEqual({
    disposition: 'skipped',
    reason: TriggerSkipReason.Capacity,
  });
  expect(await invocations(journal)).toHaveLength(0);
});

it('keeps pause consumption durable when a manual request crashes before its claim', async () => {
  const journal = new FaultInjectingJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') });
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, false, journal);
  journal.failAfter = ControlEventType.TriggerRequestRecorded;
  await expect(f.root.triggers.requestManual('oversight', f.context)).rejects.toThrow(
    'Injected storage failure',
  );
  const root = await restart(f);
  await root.triggers.pause('oversight', 'Operator pause', {
    ...f.context,
    commandId: 'pause-after-crash',
  });
  await root.triggers.resume('oversight', { ...f.context, commandId: 'resume-after-crash' });
  expect(await root.triggers.requestManual('oversight', f.context)).toEqual({
    disposition: 'skipped',
    reason: TriggerSkipReason.Paused,
  });
  expect(await root.triggers.requestManual('oversight', f.context)).toEqual({
    disposition: 'skipped',
    reason: TriggerSkipReason.Paused,
  });
  expect(await invocations(journal)).toHaveLength(0);
});

it('inspects a blocked slot through HTTP and retries durably across restart before reconsidering queued work', async () => {
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
  await f.root.triggers.requestManual('oversight', { ...f.context, commandId: 'first' });
  const first = (await invocations(f.journal))[0]!;
  await f.root.triggers.requestManual('oversight', { ...f.context, commandId: 'queued' });
  await accept(f, first.workflowInstanceId, ActivityOutcomeKind.Failed);
  const api = createApiDispatcher((await createSurfaceApplications(f.root)).api);
  expect(await api.dispatch('GET', '/api/v1/triggers/oversight', undefined)).toMatchObject({
    status: 200,
    body: {
      data: {
        activeInvocation: {
          activeWorkItemId: first.workItemId,
          workflowStatus: 'blocked',
          blockReason: 'unconfigured outcome failed',
          retryEligible: true,
        },
        pending: [{ activeWorkItemId: first.workItemId }],
      },
    },
  });
  const path = '/api/v1/work-items/' + toWorkItemKey(first.workItemId) + '/commands/retry';
  expect(await api.dispatch('POST', path, { idempotencyKey: 'release-slot' })).toMatchObject({
    status: 202,
  });
  const recovered = await restart(f);
  const recoveredApi = createApiDispatcher((await createSurfaceApplications(recovered)).api);
  expect(
    await recoveredApi.dispatch('POST', path, { idempotencyKey: 'release-slot' }),
  ).toMatchObject({ status: 202 });
  const retries = (await f.journal.readAll(0)).filter(
    (entry) => entry.event.eventType === OrchestrationEventType.OperatorRetryRequested,
  );
  expect(retries).toHaveLength(1);
  expect(retries[0]?.event.actor).toEqual({ kind: EventActorKind.Operator, id: 'web' });
  await recovered.triggers.reconcile(f.context);
  expect(await invocations(f.journal)).toHaveLength(1);
  await accept({ ...f, root: recovered }, first.workflowInstanceId);
  const again = await restart(f);
  await again.triggers.reconcile(f.context);
  expect(await invocations(f.journal)).toHaveLength(2);
  expect((await again.triggers.get()).coalesced).toEqual({});
});

it('attributes shared pending requests to the sibling invocation holding their coordination slot', async () => {
  const f = await fixture(
    { events: [WorkEventType.ObjectiveRevised] },
    false,
    undefined,
    { triggerCoordinationKey: () => 'shared' },
    ['oversight', 'secondary'],
  );
  await f.root.triggers.requestManual('oversight', { ...f.context, commandId: 'holder' });
  const holder = (await invocations(f.journal))[0]!;
  const api = (await createSurfaceApplications(f.root)).api;
  expect((await api.triggers!.detail('secondary'))?.data.activeInvocation).toMatchObject({
    activeWorkItemId: holder.workItemId,
  });
  await f.root.triggers.requestManual('secondary', { ...f.context, commandId: 'sibling' });
  for (const id of ['oversight', 'secondary']) {
    expect((await api.triggers!.detail(id))?.data).toMatchObject({
      activeInvocation: { activeWorkItemId: holder.workItemId, triggerId: 'oversight' },
      pending: [{ triggerId: 'secondary', activeWorkItemId: holder.workItemId }],
    });
  }
});

it('keeps retry eligibility and pause semantics on trigger inspection and the shared Work command', async () => {
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
  await f.root.triggers.requestManual('oversight', { ...f.context, commandId: 'first' });
  const first = (await invocations(f.journal))[0]!;
  await accept(f, first.workflowInstanceId, ActivityOutcomeKind.Failed);
  await f.root.triggers.reconcile(f.context);
  const api = (await createSurfaceApplications(f.root)).api;
  const key = toWorkItemKey(first.workItemId);
  await f.root.work.freeze(workItemId(first.workItemId), { ...f.context, commandId: 'freeze' });
  expect((await api.triggers!.detail('oversight'))?.data.activeInvocation?.retryEligible).toBe(
    false,
  );
  expect(await api.work.retry!(key, { idempotencyKey: 'frozen-retry' })).toMatchObject({
    conflict: true,
    code: 'retry-ineligible',
  });
  await f.root.work.unfreeze(workItemId(first.workItemId), { ...f.context, commandId: 'unfreeze' });
  expect((await api.triggers!.detail('oversight'))?.data.activeInvocation?.retryEligible).toBe(
    true,
  );
  await api.work.retry!(key, { idempotencyKey: 'paused-retry' });
  await f.root.work.freeze(workItemId(first.workItemId), {
    ...f.context,
    commandId: 'freeze-after-retry',
  });
  expect(await api.work.retry!(key, { idempotencyKey: 'paused-retry' })).toMatchObject({
    status: 'accepted',
  });
  await f.root.work.unfreeze(workItemId(first.workItemId), {
    ...f.context,
    commandId: 'unfreeze-after-replay',
  });
  expect((await api.triggers!.detail('oversight'))?.data).toMatchObject({
    paused: true,
    activeInvocation: {
      activeWorkItemId: first.workItemId,
      workflowStatus: 'active',
      retryEligible: false,
    },
  });
  await accept(f, first.workflowInstanceId);
  await f.root.triggers.reconcile(f.context);
  expect((await api.triggers!.detail('oversight'))?.data).toMatchObject({
    paused: true,
    activeInvocation: null,
  });
});
