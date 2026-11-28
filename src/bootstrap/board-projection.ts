import type { ProjectionDefinition } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../activities/index.js';
import {
  agentTokenUsage,
  ExecutionEventType,
  RunStatus,
  selectRunExecutionEvent,
  type RunExecutionEventData,
} from '../execution/index.js';
import {
  isApprovalAwaitingSignalKind,
  observedRetryDescription,
  OrchestrationEventType,
  orchestrationStatusTransitions,
  selectWorkflowOrchestrationEvent,
  workflowDisplayStatus,
  WorkflowDisplayStatus,
  WorkflowStatus,
  type SignalName,
  type WorkflowOrchestrationEventData,
} from '../orchestration/index.js';
import { toWorkItemKey } from '../surfaces/index.js';
import { selectWorkEvent, WorkEventType } from '../work/index.js';

type WorkflowEvent = NonNullable<ReturnType<typeof selectWorkflowOrchestrationEvent>>;

type WorkflowEventOf<Type extends WorkflowOrchestrationEventData['eventType']> = WorkflowEvent & {
  readonly event: Extract<WorkflowOrchestrationEventData, { readonly eventType: Type }>;
};

type RunEvent = NonNullable<ReturnType<typeof selectRunExecutionEvent>>;

type RunEventOf<Type extends RunExecutionEventData['eventType']> = RunEvent & {
  readonly event: Extract<RunExecutionEventData, { readonly eventType: Type }>;
};

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

const activeRunPhaseShape = {
  [RunStatus.Starting]: true,
  [RunStatus.Started]: true,
} as const;
const activeRunPhases = Object.keys(activeRunPhaseShape);
const ActiveRunPhase = {
  Starting: activeRunPhases[0]! as typeof RunStatus.Starting,
  Started: activeRunPhases[1]! as typeof RunStatus.Started,
} as const;

export type BoardActiveRunPhase = (typeof ActiveRunPhase)[keyof typeof ActiveRunPhase];

export function normalizeBoardActiveRunPhase(phase: unknown): BoardActiveRunPhase {
  return phase === RunStatus.Starting ? ActiveRunPhase.Starting : ActiveRunPhase.Started;
}

interface StoredActiveRun {
  readonly action: string;
  readonly runnerName?: string;
  readonly startedAt: string;
  // Optional only for checkpoints written before phase was introduced.
  readonly phase?: BoardActiveRunPhase;
}

// A cohort the card's primary workflow delegated. Children are keyed by work
// item ID (value: assignment ID, so a corrective child can retire the one it
// replaces); `waiting` is set once the cohort holds the parent workflow.
interface StoredDelegatedCohort {
  readonly cohortId: string;
  readonly children: Readonly<Record<string, string>>;
  readonly finished: Readonly<Record<string, true>>;
  readonly needsAttention: Readonly<Record<string, true>>;
  readonly prerequisiteWaits?: Readonly<Record<string, BoardPrerequisiteWait>>;
  readonly waiting?: true;
  /** The parent's assessment handed a question about its children to a human. */
  readonly escalated?: true;
}

/** What a waiting parent's card shows about its cohort. */
export interface BoardDelegationWait {
  readonly total: number;
  readonly finished: number;
  readonly needsAttention: number;
  readonly escalated?: true;
}

/** A reserved delegated child that has not started: what it was declared to wait on. */
export interface BoardPrerequisiteWait {
  /** The journal's reason once prerequisite readiness blocked the child. */
  readonly reason?: string;
  readonly prerequisites: readonly {
    readonly assignmentId: string;
    readonly output: string;
    readonly condition: string;
  }[];
}

interface StoredCard {
  readonly workItemKey: string;
  readonly workItemId: string;
  readonly objective: string;
  readonly condition: BoardConditionValue;
  readonly frozen?: boolean;
  /** The workflow instance was replaced; the card sits in Finished, not Error. */
  readonly superseded?: true;
  /** Present on a queued delegated child until its workflow starts. */
  readonly prerequisiteWait?: BoardPrerequisiteWait;
  readonly awaitingApproval?: boolean;
  /** Present only while the primary workflow can accept a gate-budget extension. */
  readonly extendEligible?: boolean;
  readonly workflowName?: string;
  readonly stage?: string;
  readonly displayStatus?: string;
  readonly blockReason?: string;
  readonly retryCondition?: string;
  readonly dwellSince: string;
  readonly runCount: number;
  /** Set on delegated children; present only for work created after delegation existed. */
  readonly parentWorkItemKey?: string;
  /** Delegated children created under this card's work item. */
  readonly childCount?: number;
  readonly delegatedCohort?: StoredDelegatedCohort;
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
  readonly workflowBlockReasons?: Readonly<Record<string, string>>;
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
  // Delegated child work item ID -> the parent work item that reserved it, so
  // root-stream delegation facts naming only the child reach the parent card.
  readonly delegatedChildren: Readonly<Record<string, string>>;
}

