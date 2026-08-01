import {
  orchestrationGroupId,
  signalName,
  workflowName,
} from '../../src-next/orchestration/contracts/identifiers.js';
import { activationId } from '../../src-next/activities/contracts/identifiers.js';
import { activityName } from '../../src-next/activities/index.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { workId } from '../support/identities.js';
import {
  childOrchestrationGroupStream,
  decodeOrchestrationEvent,
  foldWorkflowInstance,
  OrchestrationEventType,
  primaryOrchestrationGroupStream,
  selectOrchestrationEvent,
  workflowInstanceId,
  workflowInstanceStream,
  type OrchestrationWaitingActivityOutcome,
  type WorkflowOrchestrationEvent,
  type WorkflowOrchestrationEventDraft,
} from '../../src-next/orchestration/index.js';
import {} from '../../src-next/work/index.js';
import { eventEnvelope } from '../support/event-envelope.js';

const workflow = workflowInstanceStream(workflowInstanceId('workflow-1'));
const primaryGroup = primaryOrchestrationGroupStream(workId('1'));
const childGroup = childOrchestrationGroupStream('group-1', 'watch-1');
const metadata = {
  parentWorkflowInstanceId: workflowInstanceId('workflow-parent'),
  watchId: 'watch-1',
  triggerId: 'trigger-1',
  orchestrationGroupId: orchestrationGroupId('group-1'),
  causalCycleId: 'cycle-1',
  requestId: 'request-1',
  childWorkflowInstanceId: workflowInstanceId('workflow-1'),
} as const;
const activation = {
  activationId: activationId('workflow-1:activity:1'),
  ordinal: 1,
  activity: activityName('implement'),
  input: { prompt: 'ship' },
  execution: { workspace: 'branch', tier: 'standard' },
} as const;
const signal = {
  kind: signalName('review-accepted'),
  resourceId: 'resource-1',
  revision: 'abc',
  actorId: 'reviewer',
  actorDecision: { authorized: true, evidenceId: 'evidence-1' },
  providerEventId: 'provider-1',
} as const;

