import { expect, it } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { createSurfaceWorkApplications } from '../../../src/bootstrap/surface-api-work-applications.js';
import {
  OperatorRetryIneligibleError,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { toWorkItemKey } from '../../../src/surfaces/api/contracts/work.js';
import { resId, workId } from '../../support/identities.js';

const id = workId('surface-retry-error');

it('maps only a typed operator retry ineligibility to a conflict', async () => {
  const applications = createSurfaceWorkApplications(
    rootThatRejectsRetry(new OperatorRetryIneligibleError('retry eligibility changed')),
    () => '2026-08-12T12:00:00.000Z',
  );
  const retry = applications.retry;
  if (retry === undefined) throw new Error('Expected retry work application');

  await expect(retry(toWorkItemKey(id), { idempotencyKey: 'operator-1' })).resolves.toEqual({
    conflict: true,
    code: 'retry-ineligible',
    detail: 'retry eligibility changed',
  });
});

it('rethrows an unexpected operator retry error', async () => {
  const unexpected = new Error('journal unavailable');
  const applications = createSurfaceWorkApplications(
    rootThatRejectsRetry(unexpected),
    () => '2026-08-12T12:00:00.000Z',
  );
  const retry = applications.retry;
  if (retry === undefined) throw new Error('Expected retry work application');

  await expect(retry(toWorkItemKey(id), { idempotencyKey: 'operator-1' })).rejects.toBe(unexpected);
});

it('retries an eligible child only while its parent waits on that child watch', async () => {
  const retried: unknown[] = [];
  const parent = {
    ...eligibleWorkflow(),
    workflowInstanceId: 'primary-retry' as never,
    status: 'waiting' as const,
    waitingFor: {
      signalKind: 'orchestration.watch-gate-verdict' as never,
      from: [{ kind: 'watch' as const, watch: 'plan-review' as never }],
    },
  };
  const child = {
    ...eligibleWorkflow(),
    workflowInstanceId: 'child-retry' as never,
    parentWorkflowInstanceId: parent.workflowInstanceId,
    watchId: 'plan-review',
  };
  const applications = createSurfaceWorkApplications(
    {
      work: { get: async () => ({ state: 'open', deleted: false }) },
      orchestration: {
        listAll: async () => [parent, child],
        retryBlockedFailedStage: async (...input: unknown[]) => {
          retried.push(input);
        },
      },
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );
  const retry = applications.retry;
  if (retry === undefined) throw new Error('Expected retry work application');

  await expect(retry(toWorkItemKey(id), { idempotencyKey: 'operator-1' })).resolves.toMatchObject({
    status: 'accepted',
  });
  expect(retried).toEqual([[child.workflowInstanceId, expect.any(Object)]]);
});

it('uses stable resource-specific command ids when deleting multiple correlations', async () => {
  const workItemId = workId('delete-multiple-correlations');
  const first = resId('delete-correlation-first');
  const second = resId('delete-correlation-second');
  const retractionCommandIds: string[] = [];
  const applications = createSurfaceWorkApplications(
    {
      work: { delete: async () => ({}) },
      resources: {
        correlationsForWork: async () => [{ resourceId: first }, { resourceId: second }],
        retract: async (
          _resourceId: unknown,
          _workItemId: unknown,
          context: { readonly commandId: string },
        ) => {
          retractionCommandIds.push(context.commandId);
        },
      },
    } as unknown as CompositionRoot,
    () => '2026-08-16T13:00:00.000Z',
  );
  const remove = applications.delete;
  if (remove === undefined) throw new Error('Expected delete work application');

  await remove(toWorkItemKey(workItemId), { idempotencyKey: 'operator-1' });
  await remove(toWorkItemKey(workItemId), { idempotencyKey: 'operator-1' });

  expect(retractionCommandIds).toEqual([
    `work:operator-1:resource:${first}`,
    `work:operator-1:resource:${second}`,
    `work:operator-1:resource:${first}`,
    `work:operator-1:resource:${second}`,
  ]);
});

function rootThatRejectsRetry(error: Error): CompositionRoot {
  return {
    work: { get: async () => ({ state: 'open' }) },
    orchestration: {
      listAll: async () => [eligibleWorkflow()],
      retryBlockedFailedStage: async () => {
        throw error;
      },
    },
  } as unknown as CompositionRoot;
}

function eligibleWorkflow(): WorkflowInstanceView {
  return {
    workItemId: id,
    parentWorkflowInstanceId: undefined,
    status: 'blocked',
    blockReason: 'unconfigured outcome failed',
    pendingActivation: { activationId: 'activation-1', status: 'completed', supplemental: false },
    lastOutcome: { kind: 'failed' },
    acceptedOutcomes: ['activation-1'],
  } as unknown as WorkflowInstanceView;
}