export const boardProjection: ProjectionDefinition<BoardProjectionView> = {
  name: 'operator-board',
  select: () => ({ key: 'global' }),
  initial: () => ({
    cards: {},
    workflows: {},
    runs: {},
    children: {},
    childRuns: {},
    delegatedChildren: {},
  }),
  project(previous, envelope) {
    const work = selectWorkEvent(envelope);
    if (work !== null) return projectWork(previous, work, envelope.event.occurredAt);
    const workflow = selectWorkflowOrchestrationEvent(envelope);
    if (workflow !== null) return projectWorkflow(previous, workflow, envelope.event.occurredAt);
    const run = selectRunExecutionEvent(envelope);
    return run === null ? previous : projectRun(previous, run, envelope.event.occurredAt);
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

function projectItemCreated(
  view: BoardProjectionView,
  id: string,
  payload: {
    readonly objective: string;
    readonly delegation?: { readonly parentWorkItemId: string } | undefined;
  },
  occurredAt: string,
): BoardProjectionView {
  const parentId = payload.delegation?.parentWorkItemId;
  const parent = parentId === undefined ? undefined : view.cards[parentId];
  const card: StoredCard = {
    workItemKey: toWorkItemKey(id),
    workItemId: id,
    objective: payload.objective,
    condition: BoardCondition.Ready,
    ...(parent?.delegatedCohort?.prerequisiteWaits?.[id] === undefined
      ? {}
      : { prerequisiteWait: parent.delegatedCohort.prerequisiteWaits[id] }),
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
    ...(parentId === undefined ? {} : { parentWorkItemKey: toWorkItemKey(parentId) }),
  };
  return {
    ...view,
    cards: {
      ...view.cards,
      [id]: card,
      ...(parent === undefined
        ? {}
        : { [parent.workItemId]: { ...parent, childCount: (parent.childCount ?? 0) + 1 } }),
    },
  };
}

function projectWork(
  view: BoardProjectionView,
  event: ReturnType<typeof selectWorkEvent> & {},
  occurredAt: string,
): BoardProjectionView {
  const id = event.stream.id;
  const data = event.event;
  if (data.eventType === WorkEventType.ItemCreated)
    return projectItemCreated(view, id, data.payload, occurredAt);
  const current = view.cards[id];
  if (current === undefined) return view;
  if (data.eventType === WorkEventType.ObjectiveRevised)
    return {
      ...view,
      cards: { ...view.cards, [id]: { ...current, objective: data.payload.objective } },
    };
  if (data.eventType === WorkEventType.ItemFrozen)
    return { ...view, cards: { ...view.cards, [id]: { ...current, frozen: true } } };
  if (data.eventType === WorkEventType.ItemUnfrozen) {
    const { frozen: _frozen, ...unfrozen } = current;
    return { ...view, cards: { ...view.cards, [id]: unfrozen } };
  }
  if (
    data.eventType === WorkEventType.ItemClosed ||
    data.eventType === WorkEventType.ItemCancelled
  ) {
    return {
      ...view,
      cards: {
        ...view.cards,
        [id]: {
          ...withoutPrerequisiteWait(
            withoutDelegatedCohort(withoutExtendEligible(withoutAwaitingApproval(current))),
          ),
          condition: BoardCondition.Finished,
        },
      },
    };
  }
  // Deletion is a purge, not a lifecycle outcome — the card must disappear
  // from the board entirely rather than settle into any condition column.
  if (data.eventType === WorkEventType.ItemDeleted) {
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
  if (isWorkflowEventType(event, OrchestrationEventType.InstanceStarted))
    return projectWorkflowStarted(view, event, occurredAt);
  if (isWorkflowEventType(event, OrchestrationEventType.DelegationPrerequisiteBlocked))
    return projectPrerequisiteBlocked(view, event);
  if (event.event.eventType === OrchestrationEventType.InstanceBlocked)
    view = {
      ...view,
      workflowBlockReasons: {
        ...view.workflowBlockReasons,
        [event.stream.id]: event.event.payload.reason,
      },
    };
  return projectDelegation(view, event) ?? projectWorkflowUpdate(view, event, occurredAt);
}

function isWorkflowEventType<Type extends WorkflowOrchestrationEventData['eventType']>(
  event: WorkflowEvent,
  eventType: Type,
): event is WorkflowEventOf<Type> {
  return event.event.eventType === eventType;
}

// Delegation facts land on the root stream (reservation, results) or the
// parent's stream (wait, child blockers, attention, settlement); each is
// attributed to the parent card from its payload or the reservation index.
// Returns undefined for every other event so ordinary handling applies.
function projectDelegation(
  view: BoardProjectionView,
  event: WorkflowEvent,
): BoardProjectionView | undefined {
  const registered = projectReservationFact(view, event);
  if (registered !== undefined) return registered;
  if (isWorkflowEventType(event, OrchestrationEventType.DelegationResultSelected))
    return updateCohort(
      view,
      view.delegatedChildren?.[event.event.payload.childWorkItemId],
      event.event.payload.cohortId,
      (cohort) => ({
        ...cohort,
        finished: { ...cohort.finished, [event.event.payload.childWorkItemId]: true },
        needsAttention: withoutKey(cohort.needsAttention, event.event.payload.childWorkItemId),
      }),
    );
  if (isWorkflowEventType(event, OrchestrationEventType.DelegationChildBlocked))
    return updateCohort(
      view,
      view.delegatedChildren?.[event.event.payload.childWorkItemId] ??
        primaryWorkId(view, event.stream.id),
      undefined,
      (cohort) =>
        cohort.children[event.event.payload.childWorkItemId] === undefined
          ? cohort
          : {
              ...cohort,
              needsAttention: {
                ...cohort.needsAttention,
                [event.event.payload.childWorkItemId]: true,
              },
            },
    );
  if (isWorkflowEventType(event, OrchestrationEventType.DelegationWaitStarted))
    return projectDelegationWaitStarted(view, event);
  if (isWorkflowEventType(event, OrchestrationEventType.DelegationAttentionRequested))
    return updateCohort(
      view,
      primaryWorkId(view, event.stream.id),
      event.event.payload.cohortId,
      withoutEscalation,
    );
  if (isWorkflowEventType(event, OrchestrationEventType.DelegationAttentionResolved))
    return projectDelegationAttentionResolved(view, event);
  if (
    isWorkflowEventType(event, OrchestrationEventType.DelegationJoined) ||
    isWorkflowEventType(event, OrchestrationEventType.DelegationFailed)
  )
    return projectDelegationSettled(view, event);
  return undefined;
}

function projectReservationFact(
  view: BoardProjectionView,
  event: WorkflowEvent,
): BoardProjectionView | undefined {
  if (isWorkflowEventType(event, OrchestrationEventType.DelegationReserved))
    return projectDelegationReserved(view, event);
  if (isWorkflowEventType(event, OrchestrationEventType.DelegationChildSuperseded))
    return projectChildSuperseded(view, event.event.payload.childWorkItemId);
  return undefined;
}

function projectDelegationReserved(
  view: BoardProjectionView,
  event: WorkflowEventOf<typeof OrchestrationEventType.DelegationReserved>,
): BoardProjectionView {
  const reservation = event.event.payload;
  const parentId = reservation.parentWorkItemId;
  const card = view.cards[parentId];
  if (card === undefined || view.children?.[reservation.parentWorkflowInstanceId] !== undefined)
    return view;
  const previous =
    card.delegatedCohort?.cohortId === reservation.cohortId
      ? card.delegatedCohort
      : { cohortId: reservation.cohortId, children: {}, finished: {}, needsAttention: {} };
  const cohort = reservation.children.reduce<StoredDelegatedCohort>(
    (current, child) => ({
      ...withoutReplacedChild(current, child.replaces),
      prerequisiteWaits: {
        ...withoutReplacedChild(current, child.replaces).prerequisiteWaits,
        [child.workItemId]: {
          prerequisites: (child.prerequisites ?? []).map(({ assignmentId, output, condition }) => ({
            assignmentId,
            output,
            condition,
          })),
        },
      },
      children: {
        ...withoutReplacedChild(current, child.replaces).children,
        [child.workItemId]: child.assignmentId,
      },
    }),
    previous,
  );
  const cards = queuedReservationCards(view, event, previous, cohort);
  return {
    ...view,
    delegatedChildren: {
      ...view.delegatedChildren,
      ...Object.fromEntries(reservation.children.map((child) => [child.workItemId, parentId])),
    },
    cards: { ...cards, [parentId]: { ...card, delegatedCohort: cohort } },
  };
}

function queuedReservationCards(
  view: BoardProjectionView,
  event: WorkflowEventOf<typeof OrchestrationEventType.DelegationReserved>,
  previous: StoredDelegatedCohort,
  cohort: StoredDelegatedCohort,
): Readonly<Record<string, StoredCard>> {
  const cards = { ...view.cards };
  // Children dropped by a replacement are no longer queued.
  for (const droppedId of Object.keys(previous.children)) {
    const dropped = cards[droppedId];
    if (cohort.children[droppedId] === undefined && dropped !== undefined)
      cards[droppedId] = withoutPrerequisiteWait(dropped);
  }
  for (const child of event.event.payload.children) {
    const queued = cards[child.workItemId];
    if (
      queued === undefined ||
      queued.stage !== undefined ||
      queued.condition === BoardCondition.Finished
    )
      continue;
    cards[child.workItemId] = {
      ...queued,
      prerequisiteWait: {
        ...(queued.prerequisiteWait?.reason === undefined
          ? {}
          : { reason: queued.prerequisiteWait.reason }),
        prerequisites: (child.prerequisites ?? []).map((prerequisite) => ({
          assignmentId: prerequisite.assignmentId,
          output: prerequisite.output,
          condition: prerequisite.condition,
        })),
      },
    };
  }
  return cards;
}

/** A never-started child has no instance to supersede, so its card is retired from the fact itself. */
function projectChildSuperseded(view: BoardProjectionView, childId: string): BoardProjectionView {
  const card = view.cards[childId];
  if (card === undefined || card.stage !== undefined) return view;
  const { blockReason: _blockReason, ...rest } = withoutPrerequisiteWait(card);
  return {
    ...view,
    cards: {
      ...view.cards,
      [childId]: { ...rest, condition: BoardCondition.Finished, superseded: true },
    },
  };
}

function projectPrerequisiteBlocked(
  view: BoardProjectionView,
  event: WorkflowEventOf<typeof OrchestrationEventType.DelegationPrerequisiteBlocked>,
): BoardProjectionView {
  const { childWorkItemId, reason } = event.event.payload;
  const child = view.cards[childWorkItemId];
  if (child?.prerequisiteWait === undefined) return view;
  return {
    ...view,
    cards: {
      ...view.cards,
      [childWorkItemId]: { ...child, prerequisiteWait: { ...child.prerequisiteWait, reason } },
    },
  };
}

function withoutPrerequisiteWait(card: StoredCard): StoredCard {
  const { prerequisiteWait: _prerequisiteWait, ...rest } = card;
  return rest;
}

function withoutReplacedChild(
  cohort: StoredDelegatedCohort,
  replaces: { readonly cohortId: string; readonly assignmentId: string } | undefined,
): StoredDelegatedCohort {
  if (replaces === undefined || replaces.cohortId !== cohort.cohortId) return cohort;
  const replaced = Object.entries(cohort.children).find(
    ([, assignmentId]) => assignmentId === replaces.assignmentId,
  )?.[0];
  if (replaced === undefined) return cohort;
  return {
    ...cohort,
    children: withoutKey(cohort.children, replaced),
    prerequisiteWaits: withoutKey(cohort.prerequisiteWaits ?? {}, replaced),
    finished: withoutKey(cohort.finished, replaced),
    needsAttention: withoutKey(cohort.needsAttention, replaced),
  };
}

function projectDelegationWaitStarted(
  view: BoardProjectionView,
  event: WorkflowEventOf<typeof OrchestrationEventType.DelegationWaitStarted>,
): BoardProjectionView {
  const workId = primaryWorkId(view, event.stream.id);
  const card = workId === undefined ? undefined : view.cards[workId];
  if (workId === undefined || card === undefined || card.condition === BoardCondition.Finished)
    return view;
  const { cohortId } = event.event.payload;
  const cohort: StoredDelegatedCohort = {
    ...(card.delegatedCohort?.cohortId === cohortId
      ? card.delegatedCohort
      : { cohortId, children: {}, finished: {}, needsAttention: {} }),
    waiting: true,
  };
  return withCohortCard(view, workId, {
    ...withoutExtendEligible(withoutBlockReason(card)),
    delegatedCohort: cohort,
  });
}

function projectDelegationAttentionResolved(
  view: BoardProjectionView,
  event: WorkflowEventOf<typeof OrchestrationEventType.DelegationAttentionResolved>,
): BoardProjectionView {
  const { cohortId, escalation, assessmentFailure } = event.event.payload;
  const workId = primaryWorkId(view, event.stream.id);
  // A failed assessment run is re-raised by orchestration; keep the Error its
  // run terminal already projected rather than masking it as progress.
  if (assessmentFailure !== undefined) return view;
  return updateCohort(view, workId, cohortId, (cohort) =>
    escalation === undefined ? withoutEscalation(cohort) : { ...cohort, escalated: true },
  );
}

function projectDelegationSettled(
  view: BoardProjectionView,
  event: WorkflowEventOf<
    typeof OrchestrationEventType.DelegationJoined | typeof OrchestrationEventType.DelegationFailed
  >,
): BoardProjectionView {
  const workId = primaryWorkId(view, event.stream.id);
  const card = workId === undefined ? undefined : view.cards[workId];
  if (
    workId === undefined ||
    card?.delegatedCohort === undefined ||
    card.delegatedCohort.cohortId !== event.event.payload.cohortId
  )
    return view;
  const settled = withoutDelegatedCohort(card);
  // A child that never started will not now; stop presenting it as queued.
  const cards = { ...view.cards };
  for (const childId of Object.keys(card.delegatedCohort.children)) {
    const child = cards[childId];
    if (child?.prerequisiteWait !== undefined) cards[childId] = withoutPrerequisiteWait(child);
  }
  // A failed cohort is followed by InstanceBlocked, which decides the condition;
  // a joined one resumes ordinary advancement, so it reads Ready until a Run starts.
  const condition =
    event.event.eventType === OrchestrationEventType.DelegationFailed ||
    card.condition === BoardCondition.Finished
      ? card.condition
      : hasPrimaryActiveRun(view, activeRunsFor(view, card, workId))
        ? BoardCondition.Active
        : BoardCondition.Ready;
  return { ...view, cards: { ...cards, [workId]: { ...settled, condition } } };
}

/** Applies `update` to the parent's cohort when it matches, then re-derives a waiting card's condition. */
function updateCohort(
  view: BoardProjectionView,
  workId: string | undefined,
  cohortId: string | undefined,
  update: (cohort: StoredDelegatedCohort) => StoredDelegatedCohort,
): BoardProjectionView {
  const card = workId === undefined ? undefined : view.cards[workId];
  const cohort = card?.delegatedCohort;
  if (
    workId === undefined ||
    card === undefined ||
    cohort === undefined ||
    (cohortId !== undefined && cohort.cohortId !== cohortId)
  )
    return view;
  return withCohortCard(view, workId, { ...card, delegatedCohort: update(cohort) });
}

function withCohortCard(
  view: BoardProjectionView,
  workId: string,
  card: StoredCard,
): BoardProjectionView {
  const cohort = card.delegatedCohort;
  const recondition =
    cohort?.waiting === true &&
    card.condition !== BoardCondition.Finished &&
    card.condition !== BoardCondition.Error;
  return {
    ...view,
    cards: {
      ...view.cards,
      [workId]: recondition
        ? {
            ...card,
            condition: hasPrimaryActiveRun(view, activeRunsFor(view, card, workId))
              ? BoardCondition.Active
              : cohortCondition(cohort),
          }
        : card,
    },
  };
}

// A waiting parent is progressing through its children, so it reads Active;
// it needs a human only when a child is blocked or the parent escalated.
function cohortCondition(cohort: StoredDelegatedCohort): BoardConditionValue {
  return cohort.escalated === true || Object.keys(cohort.needsAttention).length > 0
    ? BoardCondition.NeedsInput
    : BoardCondition.Active;
}

export function boardDelegationWait(card: {
  readonly delegatedCohort?: StoredDelegatedCohort;
}): BoardDelegationWait | undefined {
  const cohort = card.delegatedCohort;
  if (cohort?.waiting !== true) return undefined;
  const children = Object.keys(cohort.children);
  return {
    total: children.length,
    finished: children.filter((id) => cohort.finished[id] === true).length,
    needsAttention: children.filter((id) => cohort.needsAttention[id] === true).length,
    ...(cohort.escalated === true ? { escalated: true } : {}),
  };
}

/**
 * Freezing a work item holds its whole delegated subtree (see Work's delivery
 * availability), but descendants record no freeze of their own. Returns the
 * key of the nearest frozen ancestor on the board, if any.
 */
export function boardFrozenAncestorLookup(
  view: BoardProjectionView,
): (card: {
  readonly parentWorkItemKey?: string;
  readonly condition: BoardConditionValue;
}) => string | undefined {
  const byKey = new Map(Object.values(view.cards).map((card) => [card.workItemKey, card]));
  return (card) => {
    // Finished work has nothing left to pause.
    if (card.condition === BoardCondition.Finished) return undefined;
    const seen = new Set<string>();
    for (
      let parent =
        card.parentWorkItemKey === undefined ? undefined : byKey.get(card.parentWorkItemKey);
      parent !== undefined && !seen.has(parent.workItemKey);
      parent =
        parent.parentWorkItemKey === undefined ? undefined : byKey.get(parent.parentWorkItemKey)
    ) {
      if (parent.frozen === true) return parent.workItemKey;
      seen.add(parent.workItemKey);
    }
    return undefined;
  };
}

/** The card a primary (non-watch-child) workflow stream drives. */
function primaryWorkId(view: BoardProjectionView, streamId: string): string | undefined {
  return view.children?.[streamId] === undefined ? view.workflows[streamId] : undefined;
}

function withoutEscalation(cohort: StoredDelegatedCohort): StoredDelegatedCohort {
  const { escalated: _escalated, ...rest } = cohort;
  return rest;
}

function withoutSuperseded(card: StoredCard): StoredCard {
  const { superseded: _superseded, ...rest } = card;
  return rest;
}

function withoutDelegatedCohort(card: StoredCard): StoredCard {
  const { delegatedCohort: _delegatedCohort, ...rest } = card;
  return rest;
}

function withoutKey<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Readonly<Record<string, Value>> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function projectWorkflowStarted(
  view: BoardProjectionView,
  event: WorkflowEventOf<typeof OrchestrationEventType.InstanceStarted>,
  occurredAt: string,
): BoardProjectionView {
  const workId = event.event.payload.workItemId;
  const card = view.cards[workId];
  if (card === undefined) return view;
  const workflows = { ...view.workflows, [event.stream.id]: workId };
  if ('parentWorkflowInstanceId' in event.event.payload)
    return {
      ...view,
      workflows,
      children: { ...view.children, [event.stream.id]: event.event.payload.entry },
    };
  return {
    ...view,
    cards: {
      ...view.cards,
      [workId]: {
        ...withoutSuperseded(withoutPrerequisiteWait(withoutDelegatedCohort(card))),
        workflowName: event.event.payload.workflowName,
        stage: event.event.payload.entry,
        dwellSince: occurredAt,
        condition: BoardCondition.Ready,
      },
    },
    workflows,
  };
}

function projectFinishedCard(
  view: BoardProjectionView,
  workId: string,
  card: StoredCard,
  event: WorkflowEvent,
): BoardProjectionView {
  if (event.event.eventType !== OrchestrationEventType.InstanceSuperseded) return view;
  return {
    ...view,
    cards: { ...view.cards, [workId]: { ...withoutPrerequisiteWait(card), superseded: true } },
  };
}

function projectWorkflowUpdate(
  view: BoardProjectionView,
  event: ReturnType<typeof selectWorkflowOrchestrationEvent> & {},
  occurredAt: string,
): BoardProjectionView {
  if (view.children?.[event.stream.id] !== undefined) return view;
  const located = lookupWorkflowCard(view, event.stream.id);
  if (located === undefined) return view;
  const { workId, card } = located;
  // Closed/cancelled is terminal for a WorkItem — there is no reopen path
  // (see work-item.spec.md) — so a workflow status event that arrives after
  // closure (e.g. InstanceBlocked from the now-orphaned instance halting)
  // must not resurrect the card out of Finished.
  if (card.condition === BoardCondition.Finished)
    return projectFinishedCard(view, workId, card, event);

  // A new stage is always Ready regardless of the condition it inherits —
  // Error from the prior stage's failed run, or whatever it held before the
  // SignalAccepted that unblocked it — until a Run actually starts (Active)
  // or a fresh SignalWaitStarted arrives (Needs Input).
  if (event.event.eventType === OrchestrationEventType.StageEntered)
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: {
          ...withoutExtendEligible(withoutBlockReason(card)),
          stage: event.event.payload.stage,
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
  if (
    event.event.eventType === OrchestrationEventType.ObservedStateRetryRecorded &&
    event.event.payload.exhausted
  )
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: {
          ...card,
          retryCondition: observedRetryDescription([], true),
        },
      },
    };
  const status = orchestrationStatusTransitions[event.event.eventType];
  if (status === undefined) return view;
  const withCondition = cardForDisplayStatus(card, status, event, view);
  if (event.event.eventType === OrchestrationEventType.SignalWaitStarted)
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: {
          ...withCondition,
          ...awaitingApprovalField(event.event.payload.signalKind),
          ...(event.event.payload.observed === undefined
            ? {}
            : { retryCondition: observedRetryDescription(event.event.payload.observed) }),
        },
      },
    };
  if (event.event.eventType === OrchestrationEventType.SignalAccepted)
    return { ...view, cards: { ...view.cards, [workId]: withoutAwaitingApproval(withCondition) } };
  return { ...view, cards: { ...view.cards, [workId]: withCondition } };
}

