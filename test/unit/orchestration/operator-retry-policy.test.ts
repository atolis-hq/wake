import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  activationId,
  activityName,
  ActivityOutcomeKind,
  ActivityRegistry,
} from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  ActivityActivationStatus,
  WorkflowStatus,
} from '../../../src/orchestration/contracts/vocabulary.js';
import {
  acceptActivityOutcome,
  compileWorkflow,
  foldWorkflowInstance,
  isChangesResumeEligible,
  isOperatorRetryEligible,
  orchestrationActivityOutcome,
  OrchestrationEventType,
  requestChangesResume,
  requestFreshOperatorRetry,
  requestOperatorRetry,
  selectOperatorRetryTarget,
  startInstance,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

function blockedFailedFixture() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({ attempt: z.literal('operator') }).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
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
          with: { attempt: 'operator' },
          execution: { runnerPool: 'recovery' },
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
    occurredAt: '2026-08-12T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'start-command',
  });
  if (started.kind !== 'append') throw new Error('expected start decision');
  const beforeFailure = foldWorkflowInstance(started.events)!;
  const failed = acceptActivityOutcome(definition, beforeFailure, {
    activationId: beforeFailure.pendingActivation!.activationId,
    outcome: orchestrationActivityOutcome({ kind: ActivityOutcomeKind.Failed }),
    occurredAt: '2026-08-12T12:01:00.000Z',
    causationId: 'failed-run',
  });
  if (failed.kind !== 'append') throw new Error('expected failed outcome decision');
  return { definition, state: foldWorkflowInstance([...started.events, ...failed.events])! };
}

function waitingFailedFixture() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({ attempt: z.literal('operator') }).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
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
          with: { attempt: 'operator' },
          execution: { runnerPool: 'recovery' },
          on: {
            done: { then: 'done' },
            failed: { retry: { max: 2 }, then: 'await-human' },
          },
        },
      },
    },
    activities,
  );
  const started = startInstance({
    workflowInstanceId: workflowInstanceId('workflow-3'),
    workItemId: workId('3'),
    orchestrationGroupId: orchestrationGroupId('group-3'),
    definition,
    occurredAt: '2026-08-12T12:00:00.000Z',
    correlationId: 'correlation-3',
    causationId: 'start-command',
  });
  if (started.kind !== 'append') throw new Error('expected start decision');
  let events = [...started.events];
  let state = foldWorkflowInstance(events)!;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = acceptActivityOutcome(definition, state, {
      activationId: state.pendingActivation!.activationId,
      outcome: orchestrationActivityOutcome({ kind: ActivityOutcomeKind.Failed }),
      occurredAt: `2026-08-12T12:0${attempt + 1}:00.000Z`,
      causationId: `failed-run-${attempt}`,
    });
    if (outcome.kind !== 'append') throw new Error('expected failed outcome decision');
    events = [...events, ...outcome.events];
    state = foldWorkflowInstance(events)!;
  }
  return { definition, state };
}

function blockedAgentFixture() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('agent'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'blocked']) }).strict(),
    outcomeKinds: ['done', 'blocked'],
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
    { stages: { refine: { activity: 'agent', with: {}, on: { done: { then: 'done' } } } } },
    activities,
  );
  const started = startInstance({
    workflowInstanceId: workflowInstanceId('workflow-2'),
    workItemId: workId('2'),
    orchestrationGroupId: orchestrationGroupId('group-2'),
    definition,
    occurredAt: '2026-08-12T12:00:00.000Z',
    correlationId: 'correlation-2',
    causationId: 'start-command',
  });
  if (started.kind !== 'append') throw new Error('expected start decision');
  const beforeBlocked = foldWorkflowInstance(started.events)!;
  const blocked = acceptActivityOutcome(definition, beforeBlocked, {
    activationId: beforeBlocked.pendingActivation!.activationId,
    outcome: orchestrationActivityOutcome({ kind: ActivityOutcomeKind.Blocked }),
    occurredAt: '2026-08-12T12:01:00.000Z',
    causationId: 'blocked-run',
  });
  if (blocked.kind !== 'append') throw new Error('expected blocked outcome decision');
  return { definition, state: foldWorkflowInstance([...started.events, ...blocked.events])! };
}

const retryInput = {
  commandId: 'operator-retry-command',
  occurredAt: '2026-08-12T12:02:00.000Z',
  causationId: 'operator-retry-command',
};

