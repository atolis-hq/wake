import { EventActorKind, correlationId } from '@atolis-hq/eventing';
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
  RetrySafety,
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
import { isActiveRunStatus } from '../../../src/execution/index.js';
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

function mixedScope(shared: boolean) {
  return shared
    ? {
        binding: { triggerCoordinationKey: () => 'shared' },
        ids: ['oversight', 'secondary'],
        key: 'shared',
        head: 'secondary',
      }
    : { binding: {}, ids: ['oversight'], key: 'oversight', head: 'oversight' };
}

async function claims(journal: InMemoryEventJournal) {
  return (await journal.readAll(0))
    .map(selectControlEvent)
    .flatMap((event) =>
      event?.event.eventType === ControlEventType.TriggerInvocationClaimed
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

  // Bulk file-backed writes need headroom for fsync contention in the full suite.
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
  }, 20_000);

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
    const paused = (await root.triggers.get()).pauses.oversight;
    expect(
      await root.triggers.requestManual('oversight', {
        ...f.context,
        commandId: 'manual-auto-paused',
      }),
    ).toMatchObject({ disposition: 'coalesced', activeWorkItemId: first.workItemId });
    expect((await root.triggers.get()).pauses.oversight).toBe(paused);
    expect((await root.orchestration.get(workflow.workflowInstanceId))?.retryCounts).toEqual({
      'start:failed': 1,
    });
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

  it('preserves queued manual requests across pause and restart', async () => {
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
    expect(await root.triggers.requestManual('oversight', queued)).toMatchObject({
      disposition: 'coalesced',
    });
    expect(await invocations(f.journal)).toHaveLength(1);
    await expect(root.triggers.get()).resolves.toMatchObject({
      pauses: { oversight: 'Operator pause' },
    });
    expect(Object.values((await root.triggers.get()).coalesced)[0]?.sources).toHaveLength(1);
    await accept(f, (await invocations(f.journal))[0]!.workflowInstanceId);
    await root.triggers.reconcile(f.context);
    expect(await invocations(f.journal)).toHaveLength(2);
    expect((await invocations(f.journal))[1]?.source).toMatchObject({
      kind: 'manual',
      commandId: queued.commandId,
    });
    expect((await root.triggers.get()).pauses.oversight).toBe('Operator pause');
  });

  it.each(['dispatch-paused', 'capacity-unavailable'] as const)(
    'durably returns %s even after eligibility changes',
    async (reason) => {
      const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, true);
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
    await f.root.triggers.pause('oversight', 'Operator pause', {
      ...f.context,
      commandId: 'api-pause',
    });
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
    await dispatcher.dispatch('POST', path, { idempotencyKey: 'queued-api' });
    const detail = await (
      await createSurfaceApplications(f.root)
    ).api.triggers!.detail('oversight');
    expect(detail?.data.pending).toHaveLength(1);
    expect(detail?.data.pending[0]).not.toHaveProperty('manualRequests');
    expect(detail?.data.pending[0]?.sources).toEqual([
      { kind: TriggerSourceKind.Manual, commandId: 'trigger:queued-api', operator: 'web' },
    ]);
    expect(detail?.data.pending[0]?.manualOutcome).toMatchObject({ disposition: 'coalesced' });
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

it('starts a persisted manual request after pause and restart before claim', async () => {
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
  const recovered = await restart(f);
  const outcome = await recovered.triggers.requestManual('oversight', f.context);
  expect(outcome).toMatchObject({ disposition: 'started' });
  expect(await recovered.triggers.requestManual('oversight', f.context)).toEqual(outcome);
  expect(await invocations(journal)).toHaveLength(1);
  await accept({ ...f, root: recovered }, (await invocations(journal))[0]!.workflowInstanceId);
  await recovered.triggers.reconcile(f.context);
  expect((await recovered.triggers.get()).pauses.oversight).toBe('Operator pause');
});

it('starts manual work while operator-paused and remains paused after completion', async () => {
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
  await f.root.triggers.pause('oversight', 'Operator pause', {
    ...f.context,
    commandId: 'pause-first',
  });
  expect(await f.root.triggers.requestManual('oversight', f.context)).toMatchObject({
    disposition: 'started',
  });
  const first = (await invocations(f.journal))[0]!;
  await accept(f, first.workflowInstanceId);
  await f.root.triggers.reconcile(f.context);
  expect((await f.root.triggers.get()).pauses.oversight).toBe('Operator pause');
});

it.each(['dispatch', 'runner'] as const)(
  'returns a typed API skip for %s controls on a paused ungated trigger',
  async (control) => {
    const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
    await f.root.triggers.pause('oversight', 'Operator pause', {
      ...f.context,
      commandId: 'pause',
    });
    if (control === 'dispatch') await f.root.controlPlane.pauseDispatch('dispatch');
    else await f.root.runnerControls.pause('fake', 'runner');
    const api = createApiDispatcher((await createSurfaceApplications(f.root)).api);
    expect(
      await api.dispatch('POST', '/api/v1/triggers/oversight/commands/run', {
        idempotencyKey: 'gated-api',
      }),
    ).toMatchObject({
      status: 200,
      body: {
        data: {
          triggerOutcome: {
            disposition: 'skipped',
            reason:
              control === 'dispatch'
                ? TriggerSkipReason.DispatchPaused
                : TriggerSkipReason.Capacity,
          },
        },
      },
    });
    expect(await invocations(f.journal)).toHaveLength(0);
  },
);

it('clears automatic sources around a manual pending request without losing manual provenance', async () => {
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] });
  await f.root.triggers.requestManual('oversight', f.context);
  await source(f, 'automatic-before');
  await f.consume();
  const manual = {
    ...f.context,
    commandId: 'surviving-manual',
    actor: { kind: EventActorKind.Operator, id: 'operator' },
  };
  await f.root.triggers.requestManual('oversight', manual);
  await source(f, 'automatic-after');
  await f.consume();
  await f.root.triggers.pause('oversight', 'Operator pause', {
    ...f.context,
    commandId: 'pause-mixed',
  });
  const root = await restart(f);
  expect((await root.triggers.get()).coalesced.oversight?.sources).toEqual([
    { kind: TriggerSourceKind.Manual, commandId: manual.commandId, operator: 'operator' },
  ]);
  await accept(f, (await invocations(f.journal))[0]!.workflowInstanceId);
  await root.triggers.reconcile(f.context);
  const second = (await invocations(f.journal))[1]!;
  expect(second.source).toEqual({
    kind: TriggerSourceKind.Manual,
    commandId: manual.commandId,
    operator: 'operator',
  });
  expect((await root.triggers.get()).invocations[1]?.claim.sources).toEqual([second.source]);
});

