import { isRunnerInfrastructureOutcome } from '../../activities/index.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import type { CreditedClaims } from './coordination-claims.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/**
 * A watch child that stopped because the runner never answered (quota, authentication, transport)
 * produced no verdict, so it must not spend the group's loop-guard budget. Verdicts and
 * agent-authored failures still do.
 */
export function endedWithoutVerdictByInfrastructure(view: WorkflowInstanceView): boolean {
  return (
    (view.status === WorkflowStatus.Completed || view.status === WorkflowStatus.Blocked) &&
    isRunnerInfrastructureOutcome(view.lastOutcome)
  );
}

export function creditedGroupClaims(repository: OrchestrationRepository): CreditedClaims {
  return async (requestIds) => {
    const views = await Promise.all(requestIds.map((id) => repository.load(id)));
    return new Set(
      requestIds.filter((_id, index) => {
        const view = views[index]!.view;
        return view !== null && endedWithoutVerdictByInfrastructure(view);
      }),
    );
  };
}
