import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import {
  activationId,
  activityDecisionStream,
  ActivityEventType,
  createActivityEventData,
  MergeMethod,
  PullRequestDenialCode,
} from '../../../src/activities/index.js';
import { AgentRunPublicationReactor } from '../../../src/integrations/application/agent-run-publication-reactor.js';
import { awaitedMergeResource } from '../../../src/integrations/application/merge-publication-eligibility.js';
import { projectDeliveries } from '../../../src/integrations/index.js';
import {
  OrchestrationEventType,
  ResourceTransitionSignal,
  WorkflowStatus,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { resourceStream } from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { resId, workId } from '../../support/identities.js';

it('pins the pending merge activation decision rather than another correlated resource', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const activation = activationId('merge-activation');
  const resource = resId('awaited-pr');
  const fact = createActivityEventData({
    ...eventEnvelope('unused', {}, resourceStream(resource)).event,
    eventId: 'denial',
    eventType: ActivityEventType.PrMergeDenied,
    payload: {
      activationId: activation,
      idempotencyKey: 'merge',
      reason: PullRequestDenialCode.BlockedPathChanged,
      resourceId: resource,
    },
  });
  if (fact.eventType !== ActivityEventType.PrMergeDenied) throw new Error('Expected merge denial');
  await journal.appendToStream(activityDecisionStream(activation, MergeMethod.Merge), 0, [
    createActivityEventData({
      ...fact,
      eventId: 'claim',
      eventType: ActivityEventType.PrMergeDecisionClaimed,
      payload: {
        action: MergeMethod.Merge,
        activationId: activation,
        decisionKind: 'denied',
        outcome: { kind: 'blocked', data: { reason: PullRequestDenialCode.BlockedPathChanged } },
        fact,
        factStream: resourceStream(resource),
      },
    }),
  ]);
  const workflow = {
    workflowInstanceId: 'workflow',
    workItemId: workId('publication'),
    status: WorkflowStatus.Waiting,
    waitingFor: { signalKind: ResourceTransitionSignal },
    pendingActivation: { activationId: activation, activity: 'pr.merge' },
  } as WorkflowInstanceView;
  expect(await awaitedMergeResource(journal, workflow)).toBe(resource);
  expect(
    await awaitedMergeResource(journal, {
      ...workflow,
      pendingActivation: { ...workflow.pendingActivation!, activationId: activationId('other') },
    }),
  ).toBeUndefined();
  expect(
    await awaitedMergeResource(journal, { ...workflow, status: WorkflowStatus.Completed }),
  ).toBeUndefined();
  const destination = resId('parent-issue');
  const reactor = new AgentRunPublicationReactor({
    journal,
    orchestration: { listAll: async () => [workflow] },
    resources: {
      correlationsForWork: async () => [
        { resourceId: destination, provenance: 'delegated', role: 'secondary' },
      ],
    },
    runs: {
      load: async () => ({
        view: {
          runId: 'agent-run',
          activity: 'agent',
          workflowInstanceId: workflow.workflowInstanceId,
          activationId: 'agent-activation',
          startedAt: fact.occurredAt,
          finishedAt: fact.occurredAt,
          agent: { outcome: 'DONE', displayBody: 'Completed', metadata: {} },
        },
      }),
    },
  } as never);
  await reactor.react(
    eventEnvelope(
      OrchestrationEventType.SignalWaitStarted,
      { signalKind: ResourceTransitionSignal },
      { kind: 'workflow-instance', id: workflow.workflowInstanceId },
    ) as never,
  );
  await reactor.react(
    eventEnvelope(
      OrchestrationEventType.ActivityExecutionFailed,
      { runId: 'agent-run' },
      { kind: 'workflow-instance', id: workflow.workflowInstanceId },
    ) as never,
  );
  const publications = projectDeliveries(await journal.readAll(0));
  expect(publications).toHaveLength(2);
  for (const publication of publications) {
    expect(publication.resourceId).toBe(destination);
    expect(publication.awaitingMergeResourceId).toBe(resource);
  }
});
