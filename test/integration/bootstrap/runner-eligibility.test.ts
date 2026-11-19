import { correlationId } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCompositionRoot, parseRootConfig } from '../../../src/bootstrap/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

it('leaves exhausted fresh work unstarted so another pool can use the only open-work slot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-runner-eligibility-'));
  const clock = new FakeClock();
  const calls: string[] = [];
  const context = (id: string) => ({
    commandId: id,
    correlationId: correlationId(id),
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  });
  const stage = (pool: string) => ({
    activity: 'agent',
    with: { prompt: 'complete work' },
    execution: { workspace: 'none', runnerPool: pool },
    requiresApproval: false,
    on: { done: { then: 'done' } },
  });
  try {
    const root = await createCompositionRoot(home, {
      clock,
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      config: parseRootConfig({
        controlPlane: { maxOpenWorkItems: 1, maxConcurrentRuns: 1, maxDispatches: 1 },
        execution: {
          agentRunners: { unavailable: { kind: 'fake' }, available: { kind: 'fake' } },
          runnerPools: { exhausted: ['unavailable'], eligible: ['available'] },
          defaultRunnerPool: 'exhausted',
        },
        orchestration: {
          default: 'exhausted',
          workflows: {
            exhausted: { stages: { implement: stage('exhausted') } },
            eligible: { stages: { implement: stage('eligible') } },
          },
        },
      }),
      decorateRunner(runner, name) {
        return {
          async start(request, signal) {
            calls.push(name);
            return runner.start(request, signal);
          },
        };
      },
    });
    await root.runnerControls.pause('unavailable', 'pause');
    for (const id of ['exhausted', 'eligible']) {
      await root.work.create({ workItemId: workId(id), objective: id }, context(`${id}-work`));
      await root.orchestration.start(
        {
          workItemId: workId(id),
          workflowInstanceId: workflowInstanceId(id),
          workflowName: workflowName(id),
          orchestrationGroupId: orchestrationGroupId(id),
        },
        context(`${id}-start`),
      );
    }
    expect(await root.advanceOnce({ maxProgress: 1 })).toMatchObject({ kind: 'progressed' });
    expect(calls).toEqual(['available']);
    expect((await root.execution.list()).map((run) => run.workflowInstanceId)).toEqual([
      workflowInstanceId('eligible'),
    ]);
    const exhausted = await root.orchestration.get(workflowInstanceId('exhausted'));
    expect(exhausted?.pendingActivation).toBeDefined();
    expect(exhausted?.hasStartedActivation).toBe(false);
    await root.advanceOnce({ maxProgress: 1 });
    expect(
      (await root.orchestration.get(workflowInstanceId('exhausted')))?.hasStartedActivation,
    ).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