function cardForDisplayStatus(
  card: StoredCard,
  status: WorkflowStatus,
  event: WorkflowEvent,
  view: BoardProjectionView,
): StoredCard {
  const blockReason = view.workflowBlockReasons?.[event.stream.id];
  const displayStatus = workflowDisplayStatus({
    status,
    ...(event.event.eventType === OrchestrationEventType.SignalWaitStarted
      ? { waitingFor: event.event.payload }
      : {}),
  });
  return {
    ...cardForWorkflowStatus(card, status, event),
    displayStatus,
    ...(status === WorkflowStatus.Waiting && displayStatus === WorkflowDisplayStatus.Failed
      ? {
          condition: BoardCondition.Error,
          ...(blockReason === undefined ? {} : { blockReason }),
        }
      : {}),
  };
}

function cardForWorkflowStatus(
  card: StoredCard,
  status: WorkflowStatus,
  event: WorkflowEvent,
): StoredCard {
  if (event.event.eventType !== OrchestrationEventType.InstanceBlocked)
    return {
      ...withoutExtendEligible(withoutBlockReason(cardForCohortStatus(card, status))),
      condition: boardConditionForStatus(status, card),
      ...(status === WorkflowStatus.Superseded ? { superseded: true as const } : {}),
    };
  const extensionEligible = isExtendEligibleBlock(event.event.payload.reason);
  const unblocked = withoutDelegatedCohort(card);
  return {
    ...(extensionEligible ? unblocked : withoutExtendEligible(unblocked)),
    condition: boardConditionForStatus(status, card),
    blockReason: event.event.payload.reason,
    ...(extensionEligible ? { extendEligible: true } : {}),
  };
}

