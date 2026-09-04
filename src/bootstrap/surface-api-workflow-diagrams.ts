import { ActivityOutcomeKind } from '../activities/index.js';
import { agentTokenUsage, isActiveRunStatus, RunStatus, type RunView } from '../execution/index.js';
import {
  TransitionTargetKind,
  WorkflowStatus,
  type CompiledWorkflow,
  type WorkflowInstanceView,
} from '../orchestration/index.js';
import {
  fromWorkItemKey,
  WorkflowDiagramChildKind,
  WorkflowDiagramStatus,
  type ApiApplications,
  type WorkflowDiagramChildResponse,
  type WorkflowDiagramMetricsResponse,
  type WorkflowDiagramResponse,
} from '../surfaces/index.js';
import type { CompositionRoot } from './composition-root.js';
import { projectionMeta } from './surface-api-metadata.js';

export function createWorkflowDiagramApplications(
  root: CompositionRoot,
  now: () => string,
): NonNullable<ApiApplications['workflowDiagrams']> {
  return {
    async get(workItemKey) {
      const overlay =
        workItemKey === undefined
          ? undefined
          : await loadOverlay(root, fromWorkItemKey(workItemKey));
      const definitions =
        overlay === undefined
          ? root.orchestration.listCurrentDefinitions().map((entry) => entry.definition)
          : [await root.orchestration.definitionFor(overlay.primary)];
      return {
        data: {
          diagrams: definitions.map((definition) => presentWorkflowDiagram(definition, overlay)),
        },
        meta: await projectionMeta(root.journal, [], now()),
      };
    },
  };
}

export function presentWorkflowDiagram(
  definition: CompiledWorkflow,
  overlay?: WorkflowDiagramOverlay,
): WorkflowDiagramResponse {
  const childrenByStage = new Map<string, WorkflowDiagramChildResponse[]>();
  const transitions: WorkflowDiagramResponse['transitions'][number][] = [];
  for (const [stageId, stage] of Object.entries(definition.stages)) {
    const children: WorkflowDiagramChildResponse[] = [
      presentActivity(stageId, stage.activity, overlay),
    ];
    for (const watch of definition.watches.filter((candidate) =>
      candidate.while.stages.includes(stageId as never),
    )) {
      children.push(presentWatch(stageId, watch.id, overlay));
    }
    for (const [routeId, route] of Object.entries(stage.on)) {
      if (route.target.kind === TransitionTargetKind.Stage)
        transitions.push({ from: stageId, to: route.target.stage, label: routeId });
      for (const gate of route.watchGates ?? []) {
        const childId = watchChildId(stageId, gate.watch);
        if (!children.some((child) => child.id === childId))
          children.push(presentWatch(stageId, gate.watch, overlay));
        if (route.target.kind === TransitionTargetKind.Stage)
          transitions.push({
            from: stageId,
            fromChildId: childId,
            to: route.target.stage,
            label: routeId,
          });
      }
      for (const [index, reactor] of (route.resourceTransitions ?? []).entries()) {
        const childId = `${stageId}:reactor:${routeId}:${index}`;
        children.push({
          id: childId,
          label: resourceTransitionLabel(reactor.event, reactor.where),
          kind: WorkflowDiagramChildKind.Reactor,
        });
        if (reactor.target.kind === TransitionTargetKind.Stage)
          transitions.push({
            from: stageId,
            fromChildId: childId,
            to: reactor.target.stage,
            label: reactor.event,
          });
      }
    }
    childrenByStage.set(stageId, children);
  }
  return {
    id: definition.name,
    label: title(definition.name),
    direction: 'left-to-right',
    stages: Object.entries(definition.stages).map(([stageId]) => {
      const children = childrenByStage.get(stageId) ?? [];
      const metrics = sumMetrics(children);
      const primaryStatus =
        overlay === undefined ? undefined : stageStatus(stageId, overlay.primary);
      return {
        id: stageId,
        label: title(stageId),
        ...primaryStatus,
        ...metrics,
        children,
      };
    }),
    transitions: uniqueTransitions(transitions),
  };
}

export interface WorkflowDiagramOverlay {
  readonly primary: WorkflowInstanceView;
  readonly children: readonly WorkflowInstanceView[];
  readonly runs: readonly RunView[];
}

async function loadOverlay(
  root: CompositionRoot,
  workItemId: string,
): Promise<WorkflowDiagramOverlay> {
  const workflows = await root.orchestration.listForWorkItem(workItemId as never);
  const primary = workflows.find((workflow) => workflow.parentWorkflowInstanceId === undefined);
  if (primary === undefined) throw new Error('Workflow instance not found');
  const runs = (await root.execution.list()).filter((run) =>
    workflows.some((workflow) => workflow.workflowInstanceId === run.workflowInstanceId),
  );
  return {
    primary,
    children: workflows.filter((workflow) => workflow.parentWorkflowInstanceId !== undefined),
    runs,
  };
}

function presentActivity(
  stageId: string,
  activity: string,
  overlay: WorkflowDiagramOverlay | undefined,
): WorkflowDiagramChildResponse {
  const runs =
    overlay?.runs.filter(
      (run) =>
        run.workflowInstanceId === overlay.primary.workflowInstanceId &&
        run.stage === stageId &&
        run.activity === activity,
    ) ?? [];
  return {
    id: `${stageId}:activity`,
    label: title(activity),
    kind: WorkflowDiagramChildKind.Activity,
    ...runSummary(runs),
  };
}

