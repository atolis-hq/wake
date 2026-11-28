import {
  workflowDisplayStatus,
  WorkflowStatus,
  type OrchestrationService,
  type WorkflowInstanceView,
} from '../../../orchestration/index.js';
import { ResourceCorrelationRole, type ResourceService } from '../../../resources/index.js';
import {
  WorkStatus,
  type DeliverySnapshot,
  type WorkItemId,
  type WorkService,
} from '../../../work/index.js';
import { isGitHubWakeMarker } from '../contracts/vocabulary.js';
import type { GitHubRequestCoordinator } from '../infrastructure/request-coordinator.js';

export function reconcileGitHubWakeLabels(
  current: readonly string[],
  desired: readonly string[],
): readonly string[] {
  const userLabels = current.filter((label) => !isGitHubWakeMarker(label));
  return [...userLabels, ...desired];
}

export function isGitHubWakeEcho(input: {
  readonly authorLogin: string;
  readonly authenticatedLogin: string;
  readonly body: string;
  readonly labels: readonly string[];
}): boolean {
  return (
    input.authorLogin.toLowerCase() === input.authenticatedLogin.toLowerCase() ||
    input.body.includes('<!-- wake:agent -->') ||
    input.labels.some(isGitHubWakeMarker)
  );
}

export interface GitHubWakeLabelReconciler {
  runOnce(): Promise<void>;
}