it('starts a new manual invocation after exhausted failures without resuming or resetting retries', async () => {
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
              on: { done: { then: 'done' }, failed: { retry: { max: 1 }, then: 'done' } },
            },
          },
        },
      },
    },
  });
  const root = await restart(f, { config });
  const failing = { ...f, root, config };
  await root.triggers.requestManual('oversight', f.context);
  const first = (await invocations(f.journal))[0]!;
  await accept(failing, first.workflowInstanceId, ActivityOutcomeKind.Failed);
  await accept(failing, first.workflowInstanceId, ActivityOutcomeKind.Failed);
  await root.triggers.reconcile(f.context);
  const paused = (await root.triggers.get()).pauses.oversight;
  expect(paused).toBeDefined();
  expect(
    await root.triggers.requestManual('oversight', {
      ...f.context,
      commandId: 'manual-after-failure',
    }),
  ).toMatchObject({ disposition: 'started' });
  const second = (await invocations(f.journal))[1]!;
  await accept(failing, second.workflowInstanceId);
  await root.triggers.reconcile(f.context);
  expect((await root.triggers.get()).pauses.oversight).toBe(paused);
  expect(
    (await root.orchestration.get(workflowInstanceId(first.workflowInstanceId)))?.retryCounts,
  ).toEqual({ 'start:failed': 1 });
});

