import {
  BuiltInActivityName,
  PullRequestDenialCode,
  pullRequestMergeInputSchema,
  readMergePolicyDenial,
  selectPrimaryPullRequest,
  type MergePolicyDetails,
} from '../activities/index.js';
import { WorkflowStatus, type WorkflowInstanceView } from '../orchestration/index.js';
import { presentMergePolicyBlock, presentWorkflowInstance } from '../surfaces/index.js';
import type { CompositionRoot } from './composition-root.js';

export async function mergePolicyBlockForWork(
  root: CompositionRoot,
  workflow: WorkflowInstanceView,
) {
  const denial = readMergePolicyDenial(workflow.lastOutcome);
  if (
    denial === null ||
    workflow.status !== WorkflowStatus.Waiting ||
    workflow.pendingActivation?.activity !== BuiltInActivityName.PullRequestMerge
  )
    return undefined;
  const selected = selectPrimaryPullRequest(
    await root.pullRequests.authorityInput(workflow.workItemId),
    workflow.workItemId,
  );
  if (
    selected === null ||
    (denial.resourceId !== undefined && denial.resourceId !== selected.pullRequest.resourceId)
  )
    return undefined;
  const policy =
    denial.policy ??
    (await legacyPolicy(root, workflow, denial.reason, selected.pullRequest.changedFiles));
  return presentMergePolicyBlock({
    workflow,
    pullRequest: selected.pullRequest,
    policy,
    href: root.resolveResourceLink(selected.resource.resource.externalKey) ?? undefined,
  });
}

async function legacyPolicy(
  root: CompositionRoot,
  workflow: WorkflowInstanceView,
  reason: string,
  files: readonly string[] | undefined,
): Promise<MergePolicyDetails | undefined> {
  const definition = await root.orchestration.definitionFor(workflow).catch(() => null);
  const parsed = pullRequestMergeInputSchema.safeParse(
    definition?.stages[workflow.currentStage]?.with,
  );
  if (!parsed.success) return undefined;
  if (reason === PullRequestDenialCode.BlockedPathChanged)
    return {
      blockedPaths: [...parsed.data.blockedPaths],
      ...(files === undefined
        ? {}
        : { matchedPaths: parsed.data.blockedPaths.filter((path) => files.includes(path)) }),
    };
  if (reason === PullRequestDenialCode.TooManyFilesChanged)
    return {
      ...(parsed.data.maxFilesChanged === undefined
        ? {}
        : { maxFilesChanged: parsed.data.maxFilesChanged }),
      ...(files === undefined ? {} : { filesChanged: files.length }),
    };
  return undefined;
}

export async function presentPrimaryWorkflow(
  root: CompositionRoot,
  workflow: WorkflowInstanceView | null,
) {
  if (workflow === null) return null;
  const mergePolicyBlock = await mergePolicyBlockForWork(root, workflow);
  return {
    ...presentWorkflowInstance(workflow),
    ...(mergePolicyBlock === undefined ? {} : { mergePolicyBlock }),
  };
}
