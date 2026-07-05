import { isWakeAuthoredComment } from '../../domain/schema.js';
import type { EventEnvelope, WakeConfig } from '../../domain/types.js';
import { createEventEnvelope } from '../../lib/event-log.js';

type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name?: string }>;
  assignees: Array<{ login: string }>;
};

type GitHubComment = {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url?: string;
};

function normalizeTicketUpsert(input: {
  repo: string;
  issue: GitHubIssue;
  ingestedAt: string;
}): EventEnvelope {
  return createEventEnvelope({
    eventId: `github-issue-${input.repo}-${input.issue.number}-${input.issue.updated_at}`,
    workItemKey: `${input.repo}#${input.issue.number}`,
    streamScope: 'global-intake',
    direction: 'inbound',
    sourceSystem: 'github',
    sourceEventType: 'ticket.upsert',
    sourceRefs: {
      repo: input.repo,
      issueNumber: input.issue.number,
      sourceUrl: input.issue.html_url,
    },
    occurredAt: input.issue.updated_at,
    ingestedAt: input.ingestedAt,
    trigger: 'immediate',
    payload: {
      ticket: {
        repo: input.repo,
        number: input.issue.number,
        title: input.issue.title,
        body: input.issue.body ?? '',
        labels: input.issue.labels
          .map((label) => label.name)
          .filter((label): label is string => typeof label === 'string'),
        assignees: input.issue.assignees.map((assignee) => assignee.login),
        state: input.issue.state,
        url: input.issue.html_url,
        createdAt: input.issue.created_at,
        updatedAt: input.issue.updated_at,
      },
      providerEventType: 'github.issue.upsert',
    },
    raw: {
      github: {
        issueUpdatedAt: input.issue.updated_at,
      },
    },
  });
}

function normalizeTicketCommentEvent(input: {
  repo: string;
  issueNumber: number;
  comment: GitHubComment;
  ingestedAt: string;
  existingUpdatedAt?: string;
}): EventEnvelope {
  const isUpdate =
    input.existingUpdatedAt !== undefined &&
    input.existingUpdatedAt !== input.comment.updated_at;

  return createEventEnvelope({
    eventId: `github-comment-${input.repo}-${input.issueNumber}-${input.comment.id}-${input.comment.updated_at}`,
    workItemKey: `${input.repo}#${input.issueNumber}`,
    streamScope: 'work-item',
    direction: 'inbound',
    sourceSystem: 'github',
    sourceEventType: isUpdate ? 'ticket.comment.updated' : 'ticket.comment.created',
    sourceRefs: {
      repo: input.repo,
      issueNumber: input.issueNumber,
      commentId: String(input.comment.id),
      sourceUrl: input.comment.html_url,
    },
    occurredAt: input.comment.updated_at,
    ingestedAt: input.ingestedAt,
    trigger: 'context-only',
    payload: {
      comment: {
        id: String(input.comment.id),
        body: input.comment.body,
        author: {
          login: input.comment.user.login,
        },
        createdAt: input.comment.created_at,
        updatedAt: input.comment.updated_at,
      },
      providerEventType: isUpdate
        ? 'github.issue.comment.updated'
        : 'github.issue.comment.created',
    },
    derivedHints: {
      wakeAuthoredComment: isWakeAuthoredComment(input.comment.body),
    },
  });
}

export function createGitHubIssuesWorkSource(deps: {
  client: {
    listIssues: (owner: string, repo: string, perPage: number) => Promise<GitHubIssue[]>;
    listComments: (
      owner: string,
      repo: string,
      issueNumber: number,
      perPage: number,
    ) => Promise<GitHubComment[]>;
    createComment: (
      owner: string,
      repo: string,
      issueNumber: number,
      body: string,
    ) => Promise<unknown>;
  };
  stateStore: ReturnType<typeof import('../fs/state-store.js').createStateStore>;
  config: WakeConfig;
  now: () => Date;
}) {
  return {
    async pollEvents(): Promise<EventEnvelope[]> {
      const ingestedAt = deps.now().toISOString();
      const events: EventEnvelope[] = [];

      for (const repoRef of deps.config.sources.github.repos) {
        const [owner, repo] = repoRef.split('/');
        if (owner === undefined || repo === undefined) {
          continue;
        }

        const issues = await deps.client.listIssues(
          owner,
          repo,
          deps.config.sources.github.polling.maxIssuesPerRepo,
        );

        for (const issue of issues) {
          const local = await deps.stateStore.readIssueState(repoRef, issue.number);

          if (local?.issue.updatedAt !== issue.updated_at) {
            events.push(normalizeTicketUpsert({ repo: repoRef, issue, ingestedAt }));
          }

          const comments = await deps.client.listComments(
            owner,
            repo,
            issue.number,
            deps.config.sources.github.polling.commentPageSize,
          );

          for (const comment of comments) {
            const known = local?.comments.find(
              (entry) => entry.id === String(comment.id),
            );

            if (known?.updatedAt === comment.updated_at) {
              continue;
            }

            events.push(
              normalizeTicketCommentEvent({
                repo: repoRef,
                issueNumber: issue.number,
                comment,
                ingestedAt,
                existingUpdatedAt: known?.updatedAt,
              }),
            );
          }
        }

        await deps.stateStore.writeSourceState({
          schemaVersion: 1,
          source: 'github',
          key: repoRef,
          lastSuccessfulPollAt: ingestedAt,
        });
      }

      return events;
    },
    async deliverIntent(input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
      const repo = input.event.sourceRefs.repo;
      const issueNumber = input.event.sourceRefs.issueNumber;

      if (repo === undefined || issueNumber === undefined) {
        return [];
      }

      const [owner, repoName] = repo.split('/');
      if (owner === undefined || repoName === undefined) {
        return [];
      }

      await deps.client.createComment(
        owner,
        repoName,
        issueNumber,
        `${String(input.event.payload.body)}\n\n<!-- wake -->`,
      );

      const publishedAt = deps.now().toISOString();
      return [
        createEventEnvelope({
          eventId: `${input.event.eventId}-published`,
          workItemKey: input.event.workItemKey,
          streamScope: 'work-item',
          direction: 'outbound',
          sourceSystem: 'github',
          sourceEventType: 'ticket.reply.published',
          sourceRefs: {
            repo,
            issueNumber,
          },
          occurredAt: publishedAt,
          ingestedAt: publishedAt,
          trigger: 'context-only',
          payload: {
            intentEventId: input.event.eventId,
            kind: input.event.payload.kind,
            body: input.event.payload.body,
            providerEventType: 'github.issue.comment.published',
          },
        }),
      ];
    },
  };
}
