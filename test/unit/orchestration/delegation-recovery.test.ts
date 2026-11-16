import { correlationId } from '@atolis-hq/eventing';
import { expect, it, vi } from 'vitest';
import { DelegationPrerequisites } from '../../../src/orchestration/application/delegation-prerequisites.js';
import {
  OrchestrationEventType as Event,
  type WorkflowOrchestrationEventData,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

it.each(['ready', 'running', 'blocked', 'unsupported'])(
  'explicitly refreshes verified stale inputs and preserves recovery fences (%s)',
  async (scenario) => {
    const childWorkItemId = workId('recovery');
    const reference = {
      workItemId: workId('upstream'),
      resourceId: 'pr',
      repositoryResourceId: 'repo',
      revision: 'old',
      branch: 'upstream',
      runId: 'original',
      pullRequestBase: 'main',
    };
    const stored = { childWorkItemId, consumed: [{ name: 'change', reference }] };
    const consumed = [{ name: 'change', reference: { ...reference, revision: 'new' } }];
    const events: { event: { eventType: string; payload: unknown } }[] = [
      { event: { eventType: Event.DelegationInputsResolved, payload: stored } },
    ];
    const append = vi.fn(
      async (_id: string, _sequence: number, drafts: readonly WorkflowOrchestrationEventData[]) => {
        events.push(...drafts.map((event) => ({ event })));
      },
    );
    const repository = {
      loadRequired: async () => ({
        sequence: 1,
        view: {
          workflowInstanceId: 'child',
          status: scenario === 'blocked' ? 'blocked' : 'active',
        },
      }),
      history: async () => ({
        events: [
          {
            event: {
              eventType: Event.ActivityRequested,
              payload: { ordinal: 1, stage: 'implement', execution: { workspace: 'branch' } },
            },
          },
          ...events,
        ],
      }),
      append,
    };
    const post = vi.fn(async () => {});
    const prerequisites = new DelegationPrerequisites(
      repository as never,
      { events: async () => events } as never,
      {} as never,
      undefined,
      {} as never,
      {
        workflows: {
          definitionFor: async () => ({
            stages: { implement: { activity: 'agent', execution: { workspace: 'branch' } } },
          }),
        } as never,
        messages: { post },
        supportsAttention: () => scenario !== 'unsupported',
        childRunsEnded: async () => scenario !== 'running',
      },
    );
    vi.spyOn(prerequisites, 'read').mockResolvedValue({
      inputs: () => stored,
      select: async () => consumed,
    } as never);
    const invoke = () =>
      prerequisites.recover(
        {} as never,
        { workItemId: childWorkItemId, workflowInstanceId: 'child', prerequisites: [] } as never,
        JSON.stringify(stored.consumed),
        {
          commandId: 'recover',
          correlationId: correlationId('recover'),
          occurredAt: '2026-11-16T00:00:00Z',
          actor: { kind: 'system', id: 'test' },
        },
      );
    if (scenario !== 'ready') {
      await expect(invoke()).rejects.toThrow(
        scenario === 'running'
          ? 'unresolved Runs'
          : scenario === 'blocked'
            ? 'blocked'
            : 'agent activity',
      );
      expect(append).not.toHaveBeenCalled();
      return;
    }
    expect(await invoke()).toMatchObject({ status: 'refreshed', inputs: { consumed } });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![2].map((event: { eventType: string }) => event.eventType)).toEqual(
      [Event.DelegationInputsRefreshed, Event.StageEntered, Event.ActivityRequested],
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(await invoke()).toMatchObject({ status: 'refreshed' });
    expect(append).toHaveBeenCalledTimes(1);
  },
);
