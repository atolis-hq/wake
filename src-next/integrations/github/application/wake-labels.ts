import { WorkflowStatus, type OrchestrationService } from '../../../orchestration/index.js';
import type { ResourceService } from '../../../resources/index.js';
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
  readonly getLabels: (owner: string, repo: string, number: number) => Promise<readonly string[]>;
  readonly setLabels: (
    owner: string,
    repo: string,
    number: number,
    labels: readonly string[],
  ) => Promise<void>;
}): GitHubWakeLabelReconciler {
  return {
    async runOnce() {
      for (const workflow of await input.orchestration.listAll()) {
        const desired = desiredWakeLabels(workflow);
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

function desiredWakeLabels(workflow: {
  readonly status: WorkflowStatus;
  readonly currentStage: string;
  readonly workflowName: string;
}): readonly string[] {
  return [
    `wake:status.${statusLabel(workflow.status)}`,
    `wake:stage.${workflow.currentStage}`,
    `wake:workflow.${workflow.workflowName}`,
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
