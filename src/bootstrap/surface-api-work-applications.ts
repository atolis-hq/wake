import { pullRequestProjection, type PullRequestView } from '../activities/index.js';
import {
  executionProjection,
  runsByWorkflowInstanceProjection,
  type RunView,
} from '../execution/index.js';
import { correlationId, EventActorKind } from '../kernel/index.js';
import {
  isOperatorRetryEligible,
  OperatorRetryIneligibleError,
  orchestrationProjection,
  workflowsByWorkItemProjection,
  type WorkflowInstanceView,
} from '../orchestration/index.js';
import {
  workCorrelationsProjection,
  type ResourceCorrelationView,
  type ResourceView,
} from '../resources/index.js';
import {
  ApiCommandStatus,
  fromWorkItemKey,
  presentResource,
  presentRun,
  presentWorkflowInstance,
  presentWorkItem,
  type ApiApplications,
  type WorkDetailResponse,
} from '../surfaces/index.js';
import { workItemId, WorkStatus, type WorkItemView } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';
import { primaryExternalRef } from './external-ref.js';
import { projectionMeta } from './surface-api-metadata.js';
import { projectionPage } from './surface-api-projection-pages.js';
import { withWorkflowContext } from './surface-api-run-context.js';
import { readWorkTranscript, transcriptGroups } from './surface-api-transcripts.js';

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
    async transcript(key, groupId) {
      const id = decodeWorkItemId(key);
      if (id === undefined) return undefined;
      const work = await root.projections.read<WorkItemView | null>('work', id);
      if (work === null || work.value === null) return undefined;
      return readWorkTranscript(
        root.transcriptStore,
        id,
        groupId,
        await runsForWorkItem(root, id),
      ).then(async (data) => ({ data, meta: await projectionMeta(root.journal, [], now()) }));
    },
    async freeze(key, command) {
      const id = decodeWorkItemId(key);
      if (id === undefined) throw new Error('Work item not found');
      await root.work.freeze(id, commandContext(command.idempotencyKey, now));
      return accepted(command.idempotencyKey, now());
    },
    async unfreeze(key, command) {
      const id = decodeWorkItemId(key);
      if (id === undefined) throw new Error('Work item not found');
      await root.work.unfreeze(id, commandContext(command.idempotencyKey, now));
      return accepted(command.idempotencyKey, now());
    },
    async delete(key, command) {
      const id = decodeWorkItemId(key);
      if (id === undefined) throw new Error('Work item not found');
      const context = commandContext(command.idempotencyKey, now);
      const correlations = await root.resources.correlationsForWork(id);
      await root.work.delete(id, context);
      await Promise.all(
        correlations.map((entry) => root.resources.retract(entry.resourceId, id, context)),
      );
      return accepted(command.idempotencyKey, now());
    },
    async retry(key, command) {
      const id = decodeWorkItemId(key);
      if (id === undefined) return retryIneligible('Work item was not found');
      const work = await root.work.get(id);
      if (work === null) return retryIneligible('Work item was not found');
      if (work.deleted === true) return retryIneligible('Work item is deleted');
      if (work.state !== WorkStatus.Open) return retryIneligible('Work item is not open');
      const primary = (await root.orchestration.listAll()).find(
        (value) => value.workItemId === id && value.parentWorkflowInstanceId === undefined,
      );
      if (primary === undefined) return retryIneligible('Work item has no primary workflow');
      if (!isOperatorRetryEligible(primary))
        return retryIneligible('Workflow is not retry eligible');
      try {
        await root.orchestration.retryBlockedFailedStage(
          primary.workflowInstanceId,
          commandContext(command.idempotencyKey, now),
        );
      } catch (error) {
        if (error instanceof OperatorRetryIneligibleError) return retryIneligible(error.message);
        throw error;
      }
      return accepted(command.idempotencyKey, now());
    },
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
  const correlationProjection = await root.projections.read<readonly ResourceCorrelationView[]>(
    workCorrelationsProjection.name,
    id,
  );
  const correlations = correlationProjection?.value ?? workCorrelationsProjection.initial(id);
  const resources = (
    await Promise.all(correlations.map((item) => root.resources.get(item.resourceId)))
  ).filter((value): value is ResourceView => value !== null);
  const workflowIds =
    (await root.projections.read<readonly string[]>(workflowsByWorkItemProjection.name, id))
      ?.value ?? workflowsByWorkItemProjection.initial(id);
  const workflows = (
    await Promise.all(
      workflowIds.map((workflowInstanceId) =>
        root.projections.read<{ readonly view: WorkflowInstanceView | null }>(
          orchestrationProjection.name,
          workflowInstanceId,
        ),
      ),
    )
  ).flatMap((entry) => (entry === null || entry.value.view === null ? [] : [entry.value.view]));
  const runs = await runsForWorkItem(root, id, workflows);
  const pullRequest = (
    await Promise.all(
      resources.map((resource) =>
        root.projections.read<PullRequestView | null>(
          pullRequestProjection.name,
          resource.resourceId,
        ),
      ),
    )
  ).find((entry) => entry !== null && entry.value !== null);
  const primary = workflows.find((value) => value.parentWorkflowInstanceId === undefined) ?? null;
  const externalRef = await primaryExternalRef(root, work.workItemId, correlations, resources);
  const data: WorkDetailResponse = {
    work: { ...presentWorkItem(work), ...(externalRef === undefined ? {} : { externalRef }) },
    resources: resources.map(presentResource(root.resolveResourceLink)),
    orchestration: {
      primary: primary === null ? null : presentWorkflowInstance(primary),
      children: workflows
        .filter((value) => value.parentWorkflowInstanceId !== undefined)
        .map(presentWorkflowInstance),
    },
    execution: {
      runs: await Promise.all(runs.map((run) => withWorkflowContext(root, presentRun(run)))),
      transcriptGroups: await transcriptGroups(root.transcriptStore, id, runs),
    },
    activities: presentPullRequest(pullRequest?.value),
  };
  const [projections, correlationFacts] = await Promise.all([
    contributingProjections(root, id, resources, workflows, runs),
    Promise.resolve(correlationProjection).then((entry) => (entry === null ? [] : [entry])),
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

async function runsForWorkItem(
  root: CompositionRoot,
  id: ReturnType<typeof workItemId>,
  workflows?: readonly { readonly workflowInstanceId: string }[],
) {
  const matching = workflows ?? (await workflowsForWorkItem(root, id));
  const runIds = (
    await Promise.all(
      matching.map((workflow) =>
        root.projections.read<readonly string[]>(
          runsByWorkflowInstanceProjection.name,
          workflow.workflowInstanceId,
        ),
      ),
    )
  ).flatMap((entry) => entry?.value ?? []);
  return (
    await Promise.all(
      runIds.map((runId) =>
        root.projections.read<{ readonly view: RunView | null }>(executionProjection.name, runId),
      ),
    )
  )
    .flatMap((entry) => (entry === null || entry.value.view === null ? [] : [entry.value.view]))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function workflowsForWorkItem(root: CompositionRoot, id: ReturnType<typeof workItemId>) {
  const workflowIds =
    (await root.projections.read<readonly string[]>(workflowsByWorkItemProjection.name, id))
      ?.value ?? workflowsByWorkItemProjection.initial(id);
  return (
    await Promise.all(
      workflowIds.map((workflowInstanceId) =>
        root.projections.read<{ readonly view: WorkflowInstanceView | null }>(
          orchestrationProjection.name,
          workflowInstanceId,
        ),
      ),
    )
  ).flatMap((entry) => (entry === null || entry.value.view === null ? [] : [entry.value.view]));
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
    ...workflows.map((value) =>
      root.projections.read(orchestrationProjection.name, value.workflowInstanceId),
    ),
    ...runs.map((value) => root.projections.read(executionProjection.name, value.runId)),
  ]);
  return records.filter((value) => value !== null);
}

function commandContext(idempotencyKey: string, now: () => string) {
  const occurredAt = now();
  return {
    commandId: `work:${idempotencyKey}`,
    correlationId: correlationId(`work:${idempotencyKey}`),
    occurredAt,
    actor: { kind: EventActorKind.Operator, id: 'web' },
  };
}

function accepted(idempotencyKey: string, acceptedAt: string) {
  return {
    commandId: `work:${idempotencyKey}`,
    idempotencyKey,
    acceptedAt,
    status: ApiCommandStatus.Accepted,
  };
}

function retryIneligible(detail: string) {
  return { conflict: true as const, code: 'retry-ineligible', detail };
}
