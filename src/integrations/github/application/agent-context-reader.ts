import {
  PullRequestCheckState,
  type AgentContextComment,
  type AgentContextPullRequest,
  type AgentContextReader,
} from '../../../activities/index.js';
import type { EventJournal } from '../../../kernel/index.js';
import type { ConversationService } from '../../../conversations/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationRole,
  type ResourceService,
} from '../../../resources/index.js';
import type { WorkItemId } from '../../../work/index.js';
import { adapterId } from '../../contracts/identifiers.js';
import { integrationStream } from '../../contracts/streams.js';
import { boundedDiagnosticEvidence } from '../contracts/check-evidence.js';
import { GitHubEventType, selectGitHubAdapterEvent } from '../contracts/events.js';
import {
  createCommentHistoryReader,
  type CommentHistoryReaderOptions,
} from './comment-history-reader.js';

export function createGitHubAgentContextReader(
  journal: EventJournal,
  resources: Pick<ResourceService, 'correlationsForWork' | 'get'>,
  options: CommentHistoryReaderOptions = {},
  conversations?: Pick<ConversationService, 'forWorkItem'>,
): AgentContextReader {
  const commentHistory = createCommentHistoryReader(journal, resources, options);
  return {
    async forWorkItem(workItemId, options) {
      const { comments, omittedComments } = boundedAgentContextComments(
        await commentsForWorkItem(commentHistory, conversations, workItemId as WorkItemId, options),
      );
      return {
        ...(await currentWorkItemContent(journal, resources, workItemId as WorkItemId)),
        comments,
        ...(omittedComments > 0 ? { omittedComments } : {}),
        ...pullRequestContextField(
          await currentPullRequestContext(journal, resources, workItemId as WorkItemId),
        ),
      };
    },
  };
}

async function commentsForWorkItem(
  commentHistory: ReturnType<typeof createCommentHistoryReader>,
  conversations: Pick<ConversationService, 'forWorkItem'> | undefined,
  workItemId: WorkItemId,
  options: Parameters<ReturnType<typeof createCommentHistoryReader>['forWorkItem']>[1],
): Promise<readonly AgentContextComment[]> {
  const conversation = await conversations?.forWorkItem(workItemId);
  if (conversation === null || conversation === undefined)
    return commentHistory.forWorkItem(workItemId, options);
  return conversation.entries.map((entry) => ({
    author: entry.origin.actorId,
    occurredAt: entry.occurredAt,
    body: entry.body,
  }));
}

const maximumAgentContextCommentCharacters = 8_000;
const maximumAgentContextCharacters = 200_000;
const truncationNotice = '\n[Wake truncated this historical comment for context bounds.]';

function boundedAgentContextComments(comments: readonly AgentContextComment[]): {
  readonly comments: readonly AgentContextComment[];
  readonly omittedComments: number;
} {
  const retainedNewestFirst: AgentContextComment[] = [];
  let characters = 0;
  for (const comment of [...comments].reverse()) {
    const remaining = maximumAgentContextCharacters - characters;
    if (remaining <= 0) break;
    const body = truncateComment(
      comment.body,
      Math.min(maximumAgentContextCommentCharacters, remaining),
    );
    retainedNewestFirst.push({ ...comment, body });
    characters += body.length;
  }
  return {
    comments: retainedNewestFirst.reverse(),
    omittedComments: comments.length - retainedNewestFirst.length,
  };
}

function truncateComment(body: string, maximumCharacters: number): string {
  if (body.length <= maximumCharacters) return body;
  if (maximumCharacters <= truncationNotice.length) return body.slice(0, maximumCharacters);
  return `${body.slice(0, maximumCharacters - truncationNotice.length)}${truncationNotice}`;
}

