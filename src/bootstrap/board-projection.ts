import { ActivityOutcomeKind } from '../activities/index.js';
import {
  agentTokenUsage,
  ExecutionEventType,
  RunStatus,
  selectRunExecutionEvent,
} from '../execution/index.js';
import type { ProjectionDefinition } from '../kernel/index.js';
import {
  isApprovalAwaitingSignalKind,
  OrchestrationEventType,
  orchestrationStatusTransitions,
  selectWorkflowOrchestrationEvent,
  WorkflowStatus,
  type SignalName,
} from '../orchestration/index.js';
import { toWorkItemKey } from '../surfaces/index.js';
import { selectWorkEvent, WorkEventType } from '../work/index.js';

const conditionShape = {
  ready: true,
  active: true,
  'needs-input': true,
  error: true,
  finished: true,
};
const conditions = Object.keys(conditionShape);
const BoardCondition = {
  Ready: conditions[0]!,
  Active: conditions[1]!,
  NeedsInput: conditions[2]!,
  Error: conditions[3]!,
  Finished: conditions[4]!,
} as const;

type BoardConditionValue = (typeof BoardCondition)[keyof typeof BoardCondition];

interface StoredActiveRun {
  readonly action: string;
  readonly runnerName?: string;
  readonly startedAt: string;
}

interface StoredCard {
  readonly workItemKey: string;
  readonly workItemId: string;
  readonly objective: string;
  readonly condition: BoardConditionValue;
  readonly frozen?: boolean;
  readonly awaitingApproval?: boolean;
  readonly workflowName?: string;
  readonly stage?: string;
  readonly dwellSince: string;
  readonly runCount: number;
  readonly activeRuns: Readonly<Record<string, StoredActiveRun>>;
  // Kept only to recover checkpoints written before active runs were keyed
  // by run ID. Newly projected cards never write this field.
  readonly activeRun?: StoredActiveRun;
  readonly lastRunAt?: string;
  readonly lastRunOutcome?: string;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
}

export interface BoardProjectionView {
  readonly cards: Readonly<Record<string, StoredCard>>;
  readonly workflows: Readonly<Record<string, string>>;
  readonly runs: Readonly<Record<string, string>>;
  // A watch's spawned child shares its parent's work item (and so its board
  // card) but is not the canonical state for that card — only a primary
  // (non-child) instance's own stage/condition/awaitingApproval drives it,
  // the same rule GitHub label reconciliation already follows. Child
  // streams still register in `workflows` above so their own Runs keep
  // counting toward the card's totals. The value is the child's own entry
  // stage (e.g. "review"), so a Run dispatched under that child can label
  // itself correctly instead of borrowing the primary's current stage.
  readonly children: Readonly<Record<string, string>>;
  // Same non-driving rule as `children`, applied to the Run stream once it
  // starts: a Run dispatched under a watch child (e.g. the reviewer agent)
  // must not flip the shared card to Active or clear awaitingApproval —
  // the primary is still genuinely waiting on that child's verdict, so the
  // card stays Needs Input while activeRuns/runCount/totals still reflect
  // the child's Run for display.
  readonly childRuns: Readonly<Record<string, true>>;
}

export const boardProjection: ProjectionDefinition<BoardProjectionView> = {
  name: 'operator-board',
  select: () => ({ key: 'global' }),
  initial: () => ({ cards: {}, workflows: {}, runs: {}, children: {}, childRuns: {} }),
  project(previous, envelope) {
    const work = selectWorkEvent(envelope);
    if (work !== null) return projectWork(previous, work, envelope.occurredAt);
    const workflow = selectWorkflowOrchestrationEvent(envelope);
    if (workflow !== null) return projectWorkflow(previous, workflow, envelope.occurredAt);
    const run = selectRunExecutionEvent(envelope);
    return run === null ? previous : projectRun(previous, run, envelope.occurredAt);
  },
};

export function boardConditionCounts(
  view: BoardProjectionView,
): Partial<Record<BoardConditionValue, number>> {
  return Object.values(view.cards).reduce<Partial<Record<BoardConditionValue, number>>>(
    (counts, card) => {
      counts[card.condition] = (counts[card.condition] ?? 0) + 1;
      return counts;
    },
    {},
  );
}

