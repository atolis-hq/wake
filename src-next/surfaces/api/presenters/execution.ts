import { RunStatus, type RunView } from '../../../execution/index.js';
import type { RunResponse } from '../contracts/execution.js';

export function presentRun(value: RunView): RunResponse {
  return {
    runId: value.runId,
    activationId: value.activationId,
    activity: value.activity,
    workflowInstanceId: value.workflowInstanceId,
    orchestrationGroupId: value.orchestrationGroupId,
    attempt: value.attempt,
    status: value.status,
    active: value.status === RunStatus.Started,
    startedAt: value.startedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
    ...(value.failure === undefined ? {} : { failure: { kind: value.failure.kind } }),
  };
}
