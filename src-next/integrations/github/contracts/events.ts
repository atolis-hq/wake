import { z } from 'zod';
import {
  ProviderPermission,
  PullRequestCheckState,
  PullRequestState,
  ReviewActorKind,
  ReviewerAuthorizationSource,
} from '../../../activities/index.js';
import {
  eventEnvelopeSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../../kernel/index.js';
import { adapterId } from '../../contracts/identifiers.js';
import { IntegrationStreamKind, type IntegrationStreamRef } from '../../contracts/streams.js';

export const GitHubEventType = {
  WorkObserved: 'integration.github.work-observed',
  CommentObserved: 'integration.github.comment-observed',
  DeliveryObserved: 'integration.github.delivery-observed',
} as const;

export interface ExternalWorkObservedPayload {
  readonly externalKey: string;
  readonly kind: 'issue' | 'pull-request';
  readonly title: string;
  readonly body: string;
  readonly state:
    typeof PullRequestState.Open | typeof PullRequestState.Closed | typeof PullRequestState.Merged;
  readonly revision: string;
  readonly headRevision?: string | undefined;
  readonly baseRevision?: string | undefined;
  readonly checks?:
    | typeof PullRequestCheckState.Unknown
    | typeof PullRequestCheckState.Pending
    | typeof PullRequestCheckState.Passing
    | typeof PullRequestCheckState.Failing
    | undefined;
  readonly actor: {
    readonly id: string;
    readonly kind: typeof ReviewActorKind.Human | typeof ReviewActorKind.Bot;
  };
  // Optional so observations recorded before intake matching still decode.
  readonly labels?: readonly string[] | undefined;
  readonly assignees?: readonly string[] | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

interface GitHubCommentObservedPayload {
  readonly externalKey: string;
  readonly body: string;
  readonly revision: string;
  readonly actor: {
    readonly id: string;
    readonly kind: typeof ReviewActorKind.Human | typeof ReviewActorKind.Bot;
  };
  readonly resourceAuthorId?: string | undefined;
  readonly authorization?:
    | {
        readonly source: typeof ReviewerAuthorizationSource.ConfiguredReviewer;
        readonly reviewerId: string;
      }
    | {
        readonly source: typeof ReviewerAuthorizationSource.ProviderPermission;
        readonly permission:
          | typeof ProviderPermission.None
          | typeof ProviderPermission.Read
          | typeof ProviderPermission.Triage
          | typeof ProviderPermission.Write
          | typeof ProviderPermission.Maintain
          | typeof ProviderPermission.Admin;
      }
    | { readonly source: typeof ReviewerAuthorizationSource.None }
    | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

interface GitHubDeliveryObservedPayload {
  readonly deliveryId: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GitHubEventPayloads {
  readonly [GitHubEventType.WorkObserved]: ExternalWorkObservedPayload;
  readonly [GitHubEventType.CommentObserved]: GitHubCommentObservedPayload;
  readonly [GitHubEventType.DeliveryObserved]: GitHubDeliveryObservedPayload;
}

export type GitHubAdapterEvent = EventUnion<GitHubEventPayloads, IntegrationStreamRef>;

export type GitHubAdapterEventDraft = EventDraftUnion<GitHubEventPayloads, IntegrationStreamRef>;

const streamSchema = z
  .object({
    kind: z.literal(IntegrationStreamKind.Integration),
    id: z.string().transform(adapterId),
  })
  .strict();
const rawSchema = z.record(z.string(), z.unknown());
const actorSchema = z
  .object({ id: z.string(), kind: z.enum([ReviewActorKind.Human, ReviewActorKind.Bot]) })
  .strict();
const authorizationSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal(ReviewerAuthorizationSource.ConfiguredReviewer),
      reviewerId: z.string(),
    })
    .strict(),
  z
    .object({
      source: z.literal(ReviewerAuthorizationSource.ProviderPermission),
      permission: z.enum([
        ProviderPermission.None,
        ProviderPermission.Read,
        ProviderPermission.Triage,
        ProviderPermission.Write,
        ProviderPermission.Maintain,
        ProviderPermission.Admin,
      ]),
    })
    .strict(),
  z.object({ source: z.literal(ReviewerAuthorizationSource.None) }).strict(),
]);
const eventSchema = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema.extend({
    eventType: z.literal(GitHubEventType.WorkObserved),
    stream: streamSchema,
    payload: z
      .object({
        externalKey: z.string(),
        kind: z.enum(['issue', 'pull-request']),
        title: z.string(),
        body: z.string(),
        state: z.enum([PullRequestState.Open, PullRequestState.Closed, PullRequestState.Merged]),
        revision: z.string(),
        headRevision: z.string().optional(),
        baseRevision: z.string().optional(),
        checks: z
          .enum([
            PullRequestCheckState.Unknown,
            PullRequestCheckState.Pending,
            PullRequestCheckState.Passing,
            PullRequestCheckState.Failing,
          ])
          .optional(),
        actor: actorSchema,
        labels: z.array(z.string()).readonly().optional(),
        assignees: z.array(z.string()).readonly().optional(),
        raw: rawSchema,
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(GitHubEventType.CommentObserved),
    stream: streamSchema,
    payload: z
      .object({
        externalKey: z.string(),
        body: z.string(),
        revision: z.string(),
        actor: actorSchema,
        resourceAuthorId: z.string().optional(),
        authorization: authorizationSchema.optional(),
        raw: rawSchema,
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(GitHubEventType.DeliveryObserved),
    stream: streamSchema,
    payload: z.object({ deliveryId: z.string(), raw: rawSchema }).strict(),
  }),
]);

export function decodeGitHubAdapterEvent(event: EventEnvelope): GitHubAdapterEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidGitHubEvent(event, result.error);
  return result.data;
}

export function selectGitHubAdapterEvent(event: EventEnvelope): GitHubAdapterEvent | null {
  return event.eventType.startsWith('integration.github.') ? decodeGitHubAdapterEvent(event) : null;
}

function invalidGitHubEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid GitHub adapter event ${event.eventId} at global position ${event.globalPosition} (${event.eventType}): ${cause.message}`,
    { cause },
  );
}
