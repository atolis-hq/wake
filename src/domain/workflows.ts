import type {
  EventEnvelope,
  IssueStateRecord,
  RunnerSentinel,
  Stage,
  WakeConfig,
  WorkflowDefinition,
} from './types.js';
import { stageLabelForStage } from './stages.js';

export const universalQueueStage = 'queue';
export const universalDoneStage = 'done';
export const workflowChangedBlockReason = 'workflow-changed';
export const wakeWorkflowLabelPrefix = 'wake:workflow.';

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

type WorkflowSelector = WakeConfig['workflowSelectors'][number];

type WorkflowSelectorInput = {
  kind?: string;
  sourceEventType: string;
  repo?: string;
  labels: string[];
  assignees: string[];
  author?: string;
};

type WorkflowSelectorEvent = Pick<EventEnvelope, 'sourceEventType' | 'sourceRefs' | 'payload'>;

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
  return typeof context.workflow === 'string' ? context.workflow : defaultWorkflowName(config);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function repoFromResourceUri(resourceUri: string | undefined): string | undefined {
  if (resourceUri === undefined) {
    return undefined;
  }

  const [, , rest] = resourceUri.split(':', 3);
  return rest?.split('#')[0];
}

export function workflowSelectorInputFromEvent(
  event: WorkflowSelectorEvent,
): WorkflowSelectorInput {
  const resourceUri = event.sourceRefs.resourceUri ?? event.sourceRefs.parentResourceUri;
  const kind = resourceUri?.split(':')[1];
  const ticket = (event.payload.ticket ?? event.payload.issue) as
    { repo?: unknown; labels?: unknown; assignees?: unknown } | undefined;
  const pr = event.payload.pr as { author?: unknown } | undefined;
  const repo =
    (typeof ticket?.repo === 'string' ? ticket.repo : undefined) ??
    event.sourceRefs.repo ??
    repoFromResourceUri(resourceUri);

  return {
    ...(kind === undefined ? {} : { kind }),
    sourceEventType: event.sourceEventType,
    ...(repo === undefined ? {} : { repo }),
    labels: stringArray(ticket?.labels),
    assignees: stringArray(ticket?.assignees),
    ...(typeof pr?.author === 'string' ? { author: pr.author } : {}),
  };
}

function labelsAndAssigneesMatch(input: {
  labels: string[];
  assignees: string[];
  requiredLabels: string[];
  ignoredLabels: string[];
  requiredAssignees: string[];
}): boolean {
  const labels = new Set(input.labels);
  const assignees = new Set(input.assignees);

  if (input.requiredLabels.some((label) => !labels.has(label))) {
    return false;
  }

  if (input.ignoredLabels.some((label) => labels.has(label))) {
    return false;
  }

  if (
    input.requiredAssignees.length > 0 &&
    !input.requiredAssignees.some((login) => assignees.has(login))
  ) {
    return false;
  }

  return true;
}

function selectorMatches(selector: WorkflowSelector, input: WorkflowSelectorInput): boolean {
  const match = selector.match;

  if (match.kind !== undefined && match.kind !== input.kind) {
    return false;
  }

  if (match.sourceEventType !== undefined && match.sourceEventType !== input.sourceEventType) {
    return false;
  }

  if (match.repo !== undefined && match.repo !== input.repo) {
    return false;
  }

  if (!labelsAndAssigneesMatch({ ...match, labels: input.labels, assignees: input.assignees })) {
    return false;
  }

  if (
    match.requiredAuthors.length > 0 &&
    (input.author === undefined || !match.requiredAuthors.includes(input.author))
  ) {
    return false;
  }

  return true;
}

export function selectWorkflowForEvent(
  event: WorkflowSelectorEvent,
  config: WakeConfig,
): string | null {
  const input = workflowSelectorInputFromEvent(event);
  const selector = config.workflowSelectors.find((candidate) => selectorMatches(candidate, input));
  return selector?.workflow ?? null;
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

export function workflowLabelForWorkflowName(workflowName: string): string {
  return `${wakeWorkflowLabelPrefix}${workflowName}`;
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
