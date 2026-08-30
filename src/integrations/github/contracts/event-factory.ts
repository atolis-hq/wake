import { createEventData, type EventDataInput } from '../../../kernel/index.js';
import {
  GitHubEventType,
  type GitHubAdapterEventData,
  type GitHubEventPayloads,
} from './events.js';

export type GitHubEventDataInput = {
  [Type in keyof GitHubEventPayloads]: EventDataInput<Type, GitHubEventPayloads[Type]>;
}[keyof GitHubEventPayloads];

export function createGitHubEventData(input: GitHubEventDataInput): GitHubAdapterEventData {
  switch (input.eventType) {
    case GitHubEventType.WorkObserved:
      return createEventData(input);
    case GitHubEventType.CommentObserved:
      return createEventData(input);
    case GitHubEventType.DeliveryObserved:
      return createEventData(input);
    case GitHubEventType.DeletedWorkObservationSkipped:
      return createEventData(input);
    case GitHubEventType.AdmissionStarted:
      return createEventData(input);
    case GitHubEventType.InboundTranslationRetried:
      return createEventData(input);
    case GitHubEventType.InboundTranslationRecovered:
      return createEventData(input);
    case GitHubEventType.InboundTranslationFailed:
      return createEventData(input);
    case GitHubEventType.ConversationRecordDeferred:
      return createEventData(input);
    case GitHubEventType.ConversationRecordRecovered:
      return createEventData(input);
  }
}
