import {
  PullRequestCheckState,
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
import { createCommentHistoryReader } from './comment-history-reader.js';

export function createGitHubAgentContextReader(
  journal: EventJournal,
  resources: Pick<ResourceService, 'correlationsForWork' | 'get'>,
): AgentContextReader {
  const commentHistory = createCommentHistoryReader(journal, resources);
  return {
    async forWorkItem(workItemId) {
      const comments = await commentHistory.forWorkItem(workItemId as WorkItemId);
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