// Orchestration drops a delegation wait whenever the instance terminates or blocks.
function cardForCohortStatus(card: StoredCard, status: WorkflowStatus): StoredCard {
  return status === WorkflowStatus.Completed ||
    status === WorkflowStatus.Blocked ||
    status === WorkflowStatus.Superseded
    ? withoutPrerequisiteWait(withoutDelegatedCohort(card))
    : card;
}

function boardConditionForStatus(status: WorkflowStatus, card: StoredCard): BoardConditionValue {
  switch (status) {
    // Orchestration "active" means outstanding work, not a run in flight —
    // the board's Active condition is reserved for RunStarted (below).
    case WorkflowStatus.Active:
      return BoardCondition.Ready;
    case WorkflowStatus.Waiting:
      return BoardCondition.NeedsInput;
    case WorkflowStatus.Blocked:
      return failedOrAmbiguousRun(card.lastRunOutcome)
        ? BoardCondition.Error
        : BoardCondition.NeedsInput;
    case WorkflowStatus.Completed:
      return BoardCondition.Finished;
    // A replaced instance is retired work, not a current failure.
    case WorkflowStatus.Superseded:
      return BoardCondition.Finished;
  }
}

function failedOrAmbiguousRun(outcome: StoredCard['lastRunOutcome']): boolean {
  return outcome === RunStatus.Failed || outcome === RunStatus.Ambiguous;
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

function withoutBlockReason(card: StoredCard): StoredCard {
  const {
    blockReason: _blockReason,
    retryCondition: _retryCondition,
    displayStatus: _displayStatus,
    ...withoutReason
  } = card;
  return withoutReason;
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
  const data = event.event;
  if (
    data.eventType === ExecutionEventType.RunSucceeded ||
    data.eventType === ExecutionEventType.RunFailed ||
    data.eventType === ExecutionEventType.RunCancelled ||
    data.eventType === ExecutionEventType.RunAmbiguous
  )
    return data.payload.finishedAt;
  return undefined;
}

// RunSucceeded is a transport-level fact only: the agent can still report
// a failed/blocked sentinel inside its outcome, so the board's condition
// must follow outcome.kind, not just the event type, or a failed/blocked
// run leaves the card silently stuck on the prior "active" condition.
// The agent activity echoes the raw sentinel it was parsed from verbatim
// under outcome.data.status; preserve NEEDS_CLARIFICATION verbatim on the
// card while every other blocked run keeps its existing 'blocked' label.
function needsClarificationOutcome(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const status = (data as Record<string, unknown>).status;
  return status === 'NEEDS_CLARIFICATION' ? status : undefined;
}

function terminalRunFields(
  event: ReturnType<typeof selectRunExecutionEvent> & {},
): (Pick<StoredCard, 'lastRunOutcome'> & Partial<Pick<StoredCard, 'condition'>>) | undefined {
  const data = event.event;
  if (data.eventType === ExecutionEventType.RunSucceeded) {
    const kind = data.payload.outcome.kind;
    // A successful outcome means the runner has stopped, but does not decide
    // the workflow's next state. Keep the workflow-owned condition until its
    // next lifecycle event (ActivityRequested, SignalWaitStarted, or
    // InstanceCompleted) changes it.
    if (kind === ActivityOutcomeKind.Failed)
      return { lastRunOutcome: kind, condition: BoardCondition.Error };
    if (kind === ActivityOutcomeKind.Blocked)
      return {
        lastRunOutcome: needsClarificationOutcome(data.payload.outcome.data) ?? kind,
        condition: BoardCondition.NeedsInput,
      };
    return { lastRunOutcome: kind };
  }
  if (data.eventType === ExecutionEventType.RunFailed)
    return { lastRunOutcome: RunStatus.Failed, condition: BoardCondition.Error };
  if (data.eventType === ExecutionEventType.RunCancelled)
    return { lastRunOutcome: RunStatus.Cancelled, condition: BoardCondition.Error };
  if (data.eventType === ExecutionEventType.RunAmbiguous)
    return { lastRunOutcome: RunStatus.Ambiguous, condition: BoardCondition.Error };
  return undefined;
}

function projectRun(
  view: BoardProjectionView,
  event: ReturnType<typeof selectRunExecutionEvent> & {},
  _occurredAt: string,
): BoardProjectionView {
  if (isRunEventType(event, ExecutionEventType.RunPreparationStarted))
    return projectRunPreparationStarted(view, event);
  if (isRunEventType(event, ExecutionEventType.RunStarted)) return projectRunStarted(view, event);

  const workId = view.runs[event.stream.id];
  const card = workId === undefined ? undefined : view.cards[workId];
  if (card === undefined || workId === undefined) return view;

  if (runTerminalEventTypes.has(event.event.eventType))
    return projectRunTerminal(view, event, workId, card);

  if (event.event.eventType === ExecutionEventType.RunRunnerResultReported)
    return projectRunnerResult(view, workId, card, event.event.payload.agent?.metadata);

  return view;
}

function isRunEventType<Type extends RunExecutionEventData['eventType']>(
  event: RunEvent,
  eventType: Type,
): event is RunEventOf<Type> {
  return event.event.eventType === eventType;
}

function projectRunPreparationStarted(
  view: BoardProjectionView,
  event: RunEventOf<typeof ExecutionEventType.RunPreparationStarted>,
): BoardProjectionView {
  return projectNewRun(view, event, ActiveRunPhase.Starting);
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
  const remainingActiveRuns = withoutActiveRun(activeRuns, event.stream.id);
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
        activeRuns: remainingActiveRuns,
        ...(terminal === undefined ? {} : { lastRunOutcome: terminal.lastRunOutcome }),
        ...(card.condition === BoardCondition.Finished
          ? {}
          : hasPrimaryActiveRun(view, remainingActiveRuns)
            ? { condition: BoardCondition.Active }
            : terminal === undefined || isChildRun || terminal.condition === undefined
              ? {}
              : { condition: settledRunCondition(card, terminal.condition) }),
        totalDurationMs: card.totalDurationMs + runDurationMs,
      },
    },
  };
}

