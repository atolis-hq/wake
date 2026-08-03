import { ReviewActorKind } from '../../../activities/index.js';
import { createEventDraft, EventActorKind, EventSourceKind } from '../../../kernel/index.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import { integrationStream } from '../../contracts/streams.js';
import { GitHubEventType, type GitHubAdapterEventDraft } from '../contracts/events.js';
import { formatGitHubResourceKey } from '../contracts/external-key.js';
import {
  gitHubAssigneeLogins,
  gitHubLabelNames,
  type GitHubIssueCommentPayload,
  type GitHubIssuePayload,
} from '../contracts/payloads.js';
import { GitHubAdapter, UnknownGitHubIdentity } from '../contracts/vocabulary.js';

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
      labels: gitHubLabelNames(input.issue),
      assignees: gitHubAssigneeLogins(input.issue),
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

export function issueCommentObservation(input: {
  readonly repository: string;
  readonly issue: Pick<GitHubIssuePayload, 'number'>;
  readonly comment: GitHubIssueCommentPayload;
  readonly adapter?: AdapterId;
}): Extract<GitHubAdapterEventDraft, { eventType: typeof GitHubEventType.CommentObserved }> | null {
  if (input.comment.body?.trim().toLowerCase() !== '/approved') return null;
  const key = formatGitHubResourceKey({ ...parseRepository(input.repository), number: input.issue.number });
  return createEventDraft({
    eventId: `github:issue-comment:${key}:${input.comment.id}:${input.comment.updated_at}`,
    eventType: GitHubEventType.CommentObserved,
    occurredAt: input.comment.updated_at,
    correlationId: `github:${key}`,
    causationId: `github:issue-comment:${input.comment.id}`,
    actor: { kind: EventActorKind.Integration, id: 'github' },
    source: { kind: EventSourceKind.Adapter, id: input.adapter ?? GitHubAdapter },
    stream: integrationStream(input.adapter ?? GitHubAdapter),
    payload: {
      reviewKind: 'issue',
      externalKey: key,
      body: '/approved',
      revision: input.comment.updated_at,
      actor: {
        id: input.comment.user?.login ?? UnknownGitHubIdentity,
        kind: input.comment.user?.type === 'Bot' ? ReviewActorKind.Bot : ReviewActorKind.Human,
      },
      raw: { id: input.comment.id },
    },
  });
}