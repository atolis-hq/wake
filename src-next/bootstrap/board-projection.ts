import { ActivityOutcomeKind } from '../activities/index.js';
import {
  agentTokenUsage,
  ExecutionEventType,
  RunStatus,
  selectRunExecutionEvent,
} from '../execution/index.js';
import type { ProjectionDefinition } from '../kernel/index.js';
import {
  OrchestrationEventType,
  selectWorkflowOrchestrationEvent,
} from '../orchestration/index.js';
import { toWorkItemKey } from '../surfaces/api/contracts/work.js';
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
  readonly awaitingApproval?: boolean;
  readonly workflowName?: string;
  readonly stage?: string;
  readonly dwellSince: string;
  readonly runCount: number;
  readonly activeRun?: StoredActiveRun;
  readonly lastRunAt?: string;
  readonly lastRunOutcome?: string;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
}

export interface BoardProjectionView {
  readonly cards: Readonly<Record<string, StoredCard>>;
  readonly workflows: Readonly<Record<string, string>>;
  readonly runs: Readonly<Record<string, string>>;
}

export const boardProjection: ProjectionDefinition<BoardProjectionView> = {
  name: 'operator-board',
  select: () => ({ key: 'global' }),
  initial: () => ({ cards: {}, workflows: {}, runs: {} }),
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
      totalTokens: 0,
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
  if (
    event.eventType === WorkEventType.ItemClosed ||
    event.eventType === WorkEventType.ItemCancelled
  ) {
    return {
      ...view,
      cards: { ...view.cards, [id]: { ...current, condition: BoardCondition.Finished } },
    };
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
      workflows: { ...view.workflows, [event.stream.id]: workId },
    };
  }
  const located = lookupWorkflowCard(view, event.stream.id);
  if (located === undefined) return view;
  const { workId, card } = located;
  if (event.eventType === OrchestrationEventType.StageEntered)
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: { ...card, stage: event.payload.stage, dwellSince: occurredAt },
      },
    };
  if (isBlockedOrWaiting(event.eventType))
    return {
      ...view,
      cards: { ...view.cards, [workId]: { ...card, condition: BoardCondition.NeedsInput } },
    };
  if (event.eventType === OrchestrationEventType.SignalWaitStarted)
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: {
          ...card,
          condition: BoardCondition.NeedsInput,
          ...awaitingApprovalField(event.payload.signalKind),
        },
      },
    };
  if (event.eventType === OrchestrationEventType.SignalAccepted)
    return {
      ...view,
      cards: { ...view.cards, [workId]: withoutAwaitingApproval(card) },
    };
  if (event.eventType === OrchestrationEventType.InstanceCompleted)
    return {
      ...view,
      cards: { ...view.cards, [workId]: { ...card, condition: BoardCondition.Finished } },
    };
  return view;
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

function isBlockedOrWaiting(eventType: string): boolean {
  return (
    eventType === OrchestrationEventType.InstanceBlocked ||
    eventType === OrchestrationEventType.ActivityWaiting
  );
}

function awaitingApprovalField(signalKind: string) {
  return signalKind === 'approved' ? { awaitingApproval: true } : {};
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
): Pick<StoredCard, 'lastRunOutcome' | 'condition'> | undefined {
  if (event.eventType === ExecutionEventType.RunSucceeded) {
    const kind = event.payload.outcome.kind;
    return {
      lastRunOutcome: kind,
      condition:
        kind === ActivityOutcomeKind.Failed
          ? BoardCondition.Error
          : kind === ActivityOutcomeKind.Blocked
            ? BoardCondition.NeedsInput
            : BoardCondition.Active,
    };
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

  if (runTerminalEventTypes.has(event.eventType)) {
    const finishedAt = terminalFinishedAt(event);
    const runDurationMs =
      card.activeRun === undefined || finishedAt === undefined
        ? 0
        : Date.parse(finishedAt) - Date.parse(card.activeRun.startedAt);
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: {
          ...withoutActiveRun(card),
          ...terminalRunFields(event),
          totalDurationMs: card.totalDurationMs + runDurationMs,
        },
      },
    };
  }

  if (event.eventType === ExecutionEventType.RunRunnerResultReported)
    return projectRunnerResult(view, workId, card, event.payload.agent?.metadata);

  return view;
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
  return {
    ...view,
    runs: { ...view.runs, [event.stream.id]: workId },
    cards: {
      ...view.cards,
      [workId]: {
        ...withoutAwaitingApproval(card),
        runCount: card.runCount + 1,
        condition: BoardCondition.Active,
        lastRunAt: event.payload.startedAt,
        activeRun: {
          action: card.stage ?? event.payload.activity,
          startedAt: event.payload.startedAt,
          ...(event.payload.runner?.name === undefined
            ? {}
            : { runnerName: event.payload.runner.name }),
        },
      },
    },
  };
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
        totalCostUsd: card.totalCostUsd + usage.costUsd,
      },
    },
  };
}

function withoutAwaitingApproval(card: StoredCard): StoredCard {
  const { awaitingApproval: _awaitingApproval, ...withoutApproval } = card;
  return withoutApproval;
}

function withoutActiveRun(card: StoredCard): StoredCard {
  const { activeRun: _activeRun, ...withoutRun } = card;
  return withoutRun;
}