// A delegating run's own outcome is held, not routed, while its cohort holds
// the workflow, so a blocked sentinel there means "waiting on my children",
// not "a human is needed". Failed or ambiguous runs still read as Error.
function settledRunCondition(
  card: StoredCard,
  condition: BoardConditionValue,
): BoardConditionValue {
  return condition === BoardCondition.NeedsInput && card.delegatedCohort?.waiting === true
    ? cohortCondition(card.delegatedCohort)
    : condition;
}

function hasPrimaryActiveRun(
  view: BoardProjectionView,
  activeRuns: Readonly<Record<string, StoredActiveRun>>,
): boolean {
  return Object.keys(activeRuns).some((runId) => view.childRuns?.[runId] !== true);
}

function projectRunStarted(
  view: BoardProjectionView,
  event: RunEventOf<typeof ExecutionEventType.RunStarted>,
): BoardProjectionView {
  const workId = view.workflows[event.event.payload.workflowInstanceId];
  const card = workId === undefined ? undefined : view.cards[workId];
  if (card === undefined || workId === undefined) return view;
  // Same legacy-checkpoint tolerance as the `children` guard in
  // projectWorkflow: a RunStarted event reaches this field independently of
  // that guard, so a checkpoint predating `children` must not crash here either.
  const childAction = view.children?.[event.event.payload.workflowInstanceId];
  const isChildRun = childAction !== undefined;
  const activeRuns = activeRunsFor(view, card, workId);
  const activeRun = activeRuns[event.stream.id];
  if (activeRun !== undefined)
    return {
      ...view,
      runs: { ...view.runs, [event.stream.id]: workId },
      ...(isChildRun ? { childRuns: { ...view.childRuns, [event.stream.id]: true } } : {}),
      cards: {
        ...view.cards,
        [workId]: {
          ...withoutLegacyActiveRun(card),
          activeRuns: {
            ...activeRuns,
            [event.stream.id]: { ...activeRun, phase: ActiveRunPhase.Started },
          },
        },
      },
    };
  return projectNewRun(view, event, ActiveRunPhase.Started);
}

