import { expect, it } from 'vitest';
import {
  activationId,
  ActivityEventType,
  createActivityEventData,
} from '../../src/activities/index.js';
import { ControlEventType, createControlPlaneEventData } from '../../src/control-plane/index.js';
import {
  ConversationEventType,
  createConversationEventData,
} from '../../src/conversations/index.js';
import { createExecutionEventData, ExecutionEventType, runId } from '../../src/execution/index.js';
import { createGitHubEventData, GitHubEventType } from '../../src/integrations/github/index.js';
import {
  adapterId,
  ArtifactEventType,
  createArtifactEventData,
  createDeliveryEventData,
  DeliveryEventType,
} from '../../src/integrations/index.js';
import { eventId } from '../../src/kernel/index.js';
import {
  childOrchestrationGroupStreamId,
  createOrchestrationEventData,
  OrchestrationEventType,
  workflowInstanceId,
} from '../../src/orchestration/index.js';
import {
  createResourceEventData,
  ResourceEventType,
  resourceKind,
} from '../../src/resources/index.js';
import { createWorkEventData, WorkEventType } from '../../src/work/index.js';

const metadata = {
  eventId: 'event-1',
  occurredAt: '2026-08-30T12:00:00.000Z',
  correlationId: 'correlation-1',
  causationId: 'causation-1',
  actor: { kind: 'system' as const, id: 'test' },
  source: { kind: 'internal' as const, id: 'test' },
};

// Factories accept only their owned closed event-to-payload mappings.
void (() => {
  // @ts-expect-error Activity factories reject Control Plane event types.
  createActivityEventData({ ...metadata, eventType: ControlEventType.DispatchPaused, payload: {} });
  // @ts-expect-error Activity factories reject Control Plane payloads.
  createActivityEventData({
    ...metadata,
    eventType: ActivityEventType.PrReviewRejected,
    payload: { checks: 'passing' as const },
  });
  // @ts-expect-error Control Plane factories reject Activity event types.
  createControlPlaneEventData({
    ...metadata,
    eventType: ActivityEventType.PrChecksChanged,
    payload: {},
  });
  // @ts-expect-error Control Plane factories reject Activity payloads.
  createControlPlaneEventData({
    ...metadata,
    eventType: ControlEventType.DispatchPaused,
    payload: { checks: 'passing' as const },
  });
})();

it('constructs representative bounded event data through public owner factories', () => {
  expect(
    createActivityEventData({
      ...metadata,
      eventType: ActivityEventType.PrChecksChanged,
      payload: { checks: 'passing' },
    }).eventType,
  ).toBe(ActivityEventType.PrChecksChanged);
  expect(
    createControlPlaneEventData({
      ...metadata,
      eventType: ControlEventType.DispatchPaused,
      payload: { resumeAt: metadata.occurredAt, reason: 'quota' },
    }).eventType,
  ).toBe(ControlEventType.DispatchPaused);
  expect(
    createConversationEventData({
      ...metadata,
      eventType: ConversationEventType.EntryTombstoned,
      payload: { entryId: 'entry-1' },
    }).eventType,
  ).toBe(ConversationEventType.EntryTombstoned);
  expect(
    createExecutionEventData({
      ...metadata,
      eventType: ExecutionEventType.ActivationReleased,
      payload: { runId: runId('run-1') },
    }).eventType,
  ).toBe(ExecutionEventType.ActivationReleased);
  expect(
    createArtifactEventData({
      ...metadata,
      eventType: ArtifactEventType.VerificationUnresolved,
      payload: {
        workflowInstanceId: workflowInstanceId('workflow-1'),
        activationId: activationId('activation-1'),
        artifact: {
          kind: resourceKind('pull-request'),
          externalKey: { adapter: adapterId('github'), key: 'wake#1' },
        },
        status: 'failed',
        attempt: 1,
        escalated: false,
      },
    }).eventType,
  ).toBe(ArtifactEventType.VerificationUnresolved);
  expect(
    createDeliveryEventData({
      ...metadata,
      eventType: DeliveryEventType.AttemptStarted,
      payload: {
        intentEventId: eventId('intent-1'),
        intentGlobalPosition: 1,
        workflowInstanceId: 'workflow-1',
        activationId: 'activation-1',
        occurrenceOrdinal: 1,
      },
    }).eventType,
  ).toBe(DeliveryEventType.AttemptStarted);
  expect(
    createGitHubEventData({
      ...metadata,
      eventType: GitHubEventType.ConversationRecordDeferred,
      payload: { adapter: 'github', sourceEventId: 'source-1' },
    }).eventType,
  ).toBe(GitHubEventType.ConversationRecordDeferred);
  expect(
    createOrchestrationEventData({
      ...metadata,
      eventType: OrchestrationEventType.GroupClaimed,
      payload: {
        key: childOrchestrationGroupStreamId('group:group-1:watch:watch-1'),
        requestId: 'request-1',
      },
    }).eventType,
  ).toBe(OrchestrationEventType.GroupClaimed);
  expect(
    createResourceEventData({
      ...metadata,
      eventType: ResourceEventType.ResourceRevisionObserved,
      payload: { revision: 'abc' },
    }).eventType,
  ).toBe(ResourceEventType.ResourceRevisionObserved);
  expect(
    createWorkEventData({
      ...metadata,
      eventType: WorkEventType.ObjectiveRevised,
      payload: { objective: 'Improve event construction' },
    }).eventType,
  ).toBe(WorkEventType.ObjectiveRevised);
});

it('keeps stream routing separate from Work event data', () => {
  const event = createWorkEventData({
    ...metadata,
    eventType: WorkEventType.ItemDeleted,
    payload: {},
  });
  // @ts-expect-error EventData does not carry a stream reference.
  void event.stream;
});
