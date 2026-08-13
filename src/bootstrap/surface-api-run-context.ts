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
