import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  activityName,
  ActivityOutcomeKind,
  ActivityRegistry,
} from '../../../src/activities/index.js';
import { correlationId } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  signalName,
  stageName,
  watchId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  ApprovedSignal,
  compileWorkflow,
  createOrchestrationService,
  createSignalReactor,
  isApprovalAwaitingSignalKind,
  OrchestrationEventType,
  orchestrationStatusTransitions,
  WatchGateVerdictSignal,
  WorkflowStatus,
} from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import {} from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

async function waitingService(input: { readonly watchGate?: boolean } = {}) {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  const baseContext = {
    correlationId: correlationId('corr-1'),
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'operator' as const, id: 'owner' },
  };
  await work.create(
    { workItemId: workId('1'), objective: 'ship' },
    { ...baseContext, commandId: 'create-work' },
  );
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['failed', 'blocked']) }).strict(),
    outcomeKinds: ['failed', 'blocked'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'blocked' };
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
            failed: { retry: { max: 1 }, then: 'await-human' },
            blocked: { then: 'await-human' },
          },
        },
      },
    },
    activities,
  );
  const service = createOrchestrationService(journal, work, { default: definition });
  const started = await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-1'),
      workItemId: workId('1'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    { ...baseContext, commandId: 'start' },
  );
  const retried = await service.acceptOutcome(
    {
      workflowInstanceId: started.workflowInstanceId,
      activationId: started.pendingActivation!.activationId,
      outcome: { kind: 'failed' },
    },
    { ...baseContext, commandId: 'run-1' },
  );
  const waiting = await service.acceptOutcome(
    {
      workflowInstanceId: retried.workflowInstanceId,
      activationId: retried.pendingActivation!.activationId,
      outcome: { kind: 'blocked' },
    },
    { ...baseContext, commandId: 'run-2' },
  );
  await service.waitForSignal(
    waiting.workflowInstanceId,
    {
      signalKind: input.watchGate ? WatchGateVerdictSignal : signalName('accepted'),
      resourceId: resId('pr-1'),
      revision: 'abc123',
      ...(input.watchGate
        ? {
            from: [{ kind: 'watch' as const, watch: watchId('pr-review') }],
            onRejectResume: { kind: 'stage' as const, stage: stageName('implement') },
          }
        : {}),
    },
    { ...baseContext, commandId: 'wait' },
  );
  return { service, baseContext };
}

async function rejectedApprovalWaitingService(onRejectResume?: {
  readonly kind: 'stage';
  readonly stage: ReturnType<typeof stageName>;
}) {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  const baseContext = {
    correlationId: correlationId('corr-1'),
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'operator' as const, id: 'owner' },
  };
  await work.create(
    { workItemId: workId('1'), objective: 'ship' },
    { ...baseContext, commandId: 'create-work' },
  );
  const activities = new ActivityRegistry();
  for (const name of ['refine', 'implement']) {
    activities.register({
      name: activityName(name),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('blocked') }).strict(),
      outcomeKinds: ['blocked'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'blocked' };
        },
      },
    });
  }
  const definition = compileWorkflow(
    'default',
    {
      stages: {
        refine: {
          activity: 'refine',
          with: {},
          on: {
            blocked: {
              then: 'implement',
              await: { signal: ApprovedSignal, from: ['human'] },
            },
          },
        },
        implement: { activity: 'implement', with: {}, on: { blocked: { then: 'done' } } },
      },
    },
    activities,
  );
  const service = createOrchestrationService(journal, work, { default: definition });
  const started = await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-1'),
      workItemId: workId('1'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    { ...baseContext, commandId: 'start' },
  );
  const waiting = await service.acceptOutcome(
    {
      workflowInstanceId: started.workflowInstanceId,
      activationId: started.pendingActivation!.activationId,
      outcome: { kind: 'blocked' },
    },
    { ...baseContext, commandId: 'refine-blocked' },
  );
  await service.waitForSignal(
    waiting.workflowInstanceId,
    {
      signalKind: ApprovedSignal,
      resourceId: resId('pr-1'),
      revision: 'abc123',
      from: [{ kind: 'human' }],
      resume: { kind: 'stage', stage: stageName('implement') },
      ...(onRejectResume === undefined ? {} : { onRejectResume }),
    },
    { ...baseContext, commandId: 'set-rejection-resume' },
  );
  return { service, baseContext, journal };
}

it('does not let a human reply reset the retry count', async () => {
  const { service, baseContext } = await waitingService();
  const resumed = await service.acceptSignal(
    workflowInstanceId('workflow-1'),
    {
      kind: signalName('accepted'),
      resourceId: resId('pr-1'),
      revision: 'abc123',
      actorId: 'owner',
      actorDecision: { authorized: true, evidenceId: 'review-decision-1' },
      providerEventId: 'github-comment-1',
    },
    { ...baseContext, commandId: 'signal-1' },
  );
  expect(resumed.retryCounts).toEqual({ 'implement:failed': 1 });
  expect(resumed.pendingActivation?.ordinal).toBe(3);
});

it('restarts the current refine stage when an approval is rejected', async () => {
  const { service, baseContext, journal } = await rejectedApprovalWaitingService();
  const before = (await journal.readAll(0)).length;

  await service.acceptSignal(
    workflowInstanceId('workflow-1'),
    {
      kind: ApprovedSignal,
      resourceId: resId('pr-1'),
      revision: 'abc123',
      outcome: ActivityOutcomeKind.Rejected,
      actorId: 'owner',
      actorDecision: { authorized: true, evidenceId: 'review-rejected' },
      providerEventId: 'github-comment-rejected',
      authority: { kind: 'human' },
    },
    { ...baseContext, commandId: 'approval-rejected' },
  );

  const events = (await journal.readAll(0)).slice(before);
  expect(events.map((event) => event.eventType)).toEqual([
    OrchestrationEventType.SignalAccepted,
    OrchestrationEventType.ActivityRequested,
  ]);
  expect(events.at(-1)?.payload).toMatchObject({ activity: 'refine' });
});