it('returns a capacity skip at maxConcurrentRuns even for an ungated paused manual trigger', async () => {
  const started = deferred(),
    release = deferred();
  const f = await fixture(
    { events: [WorkEventType.ObjectiveRevised] },
    false,
    undefined,
    {
      decorateRunner(runner) {
        return {
          async start(request, signal) {
            const execution = await runner.start(request, signal);
            started.resolve();
            return { ...execution, result: release.promise.then(() => execution.result) };
          },
        };
      },
    },
    ['oversight', 'secondary'],
  );
  await f.root.triggers.requestManual('oversight', f.context);
  const running = f.root.advanceOnce({ maxProgress: 1 });
  try {
    await started.promise;
    expect(
      (await f.root.execution.list()).filter((run) => isActiveRunStatus(run.status)),
    ).toHaveLength(1);
    await f.root.triggers.pause('secondary', 'Operator pause', {
      ...f.context,
      commandId: 'pause-secondary',
    });
    expect(
      await f.root.triggers.requestManual('secondary', {
        ...f.context,
        commandId: 'manual-at-limit',
      }),
    ).toEqual({ disposition: 'skipped', reason: TriggerSkipReason.Capacity });
  } finally {
    release.resolve();
    await running;
  }
});

it.each([false, true])(
  'enforces manual capacity for mixed pending sources (shared scope: %s)',
  async (shared) => {
    const { binding, ids, key, head } = mixedScope(shared);
    const f = await fixture(
      { events: [WorkEventType.ObjectiveRevised] },
      false,
      undefined,
      binding,
      ids,
    );
    await f.root.triggers.requestManual('oversight', f.context);
    const commands = ['mixed-manual-first', 'mixed-manual-second'];
    const initialApi = createApiDispatcher((await createSurfaceApplications(f.root)).api);
    for (const command of commands)
      expect(
        await initialApi.dispatch('POST', '/api/v1/triggers/oversight/commands/run', {
          idempotencyKey: command,
        }),
      ).toMatchObject({
        body: { data: { triggerOutcome: { disposition: 'coalesced' } } },
      });
    await source(f, 'automatic-after-manual');
    await f.consume();
    expect((await f.root.triggers.get()).coalesced[key]?.source.kind).toBe(TriggerSourceKind.Event);
    expect((await f.root.triggers.get()).coalesced[key]?.triggerId).toBe(head);
    await f.root.runnerControls.pause('fake', 'capacity-lost');
    await accept(f, (await invocations(f.journal))[0]!.workflowInstanceId);
    const root = await restart(f, binding);
    await root.triggers.reconcile(f.context);
    // Only the manual commands are skipped; the ungated automatic occurrence still starts.
    const claimed = await claims(f.journal);
    expect(claimed).toHaveLength(2);
    expect(claimed[1]?.sources.length).toBeGreaterThan(0);
    expect(claimed[1]?.sources.every((entry) => entry.kind === TriggerSourceKind.Event)).toBe(true);
    expect(claimed[1]?.triggerId).toBe(head);
    expect((await root.triggers.get()).coalesced).toEqual({});
    await root.runnerControls.unpause('fake', 'capacity-restored');
    const recovered = await restart(f, binding);
    const api = createApiDispatcher((await createSurfaceApplications(recovered)).api);
    for (const command of commands) {
      expect(
        await api.dispatch('POST', '/api/v1/triggers/oversight/commands/run', {
          idempotencyKey: command,
        }),
      ).toMatchObject({
        status: 200,
        body: {
          data: { triggerOutcome: { disposition: 'skipped', reason: TriggerSkipReason.Capacity } },
        },
      });
    }
    expect(await invocations(f.journal)).toHaveLength(2);
  },
);

