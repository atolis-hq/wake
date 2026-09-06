import { EventActorKind, EventSourceKind } from '@atolis-hq/eventing';
import {
  PullRequestState,
  ReviewActorKind,
  type ReviewerAuthorizationEvidence,
} from '../../../activities/index.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import { ExternalWorkOutcome } from '../../contracts/outcome-vocabulary.js';
import { createGitHubEventData } from '../contracts/event-factory.js';
import { GitHubEventType, type GitHubAdapterEventData } from '../contracts/events.js';
import { formatGitHubResourceKey } from '../contracts/external-key.js';
import {
  gitHubAssigneeLogins,
  gitHubLabelNames,
  type GitHubIssueCommentPayload,
  type GitHubIssuePayload,
} from '../contracts/payloads.js';
import { GitHubAdapter, UnknownGitHubIdentity } from '../contracts/vocabulary.js';
import { gitHubContentFingerprint, withoutWakeMarkers } from './content-fingerprint.js';

export function issueObservation(input: {
  readonly repository: string;
  readonly issue: GitHubIssuePayload;
  readonly adapter?: AdapterId;
}): Extract<GitHubAdapterEventData, { eventType: typeof GitHubEventType.WorkObserved }> {
  const key = formatGitHubResourceKey({
    ...parseRepository(input.repository),
    number: input.issue.number,
  });
  const actor = {
    id: input.issue.user?.login ?? UnknownGitHubIdentity,
    kind: input.issue.user?.type === 'Bot' ? ReviewActorKind.Bot : ReviewActorKind.Human,
  };
  const labels = gitHubLabelNames(input.issue);
  const assignees = gitHubAssigneeLogins(input.issue);
  const outcome = issueOutcome(input.issue);
  // Wake's own status/stage/workflow labels are excluded here so republishing them
  // never looks like an external change and re-triggers discovery.
  const fingerprint = gitHubContentFingerprint({
    title: input.issue.title,
    body: input.issue.body ?? '',
    state: input.issue.state,
    outcome,
    actor,
    labels: withoutWakeMarkers(labels),
    assignees: [...assignees].sort(),
  });
  const event = createGitHubEventData({
    eventId: `github:issue:${key}:${fingerprint}`,
    eventType: GitHubEventType.WorkObserved,
    occurredAt: input.issue.updated_at,
    correlationId: `github:${key}`,
    causationId: `github:${key}:${fingerprint}`,
    actor: { kind: EventActorKind.Integration, id: 'github' },
    source: { kind: EventSourceKind.Adapter, id: input.adapter ?? GitHubAdapter },
    payload: {
      externalKey: key,
      kind: 'issue',
      title: input.issue.title,
      body: input.issue.body ?? '',
      state: input.issue.state,
      outcome,
      revision: fingerprint,
      actor,
      labels,
      assignees,
      raw: { number: input.issue.number },
    },
  });
  if (event.eventType !== GitHubEventType.WorkObserved)
    throw new Error(`Expected GitHub WorkObserved event data, received ${event.eventType}`);
  return event;
}

function issueOutcome(issue: GitHubIssuePayload): ExternalWorkOutcome | undefined {
  if (issue.state !== PullRequestState.Closed) return undefined;
  return issue.state_reason === 'not_planned'
    ? ExternalWorkOutcome.Cancelled
    : ExternalWorkOutcome.Completed;
}

function parseRepository(repository: string): { readonly owner: string; readonly repo: string } {
  const [owner, repo, ...extra] = repository.split('/');
  if (owner === undefined || repo === undefined || extra.length > 0)
    throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner, repo };
}

// eslint-disable-next-line complexity -- provider payload normalization keeps one canonical envelope.
export function issueCommentObservation(input: {
  readonly repository: string;
  readonly issue: Pick<GitHubIssuePayload, 'number' | 'user'>;
  readonly comment: GitHubIssueCommentPayload;
  readonly authorization?: ReviewerAuthorizationEvidence;
  readonly adapter?: AdapterId;
}): Extract<GitHubAdapterEventData, { eventType: typeof GitHubEventType.CommentObserved }> | null {
  const body = input.comment.body?.trim();
  if (body === undefined || body.length === 0) return null;
  const key = formatGitHubResourceKey({
    ...parseRepository(input.repository),
    number: input.issue.number,
  });
  const location = commentLocation(input.comment);
  const event = createGitHubEventData({
    eventId: `github:issue-comment:${key}:${input.comment.id}:${input.comment.updated_at}`,
    eventType: GitHubEventType.CommentObserved,
    occurredAt: input.comment.updated_at,
    correlationId: `github:${key}`,
    causationId: `github:issue-comment:${input.comment.id}`,
    actor: { kind: EventActorKind.Integration, id: 'github' },
    source: { kind: EventSourceKind.Adapter, id: input.adapter ?? GitHubAdapter },
    payload: {
      reviewKind: 'issue',
      externalKey: key,
      body,
      revision: input.comment.updated_at,
      ...(location === undefined ? {} : { location }),
      actor: {
        id: input.comment.user?.login ?? UnknownGitHubIdentity,
        kind: input.comment.user?.type === 'Bot' ? ReviewActorKind.Bot : ReviewActorKind.Human,
      },
      resourceAuthorId: input.issue.user?.login ?? UnknownGitHubIdentity,
      ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
      raw: { id: input.comment.id },
    },
  });
  if (event.eventType !== GitHubEventType.CommentObserved)
    throw new Error(`Expected GitHub CommentObserved event data, received ${event.eventType}`);
  return event;
}

function commentLocation(comment: GitHubIssueCommentPayload) {
  if (
    comment.path === undefined ||
    comment.line === undefined ||
    comment.line === null ||
    comment.side === undefined
  )
    return undefined;
  return { path: comment.path, line: comment.line, side: comment.side };
}
