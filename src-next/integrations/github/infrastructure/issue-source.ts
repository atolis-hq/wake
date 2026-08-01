import { EventSourceKind } from '../../../kernel/index.js';
import { ReviewActorKind } from '../../../activities/index.js';
import { createEventDraft, EventActorKind } from '../../../kernel/index.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import { integrationStream } from '../../contracts/streams.js';
import { formatGitHubResourceKey } from '../contracts/external-key.js';
import type { GitHubIssuePayload } from '../contracts/payloads.js';
import { GitHubEventType, type GitHubAdapterEventDraft } from '../contracts/events.js';
import { UnknownGitHubIdentity } from '../contracts/vocabulary.js';

export function issueObservation(input: {
  readonly repository: string;
  readonly issue: GitHubIssuePayload;
  readonly adapter?: AdapterId;
}): Extract<GitHubAdapterEventDraft, { eventType: typeof GitHubEventType.WorkObserved }> {
  const key = formatGitHubResourceKey({
    ...parseRepository(input.repository),
    number: input.issue.number,
  });
  return createEventDraft({
    eventId: `github:issue:${key}:${input.issue.updated_at}`,
    eventType: GitHubEventType.WorkObserved,
    occurredAt: input.issue.updated_at,
    correlationId: `github:${key}`,
    causationId: `github:${key}:${input.issue.updated_at}`,
    actor: { kind: EventActorKind.Integration, id: 'github' },
    source: { kind: EventSourceKind.Adapter, id: input.adapter ?? GitHubAdapter },
    stream: integrationStream(input.adapter ?? GitHubAdapter),
    payload: {
      externalKey: key,
      kind: 'issue',
      title: input.issue.title,
      body: input.issue.body ?? '',
      state: input.issue.state,
      revision: input.issue.updated_at,
      actor: {
        id: input.issue.user?.login ?? UnknownGitHubIdentity,
        kind: input.issue.user?.type === 'Bot' ? ReviewActorKind.Bot : ReviewActorKind.Human,
      },
      raw: { number: input.issue.number },
    },
  });
}

function parseRepository(repository: string): { readonly owner: string; readonly repo: string } {
  const [owner, repo, ...extra] = repository.split('/');
  if (owner === undefined || repo === undefined || extra.length > 0)
    throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner, repo };
}