function projectWork(
  view: BoardProjectionView,
  event: ReturnType<typeof selectWorkEvent> & {},
  occurredAt: string,
): BoardProjectionView {
  const id = event.stream.id;
  if (event.eventType === WorkEventType.ItemCreated) {
    const card: StoredCard = {
      workItemKey: toWorkItemKey(id),
      workItemId: id,
      objective: event.payload.objective,
      condition: BoardCondition.Ready,
      dwellSince: occurredAt,
      runCount: 0,
      activeRuns: {},
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
    };
    return { ...view, cards: { ...view.cards, [id]: card } };
  }
  const current = view.cards[id];
  if (current === undefined) return view;
  if (event.eventType === WorkEventType.ObjectiveRevised)
    return {
      ...view,
      cards: { ...view.cards, [id]: { ...current, objective: event.payload.objective } },
    };
  if (event.eventType === WorkEventType.ItemFrozen)
    return { ...view, cards: { ...view.cards, [id]: { ...current, frozen: true } } };
  if (event.eventType === WorkEventType.ItemUnfrozen) {
    const { frozen: _frozen, ...unfrozen } = current;
    return { ...view, cards: { ...view.cards, [id]: unfrozen } };
  }
  if (
    event.eventType === WorkEventType.ItemClosed ||
    event.eventType === WorkEventType.ItemCancelled
  ) {
    return {
      ...view,
      cards: {
        ...view.cards,
        [id]: { ...withoutAwaitingApproval(current), condition: BoardCondition.Finished },
      },
    };
  }
  // Deletion is a purge, not a lifecycle outcome — the card must disappear
  // from the board entirely rather than settle into any condition column.
  if (event.eventType === WorkEventType.ItemDeleted) {
    const { [id]: _removed, ...cards } = view.cards;
    return { ...view, cards };
  }
  return view;
}

function projectWorkflow(
  view: BoardProjectionView,
  event: ReturnType<typeof selectWorkflowOrchestrationEvent> & {},
  occurredAt: string,
): BoardProjectionView {
  if (event.eventType === OrchestrationEventType.InstanceStarted) {
    const workId = event.payload.workItemId;
    const card = view.cards[workId];
    if (card === undefined) return view;
    const workflows = { ...view.workflows, [event.stream.id]: workId };
    if ('parentWorkflowInstanceId' in event.payload)
      return {
        ...view,
        workflows,
        children: { ...view.children, [event.stream.id]: event.payload.entry },
      };
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: {
          ...card,
          workflowName: event.payload.workflowName,
          stage: event.payload.entry,
          dwellSince: occurredAt,
          condition: BoardCondition.Ready,
        },
      },
      workflows,
    };
  }
  if (view.children?.[event.stream.id] !== undefined) return view;
  const located = lookupWorkflowCard(view, event.stream.id);
  if (located === undefined) return view;
  const { workId, card } = located;
  // Closed/cancelled is terminal for a WorkItem — there is no reopen path
  // (see work-item.spec.md) — so a workflow status event that arrives after
  // closure (e.g. InstanceBlocked from the now-orphaned instance halting)
  // must not resurrect the card out of Finished.
  if (card.condition === BoardCondition.Finished) return view;
  // A new stage is always Ready regardless of the condition it inherits —
  // Error from the prior stage's failed run, or whatever it held before the
  // SignalAccepted that unblocked it — until a Run actually starts (Active)
  // or a fresh SignalWaitStarted arrives (Needs Input).
  if (event.eventType === OrchestrationEventType.StageEntered)
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: {
          ...card,
          stage: event.payload.stage,
          dwellSince: occurredAt,
          condition: BoardCondition.Ready,
        },
      },
    };
  // Every event that changes a workflow instance's status is looked up from
  // orchestrationStatusTransitions rather than hand-matched here, so a new
  // status-changing event type added to the engine automatically reaches
  // the board instead of silently sitting at whatever condition it had
  // before — this is exactly the class of gap that let the card sit in
  // Ready while GitHub's own label already said working.
  const status = orchestrationStatusTransitions[event.eventType];
  if (status === undefined) return view;
  const withCondition = { ...card, condition: boardConditionForStatus(status) };
  if (event.eventType === OrchestrationEventType.SignalWaitStarted)
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: { ...withCondition, ...awaitingApprovalField(event.payload.signalKind) },
      },
    };
  if (event.eventType === OrchestrationEventType.SignalAccepted)
    return { ...view, cards: { ...view.cards, [workId]: withoutAwaitingApproval(withCondition) } };
  return { ...view, cards: { ...view.cards, [workId]: withCondition } };
}

function boardConditionForStatus(status: WorkflowStatus): BoardConditionValue {
  switch (status) {
    // Orchestration "active" means outstanding work, not a run in flight —
    // the board's Active condition is reserved for RunStarted (below).
    case WorkflowStatus.Active:
      return BoardCondition.Ready;
    case WorkflowStatus.Waiting:
    case WorkflowStatus.Blocked:
      return BoardCondition.NeedsInput;
    case WorkflowStatus.Completed:
      return BoardCondition.Finished;
    case WorkflowStatus.Superseded:
      return BoardCondition.Error;
  }
}