it.each([
  { name: 'later command fails', order: ['oversight', 'secondary'] },
  { name: 'earlier command fails', order: ['secondary', 'oversight'] },
])(
  'keeps the passing manual command pending when a shared-scope sibling fails admission ($name)',
  async ({ order }) => {
    const stage = (runnerPool: string) => ({
      start: {
        activity: 'agent',
        requiresApproval: false,
        execution: { runnerPool },
        with: { prompt: 'Inspect configured task' },
        on: { done: { then: 'done' } },
      },
    });
    const config = parseRootConfig({
      execution: {
        agentRunners: { fake: { kind: 'fake' }, other: { kind: 'fake' } },
        runnerPools: { standard: ['fake'], isolated: ['other'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: {
        default: 'inspect',
        workflows: {
          inspect: { stages: stage('standard') },
          isolated: { stages: stage('isolated') },
        },
      },
      controlPlane: {
        triggers: [
          {
            id: 'oversight',
            workflow: 'inspect',
            on: { events: [WorkEventType.ObjectiveRevised] },
          },
          {
            id: 'secondary',
            workflow: 'isolated',
            on: { events: [WorkEventType.ObjectiveRevised] },
          },
        ],
      },
    });
    const binding = { triggerCoordinationKey: () => 'shared', config };
    const f = await fixture(
      { events: [WorkEventType.ObjectiveRevised] },
      false,
      undefined,
      binding,
    );
    await f.root.triggers.requestManual('oversight', f.context);
    const api = createApiDispatcher((await createSurfaceApplications(f.root)).api);
    for (const trigger of order)
      expect(
        await api.dispatch('POST', `/api/v1/triggers/${trigger}/commands/run`, {
          idempotencyKey: `shared-${trigger}`,
        }),
      ).toMatchObject({ body: { data: { triggerOutcome: { disposition: 'coalesced' } } } });
    await f.root.runnerControls.pause('other', 'isolated-capacity-lost');
    await accept(f, (await invocations(f.journal))[0]!.workflowInstanceId);
    const root = await restart(f, binding);
    await root.triggers.reconcile(f.context);
    const claimed = await claims(f.journal);
    expect(claimed).toHaveLength(2);
    expect(claimed[1]?.triggerId).toBe('oversight');
    expect(claimed[1]?.sources).toEqual([
      { kind: TriggerSourceKind.Manual, commandId: 'trigger:shared-oversight', operator: 'web' },
    ]);
    expect((await root.triggers.get()).coalesced).toEqual({});
    const recovered = createApiDispatcher((await createSurfaceApplications(root)).api);
    expect(
      await recovered.dispatch('POST', '/api/v1/triggers/secondary/commands/run', {
        idempotencyKey: 'shared-secondary',
      }),
    ).toMatchObject({
      body: {
        data: { triggerOutcome: { disposition: 'skipped', reason: TriggerSkipReason.Capacity } },
      },
    });
  },
);

it('recovers a partial mixed-source skip without running the consumed manual command', async () => {
  const journal = new FaultInjectingJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') });
  const f = await fixture({ events: [WorkEventType.ObjectiveRevised] }, false, journal);
  await f.root.triggers.requestManual('oversight', f.context);
  const commands = ['consumed-before-crash', 'pending-after-crash'].map((commandId) => ({
    ...f.context,
    commandId,
  }));
  for (const command of commands) await f.root.triggers.requestManual('oversight', command);
  await source(f, 'automatic-after-commands');
  await f.consume();
  await f.root.runnerControls.pause('fake', 'capacity-lost');
  await accept(f, (await invocations(journal))[0]!.workflowInstanceId);
  journal.failAfter = ControlEventType.TriggerRequestRecorded;
  await expect(f.root.triggers.reconcile(f.context)).rejects.toThrow('Injected storage failure');
  await f.root.runnerControls.unpause('fake', 'capacity-restored');
  const root = await restart(f);
  await root.triggers.reconcile(f.context);
  expect(await root.triggers.requestManual('oversight', commands[0]!)).toEqual({
    disposition: 'skipped',
    reason: TriggerSkipReason.Capacity,
  });
  const history = (await root.triggers.get()).invocations;
  expect(history).toHaveLength(2);
  expect(history[1]?.claim.sources).toContainEqual({
    kind: TriggerSourceKind.Manual,
    commandId: commands[1]!.commandId,
    operator: commands[1]!.actor.id,
  });
  expect(history[1]?.claim.sources).not.toContainEqual({
    kind: TriggerSourceKind.Manual,
    commandId: commands[0]!.commandId,
    operator: commands[0]!.actor.id,
  });
});
