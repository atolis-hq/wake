import { describe, expect, it } from 'vitest';
import {
  concludeObservedWork,
  ExternalWorkOutcome,
  type WorkConclusion,
  type WorkConclusionServices,
} from '../../../src/integrations/index.js';
import type { WorkItemId, WorkItemView, WorkService } from '../../../src/work/index.js';
import { workId } from '../../support/identities.js';

function fakeWork(state: WorkItemView['state'] | null): WorkService {
  return {
    async get(id: WorkItemId) {
      return state === null ? null : ({ workItemId: id, state } as WorkItemView);
    },
  } as unknown as WorkService;
}

function fakeConclusion() {
  const calls: { method: 'closeWork' | 'cancelWork'; workItemId: WorkItemId; reason: string }[] =
    [];
  const conclusion: WorkConclusion = {
    async closeWork(id, reason) {
      calls.push({ method: 'closeWork', workItemId: id, reason });
      return { workItemId: id, state: 'closed' } as WorkItemView;
    },
    async cancelWork(id, reason) {
      calls.push({ method: 'cancelWork', workItemId: id, reason });
      return { workItemId: id, state: 'cancelled' } as WorkItemView;
    },
  };
  return { calls, conclusion };
}

describe('concludeObservedWork', () => {
  it('closes the work item when the outcome is Completed', async () => {
    const id = workId('work-1');
    const { calls, conclusion } = fakeConclusion();
    const services: WorkConclusionServices = { work: fakeWork('open'), conclusion };

    await concludeObservedWork(services, {
      workItemId: id,
      outcome: ExternalWorkOutcome.Completed,
      reason: 'issue closed',
    });

    expect(calls).toEqual([{ method: 'closeWork', workItemId: id, reason: 'issue closed' }]);
  });

  it('cancels the work item when the outcome is Cancelled', async () => {
    const id = workId('work-2');
    const { calls, conclusion } = fakeConclusion();
    const services: WorkConclusionServices = { work: fakeWork('open'), conclusion };

    await concludeObservedWork(services, {
      workItemId: id,
      outcome: ExternalWorkOutcome.Cancelled,
      reason: 'not planned',
    });

    expect(calls).toEqual([{ method: 'cancelWork', workItemId: id, reason: 'not planned' }]);
  });

  it('is a no-op when the work item is already concluded', async () => {
    const id = workId('work-3');
    const { calls, conclusion } = fakeConclusion();
    const services: WorkConclusionServices = { work: fakeWork('closed'), conclusion };

    await concludeObservedWork(services, {
      workItemId: id,
      outcome: ExternalWorkOutcome.Completed,
      reason: 'echo',
    });

    expect(calls).toEqual([]);
  });

  it('is a no-op when the work item does not exist', async () => {
    const id = workId('work-4');
    const { calls, conclusion } = fakeConclusion();
    const services: WorkConclusionServices = { work: fakeWork(null), conclusion };

    await concludeObservedWork(services, {
      workItemId: id,
      outcome: ExternalWorkOutcome.Cancelled,
      reason: 'missing',
    });

    expect(calls).toEqual([]);
  });
});
