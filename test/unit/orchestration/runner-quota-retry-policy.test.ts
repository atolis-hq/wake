import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activationId, activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import { WorkflowStatus } from '../../../src/orchestration/contracts/vocabulary.js';
import {
  compileWorkflow,
  foldWorkflowInstance,
  isRunnerQuotaRetryEligible,
  OrchestrationEventType,
  requestRunnerQuotaRetry,
  startInstance,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

function fixture() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({ attempt: z.literal('quota') }).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
    outcomeKinds: ['done', 'failed'],
    resources: [],
    executionKind: 'agent',
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
          with: { attempt: 'quota' },
          execution: { runnerPool: 'standard' },
          on: { done: { then: 'done' } },
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
    occurredAt: '2026-08-19T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'start-command',
  });
  if (started.kind !== 'append') throw new Error('expected start decision');
  const state = foldWorkflowInstance(started.events)!;
  return { definition, state, startEvents: started.events };
}

describe('runner-quota-retry-policy', () => {
  it('is eligible when the workflow has a matching, not-yet-accepted pending activation', () => {
    const { state } = fixture();
    expect(isRunnerQuotaRetryEligible(state, state.pendingActivation!.activationId)).toBe(true);
  });

  it('is not eligible for a different activation id', () => {
    const { state } = fixture();
    expect(isRunnerQuotaRetryEligible(state, activationId('other-activation'))).toBe(false);
  });

  it('appends a resolution fact and a fresh ActivityRequested without RetryCounted', () => {
    const { definition, state, startEvents } = fixture();
    const pendingActivationId = state.pendingActivation!.activationId;
    const decision = requestRunnerQuotaRetry(definition, state, {
      activationId: pendingActivationId,
      runId: 'run-1',
      runnerName: 'codex',
      message: "You've hit your usage limit.",
      occurredAt: '2026-08-19T12:05:00.000Z',
      causationId: 'command-1',
    });
    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') throw new Error('expected append');
    expect(decision.events.map((event) => event.eventType)).toEqual([
      OrchestrationEventType.ActivityRetriedForRunnerQuota,
      OrchestrationEventType.ActivityRequested,
    ]);

    const next = foldWorkflowInstance([...startEvents, ...decision.events])!;
    expect(next.status).toBe(WorkflowStatus.Active);
    expect(next.acceptedOutcomes).toContain(pendingActivationId);
    expect(next.retryCounts).toEqual({});
    expect(next.pendingActivation?.activationId).not.toBe(pendingActivationId);
  });

  it('is ignored when the activation id no longer matches the pending activation', () => {
    const { definition, state } = fixture();
    const decision = requestRunnerQuotaRetry(definition, state, {
      activationId: activationId('stale-activation'),
      runId: 'run-1',
      runnerName: 'codex',
      message: 'stale',
      occurredAt: '2026-08-19T12:05:00.000Z',
      causationId: 'command-1',
    });
    expect(decision.kind).toBe('ignored');
  });
});
