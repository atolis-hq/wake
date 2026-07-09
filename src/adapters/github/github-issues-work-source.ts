import type { EventEnvelope, IssueStateRecord, WakeConfig } from '../../domain/types.js';
import { wakeStageLabelPrefix } from '../../domain/stages.js';
import { createEventEnvelope } from '../../lib/event-log.js';
import { buildResumeCommandForCli } from '../runner/runner-cli-adapter.js';

const wakeStatusLabelPrefix = 'wake:status.';

type GitHubIssue = {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels?: Array<string | { name?: string }>;
  assignees?: Array<{ login?: string }> | null;
};

type GitHubComment = {
  id: number;
  body?: string;
  user?: { login?: string; type?: string } | null;
  created_at: string;
  updated_at: string;
  html_url?: string;
};

function normalizeTicketUpsert(input: {
  repo: string;
  issue: GitHubIssue;
  ingestedAt: string;
  expectedEcho?: boolean;
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
    trigger: input.expectedEcho === true ? 'context-only' : 'immediate',
    payload: {
      ticket: {
        repo: input.repo,
        number: input.issue.number,
        title: input.issue.title,
        body: input.issue.body ?? '',
        labels: (input.issue.labels ?? [])
          .map((label) => (typeof label === 'string' ? label : label.name))
          .filter((label): label is string => typeof label === 'string'),
        assignees: (input.issue.assignees ?? [])
          .map((assignee) => assignee.login)
          .filter((login): login is string => typeof login === 'string'),
        state: input.issue.state === 'closed' ? 'closed' : 'open',
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
    ...(input.expectedEcho === true
      ? { derivedHints: { expectedEcho: true } }
      : {}),
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
        body: input.comment.body ?? '',
        author: {
          login: input.comment.user?.login ?? 'unknown',
        },
        createdAt: input.comment.created_at,
        updatedAt: input.comment.updated_at,
      },
      providerEventType: isUpdate
        ? 'github.issue.comment.updated'
        : 'github.issue.comment.created',
    },
    derivedHints: {
      // Third-party bots/integrations (CI, Dependabot, Renovate, etc.) must
      // not be able to unblock a blocked issue; only an actual human reply should.
      botAuthoredComment: input.comment.user?.type === 'Bot',
    },
  });
}

function normalizeLabels(labels: string[]): string[] {
  return [...labels].sort();
}

function labelsMatch(left: string[], right: string[]): boolean {
  const normalizedLeft = normalizeLabels(left);
  const normalizedRight = normalizeLabels(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((label, index) => label === normalizedRight[index])
  );
}

