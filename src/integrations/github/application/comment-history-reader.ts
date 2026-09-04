import type { EventEnvelope, EventJournal } from '@atolis-hq/eventing';
import { ResourceCorrelationRole, type ResourceService } from '../../../resources/index.js';
import type { WorkItemId } from '../../../work/index.js';
import { adapterId } from '../../contracts/identifiers.js';
import { DeliveryEventType, selectDeliveryEvent } from '../../delivery/contracts/events.js';
import {
  DeliveryIntentEventType,
  selectDeliveryIntentEvent,
} from '../../delivery/contracts/intents.js';
import { DeliveryResultKind } from '../../delivery/contracts/vocabulary.js';
import {
  GitHubEventType,
  selectGitHubAdapterEvent,
  type GitHubAdapterEventOf,
} from '../contracts/events.js';
import { GitHubAdapter, UnknownGitHubIdentity } from '../contracts/vocabulary.js';
import { formatAgentRunComment } from './agent-run-comment.js';
import { appendDeliveryMarker, deliveryMarker } from './delivery-marker.js';

export interface CommentHistoryEntry {
  readonly author: string;
  readonly occurredAt: string;
  readonly body: string;
  readonly location?: {
    readonly path: string;
    readonly line: number;
    readonly side: 'LEFT' | 'RIGHT';
  };
}

const sourceMessageIds = new WeakMap<object, string>();
const deliveryIntentIds = new WeakMap<object, string>();

export function sourceMessageIdForComment(entry: CommentHistoryEntry): string | undefined {
  return sourceMessageIds.get(entry);
}

export function deliveryIntentIdForComment(entry: CommentHistoryEntry): string | undefined {
  return deliveryIntentIds.get(entry);
}

export interface CommentHistoryReader {
  forWorkItem(
    workItemId: WorkItemId,
    options?: { readonly observedSince?: string },
  ): Promise<readonly CommentHistoryEntry[]>;
}

export interface CommentHistoryReaderOptions {
  readonly publicUiUrl?: string | undefined;
  readonly githubAdapters?: readonly string[] | undefined;
}

export function createCommentHistoryReader(
  journal: EventJournal,
  resources: Pick<ResourceService, 'correlationsForWork' | 'get'>,
  readerOptions: CommentHistoryReaderOptions = {},
): CommentHistoryReader {
  return {
    async forWorkItem(workItemId, options) {
      const resourcesById = new Map(
        (
          await Promise.all(
            (await resources.correlationsForWork(workItemId))
              .filter((correlation) => correlation.role === ResourceCorrelationRole.Primary)
              .map((correlation) => resources.get(correlation.resourceId)),
          )
        ).flatMap((resource) =>
          resource === null ? [] : [[resource.resourceId, resource] as const],
        ),
      );
      const keys = new Set(
        [...resourcesById.values()].flatMap((resource) => {
          if (parseAdapterId(resource.externalKey.adapter) === null) return [];
          return [`${resource.externalKey.adapter}:${resource.externalKey.key}`];
        }),
      );
      if (keys.size === 0) return [];
      const githubAdapters = new Set(readerOptions.githubAdapters ?? [GitHubAdapter]);
      const githubResourceIds = new Set(
        [...resourcesById.entries()].flatMap(([resourceId, resource]) =>
          githubAdapters.has(resource.externalKey.adapter) ? [resourceId] : [],
        ),
      );
      return readCommentHistory(
        await journal.readAll(0),
        resourcesById,
        keys,
        githubResourceIds,
        options?.observedSince,
        readerOptions.publicUiUrl,
      );
    },
  };
}

function readCommentHistory(
  events: readonly EventEnvelope[],
  resourcesById: ReadonlyMap<
    string,
    { readonly externalKey: { readonly adapter: string; readonly key: string } }
  >,
  keys: ReadonlySet<string>,
  githubResourceIds: ReadonlySet<string>,
  observedSince: string | undefined,
  publicUiUrl: string | undefined,
): readonly CommentHistoryEntry[] {
  const intents = commentIntents(events, githubResourceIds);
  const observed = providerComments(events, keys);
  const confirmed = confirmations(events, intents);
  return reconcileCommentHistory(observed, confirmed, resourcesById, observedSince, publicUiUrl);
}

function commentIntents(
  events: readonly EventEnvelope[],
  githubResourceIds: ReadonlySet<string>,
): ReadonlyMap<string, ConfirmableCommentIntent> {
  const intents = new Map<string, ConfirmableCommentIntent>();
  for (const event of events) {
    const intent = selectDeliveryIntentEvent(event);
    if (
      intent !== null &&
      isCommentIntent(intent) &&
      githubResourceIds.has(intent.event.payload.resourceId)
    )
      intents.set(intent.event.eventId, intent);
  }
  return intents;
}

function providerComments(
  events: readonly EventEnvelope[],
  keys: ReadonlySet<string>,
): ReadonlyMap<string, ProviderComment> {
  const observed = new Map<string, ProviderComment>();
  for (const event of events) {
    const comment = providerComment(event, keys);
    if (comment !== null) observed.set(comment.messageId, comment);
  }
  return observed;
}

function confirmations(
  events: readonly EventEnvelope[],
  intents: ReadonlyMap<string, ConfirmableCommentIntent>,
): ReadonlyMap<string, Confirmation> {
  const confirmed = new Map<string, Confirmation>();
  for (const event of events) {
    const delivery = selectDeliveryEvent(event);
    if (delivery === null || !isConfirmed(delivery)) continue;
    const intent = intents.get(delivery.event.payload.intentEventId);
    if (intent === undefined) continue;
    const candidate = { event, intent };
    const current = confirmed.get(delivery.event.payload.intentEventId);
    if (current === undefined || candidate.event.globalPosition < current.event.globalPosition)
      confirmed.set(delivery.event.payload.intentEventId, candidate);
  }
  return confirmed;
}

