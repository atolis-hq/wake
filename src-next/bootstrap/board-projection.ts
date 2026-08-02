import { ExecutionEventType, selectRunExecutionEvent } from '../execution/index.js';
import type { ProjectionDefinition } from '../kernel/index.js';
import {
  OrchestrationEventType,
  selectWorkflowOrchestrationEvent,
} from '../orchestration/index.js';
import { selectWorkEvent, WorkEventType } from '../work/index.js';

const conditionShape = {
  ready: true,
  active: true,
  'needs-human': true,
  error: true,
  finished: true,
};
const conditions = Object.keys(conditionShape);
const BoardCondition = {
  Ready: conditions[0]!,
  Active: conditions[1]!,
  NeedsHuman: conditions[2]!,
  Error: conditions[3]!,
  Finished: conditions[4]!,
} as const;

type BoardConditionValue = (typeof BoardCondition)[keyof typeof BoardCondition];

interface StoredCard {
  readonly workItemKey: string;
  readonly workItemId: string;
  readonly objective: string;
  readonly condition: BoardConditionValue;
  readonly workflowName?: string;
  readonly stage?: string;
  readonly dwellSince: string;
  readonly runCount: number;
}

export interface BoardProjectionView {
  readonly cards: Readonly<Record<string, StoredCard>>;
  readonly workflows: Readonly<Record<string, string>>;
}

export const boardProjection: ProjectionDefinition<BoardProjectionView> = {
  name: 'operator-board',
  select: () => ({ key: 'global' }),
  initial: () => ({ cards: {}, workflows: {} }),
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
      workItemKey: `wk_${id}`,
      workItemId: id,
      objective: event.payload.objective,
      condition: BoardCondition.Ready,
      dwellSince: occurredAt,
      runCount: 0,
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
  const workId = view.workflows[event.stream.id];
  const card = workId === undefined ? undefined : view.cards[workId];
  if (card === undefined || workId === undefined) return view;
  if (event.eventType === OrchestrationEventType.StageEntered)
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: { ...card, stage: event.payload.stage, dwellSince: occurredAt },
      },
    };
  if (
    event.eventType === OrchestrationEventType.InstanceBlocked ||
    event.eventType === OrchestrationEventType.ActivityWaiting
  )
    return {
      ...view,
      cards: { ...view.cards, [workId]: { ...card, condition: BoardCondition.NeedsHuman } },
    };
  if (event.eventType === OrchestrationEventType.InstanceCompleted)
    return {
      ...view,
      cards: { ...view.cards, [workId]: { ...card, condition: BoardCondition.Finished } },
    };
  return view;
}

function projectRun(
  view: BoardProjectionView,
  event: ReturnType<typeof selectRunExecutionEvent> & {},
  _occurredAt: string,
): BoardProjectionView {
  if (event.eventType !== ExecutionEventType.RunStarted) return view;
  const workId = view.workflows[event.payload.workflowInstanceId];
  const card = workId === undefined ? undefined : view.cards[workId];
  if (card === undefined || workId === undefined) return view;
  return {
    ...view,
    cards: {
      ...view.cards,
      [workId]: { ...card, runCount: card.runCount + 1, condition: BoardCondition.Active },
    },
  };
}