function projectNewRun(
  view: BoardProjectionView,
  event: RunEventOf<
    typeof ExecutionEventType.RunPreparationStarted | typeof ExecutionEventType.RunStarted
  >,
  phase: BoardActiveRunPhase,
): BoardProjectionView {
  const target = newRunTarget(view, event);
  if (target === undefined) return view;
  const { workId } = target;
  return {
    ...view,
    runs: { ...view.runs, [event.stream.id]: workId },
    ...childRunReference(view, event, target.isChildRun),
    cards: {
      ...view.cards,
      [workId]: newRunCard(view, event, target, phase),
    },
  };
}

function newRunTarget(
  view: BoardProjectionView,
  event: RunEventOf<
    typeof ExecutionEventType.RunPreparationStarted | typeof ExecutionEventType.RunStarted
  >,
):
  | {
      readonly workId: string;
      readonly card: StoredCard;
      readonly childAction: string | undefined;
      readonly isChildRun: boolean;
    }
  | undefined {
  const workId = view.workflows[event.event.payload.workflowInstanceId];
  const card = workId === undefined ? undefined : view.cards[workId];
  if (workId === undefined || card === undefined) return undefined;
  const childAction = view.children?.[event.event.payload.workflowInstanceId];
  return { workId, card, childAction, isChildRun: childAction !== undefined };
}