const samples = [
  eventEnvelope(
    OrchestrationEventType.InstanceStarted,
    {
      workItemId: workId('1'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      entry: 'implement',
    },
    workflow,
  ),
  eventEnvelope(OrchestrationEventType.StageEntered, { stage: 'implement' }, workflow),
  eventEnvelope(OrchestrationEventType.ActivityRequested, activation, workflow),
  eventEnvelope(
    OrchestrationEventType.ActivityStarted,
    { activationId: activation.activationId },
    workflow,
  ),
  eventEnvelope(
    OrchestrationEventType.ActivityOutcomeAccepted,
    { activationId: activation.activationId, outcome: { kind: 'done', data: { result: 'ok' } } },
    workflow,
  ),
  eventEnvelope(
    OrchestrationEventType.ActivityWaiting,
    {
      activationId: activation.activationId,
      outcome: {
        kind: 'waiting',
        data: { intentEventId: 'intent-1', signalKind: signalName('delivery-result') },
      },
    },
    workflow,
  ),
  eventEnvelope(
    OrchestrationEventType.SignalWaitStarted,
    { signalKind: signalName('review-accepted'), resourceId: 'resource-1', revision: 'abc' },
    workflow,
  ),
  eventEnvelope(OrchestrationEventType.SignalAccepted, signal, workflow),
  eventEnvelope(
    OrchestrationEventType.SupplementalActivityQueued,
    { activity: 'review', input: { prompt: 'check' }, requestedBy: 'operator-1' },
    workflow,
  ),
  eventEnvelope(
    OrchestrationEventType.SupplementalActivityDequeued,
    { activity: 'review', requestedBy: 'operator-1' },
    workflow,
  ),
  eventEnvelope(OrchestrationEventType.RepeatCounted, { routeId: 'route-1', count: 1 }, workflow),
  eventEnvelope(
    OrchestrationEventType.RetryCounted,
    { retryKey: 'implement:failed', count: 1 },
    workflow,
  ),
  eventEnvelope(OrchestrationEventType.InstanceCompleted, {}, workflow),
  eventEnvelope(OrchestrationEventType.InstanceBlocked, { reason: 'failed' }, workflow),
  eventEnvelope(OrchestrationEventType.InstanceSuperseded, {}, workflow),
  eventEnvelope(
    OrchestrationEventType.ChildRequested,
    { ...metadata, workflowName: workflowName('child') },
    workflow,
  ),
  eventEnvelope(OrchestrationEventType.ChildStarted, metadata, workflow),
  eventEnvelope(OrchestrationEventType.ChildCompleted, metadata, workflow),
  eventEnvelope(OrchestrationEventType.ChildCompletionConsumed, metadata, workflow),
  eventEnvelope(OrchestrationEventType.CausalActivationRejected, metadata, workflow),
  eventEnvelope(
    OrchestrationEventType.GroupBudgetExhausted,
    { ...metadata, maxPerGroup: 3 },
    workflow,
  ),
  eventEnvelope(
    OrchestrationEventType.PrimaryClaimed,
    { workItemId: workId('1'), workflowInstanceId: workflowInstanceId('workflow-1') },
    primaryGroup,
  ),
  eventEnvelope(
    OrchestrationEventType.GroupClaimed,
    { key: childGroup.id, requestId: 'request-1' },
    childGroup,
  ),
] as const;

it('types decoded and draft ActivityWaiting outcomes with the Orchestration brand', () => {
  type WaitingEvent = Extract<
    WorkflowOrchestrationEvent,
    { readonly eventType: typeof OrchestrationEventType.ActivityWaiting }
  >;
  type WaitingDraft = Extract<
    WorkflowOrchestrationEventDraft,
    { readonly eventType: typeof OrchestrationEventType.ActivityWaiting }
  >;
  expectTypeOf<
    WaitingEvent['payload']['outcome']
  >().toEqualTypeOf<OrchestrationWaitingActivityOutcome>();
  expectTypeOf<
    WaitingDraft['payload']['outcome']
  >().toEqualTypeOf<OrchestrationWaitingActivityOutcome>();
  expectTypeOf<WaitingDraft['payload']>().toEqualTypeOf<{
    readonly activationId: ReturnType<typeof activationId>;
    readonly outcome: OrchestrationWaitingActivityOutcome;
  }>();

  const canonicalPayload: WaitingDraft['payload'] = {
    activationId: activation.activationId,
    outcome: {
      kind: 'waiting',
      data: { intentEventId: 'intent-1', signalKind: signalName('delivery-result') },
    } as OrchestrationWaitingActivityOutcome,
  };

  const decoded = decodeOrchestrationEvent(
    eventEnvelope(
      OrchestrationEventType.ActivityWaiting,
      {
        activationId: activation.activationId,
        outcome: {
          kind: 'waiting',
          data: { intentEventId: 'intent-1', signalKind: 'delivery-result' },
        },
      },
      workflow,
    ),
  );
  if (decoded.eventType !== OrchestrationEventType.ActivityWaiting)
    throw new Error('expected ActivityWaiting');
  expect(decoded.payload.outcome.data.signalKind).toBe(signalName('delivery-result'));
  const started = decodeOrchestrationEvent(samples[0]);
  if (started.eventType !== OrchestrationEventType.InstanceStarted)
    throw new Error('expected InstanceStarted');
  expect(foldWorkflowInstance([started, decoded])?.waitingFor).toEqual({
    intentEventId: 'intent-1',
    signalKind: signalName('delivery-result'),
  });
  expect(() =>
    decodeOrchestrationEvent(
      eventEnvelope(
        OrchestrationEventType.ActivityWaiting,
        {
          ...canonicalPayload,
          intentEventId: 'intent-2',
          signalKind: signalName('different-signal'),
        },
        workflow,
      ),
    ),
  ).toThrow();
});

describe('Orchestration event contract', () => {
  it('decodes every declared event with its exact payload and permitted stream', () => {
    expect(samples.map((event) => decodeOrchestrationEvent(event))).toHaveLength(
      Object.keys(OrchestrationEventType).length,
    );
  });

  it('rejects unknown and malformed owned events', () => {
    expect(() =>
      decodeOrchestrationEvent(eventEnvelope('orchestration.unknown', {}, workflow)),
    ).toThrow();
    expect(() =>
      decodeOrchestrationEvent(
        eventEnvelope(
          OrchestrationEventType.ActivityRequested,
          { ...activation, ordinal: 0 },
          workflow,
        ),
      ),
    ).toThrow();
  });

  it("rejects each stream group's events on the other stream kind", () => {
    expect(() =>
      decodeOrchestrationEvent(
        eventEnvelope(OrchestrationEventType.InstanceCompleted, {}, childGroup),
      ),
    ).toThrow();
    expect(() =>
      decodeOrchestrationEvent(
        eventEnvelope(OrchestrationEventType.GroupClaimed, samples[22].payload, workflow),
      ),
    ).toThrow();
  });

  it('rejects a primary claim on a child/watch group stream', () => {
    expect(() =>
      decodeOrchestrationEvent(
        eventEnvelope(OrchestrationEventType.PrimaryClaimed, samples[21].payload, childGroup),
      ),
    ).toThrow();
  });

  it('rejects a child/watch group claim on a primary group stream', () => {
    expect(() =>
      decodeOrchestrationEvent(
        eventEnvelope(OrchestrationEventType.GroupClaimed, samples[22].payload, primaryGroup),
      ),
    ).toThrow();
  });

  it.each([
    eventEnvelope(
      OrchestrationEventType.InstanceCompleted,
      {},
      { kind: 'workflow-instance', id: ' ' },
    ),
    eventEnvelope(
      OrchestrationEventType.InstanceStarted,
      { ...samples[0].payload, workItemId: 'invalid-work-id' },
      workflow,
    ),
  ])('reports invalid branded IDs through the Orchestration decoder context', (event) => {
    expect(() => decodeOrchestrationEvent(event)).toThrow(
      /Invalid Orchestration event event-7 at global position 7/i,
    );
  });

  it('rejects a primary claim whose work item does not identify its stream', () => {
    expect(() =>
      decodeOrchestrationEvent(
        eventEnvelope(
          OrchestrationEventType.PrimaryClaimed,
          { ...samples[21].payload, workItemId: workId('2') },
          primaryGroup,
        ),
      ),
    ).toThrow();
  });

  it('rejects a group claim whose key does not identify its stream', () => {
    const otherChildGroup = childOrchestrationGroupStream('group-2', 'watch-1');
    expect(() =>
      decodeOrchestrationEvent(
        eventEnvelope(
          OrchestrationEventType.GroupClaimed,
          { ...samples[22].payload, key: otherChildGroup.id },
          childGroup,
        ),
      ),
    ).toThrow();
  });

  it('selects unrelated namespaces as null but throws for invalid owned events', () => {
    expect(selectOrchestrationEvent(eventEnvelope('work.item-created', {}, workflow))).toBeNull();
    expect(() =>
      selectOrchestrationEvent(eventEnvelope('orchestration.unknown', {}, workflow)),
    ).toThrow(/event-7.*position 7.*orchestration\.unknown/i);
  });
});
