import { createEventDraft, EventActorKind } from '../../../kernel/index.js';
import { BuiltInAdapterId } from '../../contracts/identifiers.js';
import { integrationStream } from '../../contracts/streams.js';
import type { GitHubIssuePayload } from '../contracts/payloads.js';
import { GitHubEventType, type GitHubAdapterEventDraft } from '../contracts/events.js';

export function issueObservation(input: {
  readonly repository: string;
  readonly issue: GitHubIssuePayload;
}): Extract<GitHubAdapterEventDraft, { eventType: typeof GitHubEventType.WorkObserved }> {
  const key = `${input.repository}#${input.issue.number}`;
  return createEventDraft({
    eventId: `github:issue:${key}:${input.issue.updated_at}`,
    eventType: GitHubEventType.WorkObserved,
    occurredAt: input.issue.updated_at,
    correlationId: `github:${key}`,
    causationId: `github:${key}:${input.issue.updated_at}`,
    actor: { kind: EventActorKind.Integration, id: 'github' },
    source: { kind: 'adapter', id: 'github' },
    stream: integrationStream(BuiltInAdapterId.GitHub),
    payload: {
      externalKey: key,
      kind: 'issue',
      title: input.issue.title,
      body: input.issue.body ?? '',
      state: input.issue.state,
      revision: input.issue.updated_at,
      actor: {
        id: input.issue.user?.login ?? 'unknown',
        kind: input.issue.user?.type === 'Bot' ? 'bot' : 'human',
      },
      raw: { number: input.issue.number },
    },
  });
}
