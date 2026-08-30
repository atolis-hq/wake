import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activationId, activityName, ActivityRegistry } from '../../../src/activities/index.js';
import type { ActivityRequestedPayload } from '../../../src/orchestration/contracts/events.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import type {
  ActivityActivationView,
  WorkflowInstanceView,
} from '../../../src/orchestration/contracts/views.js';
import { WorkflowStatus } from '../../../src/orchestration/contracts/vocabulary.js';
import {
  compileWorkflow,
  foldWorkflowInstance,
  isRunnerQuotaRetryEligible,
  OrchestrationEventType,
  requestRunnerQuotaRetry,
  startInstance,
  workflowInstanceStream,
  type WorkflowOrchestrationEvent,
  type WorkflowOrchestrationEventData,
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
  const state = foldWorkflowInstance(recorded(started.events))!;
  return { state, startEvents: started.events };
}

function requestedActivation(decision: ReturnType<typeof requestRunnerQuotaRetry>) {
  if (decision.kind !== 'append') throw new Error('expected append');
  const requested = decision.events.find(
    (event) => event.eventType === OrchestrationEventType.ActivityRequested,
  );
  return requested!.payload as ActivityRequestedPayload;
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
    const { state, startEvents } = fixture();
    const pendingActivationId = state.pendingActivation!.activationId;
    const decision = requestRunnerQuotaRetry(state, {
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

    const next = foldWorkflowInstance(recorded([...startEvents, ...decision.events]))!;
    expect(next.status).toBe(WorkflowStatus.Active);
    expect(next.acceptedOutcomes).toContain(pendingActivationId);
    expect(next.retryCounts).toEqual({});
    expect(next.pendingActivation?.activationId).not.toBe(pendingActivationId);
  });

  it('is ignored when the activation id no longer matches the pending activation', () => {
    const { state } = fixture();
    const decision = requestRunnerQuotaRetry(state, {
      activationId: activationId('stale-activation'),
      runId: 'run-1',
      runnerName: 'codex',
      message: 'stale',
      occurredAt: '2026-08-19T12:05:00.000Z',
      causationId: 'command-1',
    });
    expect(decision.kind).toBe('ignored');
  });

  it('retries a supplemental activation with its own activity and input, not the stage activity', () => {
    const { state } = fixture();
    const supplemental = {
      ...state.pendingActivation!,
      activationId: activationId('workflow-1:activity:7'),
      ordinal: 7,
      activity: activityName('address-review'),
      input: { comment: 'please fix the import order' },
      supplemental: true,
    } as ActivityActivationView;
    const withSupplemental = {
      ...state,
      pendingActivation: supplemental,
    } as WorkflowInstanceView;

    const requested = requestedActivation(
      requestRunnerQuotaRetry(withSupplemental, {
        activationId: supplemental.activationId,
        runId: 'run-1',
        runnerName: 'codex',
        message: "You've hit your usage limit.",
        occurredAt: '2026-08-19T12:05:00.000Z',
        causationId: 'command-1',
      }),
    );

    expect(requested.activity).toBe(supplemental.activity);
    expect(requested.input).toEqual(supplemental.input);
    expect(requested.supplemental).toBe(true);
    expect(requested.ordinal).toBe(8);
  });

  it('retries a follow-on activation at its own follow-on index', () => {
    const { state } = fixture();
    const followOn = {
      ...state.pendingActivation!,
      activationId: activationId('workflow-1:activity:4'),
      ordinal: 4,
      activity: activityName('open-pull-request'),
      input: { title: 'ship' },
      followOnIndex: 1,
    } as ActivityActivationView;
    const withFollowOn = { ...state, pendingActivation: followOn } as WorkflowInstanceView;

    const requested = requestedActivation(
      requestRunnerQuotaRetry(withFollowOn, {
        activationId: followOn.activationId,
        runId: 'run-1',
        runnerName: 'codex',
        message: "You've hit your usage limit.",
        occurredAt: '2026-08-19T12:05:00.000Z',
        causationId: 'command-1',
      }),
    );

    expect(requested.activity).toBe(followOn.activity);
    expect(requested.input).toEqual(followOn.input);
    expect(requested.followOnIndex).toBe(1);
    expect(requested.supplemental).toBeUndefined();
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
