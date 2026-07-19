import { access } from 'node:fs/promises';

import type { UnkeyedEventEnvelope } from '../../core/contracts.js';
import type { EventEnvelope } from '../../domain/types.js';
import { buildResourceUri } from '../../domain/resource-uri.js';
import { createEventEnvelope, createUnkeyedEventEnvelope } from '../../lib/event-log.js';
import { readJsonFile } from '../../lib/json-file.js';

const fakeSource = 'fake-ticketing';

export interface FakeTicketSeed {
  repo: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: Array<{
    id: string;
    body: string;
    author: {
      login: string;
    };
  }>;
}

function normalizeIssueEvents(issue: FakeTicketSeed, nowIso: string): UnkeyedEventEnvelope[] {
  const sourceUrl = `https://example.test/${issue.repo}/issues/${issue.number}`;
  // The source names the *resource* it saw, never the work item: the resolver
  // in tick-runner turns this into the canonical workItemKey (spec D1).
  const resourceUri = buildResourceUri(fakeSource, 'issue', `${issue.repo}#${issue.number}`);

  return [
    createUnkeyedEventEnvelope({
      eventId: `fake-issue-${issue.repo}-${issue.number}`,
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'fake-ticketing',
      sourceEventType: 'fake.issue.upsert',
      sourceRefs: {
        repo: issue.repo,
        issueNumber: issue.number,
        sourceUrl,
        resourceUri,
      },
      occurredAt: nowIso,
      ingestedAt: nowIso,
      trigger: 'immediate',
      payload: {
        issue: {
          repo: issue.repo,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          assignees: [],
          state: 'open',
          url: sourceUrl,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      },
      raw: {
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
      },
    }),
    ...issue.comments.map((comment, index) =>
      createUnkeyedEventEnvelope({
        eventId: `fake-comment-${issue.repo}-${issue.number}-${comment.id}-${index}`,
        streamScope: 'work-item',
        direction: 'inbound',
        sourceSystem: 'fake-ticketing',
        sourceEventType: 'fake.issue.comment.created',
        sourceRefs: {
          repo: issue.repo,
          issueNumber: issue.number,
          commentId: comment.id,
          sourceUrl,
          resourceUri,
        },
        occurredAt: nowIso,
        ingestedAt: nowIso,
        trigger: 'context-only',
        payload: {
          comment: {
            ...comment,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        },
        derivedHints: {
          botAuthoredComment: false,
        },
      }),
    ),
  ];
}

export function createFakeTicketingSystem(options: {
  tickets: FakeTicketSeed[];
  now?: () => Date;
}) {
  return {
    async pollEvents(_input?: {
      watch: Array<{ resourceUri: string }>;
    }): Promise<UnkeyedEventEnvelope[]> {
      const nowIso = (options.now ?? (() => new Date()))().toISOString();
      return options.tickets.flatMap((issue) => normalizeIssueEvents(issue, nowIso));
    },
    async deliverIntent(input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
      const publishedAt = (options.now ?? (() => new Date()))().toISOString();

      if (input.event.sourceEventType === 'wake.labels.requested') {
        const ticket = options.tickets.find(
          (issue) =>
            issue.repo === input.event.sourceRefs.repo &&
            issue.number === input.event.sourceRefs.issueNumber,
        );
        const currentLabels = ticket?.labels ?? [];
        const statusLabel =
          typeof input.event.payload.statusLabel === 'string'
            ? input.event.payload.statusLabel
            : undefined;
        const stageLabel =
          typeof input.event.payload.stageLabel === 'string'
            ? input.event.payload.stageLabel
            : undefined;
        const labels = [
          ...currentLabels.filter(
            (label) => !label.startsWith('wake:status.') && !label.startsWith('wake:stage.'),
          ),
          ...(statusLabel === undefined
            ? currentLabels.filter((label) => label.startsWith('wake:status.'))
            : [statusLabel]),
          ...(stageLabel === undefined
            ? currentLabels.filter((label) => label.startsWith('wake:stage.'))
            : [stageLabel]),
        ];

        return [
          createEventEnvelope({
            eventId: `${input.event.eventId}-labels-updated`,
            workItemKey: input.event.workItemKey,
            streamScope: 'work-item',
            direction: 'outbound',
            sourceSystem: 'fake-ticketing',
            sourceEventType: 'ticket.labels.updated',
            sourceRefs: {
              ...input.event.sourceRefs,
              sink: 'fake-ticketing',
            },
            occurredAt: publishedAt,
            ingestedAt: publishedAt,
            trigger: 'context-only',
            payload: {
              intentEventId: input.event.eventId,
              labels,
            },
          }),
        ];
      }

      const commentId = `${input.event.eventId}-comment`;

      return [
        createEventEnvelope({
          eventId: `${input.event.eventId}-delivery`,
          workItemKey: input.event.workItemKey,
          streamScope: 'work-item',
          direction: 'outbound',
          sourceSystem: 'fake-ticketing',
          sourceEventType: 'ticket.reply.published',
          sourceRefs: {
            ...input.event.sourceRefs,
            commentId,
            sink: 'fake-ticketing',
          },
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

export async function createFileBackedFakeTicketingSystem(options: {
  fixturePath: string;
  now?: () => Date;
}) {
  try {
    await access(options.fixturePath);
  } catch {
    return createFakeTicketingSystem(
      options.now === undefined ? { tickets: [] } : { tickets: [], now: options.now },
    );
  }

  const raw = await readJsonFile<FakeTicketSeed[]>(options.fixturePath);
  return createFakeTicketingSystem(
    options.now === undefined ? { tickets: raw } : { tickets: raw, now: options.now },
  );
}
