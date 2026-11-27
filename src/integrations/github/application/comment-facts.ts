import type { EventEnvelope, ViewSnapshotCodec } from '@atolis-hq/eventing';
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

export function sourceMessageIdForComment(entry: CommentHistoryEntry): string | undefined {
  return sourceMessageIds.get(entry);
}

// Indexes every comment-bearing fact once, as the journal grows, so a query for
// one Work item reads only its own resources' entries instead of the history.
export interface CommentFacts {
  readonly intents: ReadonlyMap<string, ConfirmableCommentIntent>;
  readonly observedByResource: ReadonlyMap<string, ReadonlyMap<string, ProviderComment>>;
  /** Earliest confirming delivery event per intent. */
  readonly confirmations: ReadonlyMap<string, EventEnvelope>;
}

export const emptyCommentFacts: CommentFacts = {
  intents: new Map(),
  observedByResource: new Map(),
  confirmations: new Map(),
};

export function extendCommentFacts(
  state: CommentFacts,
  events: readonly EventEnvelope[],
): CommentFacts {
  let intents = state.intents;
  let observedByResource = state.observedByResource;
  let confirmations = state.confirmations;
  for (const event of events) {
    const intent = selectDeliveryIntentEvent(event);
    if (intent !== null) {
      if (isCommentIntent(intent)) {
        if (intents === state.intents) intents = new Map(intents);
        (intents as Map<string, ConfirmableCommentIntent>).set(intent.event.eventId, intent);
      }
      continue;
    }
    const delivery = selectDeliveryEvent(event);
    if (delivery !== null) {
      if (!isConfirmed(delivery)) continue;
      const key = delivery.event.payload.intentEventId;
      const current = confirmations.get(key);
      if (current === undefined || event.globalPosition < current.globalPosition) {
        if (confirmations === state.confirmations) confirmations = new Map(confirmations);
        (confirmations as Map<string, EventEnvelope>).set(key, event);
      }
      continue;
    }
    const comment = providerComment(event);
    if (comment === null) continue;
    if (observedByResource === state.observedByResource)
      observedByResource = new Map(observedByResource);
    const forResource = new Map(observedByResource.get(comment.resourceKey));
    forResource.set(comment.messageId, comment);
    (observedByResource as Map<string, ReadonlyMap<string, ProviderComment>>).set(
      comment.resourceKey,
      forResource,
    );
  }
  return { intents, observedByResource, confirmations };
}

// The facts are a pure fold of the envelopes that survive in them, so the
// snapshot is exactly those envelopes in journal order and loading re-folds them.
export const commentFactsCodec: ViewSnapshotCodec<CommentFacts> = {
  encode(facts) {
    const envelopes = new Map<number, EventEnvelope>();
    for (const intent of facts.intents.values()) envelopes.set(intent.globalPosition, intent);
    for (const event of facts.confirmations.values()) envelopes.set(event.globalPosition, event);
    for (const byMessage of facts.observedByResource.values())
      for (const comment of byMessage.values())
        envelopes.set(comment.event.globalPosition, comment.event);
    return [...envelopes.values()].sort((a, b) => a.globalPosition - b.globalPosition);
  },
  decode(raw) {
    if (!Array.isArray(raw)) throw new Error('Comment snapshot must be a list of events');
    return extendCommentFacts(emptyCommentFacts, raw as EventEnvelope[]);
  },
};

export type ConfirmableCommentIntent = NonNullable<ReturnType<typeof selectDeliveryIntentEvent>>;

export interface Confirmation {
  readonly event: EventEnvelope;
  readonly intent: ConfirmableCommentIntent;
}

export interface ProviderComment {
  readonly event: EventEnvelope;
  readonly messageId: string;
  readonly resourceKey: string;
  readonly value: CommentHistoryEntry;
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

function providerComment(event: EventEnvelope): ProviderComment | null {
  const observed = selectGitHubAdapterEvent(event);
  if (!isCommentObserved(observed)) return null;
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
