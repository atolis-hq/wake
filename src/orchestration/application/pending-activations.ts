import {
  ActivityExecutionKind,
  type ActivityName,
  type ActivityRegistry,
} from '../../activities/index.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import {
  pendingActivationPriority,
  type PendingActivationPriority,
} from '../domain/dispatch-priority.js';
import type { StartWorkflow } from './start-workflow.js';
import { WorkflowDefinitionUnavailableError } from './workflow-definition-registry.js';

/** Whether a stage's activity runs an agent; unknown activities conservatively count as agents. */
export type AgentActivityClassifier = (activity: ActivityName) => boolean;

export function createAgentActivityClassifier(registry: ActivityRegistry): AgentActivityClassifier {
  const kinds = new Map(registry.list().map((activity) => [activity.name, activity.executionKind]));
  return (activity) => {
    const kind = kinds.get(activity);
    return kind === undefined || kind === ActivityExecutionKind.Agent;
  };
}

export interface PendingActivationEntry {
  readonly workflow: WorkflowInstanceView;
  readonly activation: ActivityActivationView;
  readonly priority: PendingActivationPriority;
}

// Read-only: an unavailable definition ranks last rather than blocking the instance.
async function resolveDefinition(workflows: StartWorkflow, view: WorkflowInstanceView) {
  try {
    return await workflows.definitionFor(view);
  } catch (error) {
    if (error instanceof WorkflowDefinitionUnavailableError) return null;
    throw error;
  }
}

export function prioritisePendingActivations(
  workflows: StartWorkflow,
  views: readonly WorkflowInstanceView[],
  isAgentActivity: AgentActivityClassifier,
  workItemId?: string,
): Promise<readonly PendingActivationEntry[]> {
  const pending = views.filter(
    (view) =>
      view.status === WorkflowStatus.Active &&
      view.pendingActivation !== undefined &&
      (workItemId === undefined || view.workItemId === workItemId),
  );
  return Promise.all(
    pending.map(async (view) => ({
      workflow: view,
      activation: view.pendingActivation!,
      priority: pendingActivationPriority(
        await resolveDefinition(workflows, view),
        view,
        view.pendingActivation!,
        isAgentActivity,
      ),
    })),
  );
}
