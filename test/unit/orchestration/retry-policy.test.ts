import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activationId } from '../../../src/activities/contracts/identifiers.js';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  acceptActivityOutcome,
  compileWorkflow,
  foldWorkflowInstance,
  orchestrationActivityOutcome,
  outcomeRouteConfigSchema,
  startInstance,
  workflowInstanceStream,
  type WorkflowOrchestrationEvent,
  type WorkflowOrchestrationEventData,
} from '../../../src/orchestration/index.js';
import {} from '../../../src/work/index.js';
import { workId } from '../../support/identities.js';

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
    workItemId: workId('1'),
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
  const state = foldWorkflowInstance(recorded(events))!;
  return acceptActivityOutcome(fixture.definition, state, {
    activationId: state.pendingActivation!.activationId,
    outcome: orchestrationActivityOutcome({ kind: 'failed', data: { retrySafety } }),
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
    const retried = foldWorkflowInstance(recorded([...fixture.events, ...decision.events]))!;
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
    const waiting = foldWorkflowInstance(recorded([...fixture.events, ...decision.events]))!;
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
    const waiting = foldWorkflowInstance(recorded([...retriedEvents, ...exhausted.events]))!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.retryCounts).toEqual({ 'implement:failed': 1 });
    expect(waiting.pendingActivation?.ordinal).toBe(2);
  });
});

function recorded(events: readonly WorkflowOrchestrationEventData[]): WorkflowOrchestrationEvent[] {
  return events.map((event, index) => ({
    event,
    stream: workflowInstanceStream(workflowInstanceId('workflow-1')),
    recordedAt: event.occurredAt,
    sequence: index + 1,
    globalPosition: index + 1,
  }));
}

it('journals each delayed retry and preserves the final unknown-check reason on exhaustion', () => {
  const fixture = retryFixture();
  const stage = fixture.definition.stages[fixture.definition.entry]!;
  const definition = {
    ...fixture.definition,
    stages: {
      ...fixture.definition.stages,
      [fixture.definition.entry]: {
        ...stage,
        on: {
          ...stage.on,
          blocked: {
            ...stage.on.failed!,
            retry: {
              max: 3,
              reasons: ['checks-could-not-be-read' as const, 'checks-pending' as const],
              delaysMs: [60000, 300000, 900000],
            },
          },
        },
      },
    },
  };
  const events = [...fixture.events];
  let now = Date.parse('2026-07-30T12:01:00.000Z');
  for (const [index, delay] of [60000, 300000, 900000].entries()) {
    const state = foldWorkflowInstance(recorded(events))!;
    const decision = acceptActivityOutcome(definition, state, {
      activationId: state.pendingActivation!.activationId,
      outcome: orchestrationActivityOutcome({
        kind: 'blocked',
        data: { reason: 'checks-could-not-be-read' },
      }),
      occurredAt: new Date(now).toISOString(),
      causationId: `denial-${index}`,
    });
    if (decision.kind !== 'append') throw new Error('expected retry');
    events.push(...decision.events);
    const replayed = foldWorkflowInstance(recorded(events))!;
    expect(replayed.pendingActivation?.notBefore).toBe(new Date(now + delay).toISOString());
    expect(replayed.retryCounts['implement:blocked']).toBe(index + 1);
    now += delay;
  }
  const state = foldWorkflowInstance(recorded(events))!;
  const exhausted = acceptActivityOutcome(definition, state, {
    activationId: state.pendingActivation!.activationId,
    outcome: orchestrationActivityOutcome({
      kind: 'blocked',
      data: { reason: 'checks-could-not-be-read' },
    }),
    occurredAt: new Date(now).toISOString(),
    causationId: 'exhausted',
  });
  if (exhausted.kind !== 'append') throw new Error('expected route');
  const final = foldWorkflowInstance(recorded([...events, ...exhausted.events]))!;
  expect(final.status).toBe('waiting');
  expect(final.retryCounts['implement:blocked']).toBe(3);
  expect(final.lastOutcome?.data).toEqual({ reason: 'checks-could-not-be-read' });
});

it.each([
  { max: 3, delaysMs: [60000] },
  { max: 1, delaysMs: [0] },
  { max: 1, reasons: ['checks-failing'] },
])('rejects malformed selective retry configuration %j', (retry) => {
  expect(outcomeRouteConfigSchema.safeParse({ then: 'await-human', retry }).success).toBe(false);
});
