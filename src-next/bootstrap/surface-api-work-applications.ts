import type { PullRequestView } from '../activities/index.js';
import { ResourceEventType, selectResourceEvent, type ResourceView } from '../resources/index.js';
import {
  fromWorkItemKey,
  presentResource,
  presentRun,
  presentWorkItem,
  presentWorkflowInstance,
  type ApiApplications,
  type WorkDetailResponse,
} from '../surfaces/index.js';
import { workItemId, type WorkItemView } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';
import { primaryExternalRef } from './external-ref.js';
import { projectionMeta } from './surface-api-metadata.js';
import { projectionPage } from './surface-api-projection-pages.js';

export function createSurfaceWorkApplications(
  root: CompositionRoot,
  now: () => string,
): ApiApplications['work'] {
  return {
    async list(query) {
      const stored = (await root.projections.list<WorkItemView | null>('work')).flatMap((entry) =>
        entry.value === null ? [] : [{ ...entry, value: entry.value }],
      );
      const filtered = stored
        .filter(
          (entry) =>
            query.search === undefined ||
            `${entry.value.workItemId} ${entry.value.objective}`
              .toLocaleLowerCase()
              .includes(query.search.toLocaleLowerCase()),
        )
        .filter((entry) => query.state === undefined || entry.value.state === query.state);
      return projectionPage(root.journal, filtered, query, presentWorkItem, {
        emptyAsOf: now(),
        provenance: stored,
      });
    },
    detail: (key) => workDetail(root, key, now),
  };
}

async function workDetail(
  root: CompositionRoot,
  key: string,
  now: () => string,
): Promise<Awaited<ReturnType<ApiApplications['work']['detail']>>> {
  const id = decodeWorkItemId(key);
  if (id === undefined) return undefined;
  const work = await root.work.get(id);
  if (work === null) return undefined;
  const correlations = await root.resources.correlationsForWork(id);
  const resources = (
    await Promise.all(correlations.map((item) => root.resources.get(item.resourceId)))
  ).filter((value): value is ResourceView => value !== null);
  const workflows = (await root.orchestration.listAll()).filter((value) => value.workItemId === id);
  const runs = (await root.execution.list())
    .filter((run) =>
      workflows.some((workflow) => workflow.workflowInstanceId === run.workflowInstanceId),
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const pullRequests = await root.projections.list<PullRequestView | null>('activities-pr');
  const pullRequest = pullRequests.find((entry) =>
    resources.some((resource) => resource.resourceId === entry.key),
  );
  const primary = workflows.find((value) => value.parentWorkflowInstanceId === undefined) ?? null;
  const externalRef = await primaryExternalRef(root, work.workItemId);
  const data: WorkDetailResponse = {
    work: { ...presentWorkItem(work), ...(externalRef === undefined ? {} : { externalRef }) },
    resources: resources.map(presentResource(root.resolveResourceLink)),
    orchestration: {
      primary: primary === null ? null : presentWorkflowInstance(primary),
      children: workflows
        .filter((value) => value.parentWorkflowInstanceId !== undefined)
        .map(presentWorkflowInstance),
    },
    execution: { runs: runs.map(presentRun) },
    activities: presentPullRequest(pullRequest?.value),
  };
  const [projections, correlationFacts] = await Promise.all([
    contributingProjections(root, id, resources, workflows, runs),
    contributingResourceCorrelationFacts(root, id),
  ]);
  return {
    data,
    meta: await projectionMeta(
      root.journal,
      [...projections, ...correlationFacts, ...(pullRequest === undefined ? [] : [pullRequest])],
      now(),
    ),
  };
}

function decodeWorkItemId(key: string): ReturnType<typeof workItemId> | undefined {
  try {
    return workItemId(fromWorkItemKey(key));
  } catch {
    return undefined;
  }
}

function presentPullRequest(value: PullRequestView | null | undefined) {
  return value == null
    ? {}
    : {
        pullRequest: {
          resourceId: value.resourceId,
          state: value.state,
          headRevision: value.headRevision,
          baseRevision: value.baseRevision,
          checks: value.checks,
        },
      };
}

async function contributingProjections(
  root: CompositionRoot,
  id: ReturnType<typeof workItemId>,
  resources: readonly ResourceView[],
  workflows: readonly { readonly workflowInstanceId: string }[],
  runs: readonly { readonly runId: string }[],
) {
  const records = await Promise.all([
    root.projections.read('work', id),
    ...resources.map((value) => root.projections.read('resources', value.resourceId)),
    ...workflows.map((value) => root.projections.read('orchestration', value.workflowInstanceId)),
    ...runs.map((value) => root.projections.read('execution', value.runId)),
  ]);
  return records.filter((value) => value !== null);
}

async function contributingResourceCorrelationFacts(
  root: CompositionRoot,
  id: ReturnType<typeof workItemId>,
) {
  const events = await root.journal.readAll(0);
  return events.flatMap((event) => {
    const owned = selectResourceEvent(event);
    if (owned === null) return [];
    if (
      owned.eventType !== ResourceEventType.WorkCorrelationEstablished &&
      owned.eventType !== ResourceEventType.WorkCorrelationRetracted &&
      owned.eventType !== ResourceEventType.WorkCorrelationConflicted
    )
      return [];
    return owned.payload.workItemId === id ? [{ lastGlobalPosition: owned.globalPosition }] : [];
  });
}
