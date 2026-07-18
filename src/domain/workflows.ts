import type { IssueStateRecord, RunnerRouting, RunnerSentinel, Stage, WakeConfig, WorkflowDefinition } from './types.js';
import { stageLabelForStage } from './stages.js';

export const universalQueueStage = 'queue';
export const universalDoneStage = 'done';
export const workflowChangedBlockReason = 'workflow-changed';

export const builtInDefaultWorkflowDefinition: WorkflowDefinition = {
  stages: {
    refine: {
      action: 'refine',
      workspace: 'read-only',
      tier: 'light',
      onDone: 'implement',
    },
    implement: {
      action: 'implement',
      workspace: 'branch',
      tier: 'standard',
      onDone: 'done',
    },
  },
};

export type RunnableStage = WorkflowDefinition['stages'][string] & {
  action: string;
};

export interface WorkflowAction {
  action: string;
  workspace: 'none' | 'read-only' | 'branch';
  routing: {
    tier?: string;
    runner?: string;
  };
  stage: string;
}

export function configuredWorkflowNames(config: WakeConfig): string[] {
  return Object.keys(config.workflows);
}

export function defaultWorkflowName(config: WakeConfig): string {
  const [name] = configuredWorkflowNames(config);
  if (name === undefined) {
    throw new Error('Wake config must define at least one workflow.');
  }
  return name;
}

export function workflowForProjection(
  projection: IssueStateRecord,
  config: WakeConfig,
): WorkflowDefinition | null {
  const workflowName = workflowNameForProjection(projection, config);
  return config.workflows[workflowName] ?? null;
}

export function workflowNameForProjection(
  projection: IssueStateRecord,
  config: WakeConfig,
): string {
  const context = projection.context as Record<string, unknown>;
  return (
    typeof context.workflow === 'string'
      ? context.workflow
      : defaultWorkflowName(config)
  );
}

export function configuredStageNames(workflow: WorkflowDefinition): string[] {
  return Object.keys(workflow.stages);
}

export function workflowStageVocabulary(workflow: WorkflowDefinition): string[] {
  return [universalQueueStage, ...configuredStageNames(workflow), universalDoneStage];
}

export function stageLabelsForWorkflow(workflow: WorkflowDefinition): string[] {
  return workflowStageVocabulary(workflow).map((stage) => stageLabelForStage(stage));
}

export function isKnownWorkflowStage(stage: string, workflow: WorkflowDefinition): boolean {
  return workflowStageVocabulary(workflow).includes(stage);
}

export function entryStage(workflow: WorkflowDefinition): string {
  return workflow.entryStage ?? configuredStageNames(workflow)[0]!;
}

export function stageAfterQueue(workflow: WorkflowDefinition): string {
  return entryStage(workflow);
}

export function chooseAction(
  projection: IssueStateRecord,
  workflow: WorkflowDefinition,
): WorkflowAction | null {
  const stage =
    projection.wake.stage === universalQueueStage
      ? stageAfterQueue(workflow)
      : projection.wake.stage;
  const definition = workflow.stages[stage];

  if (definition === undefined || stage === universalDoneStage) {
    return null;
  }

  return {
    action: definition.action ?? stage,
    workspace: definition.workspace,
    routing: {
      ...(definition.tier === undefined ? {} : { tier: definition.tier }),
      ...(definition.runner === undefined ? {} : { runner: definition.runner }),
    },
    stage,
  };
}

export function nextStage(
  stage: Stage,
  sentinel: RunnerSentinel,
  workflow: WorkflowDefinition,
): Stage | null {
  if (sentinel === 'BLOCKED' || sentinel === 'FAILED' || sentinel === 'AWAITING_APPROVAL') {
    return null;
  }

  const runnableStage = stage === universalQueueStage ? stageAfterQueue(workflow) : stage;
  return workflow.stages[runnableStage]?.onDone ?? null;
}
