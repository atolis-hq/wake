import { createEventData, type EventDataInput } from '@atolis-hq/eventing';
import { ActivityEventType, type ActivityEventData, type ActivityEventPayloads } from './events.js';

export type ActivityEventDataInput = {
  [Type in keyof ActivityEventPayloads]: EventDataInput<Type, ActivityEventPayloads[Type]>;
}[keyof ActivityEventPayloads];

// Exhaustive dispatch preserves the closed event-to-payload mapping.
// eslint-disable-next-line complexity
export function createActivityEventData(input: ActivityEventDataInput): ActivityEventData {
  switch (input.eventType) {
    case ActivityEventType.IssueCompleteRequested:
      return createEventData(input);
    case ActivityEventType.PrDiscovered:
      return createEventData(input);
    case ActivityEventType.PrRevisionChanged:
      return createEventData(input);
    case ActivityEventType.PrStateChanged:
      return createEventData(input);
    case ActivityEventType.PrChecksChanged:
      return createEventData(input);
    case ActivityEventType.PrReviewAccepted:
      return createEventData(input);
    case ActivityEventType.ReviewAcceptanceSignalRecorded:
      return createEventData(input);
    case ActivityEventType.PrReviewChangesRequested:
      return createEventData(input);
    case ActivityEventType.PrReviewRejected:
      return createEventData(input);
    case ActivityEventType.PrMergeDenied:
      return createEventData(input);
    case ActivityEventType.PrApproveDenied:
      return createEventData(input);
    case ActivityEventType.PrMergeAuthorized:
      return createEventData(input);
    case ActivityEventType.PrApproveRequested:
      return createEventData(input);
    case ActivityEventType.PrMergeRequested:
      return createEventData(input);
    case ActivityEventType.PrApproveDecisionClaimed:
      return createEventData(input);
    case ActivityEventType.PrMergeDecisionClaimed:
      return createEventData(input);
  }
}
