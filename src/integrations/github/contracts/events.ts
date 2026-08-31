import {
  eventDataSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
} from '@atolis-hq/eventing';
import { z } from 'zod';
import {
  ProviderPermission,
  PullRequestCheckState,
  PullRequestState,
  ReviewActorKind,
  ReviewerAuthorizationSource,
  type ReviewerAuthorizationEvidence,
} from '../../../activities/index.js';
import { brandedStringSchema } from '../../../kernel/index.js';
import { resourceId, type ResourceId } from '../../../resources/index.js';
import { workItemId, type WorkItemId } from '../../../work/index.js';
import { adapterId } from '../../contracts/identifiers.js';
import { ExternalWorkOutcome } from '../../contracts/outcome-vocabulary.js';
import { IntegrationStreamKind, type IntegrationStreamRef } from '../../contracts/streams.js';

export const GitHubEventType = {
  WorkObserved: 'integration.github.work-observed',
  CommentObserved: 'integration.github.comment-observed',
  DeliveryObserved: 'integration.github.delivery-observed',
  DeletedWorkObservationSkipped: 'integration.github.deleted-work-observation-skipped',
  AdmissionStarted: 'integration.github.admission-started',
  InboundTranslationRetried: 'integration.github.inbound-translation-retried',
  InboundTranslationRecovered: 'integration.github.inbound-translation-recovered',
  InboundTranslationFailed: 'integration.github.inbound-translation-failed',
  ConversationRecordDeferred: 'integration.github.conversation-record-deferred',
  ConversationRecordRecovered: 'integration.github.conversation-record-recovered',
} as const;