function reconcileCommentHistory(
  observed: ReadonlyMap<string, ProviderComment>,
  confirmed: ReadonlyMap<string, Confirmation>,
  resourcesById: ReadonlyMap<
    string,
    { readonly externalKey: { readonly adapter: string; readonly key: string } }
  >,
  observedSince: string | undefined,
  publicUiUrl: string | undefined,
): readonly CommentHistoryEntry[] {
  const history = new Map<string, HistoryItem>();
  for (const entry of observed.values())
    history.set(entry.messageId, {
      entry: entry.value,
      occurredAt: entry.event.event.occurredAt,
      globalPosition: entry.event.globalPosition,
    });
  for (const [intentEventId, confirmation] of confirmed) {
    const resource = resourcesById.get(confirmation.intent.event.payload.resourceId);
    if (resource === undefined) continue;
    const resourceKey = `${resource.externalKey.adapter}:${resource.externalKey.key}`;
    const matchingProvider = [...observed.values()].find(
      (entry) =>
        entry.resourceKey === resourceKey && deliveryMarker(entry.value.body) === intentEventId,
    );
    history.set(intentEventId, {
      entry:
        matchingProvider?.value ??
        syntheticComment(confirmation.intent, confirmation.event.event.occurredAt, publicUiUrl),
      occurredAt: confirmation.event.event.occurredAt,
      globalPosition: confirmation.event.globalPosition,
    });
    if (matchingProvider !== undefined) history.delete(matchingProvider.messageId);
  }
  return [...history.values()]
    .filter((entry) => observedSince === undefined || entry.occurredAt > observedSince)
    .sort((left, right) => left.globalPosition - right.globalPosition)
    .map((entry) => entry.entry);
}

type ConfirmableCommentIntent = NonNullable<ReturnType<typeof selectDeliveryIntentEvent>>;

interface Confirmation {
  readonly event: EventEnvelope;
  readonly intent: ConfirmableCommentIntent;
}

interface ProviderComment {
  readonly event: EventEnvelope;
  readonly messageId: string;
  readonly resourceKey: string;
  readonly value: CommentHistoryEntry;
}

interface HistoryItem {
  readonly entry: CommentHistoryEntry;
  readonly occurredAt: string;
  readonly globalPosition: number;
}

function isCommentIntent(
  value: NonNullable<ReturnType<typeof selectDeliveryIntentEvent>>,
): value is ConfirmableCommentIntent {
  return (
    value.event.eventType === DeliveryIntentEventType.StatusPublishRequested ||
    value.event.eventType === DeliveryIntentEventType.ReplyPublishRequested ||
    value.event.eventType === DeliveryIntentEventType.AgentRunPublishRequested
  );
}

function isConfirmed(value: NonNullable<ReturnType<typeof selectDeliveryEvent>>): boolean {
  return (
    value.event.eventType === DeliveryEventType.Confirmed ||
    (value.event.eventType === DeliveryEventType.Reconciled &&
      value.event.payload.result === DeliveryResultKind.Confirmed)
  );
}

function providerComment(event: EventEnvelope, keys: ReadonlySet<string>): ProviderComment | null {
  const observed = selectGitHubAdapterEvent(event);
  if (
    !isCommentObserved(observed) ||
    !keys.has(`${observed.stream.id}:${observed.event.payload.externalKey}`)
  )
    return null;
  return {
    event,
    messageId: observedCommentExternalId(observed),
    resourceKey: `${observed.stream.id}:${observed.event.payload.externalKey}`,
    value: commentWithSourceMessageId(
      {
        author: observed.event.payload.actor.id,
        occurredAt: observed.event.occurredAt,
        body: observed.event.payload.body,
        ...(observed.event.payload.reviewKind !== 'issue' ||
        observed.event.payload.location === undefined
          ? {}
          : { location: observed.event.payload.location }),
      },
      observedCommentExternalId(observed),
    ),
  };
}

function isCommentObserved(
  event: ReturnType<typeof selectGitHubAdapterEvent>,
): event is GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved> {
  return event?.event.eventType === GitHubEventType.CommentObserved;
}

function commentWithSourceMessageId(
  entry: CommentHistoryEntry,
  messageId: string,
): CommentHistoryEntry {
  sourceMessageIds.set(entry, messageId);
  return entry;
}

function observedCommentExternalId(
  event: GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>,
): string {
  const id = event.event.payload.raw.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : event.event.eventId;
}

function syntheticComment(
  intent: ConfirmableCommentIntent,
  occurredAt: string,
  publicUiUrl: string | undefined,
): CommentHistoryEntry {
  const entry = {
    author: UnknownGitHubIdentity,
    occurredAt,
    body: deliveredCommentBody(intent, publicUiUrl),
  };
  deliveryIntentIds.set(entry, intent.event.eventId);
  return entry;
}

function deliveredCommentBody(
  intent: ConfirmableCommentIntent,
  publicUiUrl: string | undefined,
): string {
  const body =
    intent.event.eventType === DeliveryIntentEventType.AgentRunPublishRequested
      ? formatAgentRunComment({
          idempotencyKey: intent.event.eventId,
          ...intent.event.payload.report,
          publicUiUrl,
        })
      : intent.event.payload.body;
  return appendDeliveryMarker(body, intent.event.eventId);
}

function parseAdapterId(value: string) {
  try {
    return adapterId(value);
  } catch {
    return null;
  }
}
