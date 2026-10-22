import { WrongExpectedSequenceError, type CommandContext } from '@atolis-hq/eventing';
import { activationId, type ActivityName } from '../../activities/index.js';
import type { DelegationArtifacts, DelegationMessages } from '../contracts/delegation-ports.js';
import type {
  DelegationAttentionBlocker,
  DelegationAttentionReply,
  DelegationCaller,
  DelegationReservation,
} from '../contracts/delegation.js';
import { OrchestrationEventType, type WorkflowOrchestrationEvent } from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { DelegationAttentionRejection, DelegationBlockerKind } from '../contracts/vocabulary.js';
import { nextOrdinal } from '../domain/decision-events.js';
import {
  assertReplyAllowed,
  assessedBlockers,
  attentionKeyOf,
  blockerOf,
  canRequestAssessment,
  contextBlockerId,
  digest,
  MaxAssessmentAttempts,
  reject,
  resolutionDrafts,
  type AttentionVerdict,
  type OpenAttention,
} from './delegation-attention-state.js';
import { delegationDraft, isSettled, type DelegationLedger } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

export interface DelegationAttentionDependencies {
  readonly artifacts: DelegationArtifacts;
  /** True when the delegating activity can handle a typed attention activation. */
  readonly supportsAttention: (activity: ActivityName) => boolean;
  /** Resumes a child workflow blocked for clarification; idempotent per command id. */
  readonly resumeChild: (
    id: WorkflowInstanceId,
    context: CommandContext,
  ) => Promise<WorkflowInstanceView | null>;
  /** Work items whose artifacts the parent may reference (its own hierarchy). */
  readonly contextWorkItems: (parent: WorkflowInstanceView) => Promise<ReadonlySet<string>>;
  /** Where a parent's free-text answer is posted: the child's own conversation. */
  readonly messages?: DelegationMessages | undefined;
  /** Run end and delivery availability gate every attention continuation, like the join. */
  readonly canContinue: (reservation: DelegationReservation) => Promise<boolean>;
}