function childRunReference(
  view: BoardProjectionView,
  event: RunEventOf<
    typeof ExecutionEventType.RunPreparationStarted | typeof ExecutionEventType.RunStarted
  >,
  isChildRun: boolean,
): Pick<BoardProjectionView, 'childRuns'> | Record<string, never> {
  return isChildRun ? { childRuns: { ...view.childRuns, [event.stream.id]: true } } : {};
}

function newRunCard(
  view: BoardProjectionView,
  event: RunEventOf<
    typeof ExecutionEventType.RunPreparationStarted | typeof ExecutionEventType.RunStarted
  >,
  target: {
    readonly workId: string;
    readonly card: StoredCard;
    readonly childAction: string | undefined;
    readonly isChildRun: boolean;
  },
  phase: BoardActiveRunPhase,
): StoredCard {
  const { card, childAction, isChildRun, workId } = target;
  const activeRuns = activeRunsFor(view, card, workId);
  const alreadyRegistered = view.runs[event.stream.id] !== undefined;
  return {
    ...(isChildRun
      ? withoutLegacyActiveRun(card)
      : withoutLegacyActiveRun(withoutLastRunOutcome(withoutAwaitingApproval(card)))),
    runCount: alreadyRegistered ? card.runCount : card.runCount + 1,
    ...(shouldSetCardActive(card, isChildRun) ? { condition: BoardCondition.Active } : {}),
    lastRunAt: event.event.payload.startedAt,
    activeRuns: {
      ...activeRuns,
      [event.stream.id]: newActiveRun(event, childAction, card, phase),
    },
  };
}

