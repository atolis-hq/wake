import { createFakeResourceIndex } from '../../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../../src/adapters/fs/state-store.js';
import type { IssueStateRecord } from '../../../src/domain/types.js';
import { createUnkeyedEventEnvelope } from '../../../src/lib/event-log.js';

/**
 * A stable, ULID-shaped work id per issue number, for fixtures that seed a
 * projection directly rather than letting the resolver mint one. Real ids come
 * from createWorkId() and are read back off the projection.
 */
export function workId(issueNumber: number): string {
  return `work-01JZ${String(issueNumber).padStart(22, '0')}`;
}

export function githubIssueUri(issueNumber: number): string {
  return `github:issue:atolis-hq/wake#${issueNumber}`;
}

/**
 * Test-only lookup of a projection by the ticket it represents, for assertions
 * that are naturally written against an issue number rather than an opaque work
 * id. Production never does this: it resolves the ticket's uri through the
 * resource index in one shard read (spec D2). A scan is fine here — fixtures
 * hold a handful of projections — but it must not creep back into src/.
 */
export async function findByIssueRef(
  store: ReturnType<typeof createStateStore>,
  input: { repo: string; issueNumber: number },
): Promise<IssueStateRecord | null> {
  const candidates = await store.listIssueStates({ includeArchived: true });
  return (
    candidates.find(
      (record) => record.issue.repo === input.repo && record.issue.number === input.issueNumber,
    ) ?? null
  );
}

/**
 * A resource index already holding the origin-ticket registrations an earlier
 * tick's mint would have written. Fixtures that seed a projection *and* poll
 * events for the same ticket need this: without the index entry the resolver
 * correctly treats the ticket as unseen and mints a second work item, because
 * a miss means "mint" and nothing else.
 */
export async function seededResourceIndex(issueNumbers: number[]) {
  const resourceIndex = createFakeResourceIndex();
  for (const issueNumber of issueNumbers) {
    await resourceIndex.register(githubIssueUri(issueNumber), workId(issueNumber));
  }
  return resourceIndex;
}

/**
 * A single ticket.upsert-shaped inbound event, carrying payload.ticket — the
 * shape the real github-issues-work-source stamps (and the shape
 * policy.qualifiesForMint reads for 'issue'-kind resources). The fake
 * ticketing harness (createFakeTicketingSystem) stamps payload.issue under
 * sourceEventType 'fake.issue.upsert' instead, so it cannot exercise the
 * qualification gate directly — this builds the real shape.
 */
export function ticketUpsertWorkSource(input: {
  repo: string;
  issueNumber: number;
  labels: string[];
  now: Date;
}) {
  const nowIso = input.now.toISOString();
  const sourceUrl = `https://example.test/${input.repo}/issues/${input.issueNumber}`;

  return {
    async pollEvents() {
      return [
        createUnkeyedEventEnvelope({
          eventId: `ticket-upsert-${input.repo}-${input.issueNumber}`,
          streamScope: 'global-intake',
          direction: 'inbound',
          sourceSystem: 'github',
          sourceEventType: 'ticket.upsert',
          sourceRefs: {
            repo: input.repo,
            issueNumber: input.issueNumber,
            sourceUrl,
            resourceUri: githubIssueUri(input.issueNumber),
          },
          occurredAt: nowIso,
          ingestedAt: nowIso,
          trigger: 'immediate',
          payload: {
            ticket: {
              repo: input.repo,
              number: input.issueNumber,
              title: 'Ticket',
              body: 'Body',
              labels: input.labels,
              assignees: [],
              isPullRequest: false,
              state: 'open',
              url: sourceUrl,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        }),
      ];
    },
  };
}
