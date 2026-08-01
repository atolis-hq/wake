import {
  causationId,
  correlationId,
  eventId,
  EventActorKind,
  EventSourceKind,
} from '../../kernel/index.js';
import { PullRequestCheckState } from '../../activities/index.js';
import type { AdapterId } from '../contracts/identifiers.js';
import { integrationStream } from '../contracts/streams.js';
import type { ExternalEventSource, ProviderEventDraft } from '../contracts/intake.js';

export const FakeEventType = {
  WorkObserved: 'fake.work-observed',
  ReviewRequested: 'fake.review-requested',
} as const;
const missingIdentityPart = '_';
export interface FakeWorkEvidence {
  readonly key: string;
  readonly title: string;
  // Operator-assigned intake tags; Wake-owned data, never a provider passthrough.
  readonly tags?: readonly string[] | undefined;
  readonly kind?: 'issue' | 'pull-request' | undefined;
  readonly revision?: string | undefined;
  readonly baseRevision?: string | undefined;
  readonly checks?:
    | typeof PullRequestCheckState.Unknown
    | typeof PullRequestCheckState.Pending
    | typeof PullRequestCheckState.Passing
    | typeof PullRequestCheckState.Failing
    | undefined;
  readonly acceptedReview?: boolean | undefined;
  // Files the revision changed; presence models the changed-files capability.
  readonly changedFiles?: readonly string[] | undefined;
  readonly watchEvent?: typeof FakeEventType.ReviewRequested | undefined;
  readonly eligible?: boolean | undefined;
}

export class FakeExternalEventSource implements ExternalEventSource {
  constructor(
    private readonly adapter: AdapterId,
    private readonly events: readonly FakeWorkEvidence[],
  ) {}

  async poll(signal: AbortSignal): Promise<readonly ProviderEventDraft[]> {
    void signal;
    return this.events.flatMap((payload, ordinal) => {
      const identity = `fake:${this.adapter}:${payload.key}:${payload.revision ?? missingIdentityPart}:${payload.checks ?? PullRequestCheckState.Unknown}:${payload.watchEvent ?? missingIdentityPart}:${ordinal}`;
      const metadata = {
        schemaVersion: 1 as const,
        occurredAt: '2026-08-01T00:00:00.000Z',
        correlationId: correlationId(`fake:${this.adapter}:${payload.key}`),
        causationId: causationId(`fake:${this.adapter}:${payload.key}`),
        actor: { kind: EventActorKind.Integration, id: this.adapter },
        source: { kind: EventSourceKind.Adapter, id: this.adapter },
        stream: integrationStream(this.adapter),
      };
      return [
        { ...metadata, eventId: eventId(identity), eventType: FakeEventType.WorkObserved, payload },
        ...(payload.watchEvent === undefined
          ? []
          : [
              {
                ...metadata,
                eventId: eventId(`${identity}:watch`),
                eventType: payload.watchEvent,
                payload: { key: payload.key },
              },
            ]),
      ];
    });
  }
}
