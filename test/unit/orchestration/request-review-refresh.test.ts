import { expect, it, vi } from 'vitest';
import { requestReviewRefresh } from '../../../src/orchestration/application/request-review-refresh.js';
import {
  OrchestrationEventType as Event,
  WatchGateVerdictSignal,
} from '../../../src/orchestration/index.js';

const head = 'a505194b';
const childId = 'delegated:two';
const first = `${childId}:watch:review:trigger:delegation:${childId}:review-refresh:change:${head}`;
const subject = { name: 'change', reference: { workItemId: 'two', revision: head } };

// The journal shape of corum#142: one recovery review requested for the head, then concluded.
function harness(review: { status: string; lastOutcome?: unknown } | null) {
  const events = [
    {
      event: {
        eventType: Event.SignalWaitStarted,
        payload: { signalKind: WatchGateVerdictSignal, from: [{ kind: 'watch', watch: 'review' }] },
      },
    },
    {
      event: {
        eventId: `delegation:${childId}:review-refresh:change:${head}`,
        eventType: Event.DelegationReviewRefreshRequested,
        payload: { requestId: first, watchId: 'review', subject },
      },
    },
  ];
  const append = vi.fn(async () => undefined);
  const repository = {
    loadRequired: async () => ({ view: { status: 'completed' }, sequence: 7 }),
    history: async () => ({ events }),
    load: async (id: string) => ({
      view: id === first && review !== null ? { workflowInstanceId: first, ...review } : null,
    }),
    append,
  };
  const dependencies = {
    repository,
    workflows: {
      definitionFor: async () => ({
        watches: [{ id: 'review', workflow: 'review', maxPerGroup: 5 }],
      }),
    },
    definitions: {
      currentDefinition: () => ({
        fingerprint: 'review-v1',
        definition: {
          entry: 'review',
          stages: { review: { execution: { workspace: 'read-only' } } },
        },
      }),
      register: async () => undefined,
    },
    delegated: { reviewSubject: async () => subject },
  };
  const request = () =>
    requestReviewRefresh(
      dependencies as never,
      { workflowInstanceId: childId, outputs: [{ name: 'change', kind: 'change' }] } as never,
      {
        action: 'review',
        childWorkItemId: 'two',
        output: 'change',
        expectedRevision: head,
      } as never,
      {
        commandId: 'recover',
        correlationId: 'recover',
        occurredAt: '2026-11-17T13:23:00.000Z',
        actor: { kind: 'system', id: 'test' },
      } as never,
    );
  return { request, append };
}

it.each([
  ['in flight', { status: 'active' }],
  ['accepted', { status: 'completed', lastOutcome: { kind: 'done', data: { status: 'DONE' } } }],
])('returns the existing request while its review is %s', async (_label, review) => {
  const { request, append } = harness(review);
  expect((await request()).requestId).toBe(first);
  expect(append).not.toHaveBeenCalled();
});

it('names a rejected fresh review instead of reporting it as accepted', async () => {
  const { request, append } = harness({
    status: 'completed',
    lastOutcome: { kind: 'rejected', data: { status: 'REJECTED' } },
  });
  await expect(request()).rejects.toThrow(
    `Fresh review ${first} rejected change at ${head}; revise the change before requesting another review`,
  );
  expect(append).not.toHaveBeenCalled();
});

it.each([
  [
    'failed',
    {
      status: 'completed',
      lastOutcome: { kind: 'failed', data: { reason: 'runner-failed', message: 'exit 1' } },
    },
  ],
  ['blocked', { status: 'blocked' }],
])(
  'requests a new attempt at the same head after a %s review without a verdict',
  async (_label, review) => {
    const { request, append } = harness(review);
    const retried = await request();
    expect(retried).toMatchObject({ requestId: first + ':attempt:2', subject });
    expect(append).toHaveBeenCalledWith(childId, 7, [
      expect.objectContaining({
        eventId: `delegation:${childId}:review-refresh:change:${head}:attempt:2`,
        eventType: Event.DelegationReviewRefreshRequested,
      }),
    ]);
  },
);
