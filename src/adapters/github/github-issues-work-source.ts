import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ResourceIndex, UnkeyedEventEnvelope } from '../../core/contracts.js';
import { defaultAgentIdentity } from '../../domain/schema.js';
import { buildResourceUri } from '../../domain/resource-uri.js';
import { wakeStageLabelPrefix } from '../../domain/stages.js';
import type { EventEnvelope, IssueStateRecord, WakeConfig } from '../../domain/types.js';
import { createEventEnvelope, createUnkeyedEventEnvelope } from '../../lib/event-log.js';
import { wakeVersion } from '../../version.js';
import { buildResumeCommandForCli } from '../runner/runner-cli-adapter.js';

const wakeStatusLabelPrefix = 'wake:status.';
const pollOverlapMs = 60 * 60 * 1000;

// Hidden marker appended to every comment Wake posts. `expectedEcho` normally
// suppresses Wake's own comments from re-entering the projection, but if Wake
// crashes after posting and before the reply-published event is processed,
// expectedEcho is never updated — on restart the comment would otherwise be
// polled back in as a new human comment. The marker is a second, independent
// signal so bot-authored detection doesn't depend on account type or
// expectedEcho bookkeeping surviving a crash (#145).
const wakeCommentMarker = '<!-- wake:agent -->';
const githubSource = 'github';

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
  pull_request?: Record<string, unknown>;
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
}): UnkeyedEventEnvelope {
  // Names the resource, never the work item — the resolver stamps the
  // canonical workItemKey after the poll (spec D1).
  return createUnkeyedEventEnvelope({
    eventId: `github-issue-${input.repo}-${input.issue.number}-${input.issue.updated_at}`,
    streamScope: 'global-intake',
    direction: 'inbound',
    sourceSystem: 'github',
    sourceEventType: 'ticket.upsert',
    sourceRefs: {
      repo: input.repo,
      issueNumber: input.issue.number,
      sourceUrl: input.issue.html_url,
      resourceUri: buildResourceUri(githubSource, 'issue', `${input.repo}#${input.issue.number}`),
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
        isPullRequest: input.issue.pull_request !== undefined,
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
}): UnkeyedEventEnvelope {
  const isUpdate =
    input.existingUpdatedAt !== undefined &&
    input.existingUpdatedAt !== input.comment.updated_at;

  return createUnkeyedEventEnvelope({
    eventId: `github-comment-${input.repo}-${input.issueNumber}-${input.comment.id}-${input.comment.updated_at}`,
    streamScope: 'work-item',
    direction: 'inbound',
    sourceSystem: 'github',
    sourceEventType: isUpdate ? 'ticket.comment.updated' : 'ticket.comment.created',
    sourceRefs: {
      repo: input.repo,
      issueNumber: input.issueNumber,
      commentId: String(input.comment.id),
      sourceUrl: input.comment.html_url,
      // The comment belongs to the issue's work item; the issue is the
      // resource the resolver knows it by.
      resourceUri: buildResourceUri(githubSource, 'issue', `${input.repo}#${input.issueNumber}`),
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
      // The marker check catches Wake's own comments even when expectedEcho
      // missed them (crash-recovery gap) or the agent account type is 'User'.
      botAuthoredComment:
        input.comment.user?.type === 'Bot' ||
        (input.comment.body ?? '').includes(wakeCommentMarker),
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

function formatControlPlaneLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function readControlPlaneUiUrl(wakeRoot: string): Promise<string | undefined> {
  try {
    const raw = await readFile(resolve(wakeRoot, 'control-plane-ui-url'), 'utf8');
    return formatControlPlaneLink(raw.trim()) ?? undefined;
  } catch {
    return undefined;
  }
}

function formatWakeComment(payload: Record<string, unknown>, controlPlaneUrl?: string): string {
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
  const cost = typeof payload.cost === 'string' ? payload.cost : undefined;
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
    cost === undefined ? undefined : `cost ${cost}`,
    runId === undefined ? undefined : `run \`${runId}\``,
  ].filter((part): part is string => part !== undefined);

  const name = controlPlaneUrl === undefined ? defaultAgentIdentity : `[${defaultAgentIdentity}](${controlPlaneUrl})`;
  const header = `**${name}** _(Wake ${wakeVersion}${details.length > 0 ? ` · ${details.join(' · ')}` : ''})_`;
  const sections = [wakeCommentMarker, header, body];

  if (kind === 'approval-request') {
    sections.push('_To approve this work, reply with `/approved`. To request changes, reply with `/changes` followed by your feedback. To ask a question without requesting changes, reply with `/question` followed by your question._');
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
        `_Next steps: reply on this thread to continue, or resume this exact ${defaultAgentIdentity} session locally:_`,
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
    listIssues: (
      owner: string,
      repo: string,
      perPage: number,
      since?: string,
    ) => Promise<GitHubIssue[]>;
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
  // Read-only resolution of uris this source constructs itself, for poll dedup
  // and echo suppression. This is NOT self-keying (spec D1): pollEvents still
  // returns UnkeyedEventEnvelope[] and the central resolver in tick-runner is
  // still the only thing that stamps workItemKey. Required, never defaulted —
  // a forgotten index must fail loudly, not silently degrade to a scan.
  resourceIndex: ResourceIndex;
  now: () => Date;
}) {
  /** O(1): one shard read, then a direct projection read by work id. */
  async function readProjectionForIssue(
    repo: string,
    issueNumber: number,
  ): Promise<IssueStateRecord | null> {
    const uri = buildResourceUri(githubSource, 'issue', `${repo}#${issueNumber}`);
    const workItemKey = await deps.resourceIndex.resolve(uri);
    if (workItemKey === undefined) {
      return null;
    }
    return deps.stateStore.readIssueState(workItemKey);
  }

  return {
    async pollEvents(): Promise<UnkeyedEventEnvelope[]> {
      const ingestedAt = deps.now().toISOString();
      const events: UnkeyedEventEnvelope[] = [];

      for (const repoRef of deps.config.sources.github.repos) {
        const [owner, repo] = repoRef.split('/');
        if (owner === undefined || repo === undefined) {
          continue;
        }

        // One repo's failure (deleted repo, revoked access, transient API
        // error) must not stop polling for every other configured repo (E3).
        // Skipping `writeSourceState` below on failure means the `since`
        // cursor doesn't advance, so the next tick retries this repo from the
        // same point instead of silently losing the gap.
        try {
          const previousPoll = await deps.stateStore.readSourceState('github', repoRef);
          const since = previousPoll === null
            ? undefined
            : new Date(Date.parse(previousPoll.lastSuccessfulPollAt) - pollOverlapMs).toISOString();
          const issues = since === undefined
            ? await deps.client.listIssues(
                owner,
                repo,
                deps.config.sources.github.polling.maxIssuesPerRepo,
              )
            : await deps.client.listIssues(
                owner,
                repo,
                deps.config.sources.github.polling.maxIssuesPerRepo,
                since,
              );

          for (const issue of issues) {
            // Poll dedup + echo suppression only, never identity: the uri is
            // constructed (never parsed) and resolved through the index, which
            // keeps a poll flat in the number of work items rather than
            // O(issues x projections) (spec D2).
            const local = await readProjectionForIssue(repoRef, issue.number);

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
        } catch (error) {
          console.error(
            `[github-work-source] poll failed for ${repoRef}, skipping this tick: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      return events;
    },
    async deliverIntent(input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
      const repo = input.event.sourceRefs.repo;
      const issueNumber = input.event.sourceRefs.issueNumber;

      if (repo === undefined || issueNumber === undefined) {
        throw new Error(
          `cannot deliver intent ${input.event.eventId}: missing sourceRefs.repo/issueNumber`,
        );
      }

      const [owner, repoName] = repo.split('/');
      if (owner === undefined || repoName === undefined) {
        throw new Error(`cannot deliver intent ${input.event.eventId}: malformed repo "${repo}"`);
      }

      const publishedAt = deps.now().toISOString();
      if (input.event.sourceEventType === 'wake.labels.requested') {
        // Outbound intents are keyed envelopes Wake itself minted, so the work
        // item is already named on the event — a direct read, not a lookup.
        const projection = await deps.stateStore.readIssueState(input.event.workItemKey);
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
        formatWakeComment(input.event.payload, await readControlPlaneUiUrl(deps.config.paths.wakeRoot)),
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
