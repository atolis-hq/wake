import { correlationId } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import { compileWorkflow, createOrchestrationService } from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const context = (seed: string) => ({
  commandId: `cmd-${seed}`,
  correlationId: correlationId(`corr-${seed}`),
  occurredAt: '2026-07-30T12:00:00Z',
  actor: { kind: 'operator' as const, id: 'test' },
});

// The resident loop runs merge recovery on every pass. It must fold only new
// events; replaying the whole journal per call costs one file read per event.
it('merge recovery folds the journal once across repeated passes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-merge-recovery-io-'));
  const journal = new FileEventJournal(root, new FakeClock());
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
  const definition = compileWorkflow(
    'default',
    {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    },
    registry,
  );
  const work = createWorkService(journal);
  const service = createOrchestrationService(journal, work, { default: definition });
  await work.create({ workItemId: workId('item'), objective: 'item' }, context('item'));
  await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow'),
      workItemId: workId('item'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group'),
    },
    context('item'),
  );
  const readAll = vi.spyOn(journal, 'readAll');

  for (let pass = 0; pass < 5; pass += 1)
    await service.recoverPolicyBlockedMerges({} as never, context(`pass-${pass}`));

  expect(readAll.mock.calls.filter(([after]) => after === 0).length).toBeLessThanOrEqual(1);
});
