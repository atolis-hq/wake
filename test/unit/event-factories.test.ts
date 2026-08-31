import { eventId } from '@atolis-hq/eventing';
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
import * as Execution from '../../src/execution/index.js';
import { createExecutionEventData, ExecutionEventType, runId } from '../../src/execution/index.js';
import { createGitHubEventData, GitHubEventType } from '../../src/integrations/github/index.js';
import {
  adapterId,
  ArtifactEventType,
  createArtifactEventData,
  createDeliveryEventData,
  DeliveryEventType,
} from '../../src/integrations/index.js';
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
  createActivityEventData({
    ...metadata,
    eventType: ActivityEventType.PrReviewRejected,
    // @ts-expect-error Activity factories reject Control Plane payloads.
    payload: { checks: 'passing' as const },
  });
  createControlPlaneEventData({
    ...metadata,
    // @ts-expect-error Control Plane factories reject Activity event types.
    eventType: ActivityEventType.PrChecksChanged,
    // @ts-expect-error Foreign event types do not supply Control Plane payloads.
    payload: {},
  });
  createControlPlaneEventData({
    ...metadata,
    eventType: ControlEventType.DispatchPaused,
    // @ts-expect-error Control Plane factories reject Activity payloads.
    payload: { checks: 'passing' as const },
  });

  void ((
    eventType:
      typeof ConversationEventType.EntryRevised | typeof ConversationEventType.EntryTombstoned,
  ) => {
    // @ts-expect-error Conversation factories preserve union discriminator/payload correlation.
    createConversationEventData({
      ...metadata,
      eventType,
      payload: { entryId: 'entry-1' },
    });
  });
  createConversationEventData({
    ...metadata,
    // @ts-expect-error Conversation factories reject foreign event types.
    eventType: ControlEventType.DispatchPaused,
    // @ts-expect-error Foreign event types do not supply Conversation payloads.
    payload: {},
  });
  createConversationEventData({
    ...metadata,
    eventType: ConversationEventType.EntryTombstoned,
    // @ts-expect-error Conversation factories reject payloads for another Conversation event.
    payload: { objective: 'wrong owner payload' },
  });

  void ((
    eventType:
      typeof ExecutionEventType.RunCancellationConfirmed | typeof ExecutionEventType.RunCancelled,
  ) => {
    // @ts-expect-error Execution factories preserve union discriminator/payload correlation.
    createExecutionEventData({
      ...metadata,
      eventType,
      payload: { confirmedAt: metadata.occurredAt },
    });
  });
  void ((
    eventType:
      typeof ExecutionEventType.RunCancellationConfirmed | typeof ExecutionEventType.RunCancelled,
  ) => {
    // @ts-expect-error Execution exposes no secondary factory that loses union discrimination.
    Execution.createRunExecutionEventData({
      ...metadata,
      eventType,
      payload: { confirmedAt: metadata.occurredAt },
    });
  });
  createExecutionEventData({
    ...metadata,
    // @ts-expect-error Execution factories reject foreign event types.
    eventType: ControlEventType.DispatchPaused,
    // @ts-expect-error Foreign event types do not supply Execution payloads.
    payload: {},
  });
  createExecutionEventData({
    ...metadata,
    eventType: ExecutionEventType.ActivationReleased,
    // @ts-expect-error Execution factories reject payloads for another Execution event.
    payload: { confirmedAt: metadata.occurredAt },
  });

  void ((
    eventType:
      | typeof GitHubEventType.InboundTranslationRecovered
      | typeof GitHubEventType.InboundTranslationRetried,
  ) => {
    // @ts-expect-error GitHub factories preserve union discriminator/payload correlation.
    createGitHubEventData({
      ...metadata,
      eventType,
      payload: { adapter: 'github', sourceEventId: 'source-1' },
    });
  });
  createGitHubEventData({
    ...metadata,
    // @ts-expect-error GitHub factories reject foreign event types.
    eventType: ControlEventType.DispatchPaused,
    // @ts-expect-error Foreign event types do not supply GitHub payloads.
    payload: {},
  });
  createGitHubEventData({
    ...metadata,
    eventType: GitHubEventType.DeliveryObserved,
    // @ts-expect-error GitHub factories reject payloads for another GitHub event.
    payload: { adapter: 'github', sourceEventId: 'source-1' },
  });

  void ((
    eventType:
      | typeof OrchestrationEventType.InstanceCompleted
      | typeof OrchestrationEventType.InstanceBlocked,
  ) => {
    // @ts-expect-error Orchestration factories preserve union discriminator/payload correlation.
    createOrchestrationEventData({
      ...metadata,
      eventType,
      payload: {},
    });
  });
  createOrchestrationEventData({
    ...metadata,
    // @ts-expect-error Orchestration factories reject foreign event types.
    eventType: ControlEventType.DispatchPaused,
    payload: {},
  });
  createOrchestrationEventData({
    ...metadata,
    eventType: OrchestrationEventType.InstanceBlocked,
    // @ts-expect-error Orchestration factories reject payloads for another Orchestration event.
    payload: { stage: 'wrong-payload' },
  });

  void ((
    eventType:
      | typeof ResourceEventType.ResourceRevisionObserved
      | typeof ResourceEventType.WorkCorrelationRetracted,
  ) => {
    // @ts-expect-error Resource factories preserve union discriminator/payload correlation.
    createResourceEventData({
      ...metadata,
      eventType,
      payload: { revision: 'abc' },
    });
  });
  createResourceEventData({
    ...metadata,
    // @ts-expect-error Resource factories reject foreign event types.
    eventType: ControlEventType.DispatchPaused,
    // @ts-expect-error Foreign event types do not supply Resource payloads.
    payload: {},
  });
  createResourceEventData({
    ...metadata,
    eventType: ResourceEventType.ResourceRevisionObserved,
    // @ts-expect-error Resource factories reject payloads for another Resource event.
    payload: { sourceObservationId: 'source-1' },
  });

  void ((eventType: typeof WorkEventType.ObjectiveRevised | typeof WorkEventType.ItemClosed) => {
    // @ts-expect-error Work factories preserve union discriminator/payload correlation.
    createWorkEventData({
      ...metadata,
      eventType,
      payload: { objective: 'Improve event construction' },
    });
  });
  createWorkEventData({
    ...metadata,
    // @ts-expect-error Work factories reject foreign event types.
    eventType: ControlEventType.DispatchPaused,
    payload: {},
  });
  createWorkEventData({
    ...metadata,
    eventType: WorkEventType.ObjectiveRevised,
    // @ts-expect-error Work factories reject payloads for another Work event.
    payload: { reason: 'wrong payload' },
  });

  createArtifactEventData({
    ...metadata,
    // @ts-expect-error Artifact factories reject foreign event types.
    eventType: ControlEventType.DispatchPaused,
    // @ts-expect-error Foreign event types do not supply Artifact payloads.
    payload: {},
  });
  createArtifactEventData({
    ...metadata,
    eventType: ArtifactEventType.VerificationUnresolved,
    // @ts-expect-error Artifact factories reject literal payloads for another owner.
    payload: { reason: 'wrong payload' },
  });

  void ((
    eventType: typeof DeliveryEventType.AttemptStarted | typeof DeliveryEventType.Confirmed,
  ) => {
    // @ts-expect-error Delivery factories preserve union discriminator/payload correlation.
    createDeliveryEventData({
      ...metadata,
      eventType,
      payload: {
        intentEventId: eventId('intent-1'),
        intentGlobalPosition: 1,
        workflowInstanceId: 'workflow-1',
        activationId: 'activation-1',
        occurrenceOrdinal: 1,
      },
    });
  });
  createDeliveryEventData({
    ...metadata,
    // @ts-expect-error Delivery factories reject foreign event types.
    eventType: ControlEventType.DispatchPaused,
    // @ts-expect-error Foreign event types do not supply Delivery payloads.
    payload: {},
  });
  // @ts-expect-error Delivery factories reject payloads for another Delivery event.
  createDeliveryEventData({
    ...metadata,
    eventType: DeliveryEventType.Confirmed,
    payload: {
      intentEventId: eventId('intent-1'),
      intentGlobalPosition: 1,
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      occurrenceOrdinal: 1,
    },
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
  expect(event.eventType).toBe(WorkEventType.ItemDeleted);
});