describe('operator retry policy', () => {
  it('marks a fresh operator retry so execution starts a new runner session', () => {
    const { definition, state } = blockedFailedFixture();

    const decision = requestFreshOperatorRetry(definition, state, retryInput);

    expect(decision).toMatchObject({
      kind: 'append',
      events: [
        { eventType: OrchestrationEventType.OperatorRetryRequested },
        {
          eventType: OrchestrationEventType.ActivityRequested,
          payload: { sessionPolicy: 'fresh' },
        },
      ],
    });
  });
  it('selects the retry-eligible watch child only while its exact parent waits on that watch', () => {
    const { state: child } = blockedFailedFixture();
    const parent = {
      ...child,
      workflowInstanceId: workflowInstanceId('parent'),
      status: WorkflowStatus.Waiting,
      waitingFor: {
        signalKind: 'orchestration.watch-gate-verdict' as never,
        from: [{ kind: 'watch' as const, watch: 'plan-review' as never }],
      },
    };
    const watchedChild = {
      ...child,
      workflowInstanceId: workflowInstanceId('watch-child'),
      parentWorkflowInstanceId: parent.workflowInstanceId,
      watchId: 'plan-review',
    };

    expect(selectOperatorRetryTarget([parent, watchedChild])).toBe(watchedChild);
  });

  it.each([
    [
      'parent is not waiting',
      (parent: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...parent,
        status: WorkflowStatus.Active,
      }),
    ],
    [
      'parent waits for another signal',
      (parent: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...parent,
        status: WorkflowStatus.Waiting,
        waitingFor: {
          signalKind: 'approved' as never,
          from: [{ kind: 'watch' as const, watch: 'plan-review' as never }],
        },
      }),
    ],
    [
      'child belongs to another watch',
      (parent: ReturnType<typeof blockedFailedFixture>['state']) => parent,
    ],
  ])('does not select a child when %s', (_name, change) => {
    const { state: child } = blockedFailedFixture();
    const parent = change({
      ...child,
      workflowInstanceId: workflowInstanceId('parent'),
      status: WorkflowStatus.Waiting,
      waitingFor: {
        signalKind: 'orchestration.watch-gate-verdict' as never,
        from: [{ kind: 'watch' as const, watch: 'plan-review' as never }],
      },
    });
    const watchedChild = {
      ...child,
      workflowInstanceId: workflowInstanceId('watch-child'),
      parentWorkflowInstanceId: parent.workflowInstanceId,
      watchId: _name === 'child belongs to another watch' ? 'pr-review' : 'plan-review',
    };

    expect(selectOperatorRetryTarget([parent, watchedChild])).toBeUndefined();
  });

  it('resumes an agent-blocked stage for a /changes command', () => {
    const { definition, state } = blockedAgentFixture();

    expect(isChangesResumeEligible(state)).toBe(true);
    const decision = requestChangesResume(definition, state, retryInput);

    expect(decision).toMatchObject({
      kind: 'append',
      events: [
        {
          eventType: OrchestrationEventType.OperatorRetryRequested,
          payload: {
            activationId: state.pendingActivation!.activationId,
            commandId: retryInput.commandId,
          },
        },
        {
          eventType: OrchestrationEventType.ActivityRequested,
          payload: { activity: activityName('agent') },
        },
      ],
    });
  });

  it('resumes the current agent stage when a conversation message arrives during a human wait', () => {
    const { definition, state } = blockedAgentFixture();
    const { blockReason: _blockReason, ...withoutBlockReason } = state;
    const waitingForApproval = {
      ...withoutBlockReason,
      status: WorkflowStatus.Waiting,
      lastOutcome: { kind: ActivityOutcomeKind.Done },
      waitingFor: { signalKind: 'approved' as never, from: [{ kind: 'human' as const }] },
    };

    expect(isChangesResumeEligible(waitingForApproval)).toBe(true);
    expect(requestChangesResume(definition, waitingForApproval, retryInput)).toMatchObject({
      kind: 'append',
      events: [
        { eventType: OrchestrationEventType.OperatorRetryRequested },
        {
          eventType: OrchestrationEventType.ActivityRequested,
          payload: { activity: activityName('agent') },
        },
      ],
    });
  });

  it('does not resume a human wait whose current stage is not an agent', () => {
    const { state } = blockedFailedFixture();
    const waitingForApproval = {
      ...state,
      status: WorkflowStatus.Waiting,
      waitingFor: { signalKind: 'approved' as never, from: [{ kind: 'human' as const }] },
    };

    expect(isChangesResumeEligible(waitingForApproval)).toBe(false);
  });

  it('rejects an empty operator retry command id', () => {
    const { definition, state } = blockedFailedFixture();

    expect(requestOperatorRetry(definition, state, { ...retryInput, commandId: '' })).toEqual({
      kind: 'ignored',
      reason: 'operator retry command id is required',
    });
  });

  it('records recovery then requests the current stage with its next ordinal and configuration', () => {
    const { definition, state } = blockedFailedFixture();

    const decision = requestOperatorRetry(definition, state, retryInput);

    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') return;
    expect(decision.events).toHaveLength(2);
    expect(decision.events.map((event) => event.eventType)).toEqual([
      OrchestrationEventType.OperatorRetryRequested,
      OrchestrationEventType.ActivityRequested,
    ]);
    expect(decision.events[0]!.payload).toEqual({
      activationId: state.pendingActivation!.activationId,
      commandId: retryInput.commandId,
    });
    expect(decision.events[1]!.payload).toMatchObject({
      activationId: 'workflow-1:activity:2',
      ordinal: 2,
      activity: activityName('implement'),
      input: { attempt: 'operator' },
      execution: { runnerPool: 'recovery' },
    });
    expect(isOperatorRetryEligible(state)).toBe(true);
  });

  it('retries a blocked terminal execution failure for the pending activation', () => {
    const { definition, state } = blockedFailedFixture();
    const { lastOutcome: _lastOutcome, ...withoutOutcome } = state;
    const executionFailed = {
      ...withoutOutcome,
      blockReason: 'runner exited 1',
      executionFailure: {
        activationId: state.pendingActivation!.activationId,
        runId: 'run-operator-retry',
        reason: 'runner exited 1',
      },
    };

    expect(isOperatorRetryEligible(executionFailed)).toBe(true);
    const decision = requestOperatorRetry(definition, executionFailed, retryInput);
    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') return;
    expect(decision.events[0]?.eventType).toBe(OrchestrationEventType.OperatorRetryRequested);
  });

  it('retries a stage waiting on the failed signal after automatic retries are exhausted', () => {
    const { definition, state } = waitingFailedFixture();

    expect(state.status).toBe(WorkflowStatus.Waiting);
    expect(state.waitingFor?.signalKind).toBe('failed');
    expect(isOperatorRetryEligible(state)).toBe(true);

    const decision = requestOperatorRetry(definition, state, retryInput);

    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') return;
    expect(decision.events.map((event) => event.eventType)).toEqual([
      OrchestrationEventType.OperatorRetryRequested,
      OrchestrationEventType.ActivityRequested,
    ]);
    expect(decision.events[0]!.payload).toEqual({
      activationId: state.pendingActivation!.activationId,
      commandId: retryInput.commandId,
    });
    expect(decision.events[1]!.payload).toMatchObject({
      activationId: 'workflow-3:activity:4',
      ordinal: 4,
      activity: activityName('implement'),
      input: { attempt: 'operator' },
      execution: { runnerPool: 'recovery' },
    });
  });

  it('does not treat waiting on a different signal as an exhausted-retry failure', () => {
    const { state } = waitingFailedFixture();

    expect(
      isOperatorRetryEligible({
        ...state,
        waitingFor: { ...state.waitingFor!, signalKind: 'approved' as never },
      }),
    ).toBe(false);
  });

  it.each([
    [
      'active',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        status: WorkflowStatus.Active,
      }),
    ],
    [
      'completed',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        status: WorkflowStatus.Completed,
      }),
    ],
    [
      'waiting',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        status: WorkflowStatus.Waiting,
      }),
    ],
    [
      'differently blocked',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        blockReason: 'manual block',
      }),
    ],
    [
      'supplemental',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        pendingActivation: { ...state.pendingActivation!, supplemental: true },
      }),
    ],
    [
      'follow-on',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        pendingActivation: { ...state.pendingActivation!, followOnIndex: 0 },
      }),
    ],
    [
      'pending activation',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        pendingActivation: {
          ...state.pendingActivation!,
          status: ActivityActivationStatus.Pending,
        },
      }),
    ],
    [
      'unaccepted activation',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        acceptedOutcomes: [],
      }),
    ],
    [
      'a different accepted activation',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        acceptedOutcomes: [activationId('workflow-1:activity:0')],
      }),
    ],
    [
      'non-failed outcome',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        lastOutcome: orchestrationActivityOutcome({ kind: ActivityOutcomeKind.Done }),
      }),
    ],
  ])('rejects %s states', (_name, change) => {
    const { definition, state } = blockedFailedFixture();
    const candidate = change(state);

    expect(isOperatorRetryEligible(candidate)).toBe(false);
    expect(requestOperatorRetry(definition, candidate, retryInput)).toEqual({
      kind: 'ignored',
      reason: 'workflow is not in a retryable failed-stage state',
    });
  });
});