function newActiveRun(
  event: RunEventOf<
    typeof ExecutionEventType.RunPreparationStarted | typeof ExecutionEventType.RunStarted
  >,
  childAction: string | undefined,
  card: StoredCard,
  phase: BoardActiveRunPhase,
): StoredActiveRun {
  return {
    action: childAction ?? event.event.payload.stage ?? card.stage ?? event.event.payload.activity,
    startedAt: event.event.payload.startedAt,
    phase,
    ...(event.event.payload.runner?.name === undefined
      ? {}
      : { runnerName: event.event.payload.runner.name }),
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

function withoutExtendEligible(card: StoredCard): StoredCard {
  const { extendEligible: _extendEligible, ...withoutExtension } = card;
  return withoutExtension;
}

function isExtendEligibleBlock(reason: string): boolean {
  return reason.startsWith('watch group budget exhausted for ');
}

function activeRunsFor(
  view: BoardProjectionView,
  card: StoredCard,
  workId: string,
): Readonly<Record<string, StoredActiveRun>> {
  if (card.activeRuns !== undefined)
    return Object.fromEntries(
      Object.entries(card.activeRuns).map(([runId, activeRun]) => [
        runId,
        normalizedActiveRun(activeRun),
      ]),
    );
  if (card.activeRun === undefined) return {};
  const legacyRunId = Object.entries(view.runs)
    .reverse()
    .find(([, runWorkId]) => runWorkId === workId)?.[0];
  return legacyRunId === undefined ? {} : { [legacyRunId]: normalizedActiveRun(card.activeRun) };
}

function normalizedActiveRun(activeRun: StoredActiveRun): StoredActiveRun {
  return { ...activeRun, phase: normalizeBoardActiveRunPhase(activeRun.phase) };
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