function issueLabels(issue: GitHubIssue): string[] {
  return (issue.labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((label): label is string => typeof label === 'string');
}

function issueAssignees(issue: GitHubIssue): string[] {
  return (issue.assignees ?? [])
    .map((assignee) => assignee.login)
    .filter((login): login is string => typeof login === 'string');
}

function isExpectedLabelEcho(issue: GitHubIssue, local: IssueStateRecord | null): boolean {
  if (local === null || local.wake.expectedEcho.labels.length === 0) {
    return false;
  }

  return (
    issue.title === local.issue.title &&
    (issue.body ?? '') === local.issue.body &&
    (issue.state === 'closed' ? 'closed' : 'open') === local.issue.state &&
    issue.html_url === local.issue.url &&
    labelsMatch(issueAssignees(issue), local.issue.assignees) &&
    labelsMatch(issueLabels(issue), local.wake.expectedEcho.labels)
  );
}

function extractCreatedCommentId(response: unknown): string | undefined {
  if (response === null || typeof response !== 'object') {
    return undefined;
  }

  const directId = (response as { id?: unknown }).id;
  if (typeof directId === 'number' || typeof directId === 'string') {
    return String(directId);
  }

  const data = (response as { data?: unknown }).data;
  if (data !== null && typeof data === 'object') {
    const dataId = (data as { id?: unknown }).id;
    if (typeof dataId === 'number' || typeof dataId === 'string') {
      return String(dataId);
    }
  }

  return undefined;
}

function formatWakeComment(payload: Record<string, unknown>): string {
  const body = typeof payload.body === 'string' ? payload.body : '';
  const kind = typeof payload.kind === 'string' ? payload.kind : undefined;
  const action = typeof payload.action === 'string' ? payload.action : undefined;
  const runId = typeof payload.runId === 'string' ? payload.runId : undefined;
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  const model = typeof payload.model === 'string' ? payload.model : undefined;
  const cli = typeof payload.cli === 'string' ? payload.cli : undefined;
  const runnerName = typeof payload.runnerName === 'string' ? payload.runnerName : undefined;
  const runnerTier = typeof payload.runnerTier === 'string' ? payload.runnerTier : undefined;
  const duration = typeof payload.duration === 'string' ? payload.duration : undefined;
  const tokens = typeof payload.tokens === 'string' ? payload.tokens : undefined;
  const workspacePath =
    typeof payload.workspacePath === 'string' ? payload.workspacePath : undefined;

  const details = [
    action === undefined ? undefined : `stage \`${action}\``,
    runnerName === undefined ? undefined : `runner \`${runnerName}\``,
    runnerTier === undefined ? undefined : `tier \`${runnerTier}\``,
    cli === undefined ? undefined : `cli ${cli}`,
    model === undefined ? undefined : `model \`${model}\``,
    duration === undefined ? undefined : `duration ${duration}`,
    tokens === undefined ? undefined : `tokens ${tokens}`,
    runId === undefined ? undefined : `run \`${runId}\``,
  ].filter((part): part is string => part !== undefined);

  const header = `**Eddy** _(Wake${details.length > 0 ? ` · ${details.join(' · ')}` : ''})_`;
  const sections = [header, body];

  if (kind === 'approval-request') {
    sections.push('_To approve this work, reply with `/approved`. To request changes, reply with your feedback._');
  }

  if (sessionId !== undefined) {
    const resumeCommandArgs =
      cli === undefined
        ? null
        : buildResumeCommandForCli({
            cli,
            sessionId,
          });
    const resumeCommandText =
      cli === undefined
        ? `<resume command unavailable: missing runner identity for session ${sessionId}>`
        : resumeCommandArgs === null
        ? `<resume command unavailable: unsupported runner identity for session ${sessionId}>`
        : resumeCommandArgs.join(' ');
    const resumeCommand =
      workspacePath === undefined
        ? resumeCommandText
        : `cd "${workspacePath}"\n${resumeCommandText}`;

    sections.push(
      [
        '---',
        '_Next steps: reply on this thread to continue, or resume this exact Eddy session locally:_',
        '```',
        resumeCommand,
        '```',
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
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
    setLabels: (
      owner: string,
      repo: string,
      issueNumber: number,
      labels: string[],
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
            events.push(normalizeTicketUpsert({
              repo: repoRef,
              issue,
              ingestedAt,
              expectedEcho: isExpectedLabelEcho(issue, local ?? null),
            }));
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

            if (local?.wake.expectedEcho.commentIds.includes(String(comment.id)) === true) {
              continue;
            }

            events.push(normalizeTicketCommentEvent({
              repo: repoRef,
              issueNumber: issue.number,
              comment,
              ingestedAt,
              ...(known?.updatedAt === undefined
                ? {}
                : { existingUpdatedAt: known.updatedAt }),
            }));
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

      const publishedAt = deps.now().toISOString();
      if (input.event.sourceEventType === 'wake.labels.requested') {
        const projection = await deps.stateStore.readIssueState(repo, issueNumber);
        const currentLabels = projection?.issue.labels ?? [];
        const nextStatusLabel =
          typeof input.event.payload.statusLabel === 'string'
            ? input.event.payload.statusLabel
            : undefined;
        const nextStageLabel =
          typeof input.event.payload.stageLabel === 'string'
            ? input.event.payload.stageLabel
            : undefined;

        const nextLabels = [
          ...currentLabels.filter(
            (label) =>
              !label.startsWith(wakeStatusLabelPrefix) &&
              !label.startsWith(wakeStageLabelPrefix),
          ),
          ...(nextStatusLabel !== undefined
            ? [nextStatusLabel]
            : currentLabels.filter((label) => label.startsWith(wakeStatusLabelPrefix))),
          ...(nextStageLabel !== undefined
            ? [nextStageLabel]
            : currentLabels.filter((label) => label.startsWith(wakeStageLabelPrefix))),
        ];

        const labelsChanged =
          nextLabels.length !== currentLabels.length ||
          !nextLabels.every((label, index) => label === currentLabels[index]);

        if (labelsChanged) {
          await deps.client.setLabels(owner, repoName, issueNumber, nextLabels);

          return [
            createEventEnvelope({
              eventId: `${input.event.eventId}-labels-updated`,
              workItemKey: input.event.workItemKey,
              streamScope: 'work-item',
              direction: 'outbound',
              sourceSystem: 'github',
              sourceEventType: 'ticket.labels.updated',
              sourceRefs: {
                repo,
                issueNumber,
              },
              occurredAt: publishedAt,
              ingestedAt: publishedAt,
              trigger: 'context-only',
              payload: {
                intentEventId: input.event.eventId,
                ...(nextStatusLabel !== undefined ? { statusLabel: nextStatusLabel } : {}),
                ...(nextStageLabel !== undefined ? { stageLabel: nextStageLabel } : {}),
                labels: nextLabels,
                providerEventType: 'github.issue.labels.updated',
              },
            }),
          ];
        }

        return [];
      }

      const response = await deps.client.createComment(
        owner,
        repoName,
        issueNumber,
        formatWakeComment(input.event.payload),
      );
      const commentId = extractCreatedCommentId(response);

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
            ...(commentId === undefined ? {} : { commentId }),
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
