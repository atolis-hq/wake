import { describe, expect, it } from 'vitest';
import { createWorkCancellationPolicy } from '../../../src/control-plane/index.js';
import type { WorkItemId, WorkItemView } from '../../../src/work/index.js';
import { workId } from '../../support/identities.js';

class FakeClock {
  now() {
    return new Date('2026-08-05T00:00:00.000Z');
  }
}

class SequentialIds {
  private next_ = 1;
  next(prefix: string) {
    return `${prefix}-${this.next_++}`;
  }
}

function fakeWorkPort() {
  const calls: { method: 'close' | 'cancel'; workItemId: WorkItemId; reason: string }[] = [];
  return {
    calls,
    async close(workItemId: WorkItemId, reason: string) {
      calls.push({ method: 'close', workItemId, reason });
      return { workItemId, state: 'closed' } as unknown as WorkItemView;
    },
    async cancel(workItemId: WorkItemId, reason: string) {
      calls.push({ method: 'cancel', workItemId, reason });
      return { workItemId, state: 'cancelled' } as unknown as WorkItemView;
    },
  };
}

function fakeOrchestrationPort(
  workflows: { workflowInstanceId: string; workItemId: WorkItemId }[],
) {
  const blocked: { workflowInstanceId: string; reason: string }[] = [];
  return {
    blocked,
    async listAll() {
      return workflows as never;
    },
    async block(workflowInstanceId: string, reason: string) {
      blocked.push({ workflowInstanceId, reason });
      return null;
    },
  };
}

function fakeExecutionPort() {
  const cancelled: { workflowInstanceIds: readonly string[]; reason: string }[] = [];
  return {
    cancelled,
    async cancelActive(workflowInstanceIds: readonly string[], reason: string) {
      cancelled.push({ workflowInstanceIds, reason });
      return [];
    },
  };
}

describe('createWorkCancellationPolicy', () => {
  it('closeWork calls Work.close, cancels active Runs with WorkClosed, and blocks matching workflows', async () => {
    const id = workId('close-1');
    const work = fakeWorkPort();
    const orchestration = fakeOrchestrationPort([
      { workflowInstanceId: 'wf-1', workItemId: id },
      { workflowInstanceId: 'wf-2', workItemId: workId('other') },
    ]);
    const execution = fakeExecutionPort();
    const policy = createWorkCancellationPolicy(
      work as never,
      orchestration as never,
      execution as never,
      new FakeClock() as never,
      new SequentialIds(),
    );

    const result = await policy.closeWork(id, 'issue closed as completed');

    expect(result.state).toBe('closed');
    expect(work.calls).toEqual([
      { method: 'close', workItemId: id, reason: 'issue closed as completed' },
    ]);
    expect(execution.cancelled).toEqual([{ workflowInstanceIds: ['wf-1'], reason: 'work-closed' }]);
    expect(orchestration.blocked).toEqual([
      { workflowInstanceId: 'wf-1', reason: 'work closed: issue closed as completed' },
    ]);
  });

  it('cancelWork still calls Work.cancel, cancels active Runs with WorkCancelled, and blocks matching workflows', async () => {
    const id = workId('cancel-1');
    const work = fakeWorkPort();
    const orchestration = fakeOrchestrationPort([{ workflowInstanceId: 'wf-3', workItemId: id }]);
    const execution = fakeExecutionPort();
    const policy = createWorkCancellationPolicy(
      work as never,
      orchestration as never,
      execution as never,
      new FakeClock() as never,
      new SequentialIds(),
    );

    const result = await policy.cancelWork(id, 'issue closed as not planned');

    expect(result.state).toBe('cancelled');
    expect(work.calls).toEqual([
      { method: 'cancel', workItemId: id, reason: 'issue closed as not planned' },
    ]);
    expect(execution.cancelled).toEqual([
      { workflowInstanceIds: ['wf-3'], reason: 'work-cancelled' },
    ]);
    expect(orchestration.blocked).toEqual([
      { workflowInstanceId: 'wf-3', reason: 'work cancelled: issue closed as not planned' },
    ]);
  });

  it('closeWork still calls cancelActive with an empty list when there are no matching workflows', async () => {
    const id = workId('close-2');
    const work = fakeWorkPort();
    const orchestration = fakeOrchestrationPort([]);
    const execution = fakeExecutionPort();
    const policy = createWorkCancellationPolicy(
      work as never,
      orchestration as never,
      execution as never,
      new FakeClock() as never,
      new SequentialIds(),
    );

    await policy.closeWork(id, 'reason');

    expect(execution.cancelled).toEqual([{ workflowInstanceIds: [], reason: 'work-closed' }]);
    expect(orchestration.blocked).toEqual([]);
  });
});
