import { expect, it } from 'vitest';
import { ScheduleService, type ScheduleConfig } from '../../src-next/control-plane/index.js';
import { correlationId, type CommandContext } from '../../src-next/kernel/index.js';

const config: ScheduleConfig = {
  id: 'hourly',
  workflow: 'review',
  cron: '* * * * *',
  objective: 'Review the repository',
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
  const service = new ScheduleService({
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
