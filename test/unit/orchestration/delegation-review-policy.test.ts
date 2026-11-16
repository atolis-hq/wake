import { expect, it, vi } from 'vitest';
import {
  createDelegationReviewPolicy,
  OrchestrationEventType as Event,
  WatchGateVerdictSignal,
} from '../../../src/orchestration/index.js';

const merge = (requireApproval: boolean) => ({
  activity: 'pr.merge',
  with: {
    target: 'primary',
    method: 'squash',
    requireChecks: true,
    requireApproval,
    autoMerge: true,
  },
  on: {},
});

it.each([
  { stages: { merge: merge(false) }, approval: false },
  { stages: { merge: merge(true) }, approval: true },
  { stages: {}, approval: true },
  { stages: { first: merge(false), second: merge(true) }, approval: true },
])('uses the pinned merge policy conservatively: %j', async ({ stages, approval }) => {
  const child = {
    workflowInstanceId: 'child',
    workflowName: 'child',
    workflowDefinitionFingerprint: 'pinned',
  };
  const resolve = vi.fn(async () => ({ stages }));
  const policy = createDelegationReviewPolicy(
    { history: async () => ({ events: [] }) } as never,
    { resolve } as never,
  );
  expect((await policy(child as never)).requireApproval).toBe(approval);
  expect(resolve).toHaveBeenCalledWith(child, { journalFallback: true });
});

it.each(['done', 'rejected', 'wrong-watch', 'new-wait'])(
  'selects only an accepted configured watch verdict (%s)',
  async (scenario) => {
    const wait = {
      event: {
        eventType: Event.SignalWaitStarted,
        payload: { signalKind: WatchGateVerdictSignal, from: [{ kind: 'watch', watch: 'review' }] },
      },
    };
    const events = [
      wait,
      {
        event: {
          eventType: Event.SignalAccepted,
          payload: {
            kind: WatchGateVerdictSignal,
            outcome: scenario === 'rejected' ? 'rejected' : 'done',
            authority: { kind: 'watch', watch: scenario === 'wrong-watch' ? 'other' : 'review' },
            providerEventId: 'review-instance',
          },
        },
      },
      ...(scenario === 'new-wait' ? [wait] : []),
    ];
    const review = { workflowInstanceId: 'review-instance' };
    const load = vi.fn(async () => ({ view: review }));
    const policy = createDelegationReviewPolicy(
      { history: async () => ({ events }), load } as never,
      { resolve: async () => ({ stages: { merge: merge(false) } }) } as never,
    );
    expect((await policy({ workflowInstanceId: 'child' } as never)).review).toEqual(
      scenario === 'done' ? review : undefined,
    );
  },
);
