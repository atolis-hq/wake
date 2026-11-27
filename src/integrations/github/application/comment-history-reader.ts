import { foldedJournalView, type EventJournal } from '@atolis-hq/eventing';
import { ResourceCorrelationRole, type ResourceService } from '../../../resources/index.js';
import type { WorkItemId } from '../../../work/index.js';
import { adapterId } from '../../contracts/identifiers.js';
import { DeliveryIntentEventType } from '../../delivery/contracts/intents.js';
import { GitHubAdapter, UnknownGitHubIdentity } from '../contracts/vocabulary.js';
import { formatAgentRunComment } from './agent-run-comment.js';
import { githubCommentBody } from './comment-body.js';
import {
  commentFactsCodec,
  emptyCommentFacts,
  extendCommentFacts,
  type CommentFacts,
  type CommentHistoryEntry,
  type ConfirmableCommentIntent,
  type Confirmation,
  type ProviderComment,
} from './comment-facts.js';
import { appendDeliveryMarker, deliveryMarker } from './delivery-marker.js';

export { sourceMessageIdForComment, type CommentHistoryEntry } from './comment-facts.js';

const deliveryIntentIds = new WeakMap<object, string>();

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
  const facts = foldedJournalView<CommentFacts>(journal, {
    name: 'github-comment-history',
    initial: emptyCommentFacts,
    extend: extendCommentFacts,
    persist: { schemaVersion: 1, codec: commentFactsCodec },
  });
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
      const known = await facts.get();
      const intents = new Map(
        [...known.intents].filter(([, intent]) =>
          githubResourceIds.has(intent.event.payload.resourceId),
        ),
      );
      const observed = new Map<string, ProviderComment>();
      for (const key of keys)
        for (const [messageId, comment] of known.observedByResource.get(key) ?? [])
          observed.set(messageId, comment);
      const confirmed = new Map<string, Confirmation>();
      for (const [intentEventId, event] of known.confirmations) {
        const intent = intents.get(intentEventId);
        if (intent !== undefined) confirmed.set(intentEventId, { event, intent });
      }
      return reconcileCommentHistory(
        observed,
        confirmed,
        resourcesById,
        options?.observedSince,
        readerOptions.publicUiUrl,
      );
    },
  };
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

interface HistoryItem {
  readonly entry: CommentHistoryEntry;
  readonly occurredAt: string;
  readonly globalPosition: number;
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
        })
      : intent.event.payload.body;
  return appendDeliveryMarker(githubCommentBody(body, publicUiUrl), intent.event.eventId);
}

function parseAdapterId(value: string) {
  try {
    return adapterId(value);
  } catch {
    return null;
  }
}