export interface GitHubWakeLabelReconcileFailure {
  readonly workItemId: WorkItemId;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export function createGitHubWakeLabelReconciler(input: {
  readonly orchestration: Pick<OrchestrationService, 'listAll'>;
  readonly resources: Pick<ResourceService, 'correlationSnapshot'>;
  readonly work: Pick<WorkService, 'deliverySnapshot'>;
  readonly getLabels: (owner: string, repo: string, number: number) => Promise<readonly string[]>;
  readonly setLabels: (
    owner: string,
    repo: string,
    number: number,
    labels: readonly string[],
  ) => Promise<void>;
  readonly onError?: (failure: GitHubWakeLabelReconcileFailure, error: unknown) => void;
  readonly requests?: GitHubRequestCoordinator;
}): GitHubWakeLabelReconciler {
  const syncedDesiredLabels = new Map<string, string>();
  const finishedWorkItems = new Set<WorkItemId>();
  const onError = input.onError ?? defaultOnError;

  return {
    async runOnce() {
      const workflows = await input.orchestration.listAll();
      // Closed/cancelled is terminal for a WorkItem — there is no reopen path
      // (see work-item.spec.md) — so once synced, a concluded issue's labels
      // never need checking again. Without this, listAll() keeps returning
      // every WorkItem ever created and this loop keeps making a live
      // getLabels call per item, every cycle, forever.
      const open = syncableWorkItemIds(
        await input.work.deliverySnapshot(),
        workflows,
        finishedWorkItems,
      );
      // Both snapshots are in-memory and extended only by new events, so a quiet
      // pass costs no stream loads however many items are open.
      const resources = await input.resources.correlationSnapshot();
      // A watch's spawned child shares its parent's work item (and so its GitHub
      // resource) but is not the canonical state for that issue — only the
      // top-level (non-child) workflow instance drives its stage/status labels.
      // An active child instead surfaces as the watching marker below, so the
      // issue's own progress labels stay stable while a background review runs.
      for (const workflow of workflows) {
        if (workflow.parentWorkflowInstanceId !== undefined) continue;
        if (!open.has(workflow.workItemId)) continue;
        const watching = workflows.some(
          (candidate) =>
            candidate.parentWorkflowInstanceId === workflow.workflowInstanceId &&
            candidate.status !== WorkflowStatus.Completed,
        );
        const desired = desiredWakeLabels(workflow, watching);
        for (const correlation of resources.correlationsForWork(workflow.workItemId)) {
          // Delegated children can publish here, but only the active owner drives labels.
          const owners = resources.correlations(correlation.resourceId);
          if (
            !owners.some(
              (owner) =>
                owner.role === ResourceCorrelationRole.Primary &&
                owner.workItemId === workflow.workItemId,
            )
          )
            continue;
          const externalKey = resources.externalKey(correlation.resourceId);
          if (externalKey?.adapter !== 'github') continue;
          const locator = parseGitHubIssueKey(externalKey.key);
          if (locator === null) continue;
          const fingerprint = desired.join('\u0000');
          if (syncedDesiredLabels.get(correlation.resourceId) === fingerprint) continue;
          // One issue's persistent failure (rate limit, permissions, a stale
          // resource) must not stop every other open work item from being
          // reconciled this pass — each correlation is an independent GitHub
          // call with no ordering dependency on the others.
          try {
            const current = await request(input, () =>
              input.getLabels(locator.owner, locator.repo, locator.number),
            );
            const next = reconcileGitHubWakeLabels(current, desired);
            if (!sameLabels(current, next))
              await request(input, () =>
                input.setLabels(locator.owner, locator.repo, locator.number, next),
              );
            syncedDesiredLabels.set(correlation.resourceId, fingerprint);
          } catch (error) {
            syncedDesiredLabels.delete(correlation.resourceId);
            onError({ workItemId: workflow.workItemId, ...locator }, error);
          }
        }
      }
    },
  };
}

// A work item Wake concluded itself (concludesWork) is closed right after its instance
// completes, before the final labels were synced, so it still needs one last sync.
// The synced-fingerprint map makes that a single GitHub call per process, and other
// closed items stay excluded so history never costs a call per pass.
function syncableWorkItemIds(
  work: DeliverySnapshot,
  workflows: readonly WorkflowInstanceView[],
  finished: Set<WorkItemId>,
): ReadonlySet<WorkItemId> {
  const concluded = new Set(
    workflows
      .filter((w) => w.status === WorkflowStatus.Completed && w.concludesWork === true)
      .map((w) => w.workItemId),
  );
  const syncable = new Set<WorkItemId>();
  for (const workItemId of new Set(workflows.map((workflow) => workflow.workItemId))) {
    // Lifecycles are final: remember items that can never need a sync again so
    // history does not cost a journal read per item per pass.
    if (finished.has(workItemId)) continue;
    // A malformed item is unknown: skip it this pass without finishing it.
    if (work.invalid(workItemId)) continue;
    const item = work.get(workItemId);
    if (item?.state === WorkStatus.Open) syncable.add(workItemId);
    else if (item?.state === WorkStatus.Closed && concluded.has(workItemId))
      syncable.add(workItemId);
    else if (item !== null && item !== undefined) finished.add(workItemId);
  }
  return syncable;
}

function request<Value>(
  input: { readonly requests?: GitHubRequestCoordinator },
  operation: () => Promise<Value>,
): Promise<Value> {
  return input.requests === undefined ? operation() : input.requests.run(operation);
}

function defaultOnError(failure: GitHubWakeLabelReconcileFailure, error: unknown): void {
  process.stderr.write(
    `GitHub label reconcile failed for ${failure.owner}/${failure.repo}#${failure.number}: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
}

function desiredWakeLabels(
  workflow: {
    readonly status: WorkflowStatus;
    readonly currentStage: string;
    readonly workflowName: string;
    readonly waitingFor?: WorkflowInstanceView['waitingFor'];
  },
  watching: boolean,
): readonly string[] {
  return [
    `wake:status.${workflowDisplayStatus(workflow)}`,
    `wake:stage.${workflow.currentStage}`,
    `wake:workflow.${workflow.workflowName}`,
    ...(watching ? ['wake:watching'] : []),
  ];
}

function parseGitHubIssueKey(
  key: string,
): { readonly owner: string; readonly repo: string; readonly number: number } | null {
  const match = /^(?<owner>[^/]+)\/(?<repo>[^#]+)#(?<number>[1-9]\d*)$/.exec(key);
  if (match?.groups === undefined) return null;
  return {
    owner: match.groups.owner!,
    repo: match.groups.repo!,
    number: Number(match.groups.number),
  };
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((label, index) => label === normalizedRight[index])
  );
}
