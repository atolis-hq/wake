import { expect, it } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { createSurfaceWorkApplications } from '../../../src/bootstrap/surface-api-work-applications.js';
import {
  OperatorRetryIneligibleError,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { toWorkItemKey } from '../../../src/surfaces/api/contracts/work.js';
import { workId } from '../../support/identities.js';

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