export interface ExternalWorkObservedPayload {
  readonly externalKey: string;
  readonly kind: 'issue' | 'pull-request';
  readonly title: string;
  readonly body: string;
  readonly state:
    typeof PullRequestState.Open | typeof PullRequestState.Closed | typeof PullRequestState.Merged;
  readonly outcome?: ExternalWorkOutcome | undefined;
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
  // Files the head revision changed, when the provider could fetch them.
  readonly changedFiles?: readonly string[] | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

interface GitHubFormalCommentObservedPayload {
  readonly reviewKind: 'formal';
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

interface GitHubIssueCommentObservedPayload {
  readonly reviewKind: 'issue';
  readonly externalKey: string;
  readonly body: string;
  readonly revision: string;
  readonly location?:
    | {
        readonly path: string;
        readonly line: number;
        readonly side: 'LEFT' | 'RIGHT';
      }
    | undefined;
  readonly actor: {
    readonly id: string;
    readonly kind: typeof ReviewActorKind.Human | typeof ReviewActorKind.Bot;
  };
  /** Provider-derived authority for an operator command, when available. */
  readonly authorization?: ReviewerAuthorizationEvidence | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

type GitHubCommentObservedPayload =
  GitHubFormalCommentObservedPayload | GitHubIssueCommentObservedPayload;

interface GitHubDeliveryObservedPayload {
  readonly deliveryId: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

interface GitHubDeletedWorkObservationSkippedPayload {
  readonly externalKey: string;
  readonly workItemId: WorkItemId;
  readonly sourceEventId: string;
  readonly revision: string;
  readonly reason: 'work-item-deleted';
}

interface GitHubAdmissionStartedPayload {
  readonly sourceEventId: string;
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
}

interface InboundTranslationRetryPayload {
  readonly adapter: string;
  readonly sourceEventId: string;
  readonly attempt: number;
  readonly message: string;
}

interface InboundTranslationFailurePayload extends InboundTranslationRetryPayload {
  readonly globalPosition: number;
  readonly eventType: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly failedAt: string;
}

interface InboundTranslationRecoveredPayload {
  readonly adapter: string;
  readonly sourceEventId: string;
}

interface ConversationRecordPayload {
  readonly adapter: string;
  readonly sourceEventId: string;
}

export interface GitHubEventPayloads {
  readonly [GitHubEventType.WorkObserved]: ExternalWorkObservedPayload;
  readonly [GitHubEventType.CommentObserved]: GitHubCommentObservedPayload;
  readonly [GitHubEventType.DeliveryObserved]: GitHubDeliveryObservedPayload;
  readonly [GitHubEventType.DeletedWorkObservationSkipped]: GitHubDeletedWorkObservationSkippedPayload;
  readonly [GitHubEventType.AdmissionStarted]: GitHubAdmissionStartedPayload;
  readonly [GitHubEventType.InboundTranslationRetried]: InboundTranslationRetryPayload;
  readonly [GitHubEventType.InboundTranslationRecovered]: InboundTranslationRecoveredPayload;
  readonly [GitHubEventType.InboundTranslationFailed]: InboundTranslationFailurePayload;
  readonly [GitHubEventType.ConversationRecordDeferred]: ConversationRecordPayload;
  readonly [GitHubEventType.ConversationRecordRecovered]: ConversationRecordPayload;
}

export type GitHubAdapterEvent = EventUnion<GitHubEventPayloads, IntegrationStreamRef>;

export type GitHubAdapterEventData = EventDataUnion<GitHubEventPayloads>;

export type GitHubAdapterEventOf<Type extends keyof GitHubEventPayloads> = EventEnvelope<
  Extract<GitHubAdapterEventData, { readonly eventType: Type }>,
  IntegrationStreamRef
>;

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

const githubEventSchemas = {
  [GitHubEventType.ConversationRecordDeferred]: githubEventSchema(
    GitHubEventType.ConversationRecordDeferred,
    z.object({ adapter: z.string(), sourceEventId: z.string() }).strict(),
  ),
  [GitHubEventType.ConversationRecordRecovered]: githubEventSchema(
    GitHubEventType.ConversationRecordRecovered,
    z.object({ adapter: z.string(), sourceEventId: z.string() }).strict(),
  ),
  [GitHubEventType.WorkObserved]: githubEventSchema(
    GitHubEventType.WorkObserved,
    z
      .object({
        externalKey: z.string(),
        kind: z.enum(['issue', 'pull-request']),
        title: z.string(),
        body: z.string(),
        state: z.enum([PullRequestState.Open, PullRequestState.Closed, PullRequestState.Merged]),
        outcome: z.enum([ExternalWorkOutcome.Completed, ExternalWorkOutcome.Cancelled]).optional(),
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
        changedFiles: z.array(z.string()).readonly().optional(),
        raw: rawSchema,
      })
      .strict(),
  ),
  [GitHubEventType.AdmissionStarted]: githubEventSchema(
    GitHubEventType.AdmissionStarted,
    z
      .object({
        sourceEventId: z.string(),
        resourceId: brandedStringSchema(resourceId),
        workItemId: brandedStringSchema(workItemId),
      })
      .strict(),
  ),
  [GitHubEventType.CommentObserved]: githubEventSchema(
    GitHubEventType.CommentObserved,
    z.discriminatedUnion('reviewKind', [
      z
        .object({
          externalKey: z.string(),
          reviewKind: z.literal('formal'),
          body: z.string(),
          revision: z.string(),
          actor: actorSchema,
          resourceAuthorId: z.string().optional(),
          authorization: authorizationSchema.optional(),
          raw: rawSchema,
        })
        .strict(),
      z
        .object({
          externalKey: z.string(),
          reviewKind: z.literal('issue'),
          body: z.string(),
          revision: z.string(),
          location: z
            .object({
              path: z.string(),
              line: z.number().int(),
              side: z.enum(['LEFT', 'RIGHT']),
            })
            .strict()
            .optional(),
          actor: actorSchema,
          authorization: authorizationSchema.optional(),
          raw: rawSchema,
        })
        .strict(),
    ]),
  ),
  [GitHubEventType.DeliveryObserved]: githubEventSchema(
    GitHubEventType.DeliveryObserved,
    z.object({ deliveryId: z.string(), raw: rawSchema }).strict(),
  ),
  [GitHubEventType.DeletedWorkObservationSkipped]: githubEventSchema(
    GitHubEventType.DeletedWorkObservationSkipped,
    z
      .object({
        externalKey: z.string(),
        workItemId: brandedStringSchema(workItemId),
        sourceEventId: z.string(),
        revision: z.string(),
        reason: z.literal('work-item-deleted'),
      })
      .strict(),
  ),
  [GitHubEventType.InboundTranslationRetried]: githubEventSchema(
    GitHubEventType.InboundTranslationRetried,
    z
      .object({
        adapter: z.string(),
        sourceEventId: z.string(),
        attempt: z.number().int().positive(),
        message: z.string(),
      })
      .strict(),
  ),
  [GitHubEventType.InboundTranslationRecovered]: githubEventSchema(
    GitHubEventType.InboundTranslationRecovered,
    z.object({ adapter: z.string(), sourceEventId: z.string() }).strict(),
  ),
  [GitHubEventType.InboundTranslationFailed]: githubEventSchema(
    GitHubEventType.InboundTranslationFailed,
    z
      .object({
        adapter: z.string(),
        sourceEventId: z.string(),
        attempt: z.number().int().positive(),
        message: z.string(),
        globalPosition: z.number().int().positive(),
        eventType: z.string(),
        correlationId: z.string(),
        causationId: z.string(),
        failedAt: z.string(),
      })
      .strict(),
  ),
} as const;

const githubEventTypes = new Set<string>(Object.values(GitHubEventType));

function githubEventSchemaFor(eventType: string) {
  return isGitHubEventType(eventType) ? githubEventSchemas[eventType] : null;
}

function isGitHubEventType(eventType: string): eventType is keyof typeof githubEventSchemas {
  return githubEventTypes.has(eventType);
}

function githubEventSchema<Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) {
  return eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({ eventType: z.literal(eventType), payload }),
    stream: streamSchema,
  });
}

export function decodeGitHubAdapterEvent(event: EventEnvelope): GitHubAdapterEvent {
  const header = eventEnvelopeSchema.safeParse(event);
  if (!header.success) throw invalidGitHubEvent(event, header.error);
  const schema = githubEventSchemaFor(header.data.event.eventType);
  if (schema === null) {
    const unsupported = z.never().safeParse(header.data.event.eventType);
    if (unsupported.success) throw new Error('Expected unsupported event type validation to fail');
    throw invalidGitHubEvent(event, unsupported.error);
  }
  const result = schema.safeParse(event);
  if (!result.success) throw invalidGitHubEvent(event, result.error);
  return result.data;
}

export function selectGitHubAdapterEvent(event: EventEnvelope): GitHubAdapterEvent | null {
  return event.event.eventType.startsWith('integration.github.')
    ? decodeGitHubAdapterEvent(event)
    : null;
}

function invalidGitHubEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid GitHub adapter event ${event.event.eventId} at global position ${event.globalPosition} (${event.event.eventType}): ${cause.message}`,
    { cause },
  );
}
