import { expect, vi } from 'vitest';
import { z } from 'zod';
import { workId } from '../../support/identities.js';

import { ActivityRegistry, activationId, activityName } from '../../../src/activities/index.js';
import {
  createExecutionService,
  type RunStatus,
  type RunView,
} from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';

export function executionFixture() {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const ids = new SequentialIds();
  let resolve!: (outcome: { kind: 'done' }) => void;
  let cancelled = false;
  let executions = 0;
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName('long-running'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute(_invocation, context) {
        executions++;
        await context.reportExternalExecution({
          kind: 'process',
          id: 'process-1',
          startedAt: clock.now().toISOString(),
        });
        context.signal.addEventListener('abort', () => {
          cancelled = true;
        });
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
  });
  const service = createExecutionService(
    journal,
    registry,
    {
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
      leaseDurationMs: 60_000,
      leaseRenewalIntervalMs: 30_000,
    },
    { clock, ids },
  );
  const start = (owner = 'execution') =>
    service.attempt(
      {
        activationId: activationId('activation-1'),
        ordinal: 1,
        activity: activityName('long-running'),
        input: {},
        execution: { workspace: 'none' },
      },
      {
        workItemId: workId('1'),
        workflowInstanceId: workflowInstanceId('workflow-1'),
        orchestrationGroupId: orchestrationGroupId('group-1'),
        resources: [],
        owner,
      },
    );
  const started = async (): Promise<RunView> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const [run] = await service.list();
      if (run !== undefined && executions > 0) return run;
      await Promise.resolve();
    }
    throw new Error('Run did not start');
  };
  return {
    clock,
    journal,
    activities: registry,
    service,
    start,
    started,
    async finished(status: RunStatus): Promise<RunView> {
      await vi.waitFor(async () => {
        expect((await service.list())[0]?.status).toBe(status);
      });
      return (await service.list())[0]!;
    },
    complete(outcome: { kind: 'done' }) {
      resolve(outcome);
    },
    async events() {
      return journal.readAll(0);
    },
    get cancelled() {
      return cancelled;
    },
    get executions() {
      return executions;
    },
    async activeRunWithExternalExecution() {
      const pending = start('resident-a');
      await started();
      void pending;
      return (await service.list())[0]!;
    },
    expireLease() {
      clock.advance(60_001);
    },
  };
}
