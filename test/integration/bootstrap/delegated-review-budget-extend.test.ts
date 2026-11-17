import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import { WorkflowStatus } from '../../../src/orchestration/index.js';
import { toWorkItemKey } from '../../../src/surfaces/index.js';
import { workItemId } from '../../../src/work/index.js';

/**
 * corum#135 task 2 as recorded when `/extend` was rejected (409 `extend-ineligible`): a parentless
 * delegated child, completed long ago, blocked on `pr-review`'s spent `maxPerGroup` by a fresh
 * review request. The same composed API application must now accept the operator's extension.
 */
const task2 = workItemId('work-01m7hrcky7tr7rbwkkm39dx5kv');
const instance = 'delegated:work-01m7hrcky7tr7rbwkkm39dx5kv';

const stage = (workspace: string) => ({
  activity: 'agent',
  with: { prompt: 'Review the change' },
  execution: { workspace },
  requiresApproval: false,
  on: { done: { then: 'done' }, rejected: { then: 'done' } },
});

it('accepts the operator /extend for a delegated child blocked on a review-recovery budget (live corum#142 shape)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-budget-extend-'));
  try {
    const journal = new InMemoryEventJournal({ now: () => new Date('2026-11-17T19:30:00.000Z') });
    const facts: Record<string, unknown>[] = JSON.parse(
      await readFile(
        new URL('../../fixtures/delegation/corum-142-review-budget.json', import.meta.url),
        'utf8',
      ),
    );
    for (const fact of facts) {
      const {
        stream,
        recordedAt: _recorded,
        sequence: _sequence,
        globalPosition: _position,
        ...event
      } = fact as { stream: never } & Record<string, unknown>;
      await journal.appendToStream(stream, (await journal.readStream(stream)).length, [
        event as never,
      ]);
    }
    const root = await createCompositionRoot(home, {
      config: parseRootConfig({
        execution: {
          agentRunners: { fake: { kind: 'fake' } },
          runnerPools: { standard: ['fake'] },
          defaultRunnerPool: 'standard',
        },
        orchestration: {
          default: 'child-impl',
          workflows: {
            'child-impl': { stages: { implement: stage('branch') } },
            'pr-review': { stages: { review: stage('read-only') } },
          },
        },
      }),
      journal,
      checkpoints: new InMemoryCheckpointStore(),
      projections: new InMemoryProjectionStore(),
    });
    await root.work.create(
      { workItemId: task2, objective: 'namespace-137' },
      {
        commandId: 'create-task-2',
        correlationId: 'budget-extend' as never,
        occurredAt: '2026-11-17T19:30:00.000Z',
        actor: { kind: 'system', id: 'fixture' },
      },
    );
    const before = (await root.orchestration.get(instance as never))!;
    expect(before.status).toBe(WorkflowStatus.Blocked);
    expect(before.blockReason).toBe('watch group budget exhausted for pr-review');

    await root.projectionSubscriptions.catchUpOnce();
    const { api } = await createSurfaceApplications(root);
    const accepted = await api.work.extend!(toWorkItemKey(task2), { idempotencyKey: 'operator-1' });
    expect(accepted).toMatchObject({ status: 'accepted' });

    const after = (await root.orchestration.get(instance as never))!;
    expect(after.status).toBe(WorkflowStatus.Completed);
    const review = (await root.orchestration.listAll()).find(
      (workflow) =>
        workflow.parentWorkflowInstanceId === instance &&
        workflow.workflowInstanceId.endsWith('a505194b5353590afc401e52ed26f7001151c894:attempt:3'),
    );
    expect(review?.pendingActivation?.status).toBe('pending');
    // Extending again is refused by the same eligibility check, naming why.
    await expect(
      api.work.extend!(toWorkItemKey(task2), { idempotencyKey: 'operator-2' }),
    ).resolves.toMatchObject({ conflict: true, code: 'extend-ineligible' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
