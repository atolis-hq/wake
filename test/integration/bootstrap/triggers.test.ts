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
import { ActivityOutcomeKind, RetrySafety } from '../../../src/activities/index.js';
import type { CompositionRootOptions } from '../../../src/bootstrap/index.js';
import { createCompositionRoot, parseRootConfig } from '../../../src/bootstrap/index.js';
import {
  ControlEventType,
  TriggerSourceKind,
  selectControlEvent,
  type TriggerConfig,
} from '../../../src/control-plane/index.js';
import { isActiveRunStatus } from '../../../src/execution/index.js';
import {
  OrchestrationEventType,
  orchestrationGroupId,
  selectOrchestrationEvent,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
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
      else {
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
  it('bounds cron catch-up and persists consumed slots across restart', async () => {
    const f = await fixture({ cron: '* * * * *' });
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    vi.spyOn(f.clock, 'now').mockReturnValue(new Date('2026-08-11T00:01:30.000Z'));
    await f.root.triggers.pause('oversight', 'skip catch-up', {
      ...f.context,
      commandId: 'pause-catch-up',
    });
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    let view = await f.root.triggers.get();
    expect(view.requests).toHaveLength(65);
    expect(view.requests.at(-1)?.source).toEqual({
      kind: TriggerSourceKind.Cron,
      slot: '2026-08-10T01:05:00.000Z',
    });
    const recovered = await restart(f);
    await recovered.runnerPipeline.run({ maxProgress: 1 });
    view = await recovered.triggers.get();
    expect(view.requests).toHaveLength(129);
    expect(view.requests.at(-1)?.source).toEqual({
      kind: TriggerSourceKind.Cron,
      slot: '2026-08-10T02:09:00.000Z',
    });
    expect(view.coalesced).toEqual({});
    expect(view.invocations).toHaveLength(1);
  });

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
    const pause = competing.triggers.pause('oversight', 'race pause', {
      ...f.context,
      commandId: 'race-pause',
    });
    release.resolve();
    await Promise.all([start, pause]);
    expect(await invocations(journal)).toHaveLength(1);
    expect((await competing.triggers.get()).pauses.oversight).toBe('race pause');
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
    await root.triggers.resume('oversight', { ...f.context, commandId: 'failure-resume' });
    await root.runnerPipeline.run({ maxProgress: 1 });
    expect((await root.orchestration.get(workflow.workflowInstanceId))?.retryCounts).toEqual({
      'start:failed': 1,
    });
    expect(await invocations(f.journal)).toHaveLength(1);
  });
});