function lookupWorkflowCard(
  view: BoardProjectionView,
  streamId: string,
): { readonly workId: string; readonly card: StoredCard } | undefined {
  const workId = view.workflows[streamId];
  if (workId === undefined) return undefined;
  const card = view.cards[workId];
  return card === undefined ? undefined : { workId, card };
}

function awaitingApprovalField(signalKind: SignalName) {
  return isApprovalAwaitingSignalKind(signalKind) ? { awaitingApproval: true } : {};
}

const runTerminalEventTypes = new Set<string>([
  ExecutionEventType.RunSucceeded,
  ExecutionEventType.RunFailed,
  ExecutionEventType.RunCancelled,
  ExecutionEventType.RunAmbiguous,
]);

function terminalFinishedAt(
  event: ReturnType<typeof selectRunExecutionEvent> & {},
): string | undefined {
  if (
    event.eventType === ExecutionEventType.RunSucceeded ||
    event.eventType === ExecutionEventType.RunFailed ||
    event.eventType === ExecutionEventType.RunCancelled ||
    event.eventType === ExecutionEventType.RunAmbiguous
  )
    return event.payload.finishedAt;
  return undefined;
}

// RunSucceeded is a transport-level fact only: the agent can still report
// a failed/blocked sentinel inside its outcome, so the board's condition
// must follow outcome.kind, not just the event type, or a failed/blocked
// run leaves the card silently stuck on the prior "active" condition.
function terminalRunFields(
  event: ReturnType<typeof selectRunExecutionEvent> & {},
): (Pick<StoredCard, 'lastRunOutcome'> & Partial<Pick<StoredCard, 'condition'>>) | undefined {
  if (event.eventType === ExecutionEventType.RunSucceeded) {
    const kind = event.payload.outcome.kind;
    // A successful outcome means the runner has stopped, but does not decide
    // the workflow's next state. Keep the workflow-owned condition until its
    // next lifecycle event (ActivityRequested, SignalWaitStarted, or
    // InstanceCompleted) changes it.
    if (kind === ActivityOutcomeKind.Failed)
      return { lastRunOutcome: kind, condition: BoardCondition.Error };
    if (kind === ActivityOutcomeKind.Blocked)
      return { lastRunOutcome: kind, condition: BoardCondition.NeedsInput };
    return { lastRunOutcome: kind };
  }
  if (event.eventType === ExecutionEventType.RunFailed)
    return { lastRunOutcome: RunStatus.Failed, condition: BoardCondition.Error };
  if (event.eventType === ExecutionEventType.RunCancelled)
    return { lastRunOutcome: RunStatus.Cancelled, condition: BoardCondition.Error };
  if (event.eventType === ExecutionEventType.RunAmbiguous)
    return { lastRunOutcome: RunStatus.Ambiguous, condition: BoardCondition.Error };
  return undefined;
}

function projectRun(
  view: BoardProjectionView,
  event: ReturnType<typeof selectRunExecutionEvent> & {},
  _occurredAt: string,
): BoardProjectionView {
  if (event.eventType === ExecutionEventType.RunStarted) return projectRunStarted(view, event);

  const workId = view.runs[event.stream.id];
  const card = workId === undefined ? undefined : view.cards[workId];
  if (card === undefined || workId === undefined) return view;

  if (runTerminalEventTypes.has(event.eventType))
    return projectRunTerminal(view, event, workId, card);

  if (event.eventType === ExecutionEventType.RunRunnerResultReported)
    return projectRunnerResult(view, workId, card, event.payload.agent?.metadata);

  return view;
}

function projectRunTerminal(
  view: BoardProjectionView,
  event: ReturnType<typeof selectRunExecutionEvent> & {},
  workId: string,
  card: StoredCard,
): BoardProjectionView {
  const finishedAt = terminalFinishedAt(event);
  const activeRuns = activeRunsFor(view, card, workId);
  const activeRun = activeRuns[event.stream.id];
  const runDurationMs =
    activeRun === undefined || finishedAt === undefined
      ? 0
      : Date.parse(finishedAt) - Date.parse(activeRun.startedAt);
  const terminal = terminalRunFields(event);
  // Same legacy-checkpoint tolerance as the `children` guard above: a
  // checkpoint persisted before `childRuns` was added round-trips without
  // it, and this is the first read of the field after a Run starts.
  const isChildRun = view.childRuns?.[event.stream.id] === true;
  return {
    ...view,
    cards: {
      ...view.cards,
      [workId]: {
        ...withoutLegacyActiveRun(card),
        activeRuns: withoutActiveRun(activeRuns, event.stream.id),
        ...(terminal === undefined ? {} : { lastRunOutcome: terminal.lastRunOutcome }),
        ...(terminal === undefined ||
        isChildRun ||
        card.condition === BoardCondition.Finished ||
        terminal.condition === undefined
          ? {}
          : { condition: terminal.condition }),
        totalDurationMs: card.totalDurationMs + runDurationMs,
      },
    },
  };
}

