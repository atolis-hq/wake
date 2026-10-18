import type { EventJournal } from '@atolis-hq/eventing';
import { ActivityExecutionKind, type ActivityRegistry } from '../activities/index.js';
import { RunRepository, isActiveRunStatus, runId } from '../execution/index.js';
import type { DelegationAuthority } from '../orchestration/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationRole,
  resourceId,
  type ResourceService,
} from '../resources/index.js';

/** Bind delegation to durable Run identity; credentials and audit actors alone are insufficient. */
export function createDelegationAuthority(
  journal: EventJournal,
  resources: ResourceService,
  activities: ActivityRegistry,
): DelegationAuthority {
  const runs = new RunRepository(journal);
  return {
    async assertCaller(caller, parent) {
      const run = (await runs.load(runId(caller.runId), { fresh: true })).view;
      if (
        run === null ||
        !isActiveRunStatus(run.status) ||
        run.cancellation !== undefined ||
        run.workflowInstanceId !== parent.workflowInstanceId ||
        run.activationId !== caller.activationId ||
        (parent.pendingActivation?.activationId ?? parent.delegationFence?.activationId) !==
          caller.activationId ||
        activities.describe(run.activity).executionKind !== ActivityExecutionKind.Agent
      )
        throw new Error('Delegation capability is stale or does not own the parent activation');
    },
    async repositories(parent) {
      const correlated = await resources.correlationsForWork(parent.workItemId);
      const views = await Promise.all(correlated.map((entry) => resources.get(entry.resourceId)));
      return views
        .filter((view) => view?.kind === BuiltInResourceKind.Repository)
        .map((view) => view!.resourceId);
    },
    async registerRepositories(child, context) {
      for (const id of child.repositoryResourceIds ?? [])
        await resources.correlate(
          resourceId(id),
          child.workItemId,
          ResourceCorrelationRole.Secondary,
          { ...context, commandId: context.commandId + ':repository:' + id },
        );
    },
  };
}
