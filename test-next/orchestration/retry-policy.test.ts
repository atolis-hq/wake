import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../src-next/orchestration/contracts/identifiers.js';
import { activationId } from '../../src-next/activities/contracts/identifiers.js';
import { activityName } from '../../src-next/activities/index.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ActivityRegistry } from '../../src-next/activities/index.js';
import {
  acceptActivityOutcome,
  compileWorkflow,
  foldWorkflowInstance,
  startInstance,
} from '../../src-next/orchestration/index.js';
import { workItemId } from '../../src-next/work/index.js';

function retryFixture() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z
      .object({
        kind: z.enum(['done', 'failed']),
        data: z
          .object({ retrySafety: z.enum(['safe-to-retry', 'requires-reconciliation']) })
          .optional(),
      })
      .strict(),
    outcomeKinds: ['done', 'failed'],
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
          on: {
            done: { then: 'done' },
            failed: { retry: { max: 1 }, then: 'await-human' },
          },
        },
      },
    },
    activities,
  );
  const started = startInstance({
    workflowInstanceId: workflowInstanceId('workflow-1'),
    workItemId: workItemId('work-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    definition,
    occurredAt: '2026-07-30T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'command-1',
  });
  if (started.kind !== 'append') throw new Error('expected start events');
  return { definition, events: [...started.events] };
}

function fail(
  fixture: ReturnType<typeof retryFixture>,
  events: readonly ReturnType<typeof retryFixture>['events'][number][],
  causationId: string,
  retrySafety: 'safe-to-retry' | 'requires-reconciliation' = 'safe-to-retry',
) {
  const state = foldWorkflowInstance(events)!;
  return acceptActivityOutcome(fixture.definition, state, {
    activationId: state.pendingActivation!.activationId,
    outcome: { kind: 'failed', data: { retrySafety } },
    occurredAt: '2026-07-30T12:01:00.000Z',
    causationId,
  });
}

describe('workflow retry policy', () => {
  it('creates a new activation and Run when Orchestration retry policy permits', () => {
    const fixture = retryFixture();
    const decision = fail(fixture, fixture.events, 'run-1');
    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') return;
    const retried = foldWorkflowInstance([...fixture.events, ...decision.events])!;
    expect(retried.pendingActivation).toMatchObject({
      activationId: activationId('workflow-1:activity:2'),
      ordinal: 2,
      activity: activityName('implement'),
    });
    expect(retried.retryCounts).toEqual({ 'implement:failed': 1 });
  });

  it('does not retry an outcome marked requires-reconciliation', () => {
    const fixture = retryFixture();
    const decision = fail(fixture, fixture.events, 'run-1', 'requires-reconciliation');
    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') return;
    const waiting = foldWorkflowInstance([...fixture.events, ...decision.events])!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.retryCounts).toEqual({});
    expect(waiting.pendingActivation?.ordinal).toBe(1);
  });

  it('follows the configured route after retry.max is exhausted', () => {
    const fixture = retryFixture();
    const first = fail(fixture, fixture.events, 'run-1');
    if (first.kind !== 'append') throw new Error('expected retry events');
    const retriedEvents = [...fixture.events, ...first.events];
    const exhausted = fail(fixture, retriedEvents, 'run-2');
    if (exhausted.kind !== 'append') throw new Error('expected route events');
    const waiting = foldWorkflowInstance([...retriedEvents, ...exhausted.events])!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.retryCounts).toEqual({ 'implement:failed': 1 });
    expect(waiting.pendingActivation?.ordinal).toBe(2);
  });
});
