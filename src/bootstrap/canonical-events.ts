import type { EventEnvelope } from '@atolis-hq/eventing';
import { ActivityEventType, selectActivityEvent } from '../activities/index.js';
import {
  ArtifactContextEventType,
  ArtifactEventType,
  selectArtifactContextEvent,
  selectArtifactEvent,
} from '../artifacts/index.js';
import { ControlEventType, selectControlEvent } from '../control-plane/index.js';
import { ConversationEventType, selectConversationEvent } from '../conversations/index.js';
import { ExecutionEventType, selectExecutionEvent } from '../execution/index.js';
import { GitHubEventType, selectGitHubAdapterEvent } from '../integrations/github/index.js';
import {
  DeliveryEventType,
  DeliveryIntentEventType,
  ArtifactEventType as IntegrationArtifactEventType,
  decodeArtifactEvent,
  selectDeliveryEvent,
  selectDeliveryIntentEvent,
} from '../integrations/index.js';
import { OrchestrationEventType, selectOrchestrationEvent } from '../orchestration/index.js';
import { ResourceEventType, selectResourceEvent } from '../resources/index.js';
import { WorkEventType, selectWorkEvent } from '../work/index.js';

// Bootstrap registers the owning modules' public vocabularies and decoders together.
const registrations = [
  { types: Object.values(ActivityEventType), decode: selectActivityEvent },
  { types: Object.values(ArtifactEventType), decode: selectArtifactEvent },
  { types: Object.values(ArtifactContextEventType), decode: selectArtifactContextEvent },
  { types: Object.values(ControlEventType), decode: selectControlEvent },
  { types: Object.values(ConversationEventType), decode: selectConversationEvent },
  { types: Object.values(ExecutionEventType), decode: selectExecutionEvent },
  { types: Object.values(GitHubEventType), decode: selectGitHubAdapterEvent },
  { types: Object.values(IntegrationArtifactEventType), decode: decodeArtifactEvent },
  { types: Object.values(DeliveryEventType), decode: selectDeliveryEvent },
  { types: Object.values(DeliveryIntentEventType), decode: selectDeliveryIntentEvent },
  { types: Object.values(OrchestrationEventType), decode: selectOrchestrationEvent },
  { types: Object.values(ResourceEventType), decode: selectResourceEvent },
  { types: Object.values(WorkEventType), decode: selectWorkEvent },
];

export const canonicalEventTypes: ReadonlySet<string> = new Set(
  registrations.flatMap(({ types }) => types),
);

export function decodeCanonicalEvent(event: EventEnvelope): void {
  const registration = registrations.find(({ types }) =>
    (types as readonly string[]).includes(event.event.eventType),
  );
  if (registration === undefined)
    throw new Error(`Unknown canonical event ${event.event.eventType}`);
  registration.decode(event);
}
