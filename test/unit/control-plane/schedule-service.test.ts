import type { EventJournal } from '@atolis-hq/eventing';
import {
  WrongExpectedSequenceError,
  correlationId,
  type CommandContext,
} from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import {
  ControlEventType,
  TriggerService,
  TriggerSourceKind,
  selectControlEvent,
  type TriggerConfig,
} from '../../../src/control-plane/index.js';
import { workItemId } from '../../../src/work/index.js';

const config: TriggerConfig = {
  id: 'hourly',
  workflow: 'review',
  on: { cron: '* * * * *' },
};

it('creates one normal WorkItem and workflow for each accepted elapsed slot', async () => {
  let checkpoint: string | null = '2026-07-31T12:00:00.000Z';
  const created: string[] = [];
  const started: string[] = [];
  const context: CommandContext = {
    commandId: 'schedule-command',
    correlationId: correlationId('schedule-test'),
    occurredAt: '2026-07-31T12:01:30.000Z',
    actor: { kind: 'system', id: 'test' },
  };
  const service = new TriggerService({
    journal: new InMemoryEventJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') }),
    capacityAvailable: async () => true,
    checkpoint: {
      async load() {
        return checkpoint;
      },
      async save(_id, value) {
        checkpoint = value;
      },
    },
    ids: { next: () => 'work-00000000000000000000000001' },
    work: {
      async create(command) {
        created.push(command.workItemId);
        return {};
      },
    },
    orchestration: {
      async get() {
        return null;
      },
      async start(command) {
        started.push(command.workflowInstanceId);
        return {};
      },
    },
    now: () => '2026-07-31T12:01:30.000Z',
  });

  await service.run(config, context);

  expect(created).toHaveLength(1);
  expect(started).toHaveLength(1);
  expect(checkpoint).toBe('2026-07-31T12:01:00.000Z');
  expect(created[0]).toBe('work-00000000000000000000000001');
});

it.each(['contention', 'storage failure'] as const)(
  'repairs missing provenance after %s even when current capacity is full',
  async (failure) => {
    const journal = new InMemoryEventJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') });
    let unavailable = true;
    const append = vi
      .spyOn(journal, 'appendToStream')
      .mockImplementation(async (...args: Parameters<EventJournal['appendToStream']>) => {
        if (unavailable)
          throw failure === 'contention'
            ? new WrongExpectedSequenceError('contended')
            : new Error('storage unavailable');
        return InMemoryEventJournal.prototype.appendToStream.call(journal, ...args);
      });
    const item = workItemId('work-00000000000000000000000001');
    let workflow: { workItemId: typeof item } | null = null;
    const create = vi.fn(async () => ({}));
    const start = vi.fn(async () => {
      workflow = { workItemId: item };
    });
    const capacityAvailable = vi.fn(async () => true);
    const service = new TriggerService({
      journal,
      checkpoint: { load: async () => null, save: async () => {} },
      capacityAvailable,
      ids: { next: () => item },
      work: { create },
      orchestration: { get: async () => workflow, start },
      now: () => '2026-08-10T00:01:30.000Z',
    });
    const context: CommandContext = {
      commandId: 'source',
      correlationId: correlationId('source'),
      occurredAt: '2026-08-10T00:01:30.000Z',
      actor: { kind: 'system', id: 'test' },
    };
    const trigger = { ...config, when: { capacityAvailable: true } } as const;
    const source = { kind: TriggerSourceKind.Cron, slot: '2026-08-10T00:01:00.000Z' } as const;
    await expect(service.start(trigger, source, context)).rejects.toThrow();
    expect(append).toHaveBeenCalledTimes(failure === 'contention' ? 8 : 1);
    unavailable = false;
    capacityAvailable.mockResolvedValue(false);
    await expect(service.start(trigger, source, context)).resolves.toBe(true);
    await expect(service.start(trigger, source, context)).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(capacityAvailable).toHaveBeenCalledTimes(1);
    const records = (await journal.readAll(0))
      .map(selectControlEvent)
      .filter((event) => event?.event.eventType === ControlEventType.TriggerInvocationStarted);
    expect(records).toHaveLength(1);
    expect(records[0]?.event.payload).toMatchObject({
      workItemId: item,
      triggerId: config.id,
      source,
    });
  },
);