/** Durable cohort/blocker state for the parent attention protocol. */
export class DelegationAttention {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly ledger: DelegationLedger,
    private readonly dependencies: DelegationAttentionDependencies,
  ) {}

  /** Unresolved reasons for the cohort: recorded child blockers plus live clarification requests. */
  async blockers(
    reservation: DelegationReservation,
    events: readonly WorkflowOrchestrationEvent[],
  ): Promise<DelegationAttentionBlocker[]> {
    const blockers: DelegationAttentionBlocker[] = [];
    for (const child of reservation.children) {
      const recorded = events.flatMap(({ event }) =>
        event.eventType === OrchestrationEventType.DelegationChildBlocked &&
        event.payload.childWorkItemId === child.workItemId
          ? [event.payload.reason]
          : [],
      )[0];
      const view =
        recorded === undefined ? (await this.repository.load(child.workflowInstanceId)).view : null;
      const blocker = blockerOf(child, recorded, view);
      if (blocker !== undefined) blockers.push(blocker);
    }
    return blockers;
  }

  /**
   * Starts one coalesced assessment at the delegating stage when an unassessed reason exists.
   * Join and attention share the parent's single activation: this only acts from the cohort wait.
   * Callers settle fully terminal batches through the ordinary unsuccessful continuation instead.
   */
  async raise(reservation: DelegationReservation, context: CommandContext): Promise<void> {
    const events = await this.ledger.events();
    if (isSettled(events, reservation)) return;
    const blockers = await this.blockers(reservation, events);
    const assessed = assessedBlockers(events, reservation);
    if (!blockers.some((blocker) => !assessed.has(blocker.blockerId))) return;
    if (!(await this.dependencies.canContinue(reservation))) return;
    const attentionKey = attentionKeyOf(
      reservation,
      blockers.map((blocker) => blocker.blockerId),
    );
    for (;;) {
      const loaded = await this.repository.loadRequired(reservation.parentWorkflowInstanceId);
      if (!canRequestAssessment(loaded.view, reservation)) return;
      if (await this.request(reservation, loaded, { attentionKey, blockers }, context)) return;
    }
  }

  /**
   * A human replied on the parent while children wait on a clarification. The reply is new
   * information on blockers already assessed, so wake the parent once per reply to decide how
   * to pass it on; replaying the same reply never wakes it twice.
   */
  async raiseForReply(
    reservation: DelegationReservation,
    replyEntryId: string,
    context: CommandContext,
  ): Promise<void> {
    const events = await this.ledger.events();
    if (isSettled(events, reservation)) return;
    const blockers = (await this.blockers(reservation, events)).filter(
      (blocker) => blocker.kind === DelegationBlockerKind.Context,
    );
    if (blockers.length === 0 || !(await this.dependencies.canContinue(reservation))) return;
    const attentionKey = `${attentionKeyOf(
      reservation,
      blockers.map((blocker) => blocker.blockerId),
    )}:reply:${digest(replyEntryId)}`;
    const asked = events.some(
      ({ event }) =>
        event.eventType === OrchestrationEventType.DelegationAttentionRequested &&
        event.payload.attentionKey === attentionKey,
    );
    if (asked) return;
    for (;;) {
      const loaded = await this.repository.loadRequired(reservation.parentWorkflowInstanceId);
      if (!canRequestAssessment(loaded.view, reservation)) return;
      if (await this.request(reservation, loaded, { attentionKey, blockers }, context)) return;
    }
  }

  /** Returns false when a concurrent append won and the caller must re-read. */
  private async request(
    reservation: DelegationReservation,
    loaded: { readonly sequence: number; readonly view: WorkflowInstanceView },
    input: {
      readonly attentionKey: string;
      readonly blockers: DelegationAttentionBlocker[];
    },
    context: CommandContext,
  ): Promise<boolean> {
    const id = reservation.parentWorkflowInstanceId;
    const { events } = await this.repository.history(id);
    const original = events.find(
      (entry) =>
        entry.event.eventType === OrchestrationEventType.ActivityRequested &&
        entry.event.payload.activationId === reservation.activationId,
    );
    if (original?.event.eventType !== OrchestrationEventType.ActivityRequested)
      throw new Error('Missing delegating activation');
    const requested = original.event.payload;
    const keyId = digest(input.attentionKey);
    if (!this.dependencies.supportsAttention(requested.activity)) {
      await this.ledger.appendOnce(id, context, `attention-unsupported:${keyId}`, {
        eventType: OrchestrationEventType.DelegationReconciliationFailed,
        payload: {
          cohortId: reservation.cohortId,
          reason:
            'Child work needs attention but the delegating activity cannot assess it; ' +
            'an operator must inspect the blockers',
        },
      });
      return true;
    }
    const ordinal = nextOrdinal(loaded.view);
    const attentionActivation = activationId(`${id}:activity:${ordinal}`);
    try {
      await this.repository.append(id, loaded.sequence, [
        delegationDraft(
          context,
          `attention:${keyId}:${ordinal}`,
          {
            eventType: OrchestrationEventType.DelegationAttentionRequested,
            payload: {
              cohortId: reservation.cohortId,
              attentionKey: input.attentionKey,
              activationId: attentionActivation,
              revision: reservation.planRevision ?? 1,
              blockers: input.blockers,
            },
          },
          id,
        ),
        delegationDraft(
          context,
          `attention-activity:${keyId}:${ordinal}`,
          {
            eventType: OrchestrationEventType.ActivityRequested,
            payload: {
              ...requested,
              activationId: attentionActivation,
              ordinal,
              sessionPolicy: 'fresh',
            },
          },
          id,
        ),
      ]);
      return true;
    } catch (error) {
      if (error instanceof WrongExpectedSequenceError) return false;
      throw error;
    }
  }

  /** The open attention request for a parent, with the replies already accepted. */
  async current(parent: WorkflowInstanceView): Promise<OpenAttention | null> {
    const attention = parent.delegationAttention;
    if (attention === undefined) return null;
    const { events } = await this.repository.history(parent.workflowInstanceId);
    const request = events.flatMap(({ event }) =>
      event.eventType === OrchestrationEventType.DelegationAttentionRequested &&
      event.payload.attentionKey === attention.attentionKey
        ? [event.payload]
        : [],
    )[0];
    if (request === undefined) return null;
    const responses = events.flatMap(({ event }) =>
      event.eventType === OrchestrationEventType.DelegationAttentionResponded &&
      event.payload.attentionKey === attention.attentionKey
        ? [event.payload]
        : [],
    );
    return { ...request, responses };
  }

  /**
   * Accepts a parent reply for one context blocker. Everything Wake relies on is re-derived here;
   * a restart replays an accepted reply to completion because each step is idempotent.
   */
  async respond(
    caller: DelegationCaller,
    reply: DelegationAttentionReply,
    context: CommandContext,
  ): Promise<void> {
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    const attention = await this.current(parent);
    const prior = assertReplyAllowed(parent, attention, caller, reply);
    const reservation = (await this.ledger.reservations()).find(
      (entry) =>
        entry.parentWorkflowInstanceId === parent.workflowInstanceId &&
        entry.cohortId === attention!.cohortId,
    );
    const child = reservation?.children.find((entry) => entry.workItemId === reply.childWorkItemId);
    if (reservation === undefined || child === undefined)
      throw reject(DelegationAttentionRejection.UnknownBlocker, 'Unknown delegated child');
    const allowed = await this.dependencies.contextWorkItems(parent);
    if (reply.references.some((reference) => !allowed.has(reference.workItemId)))
      throw reject(
        DelegationAttentionRejection.OutsideHierarchy,
        'Delegation context is outside the parent hierarchy',
      );
    const childView = (await this.repository.load(child.workflowInstanceId)).view;
    const stillBlocked =
      childView !== null && contextBlockerId(child, childView) === reply.blockerId;
    if (!stillBlocked && prior === undefined)
      throw reject(
        DelegationAttentionRejection.NotBlocked,
        'The child is no longer blocked for this assignment context',
      );
    await this.dependencies.artifacts.validateInputs(parent, reply.references);
    const key = digest(reply.blockerId);
    await this.ledger.appendOnce(parent.workflowInstanceId, context, `response:${key}`, {
      eventType: OrchestrationEventType.DelegationAttentionResponded,
      payload: { cohortId: attention!.cohortId, attentionKey: attention!.attentionKey, ...reply },
    });
    if (reply.references.length > 0)
      await this.dependencies.artifacts.registerChild(
        {
          delegationId: `${child.grantId}:response:${key}`,
          parentWorkItemId: reservation.parentWorkItemId,
          childWorkItemId: child.workItemId,
          childReferences: reply.references,
        },
        context,
      );
    // Posted before the child resumes, so its next turn reads the answer.
    if (reply.message !== undefined)
      await this.dependencies.messages?.post(
        {
          workItemId: child.workItemId,
          entryId: `delegation-reply:${key}`,
          authorId: `delegation:${reservation.parentWorkItemId}`,
          body: reply.message,
        },
        context,
      );
    if (stillBlocked)
      await this.dependencies.resumeChild(child.workflowInstanceId, {
        ...context,
        commandId: `delegation-response:${key}`,
      });
  }

  /** Ends the assessment and restores the unresolved wait; a pending join then proceeds. */
  async resolve(
    parentId: WorkflowInstanceId,
    attentionActivation: string,
    context: CommandContext,
    verdict: AttentionVerdict = {},
  ): Promise<WorkflowInstanceView> {
    for (;;) {
      const loaded = await this.repository.loadRequired(parentId);
      const attention = loaded.view.delegationAttention;
      if (attention === undefined || attention.activationId !== attentionActivation)
        return loaded.view;
      const exhausted =
        verdict.failure !== undefined &&
        (await this.priorFailures(parentId, attention.attentionKey)) + 1 >= MaxAssessmentAttempts;
      try {
        await this.repository.append(
          parentId,
          loaded.sequence,
          resolutionDrafts(context, parentId, attention, { ...verdict, exhausted }),
        );
        return (await this.repository.loadRequired(parentId)).view;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
  }

  private async priorFailures(parentId: WorkflowInstanceId, attentionKey: string) {
    const { events } = await this.repository.history(parentId);
    return events.filter(
      ({ event }) =>
        event.eventType === OrchestrationEventType.DelegationAttentionResolved &&
        event.payload.attentionKey === attentionKey &&
        event.payload.assessmentFailure !== undefined,
    ).length;
  }
}