function presentWatch(
  stageId: string,
  watchId: string,
  overlay: WorkflowDiagramOverlay | undefined,
): WorkflowDiagramChildResponse {
  const workflows = overlay?.children.filter((workflow) => workflow.watchId === watchId) ?? [];
  const runs =
    overlay?.runs.filter((run) =>
      workflows.some((workflow) => workflow.workflowInstanceId === run.workflowInstanceId),
    ) ?? [];
  const active = workflows.find((workflow) => workflow.status === WorkflowStatus.Active);
  const blocked = workflows.find((workflow) => workflow.status === WorkflowStatus.Blocked);
  return {
    id: watchChildId(stageId, watchId),
    label: title(watchId),
    kind: WorkflowDiagramChildKind.WatchGate,
    ...(active === undefined && blocked === undefined
      ? {}
      : {
          status:
            active === undefined ? WorkflowDiagramStatus.Blocked : WorkflowDiagramStatus.Active,
        }),
    ...runSummary(runs),
  };
}

function stageStatus(stageId: string, primary: WorkflowInstanceView) {
  if (primary.currentStage !== stageId) return {};
  if (primary.status === WorkflowStatus.Completed)
    return { status: WorkflowDiagramStatus.Completed };
  if (primary.status === WorkflowStatus.Blocked) return { status: WorkflowDiagramStatus.Blocked };
  if (primary.status === WorkflowStatus.Waiting) return { status: WorkflowDiagramStatus.Waiting };
  return { status: WorkflowDiagramStatus.Active };
}

function runSummary(runs: readonly RunView[]): WorkflowDiagramMetricsResponse & {
  readonly status?: WorkflowDiagramStatus;
  readonly lastOutcome?: string;
  readonly activeRuns?: readonly {
    readonly runId: string;
    readonly activity: string;
    readonly runnerName?: string;
    readonly startedAt: string;
  }[];
} {
  if (runs.length === 0) return {};
  const ordered = [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const activeRuns = ordered
    .filter((run) => isActiveRunStatus(run.status))
    .map((run) => ({
      runId: run.runId,
      activity: run.activity,
      ...(run.runner === undefined ? {} : { runnerName: run.runner.name }),
      startedAt: run.startedAt,
    }));
  const latest = ordered[0]!;
  const usage = ordered.reduce(
    (total, run) => {
      const metadata = run.agent?.metadata;
      const agentUsage = agentTokenUsage(metadata);
      return {
        totalTokens: total.totalTokens + agentUsage.tokens,
        inputTokens: total.inputTokens + numeric(metadata, 'inputTokens'),
        outputTokens: total.outputTokens + numeric(metadata, 'outputTokens'),
        cacheReadTokens: total.cacheReadTokens + numeric(metadata, 'cacheReadTokens'),
        cacheWriteTokens: total.cacheWriteTokens + numeric(metadata, 'cacheWriteTokens'),
        totalCostUsd: total.totalCostUsd + agentUsage.costUsd,
        totalDurationMs:
          total.totalDurationMs +
          (run.finishedAt === undefined
            ? 0
            : Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))),
      };
    },
    {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
    },
  );
  return {
    runCount: runs.length,
    ...usage,
    ...(activeRuns.length > 0
      ? { status: WorkflowDiagramStatus.Active, activeRuns }
      : latest.status === RunStatus.Succeeded
        ? {
            status: WorkflowDiagramStatus.Completed,
            ...(latest.agent?.outcome === undefined
              ? {}
              : { lastOutcome: latest.agent.outcome.toLowerCase() }),
          }
        : { status: WorkflowDiagramStatus.Blocked, lastOutcome: ActivityOutcomeKind.Failed }),
  };
}

function sumMetrics(
  children: readonly WorkflowDiagramChildResponse[],
): WorkflowDiagramMetricsResponse {
  const totals = children.reduce(
    (total, child) => ({
      runCount: total.runCount + (child.runCount ?? 0),
      totalDurationMs: total.totalDurationMs + (child.totalDurationMs ?? 0),
      totalTokens: total.totalTokens + (child.totalTokens ?? 0),
      inputTokens: total.inputTokens + (child.inputTokens ?? 0),
      outputTokens: total.outputTokens + (child.outputTokens ?? 0),
      cacheReadTokens: total.cacheReadTokens + (child.cacheReadTokens ?? 0),
      cacheWriteTokens: total.cacheWriteTokens + (child.cacheWriteTokens ?? 0),
      totalCostUsd: total.totalCostUsd + (child.totalCostUsd ?? 0),
    }),
    {
      runCount: 0,
      totalDurationMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
    },
  );
  return children.some((child) => child.runCount !== undefined) ? totals : {};
}

function uniqueTransitions(transitions: readonly WorkflowDiagramResponse['transitions'][number][]) {
  return transitions.filter(
    (transition, index) =>
      transitions.findIndex(
        (candidate) =>
          candidate.from === transition.from &&
          candidate.to === transition.to &&
          candidate.fromChildId === transition.fromChildId &&
          candidate.label === transition.label,
      ) === index,
  );
}

function watchChildId(stageId: string, watchId: string) {
  return `${stageId}:watch:${watchId}`;
}

function resourceTransitionLabel(event: string, where: unknown) {
  if (where === undefined) return title(event.replace(/^activities\./, ''));
  const condition = Object.values(where as Record<string, string>).join(' ');
  return `${title(event.replace(/^activities\./, ''))}: ${condition}`;
}

function title(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function numeric(
  metadata: Readonly<Record<string, string | number | boolean | null>> | undefined,
  key: string,
) {
  const value = metadata?.[key];
  return typeof value === 'number' ? value : 0;
}
