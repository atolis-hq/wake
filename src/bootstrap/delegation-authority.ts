import type { CommandContext, EventJournal } from '@atolis-hq/eventing';
import { ActivityExecutionKind, type ActivityRegistry } from '../activities/index.js';
import { isActiveRunStatus, runId, RunRepository } from '../execution/index.js';
import type { IdGenerator } from '../kernel/index.js';
import type { DelegationAuthority } from '../orchestration/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationRole,
  resourceId,
  ResourceStreamKind,
  type ResourceRepositoryIdentityResolver,
  type ResourceService,
} from '../resources/index.js';
import type { WorkItemId } from '../work/index.js';

/** Bind delegation to durable Run identity; credentials and audit actors alone are insufficient. */
export function createDelegationAuthority(
  journal: EventJournal,
  resources: ResourceService,
  activities: ActivityRegistry,
  binding: {
    readonly ids: IdGenerator;
    readonly repositoryIdentity: ResourceRepositoryIdentityResolver;
  },
): DelegationAuthority {
  const runs = new RunRepository(journal);
  const repositories = async (workItemId: WorkItemId) => {
    const correlated = await resources.correlationsForWork(workItemId);
    const views = await Promise.all(correlated.map((entry) => resources.get(entry.resourceId)));
    return views
      .filter((view) => view?.kind === BuiltInResourceKind.Repository)
      .map((view) => view!.resourceId);
  };
  return {
    async assertCaller(caller, parent) {
      const run = (await runs.load(runId(caller.runId))).view;
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
    repositories: (parent) => repositories(parent.workItemId),
    // The scope is the repository the provider observed the root Issue in, never an agent claim.
    // Any Repository Resource already correlated to the root (for example operator-declared)
    // is the explicit scope and is left untouched.
    async bindRepositoryScope(root, context: CommandContext) {
      if ((await repositories(root.workItemId)).length > 0) return;
      const primary = (await resources.correlationsForWork(root.workItemId)).find(
        (entry) => entry.role === ResourceCorrelationRole.Primary,
      );
      const origin = primary === undefined ? null : await resources.get(primary.resourceId);
      if (origin === null || origin.kind !== BuiltInResourceKind.Issue) return;
      const identity = binding.repositoryIdentity(origin.externalKey);
      if (identity === undefined) return;
      const externalKey = { adapter: origin.externalKey.adapter, key: identity };
      const repository =
        (await resources.findByExternalKey(externalKey)) ??
        (await resources.discover(
          {
            resourceId: resourceId(binding.ids.next(ResourceStreamKind.Resource)),
            kind: BuiltInResourceKind.Repository,
            externalKey,
            capabilities: [],
          },
          context,
        ));
      await resources.correlate(
        repository.resourceId,
        root.workItemId,
        ResourceCorrelationRole.Secondary,
        context,
      );
    },
  };
}