it('honors an explicit rejection resume target', async () => {
  const { service, baseContext, journal } = await rejectedApprovalWaitingService({
    kind: 'stage',
    stage: stageName('refine'),
  });
  const before = (await journal.readAll(0)).length;

  await service.acceptSignal(
    workflowInstanceId('workflow-1'),
    {
      kind: ApprovedSignal,
      resourceId: resId('pr-1'),
      revision: 'abc123',
      outcome: ActivityOutcomeKind.Rejected,
      actorId: 'owner',
      actorDecision: { authorized: true, evidenceId: 'review-rejected' },
      providerEventId: 'github-comment-rejected',
      authority: { kind: 'human' },
    },
    { ...baseContext, commandId: 'approval-rejected' },
  );

  const events = (await journal.readAll(0)).slice(before);
  expect(events.map((event) => event.eventType)).toEqual([
    OrchestrationEventType.SignalAccepted,
    OrchestrationEventType.StageEntered,
    OrchestrationEventType.ActivityRequested,
  ]);
  expect(events.at(-1)?.payload).toMatchObject({ activity: 'refine' });
});

it('accepts one matching signal while waiting and ignores duplicates', async () => {
  const { service, baseContext } = await waitingService();
  const reactor = createSignalReactor(service);
  const signal = {
    kind: signalName('accepted'),
    resourceId: resId('pr-1'),
    revision: 'abc123',
    actorId: 'owner',
    actorDecision: { authorized: true, evidenceId: 'review-decision-1' },
    providerEventId: 'github-comment-1',
  } as const;
  const [accepted] = await reactor.accept(signal, {
    ...baseContext,
    commandId: 'signal-1',
  });
  const duplicate = await reactor.accept(signal, {
    ...baseContext,
    commandId: 'signal-duplicate',
  });
  expect(accepted?.acceptedSignalIds).toEqual(['github-comment-1']);
  expect(duplicate).toEqual([]);
});

it('ignores mismatched or unauthorised signal evidence', async () => {
  const { service, baseContext } = await waitingService();
  const mismatched = await service.acceptSignal(
    workflowInstanceId('workflow-1'),
    {
      kind: signalName('accepted'),
      resourceId: resId('pr-2'),
      revision: 'abc123',
      actorId: 'owner',
      actorDecision: { authorized: true, evidenceId: 'review-decision-1' },
      providerEventId: 'github-comment-1',
    },
    { ...baseContext, commandId: 'mismatched' },
  );
  const unauthorised = await service.acceptSignal(
    workflowInstanceId('workflow-1'),
    {
      kind: signalName('accepted'),
      resourceId: resId('pr-1'),
      revision: 'abc123',
      actorId: 'stranger',
      actorDecision: { authorized: false, evidenceId: 'review-decision-2' },
      providerEventId: 'github-comment-2',
    },
    { ...baseContext, commandId: 'unauthorised' },
  );
  expect(mismatched.status).toBe('waiting');
  expect(unauthorised.acceptedSignalIds).toEqual([]);
});

it.each(['failed', 'blocked'] as const)(
  'ignores a watch-gate signal whose outcome is %s',
  async (outcome) => {
    const { service, baseContext } = await waitingService({ watchGate: true });

    const result = await service.acceptSignal(
      workflowInstanceId('workflow-1'),
      {
        kind: WatchGateVerdictSignal,
        resourceId: resId('pr-1'),
        revision: 'abc123',
        outcome,
        actorId: 'bot',
        actorDecision: { authorized: true, evidenceId: 'watch-verdict' },
        providerEventId: `github-comment-${outcome}`,
        authority: { kind: 'watch', watch: watchId('pr-review') },
      },
      { ...baseContext, commandId: `bad-verdict-${outcome}` },
    );

    expect(result.status).toBe('waiting');
    expect(result.acceptedSignalIds).toEqual([]);
  },
);

it('recognizes only the plain approval and watchGate verdict signal kinds as awaiting approval', () => {
  expect(isApprovalAwaitingSignalKind(ApprovedSignal)).toBe(true);
  expect(isApprovalAwaitingSignalKind(WatchGateVerdictSignal)).toBe(true);
  expect(isApprovalAwaitingSignalKind(signalName('delivery-result'))).toBe(false);
  expect(isApprovalAwaitingSignalKind(signalName('orchestration.child-completed'))).toBe(false);
});

it('is the single source every status-changing orchestration event derives from', () => {
  expect(orchestrationStatusTransitions).toEqual({
    [OrchestrationEventType.ActivityRequested]: WorkflowStatus.Active,
    [OrchestrationEventType.ActivityWaiting]: WorkflowStatus.Waiting,
    [OrchestrationEventType.SignalWaitStarted]: WorkflowStatus.Waiting,
    [OrchestrationEventType.SignalAccepted]: WorkflowStatus.Active,
    [OrchestrationEventType.InstanceCompleted]: WorkflowStatus.Completed,
    [OrchestrationEventType.InstanceBlocked]: WorkflowStatus.Blocked,
    [OrchestrationEventType.InstanceSuperseded]: WorkflowStatus.Superseded,
  });
});
