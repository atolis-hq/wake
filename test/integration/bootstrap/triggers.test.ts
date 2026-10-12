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

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(
  on: TriggerConfig['on'],
  gated = false,
  journal = new InMemoryEventJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') }),
  options: CompositionRootOptions = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'wake-triggers-'));
  homes.push(home);
  const clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };
  const config = parseRootConfig({
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
              with: { prompt: 'Inspect configured task' },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: {
      triggers: [
        {
          id: 'oversight',
          workflow: 'inspect',
          on,
          ...(gated ? { when: { capacityAvailable: true } } : {}),
        },
      ],
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
    expect(origins).toHaveLength(on.cron && on.events ? 2 : 1);
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
