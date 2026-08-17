import { ActivityOutcomeKind } from '../activities/index.js';
import {
  DeliveryState,
  IntegrationStreamKind,
  type DeliveryIntentView,
} from '../integrations/index.js';
import { workflowInstanceId } from '../orchestration/index.js';
import type { RunResponse } from '../surfaces/index.js';
import type { CompositionRoot } from './composition-root.js';

export async function withWorkflowContext(
  root: CompositionRoot,
  run: RunResponse,
): Promise<RunResponse> {
  const instance = await root.orchestration.get(workflowInstanceId(run.workflowInstanceId));
  return instance === null ? run : { ...run, workflowName: instance.workflowName };
}

const deliveryResolutionSentinels: Readonly<
  Partial<Record<DeliveryState, 'DONE' | 'FAILED' | 'AMBIGUOUS'>>
> = {
  [DeliveryState.Confirmed]: 'DONE',
  [DeliveryState.Failed]: 'FAILED',
  [DeliveryState.Ambiguous]: 'AMBIGUOUS',
};

/**
 * A run whose own outcome was `waiting` on a delivery is frozen at that
 * sentinel forever (the run itself never re-fires once terminal). Join it
 * against the delivery intent it named to surface how that delivery has
 * since resolved, without rewriting the run's own history.
 */
export async function withDeliveryResolution(
  root: CompositionRoot,
  run: RunResponse,
): Promise<RunResponse> {
  const intentEventId = waitingDeliveryIntentEventId(run);
  if (intentEventId === undefined) return run;
  const stored = await root.projections.read<DeliveryIntentView>(
    IntegrationStreamKind.Delivery,
    intentEventId,
  );
  const delivery = stored?.value;
  if (delivery === undefined || delivery.resolvedAt === undefined) return run;
  const sentinel = deliveryResolutionSentinels[delivery.state];
  return sentinel === undefined
    ? run
    : { ...run, resolution: { sentinel, resolvedAt: delivery.resolvedAt } };
}

/** Full read-time enrichment applied to every presented run. */
export async function enrichRun(root: CompositionRoot, run: RunResponse): Promise<RunResponse> {
  return withDeliveryResolution(root, await withWorkflowContext(root, run));
}

function waitingDeliveryIntentEventId(run: RunResponse): string | undefined {
  if (typeof run.outcome !== 'object' || run.outcome === null) return undefined;
  if (Reflect.get(run.outcome, 'kind') !== ActivityOutcomeKind.Waiting) return undefined;
  const data = Reflect.get(run.outcome, 'data');
  if (typeof data !== 'object' || data === null) return undefined;
  const intentEventId = Reflect.get(data, 'intentEventId');
  const signalKind = Reflect.get(data, 'signalKind');
  return typeof intentEventId === 'string' && signalKind === 'delivery-result'
    ? intentEventId
    : undefined;
}
