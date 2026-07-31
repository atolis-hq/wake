import { z } from 'zod';
import {
  eventEnvelopeSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../../kernel/index.js';
import { adapterId, BuiltInAdapterId } from '../../contracts/identifiers.js';
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
  readonly state: 'open' | 'closed' | 'merged';
  readonly revision: string;
  readonly headRevision?: string | undefined;
  readonly baseRevision?: string | undefined;
  readonly checks?: 'unknown' | 'pending' | 'passing' | 'failing' | undefined;
  readonly actor: { readonly id: string; readonly kind: 'human' | 'bot' };
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GitHubCommentObservedPayload {
  readonly externalKey: string;
  readonly body: string;
  readonly revision: string;
  readonly actor: { readonly id: string; readonly kind: 'human' | 'bot' };
  readonly resourceAuthorId?: string | undefined;
  readonly authorization?:
    | { readonly source: 'configured-reviewer'; readonly reviewerId: string }
    | {
        readonly source: 'provider-permission';
        readonly permission: 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin';
      }
    | { readonly source: 'none' }
    | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GitHubDeliveryObservedPayload {
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
    id: z.literal(BuiltInAdapterId.GitHub).transform(adapterId),
  })
  .strict();
const rawSchema = z.record(z.string(), z.unknown());
const actorSchema = z.object({ id: z.string(), kind: z.enum(['human', 'bot']) }).strict();
const authorizationSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('configured-reviewer'), reviewerId: z.string() }).strict(),
  z
    .object({
      source: z.literal('provider-permission'),
      permission: z.enum(['none', 'read', 'triage', 'write', 'maintain', 'admin']),
    })
    .strict(),
  z.object({ source: z.literal('none') }).strict(),
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
        state: z.enum(['open', 'closed', 'merged']),
        revision: z.string(),
        headRevision: z.string().optional(),
        baseRevision: z.string().optional(),
        checks: z.enum(['unknown', 'pending', 'passing', 'failing']).optional(),
        actor: actorSchema,
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