function projectRunStarted(
  view: BoardProjectionView,
  event: Extract<
    ReturnType<typeof selectRunExecutionEvent> & {},
    { eventType: typeof ExecutionEventType.RunStarted }
  >,
): BoardProjectionView {
  const workId = view.workflows[event.payload.workflowInstanceId];
  const card = workId === undefined ? undefined : view.cards[workId];
  if (card === undefined || workId === undefined) return view;
  // Same legacy-checkpoint tolerance as the `children` guard in
  // projectWorkflow: a RunStarted event reaches this field independently of
  // that guard, so a checkpoint predating `children` must not crash here either.
  const childAction = view.children?.[event.payload.workflowInstanceId];
  const isChildRun = childAction !== undefined;
  const activeRuns = activeRunsFor(view, card, workId);
  return {
    ...view,
    runs: { ...view.runs, [event.stream.id]: workId },
    ...(isChildRun ? { childRuns: { ...view.childRuns, [event.stream.id]: true } } : {}),
    cards: {
      ...view.cards,
      [workId]: {
        ...(isChildRun
          ? withoutLegacyActiveRun(card)
          : withoutLegacyActiveRun(withoutLastRunOutcome(withoutAwaitingApproval(card)))),
        runCount: card.runCount + 1,
        ...(shouldSetCardActive(card, isChildRun) ? { condition: BoardCondition.Active } : {}),
        lastRunAt: event.payload.startedAt,
        activeRuns: {
          ...activeRuns,
          [event.stream.id]: {
            action: childAction ?? card.stage ?? event.payload.activity,
            startedAt: event.payload.startedAt,
            ...(event.payload.runner?.name === undefined
              ? {}
              : { runnerName: event.payload.runner.name }),
          },
        },
      },
    },
  };
}

function shouldSetCardActive(card: StoredCard, isChildRun: boolean): boolean {
  return !isChildRun && card.condition !== BoardCondition.Finished;
}

function projectRunnerResult(
  view: BoardProjectionView,
  workId: string,
  card: StoredCard,
  metadata: Readonly<Record<string, string | number | boolean | null>> | undefined,
): BoardProjectionView {
  const usage = agentTokenUsage(metadata);
  return {
    ...view,
    cards: {
      ...view.cards,
      [workId]: {
        ...card,
        totalTokens: card.totalTokens + usage.tokens,
        inputTokens: (card.inputTokens ?? 0) + numeric(metadata, 'inputTokens'),
        outputTokens: (card.outputTokens ?? 0) + numeric(metadata, 'outputTokens'),
        cacheReadTokens: (card.cacheReadTokens ?? 0) + numeric(metadata, 'cacheReadTokens'),
        cacheWriteTokens: (card.cacheWriteTokens ?? 0) + numeric(metadata, 'cacheWriteTokens'),
        totalCostUsd: card.totalCostUsd + usage.costUsd,
      },
    },
  };
}

function numeric(
  metadata: Readonly<Record<string, string | number | boolean | null>> | undefined,
  key: string,
): number {
  const value = metadata?.[key];
  return typeof value === 'number' ? value : 0;
}

function withoutAwaitingApproval(card: StoredCard): StoredCard {
  const { awaitingApproval: _awaitingApproval, ...withoutApproval } = card;
  return withoutApproval;
}

function activeRunsFor(
  view: BoardProjectionView,
  card: StoredCard,
  workId: string,
): Readonly<Record<string, StoredActiveRun>> {
  if (card.activeRuns !== undefined) return card.activeRuns;
  if (card.activeRun === undefined) return {};
  const legacyRunId = Object.entries(view.runs)
    .reverse()
    .find(([, runWorkId]) => runWorkId === workId)?.[0];
  return legacyRunId === undefined ? {} : { [legacyRunId]: card.activeRun };
}

function withoutActiveRun(
  activeRuns: Readonly<Record<string, StoredActiveRun>>,
  runId: string,
): Readonly<Record<string, StoredActiveRun>> {
  const { [runId]: _completed, ...remaining } = activeRuns;
  return remaining;
}

function withoutLegacyActiveRun(card: StoredCard): StoredCard {
  const { activeRun: _activeRun, ...withoutRun } = card;
  return withoutRun;
}

function withoutLastRunOutcome(card: StoredCard): StoredCard {
  const { lastRunOutcome: _lastRunOutcome, ...withoutOutcome } = card;
  return withoutOutcome;
}
