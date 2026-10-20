import type { createPullRequestService } from '../activities/index.js';
import { isActiveRunStatus, RunStatus, WorkspaceMode, type RunView } from '../execution/index.js';
import type { DeliveryIntegrationVerification } from '../integrations/index.js';
import {
  DeliveryRejection,
  DeliveryRejectionError,
  type DeliveryIntegration,
} from '../orchestration/index.js';
import { resourceId } from '../resources/index.js';

/**
 * Binds delivery integration to provider-observed pull request facts and to durable Run
 * identity. An agent's claim about what it leased or pushed is never enough on its own.
 */
export function createDeliveryIntegration(
  pullRequests: ReturnType<typeof createPullRequestService>,
  runs: () => Promise<readonly RunView[]>,
  verification: DeliveryIntegrationVerification,
): DeliveryIntegration {
  return {
    verifyTarget: verification.verifyTarget,
    async observe(id) {
      const view = await pullRequests.get(resourceId(id));
      return view === null
        ? null
        : {
            state: view.state,
            headRevision: view.headRevision,
            baseRevision: view.baseRevision,
            mergeability: view.mergeability,
          };
    },
    async assertMaintenanceWriter(request) {
      const all = await runs();
      const run = all.find((entry) => entry.runId === request.runId);
      const leased = run?.workspace?.maintenance?.targets.some(
        (target) =>
          target.childWorkItemId === request.childWorkItemId &&
          target.resourceId === request.resourceId &&
          target.revision.toLowerCase() === request.revision.toLowerCase(),
      );
      if (
        run === undefined ||
        !isActiveRunStatus(run.status) ||
        run.cancellation !== undefined ||
        run.activationId !== request.activationId ||
        run.workflowInstanceId !== request.workflowInstanceId ||
        leased !== true
      )
        throw new DeliveryRejectionError(
          DeliveryRejection.NotMaintainable,
          'Maintenance must be reported by the Run that Wake prepared with this target branch lease',
        );
      // An earlier writer whose outcome is unknown may have pushed; it must be reconciled first.
      const unresolved = all.find(
        (entry) =>
          entry.runId !== request.runId &&
          entry.status === RunStatus.Ambiguous &&
          ((entry.workspace?.branch === request.childWorkItemId &&
            entry.workspace?.mode === WorkspaceMode.Branch) ||
            entry.workspace?.maintenance?.targets.some(
              (target) => target.childWorkItemId === request.childWorkItemId,
            ) === true),
      );
      if (unresolved !== undefined)
        throw new DeliveryRejectionError(
          DeliveryRejection.AmbiguousWriter,
          `Run ${unresolved.runId} may have written to ${request.childWorkItemId}; reconcile it before recording maintenance`,
        );
    },
  };
}
