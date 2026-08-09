import { WorkflowStatus, type OrchestrationService } from '../../../orchestration/index.js';
import type { ResourceService } from '../../../resources/index.js';
import { WorkStatus, type WorkItemId, type WorkService } from '../../../work/index.js';
import {
  GitHubWakeStatusLabel,
  isGitHubWakeMarker,
  type GitHubWakeStatusLabel as GitHubWakeStatusLabelValue,
} from '../contracts/vocabulary.js';

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

export function createGitHubWakeLabelReconciler(input: {
  readonly orchestration: Pick<OrchestrationService, 'listAll'>;
  readonly resources: Pick<ResourceService, 'correlationsForWork' | 'get'>;
  readonly work: Pick<WorkService, 'get'>;
  readonly getLabels: (owner: string, repo: string, number: number) => Promise<readonly string[]>;
  readonly setLabels: (
    owner: string,
    repo: string,
    number: number,
    labels: readonly string[],
  ) => Promise<void>;
}): GitHubWakeLabelReconciler {
  const openWorkItemIds = async (
    workItemIds: ReadonlySet<WorkItemId>,
  ): Promise<ReadonlySet<WorkItemId>> => {
    const open = new Set<WorkItemId>();
    for (const workItemId of workItemIds) {
      const item = await input.work.get(workItemId);
      if (item?.state === WorkStatus.Open) open.add(workItemId);
    }
    return open;
  };

  return {
    async runOnce() {
      const workflows = await input.orchestration.listAll();
      // Closed/cancelled is terminal for a WorkItem — there is no reopen path
      // (see work-item.spec.md) — so once synced, a concluded issue's labels
      // never need checking again. Without this, listAll() keeps returning
      // every WorkItem ever created and this loop keeps making a live
      // getLabels call per item, every cycle, forever.
      const open = await openWorkItemIds(new Set(workflows.map((workflow) => workflow.workItemId)));
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
        for (const correlation of await input.resources.correlationsForWork(workflow.workItemId)) {
          const resource = await input.resources.get(correlation.resourceId);
          if (resource?.externalKey.adapter !== 'github') continue;
          const locator = parseGitHubIssueKey(resource.externalKey.key);
          if (locator === null) continue;
          const current = await input.getLabels(locator.owner, locator.repo, locator.number);
          const next = reconcileGitHubWakeLabels(current, desired);
          if (!sameLabels(current, next))
            await input.setLabels(locator.owner, locator.repo, locator.number, next);
        }
      }
    },
  };
}

function desiredWakeLabels(
  workflow: {
    readonly status: WorkflowStatus;
    readonly currentStage: string;
    readonly workflowName: string;
  },
  watching: boolean,
): readonly string[] {
  return [
    `wake:status.${statusLabel(workflow.status)}`,
    `wake:stage.${workflow.currentStage}`,
    `wake:workflow.${workflow.workflowName}`,
    ...(watching ? ['wake:watching'] : []),
  ];
}

function statusLabel(status: WorkflowStatus): GitHubWakeStatusLabelValue {
  switch (status) {
    case WorkflowStatus.Active:
      return GitHubWakeStatusLabel.Working;
    case WorkflowStatus.Waiting:
      return GitHubWakeStatusLabel.AwaitingApproval;
    case WorkflowStatus.Blocked:
      return GitHubWakeStatusLabel.Blocked;
    case WorkflowStatus.Completed:
      return GitHubWakeStatusLabel.Completed;
    case WorkflowStatus.Superseded:
      return GitHubWakeStatusLabel.Failed;
  }
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
  return left.length === right.length && left.every((label, index) => label === right[index]);
}