async function currentWorkItemContent(
  journal: EventJournal,
  resources: Pick<ResourceService, 'correlationsForWork' | 'get'>,
  workItemId: WorkItemId,
): Promise<{ readonly title: string; readonly body: string }> {
  const primary = (await resources.correlationsForWork(workItemId)).find(
    (correlation) => correlation.role === ResourceCorrelationRole.Primary,
  );
  if (primary === undefined) return emptyWorkItemContent;

  const resource = await resources.get(primary.resourceId);
  if (resource === null) return emptyWorkItemContent;
  const adapter = parseAdapterId(resource.externalKey.adapter);
  if (adapter === null) return emptyWorkItemContent;

  return latestWorkObservedContent(
    await journal.readStream(integrationStream(adapter)),
    adapter,
    resource.externalKey.key,
  );
}

const emptyWorkItemContent = { title: '', body: '' } as const;

async function currentPullRequestContext(
  journal: EventJournal,
  resources: Pick<ResourceService, 'correlationsForWork' | 'get'>,
  workItemId: WorkItemId,
): Promise<AgentContextPullRequest | undefined> {
  let current: { readonly context: AgentContextPullRequest; readonly position: number } | undefined;
  for (const correlation of await resources.correlationsForWork(workItemId)) {
    const resource = await resources.get(correlation.resourceId);
    if (resource?.kind !== BuiltInResourceKind.PullRequest) continue;
    const adapter = parseAdapterId(resource.externalKey.adapter);
    if (adapter === null) continue;
    for (const event of await journal.readStream(integrationStream(adapter))) {
      const observed = selectGitHubAdapterEvent(event);
      if (!isCurrentPullRequestObservedEvent(observed, adapter, resource.externalKey.key)) continue;
      if (current === undefined || event.globalPosition > current.position)
        current = { context: pullRequestContext(observed.payload), position: event.globalPosition };
    }
  }
  return current?.context;
}

function pullRequestContext(payload: WorkObservedEvent['payload']): AgentContextPullRequest {
  return {
    checks: payload.checks ?? PullRequestCheckState.Unknown,
    checkRuns: rawEvidenceList(payload.raw.checkRuns),
    statuses: rawEvidenceList(payload.raw.statuses),
  };
}

function rawEvidenceList(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? boundedDiagnosticEvidence(value) : [];
}

function pullRequestContextField(context: AgentContextPullRequest | undefined) {
  return context === undefined ? {} : { pullRequest: context };
}

function latestWorkObservedContent(
  events: Awaited<ReturnType<EventJournal['readStream']>>,
  adapter: ReturnType<typeof adapterId>,
  externalKey: string,
): { readonly title: string; readonly body: string } {
  let current: { readonly title: string; readonly body: string } | undefined;
  for (const event of events) {
    const observed = selectGitHubAdapterEvent(event);
    if (!isCurrentWorkObservedEvent(observed, adapter, externalKey)) continue;
    current = observed.payload;
  }
  return current ?? emptyWorkItemContent;
}

function isCurrentWorkObservedEvent(
  observed: ReturnType<typeof selectGitHubAdapterEvent>,
  adapter: ReturnType<typeof adapterId>,
  externalKey: string,
): observed is WorkObservedEvent {
  return (
    observed?.eventType === GitHubEventType.WorkObserved &&
    observed.stream.id === adapter &&
    observed.source.id === adapter &&
    observed.payload.externalKey === externalKey
  );
}

function isCurrentPullRequestObservedEvent(
  observed: ReturnType<typeof selectGitHubAdapterEvent>,
  adapter: ReturnType<typeof adapterId>,
  externalKey: string,
): observed is WorkObservedEvent {
  return (
    isCurrentWorkObservedEvent(observed, adapter, externalKey) &&
    observed.payload.kind === 'pull-request'
  );
}

type WorkObservedEvent = Extract<
  NonNullable<ReturnType<typeof selectGitHubAdapterEvent>>,
  { readonly eventType: typeof GitHubEventType.WorkObserved }
>;

function parseAdapterId(value: string) {
  try {
    return adapterId(value);
  } catch {
    return null;
  }
}
