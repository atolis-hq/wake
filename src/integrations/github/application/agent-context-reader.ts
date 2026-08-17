import {
  PullRequestCheckState,
  type AgentContextComment,
  type AgentContextPullRequest,
  type AgentContextReader,
} from '../../../activities/index.js';
import type { EventJournal } from '../../../kernel/index.js';
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
): AgentContextReader {
  const commentHistory = createCommentHistoryReader(journal, resources, options);
  return {
    async forWorkItem(workItemId, options) {
      const comments = boundedAgentContextComments(
        await commentHistory.forWorkItem(workItemId as WorkItemId, options),
      );
      return {
        ...(await currentWorkItemContent(journal, resources, workItemId as WorkItemId)),
        comments,
        ...pullRequestContextField(
          await currentPullRequestContext(journal, resources, workItemId as WorkItemId),
        ),
      };
    },
  };
}

const maximumAgentContextComments = 12;
const maximumAgentContextCommentCharacters = 8_000;
const maximumAgentContextCharacters = 48_000;
const truncationNotice = '\n[Wake truncated this historical comment for context bounds.]';

function boundedAgentContextComments(
  comments: readonly AgentContextComment[],
): readonly AgentContextComment[] {
  const indexed = comments.map((comment, index) => ({ comment, index }));
  const latestWakeReviewerFeedback = [...indexed]
    .reverse()
    .find(({ comment }) => isWakeReviewerFeedback(comment));
  const latestWakeAgentArtifact = [...indexed]
    .reverse()
    .find(({ comment }) => isWakeAgentArtifact(comment));
  const protectedWakeArtifacts = [latestWakeReviewerFeedback, latestWakeAgentArtifact].flatMap(
    (candidate, index, values) =>
      candidate === undefined || values.slice(0, index).some((value) => value === candidate)
        ? []
        : [candidate],
  );
  const retained: { readonly comment: AgentContextComment; readonly index: number }[] = [];
  let characters = 0;
  for (const artifact of protectedWakeArtifacts) {
    const remaining = maximumAgentContextCharacters - characters;
    if (remaining <= 0) break;
    const body = truncateComment(
      artifact.comment.body,
      Math.min(maximumAgentContextCommentCharacters, remaining),
    );
    retained.push({ ...artifact, comment: { ...artifact.comment, body } });
    characters += body.length;
  }
  for (const candidate of [...indexed].reverse()) {
    const { comment } = candidate;
    if (
      (isWakeDelivery(comment.body) && !protectedWakeArtifacts.includes(candidate)) ||
      protectedWakeArtifacts.includes(candidate) ||
      retained.length === maximumAgentContextComments
    )
      continue;
    const remaining = maximumAgentContextCharacters - characters;
    if (remaining <= 0) break;
    const body = truncateComment(
      comment.body,
      Math.min(maximumAgentContextCommentCharacters, remaining),
    );
    retained.push({ ...candidate, comment: { ...comment, body } });
    characters += body.length;
  }
  return retained.sort((left, right) => left.index - right.index).map(({ comment }) => comment);
}

function isWakeDelivery(body: string): boolean {
  return /<!--\s*wake:delivery:[^\s>]+\s*-->/.test(body);
}

function isWakeReviewerFeedback(comment: AgentContextComment): boolean {
  return (
    comment.body.includes('<!-- wake:agent -->') &&
    (comment.body.includes('**Outcome:** 🔴 Changes Requested') ||
      /"watchGateVerdict"[\s\S]*"outcome"\s*:\s*"REJECTED"/.test(comment.body))
  );
}

function isWakeAgentArtifact(comment: AgentContextComment): boolean {
  return comment.body.includes('<!-- wake:agent -->') && isWakeDelivery(comment.body);
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
