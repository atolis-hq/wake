import type { UnkeyedEventEnvelope } from '../../core/contracts.js';
import type { EventEnvelope } from '../../domain/types.js';
import { createEventEnvelope, createUnkeyedEventEnvelope } from '../../lib/event-log.js';

export interface FakePrActivitySeed {
  repo: string;
  number: number;
  author: string;
  headRef: string;
  comments: Array<{ id: string; body: string; author: string }>;
}

/** Permanent test harness — zero-token equivalent of the real GitHub PR activity source. */
export function createFakeGitHubPullRequestActivitySource(options: {
  prs: FakePrActivitySeed[];
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  return {
    async pollEvents(input?: {
      watch: Array<{ resourceUri: string }>;
    }): Promise<UnkeyedEventEnvelope[]> {
      const nowIso = now().toISOString();
      const watched = new Set((input?.watch ?? []).map((ref) => ref.resourceUri));
      const events: UnkeyedEventEnvelope[] = [];

      for (const pr of options.prs) {
        const resourceUri = `github:pr:${pr.repo}#${pr.number}`;

        if (!watched.has(resourceUri)) {
          events.push(
            createUnkeyedEventEnvelope({
              eventId: `fake-pr-seen-${pr.repo}-${pr.number}`,
              streamScope: 'global-intake',
              direction: 'inbound',
              sourceSystem: 'fake-github-pr',
              sourceEventType: 'pr.seen',
              sourceRefs: { repo: pr.repo, resourceUri },
              occurredAt: nowIso,
              ingestedAt: nowIso,
              trigger: 'context-only',
              payload: { pr: { number: pr.number, author: pr.author, headRef: pr.headRef } },
            }),
          );
          continue;
        }

        for (const comment of pr.comments) {
          events.push(
            createUnkeyedEventEnvelope({
              eventId: `fake-pr-comment-${pr.repo}-${pr.number}-${comment.id}`,
              streamScope: 'work-item',
              direction: 'inbound',
              sourceSystem: 'fake-github-pr',
              sourceEventType: 'pr.comment.created',
              sourceRefs: { repo: pr.repo, commentId: comment.id, resourceUri },
              occurredAt: nowIso,
              ingestedAt: nowIso,
              trigger: 'context-only',
              payload: {
                comment: {
                  id: comment.id,
                  body: comment.body,
                  author: { login: comment.author },
                  createdAt: nowIso,
                  updatedAt: nowIso,
                  resourceUri,
                },
              },
              derivedHints: { botAuthoredComment: false },
            }),
          );
        }
      }

      return events;
    },
    async deliverIntent(input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
      const publishedAt = now().toISOString();
      return [
        createEventEnvelope({
          eventId: `${input.event.eventId}-published`,
          workItemKey: input.event.workItemKey,
          streamScope: 'work-item',
          direction: 'outbound',
          sourceSystem: 'fake-github-pr',
          sourceEventType: 'pr.comment.reply.published',
          sourceRefs: { ...input.event.sourceRefs, sink: 'fake-github-pr' },
          occurredAt: publishedAt,
          ingestedAt: publishedAt,
          trigger: 'context-only',
          payload: {
            intentEventId: input.event.eventId,
            kind: input.event.payload.kind,
            body: input.event.payload.body,
          },
        }),
      ];
    },
  };
}
