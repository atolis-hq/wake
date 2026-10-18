/* eslint-disable max-lines */
import {
  WrongExpectedSequenceError,
  type CommandContext,
  type EventJournal,
} from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../../activities/index.js';
import type { ArtifactDelegationGrant, ArtifactRevisionReference } from '../../artifacts/index.js';
import { WorkStatus, type WorkService } from '../../work/index.js';
import type {
  DelegatedAssignment,
  DelegationCaller,
  DelegationLimits,
  DelegationReservation,
  DelegationResult,
} from '../contracts/delegation.js';
import { OrchestrationEventType } from '../contracts/events.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  type WorkflowInstanceId,
} from '../contracts/identifiers.js';
import { workflowInstanceStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import { activation, nextOrdinal } from '../domain/decision-events.js';
import type { CoordinationClaims } from './coordination-claims.js';
import {
  DelegationLedger,
  delegationDraft,
  delegationEventId,
  isJoined,
  reservationsOf,
  reservedEvent,
  selectedResults,
} from './delegation-ledger.js';
import {
  assertWithinRootLimits,
  buildReservation,
  sameDelegation,
  type ReservationParent,
} from './delegation-reservation.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';
import type { WorkflowDefinitionRegistry } from './workflow-definition-registry.js';

/** Trusted Bootstrap adapters; no provider, Run or session authority is supplied by assignments. */
export interface DelegationArtifacts {
  validateInputs(
    parent: WorkflowInstanceView,
    references: readonly ArtifactRevisionReference[],
  ): Promise<void>;
  registerChild(grant: ArtifactDelegationGrant, context: CommandContext): Promise<void>;
  qualifyingOutputs(
    child: WorkflowInstanceView,
    outputs: DelegatedAssignment['outputs'],
  ): Promise<DelegationResult['outputs'] | null>;
}

const defaultLimits: DelegationLimits = { maxDepth: 1, maxDescendants: 8 };

/**
 * Durable delegation of independent child WorkItems. Reservation is the single commit point;
 * every later boundary is reconciled idempotently from it, and the parent stays fenced until join.
 */
export class DelegatedWork {
  private artifacts: DelegationArtifacts | undefined;
  private readonly ledger: DelegationLedger;

  constructor(
    private readonly journal: EventJournal,
    private readonly repository: OrchestrationRepository,
    private readonly work: WorkService,
    private readonly claims: CoordinationClaims,
    private readonly definitions: WorkflowDefinitionRegistry,
    private readonly workflows: StartWorkflow,
  ) {
    this.ledger = new DelegationLedger(journal, repository);
  }

  setArtifacts(artifacts: DelegationArtifacts): void {
    this.artifacts = artifacts;
  }

  fences(id: WorkflowInstanceId, activationId?: string): Promise<boolean> {
    return this.ledger.fences(id, activationId);
  }

  async reserve(
    caller: DelegationCaller,
    cohortId: string,
    assignments: readonly DelegatedAssignment[],
    context: CommandContext,
    limits: DelegationLimits = defaultLimits,
  ): Promise<DelegationReservation> {
    const artifacts = this.requireArtifacts();
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    const identity = await this.parentIdentity(parent);
    const reservation = buildReservation(identity.parent, caller, cohortId, assignments, limits);
    for (;;) {
      const events = await this.ledger.events();
      const all = reservationsOf(events).filter(
        (entry) => entry.rootWorkItemId === reservation.rootWorkItemId,
      );
      const prior = all.find((entry) => entry.cohortId === cohortId);
      if (prior !== undefined) {
        if (!sameDelegation(prior, reservation)) throw new Error('Delegation replay conflict');
        await this.reconcile(context);
        return prior;
      }
      await this.assertReservable(caller, all, reservation, limits);
      for (const child of reservation.children)
        await this.prepareChild(artifacts, parent, child, context);
      if (await this.commit(identity.root, events, reservation, context)) break;
    }
    await this.reconcile(context);
    return reservation;
  }

  async reconcile(context: CommandContext): Promise<void> {
    if (this.artifacts === undefined) return;
    for (const reservation of await this.ledger.reservations())
      await this.reconcileReservation(this.artifacts, reservation, context);
  }

  private requireArtifacts(): DelegationArtifacts {
    if (this.artifacts === undefined) throw new Error('Delegation adapters unavailable');
    return this.artifacts;
  }

  private async parentIdentity(
    parent: WorkflowInstanceView,
  ): Promise<{ parent: ReservationParent; root: WorkflowInstanceId }> {
    const item = await this.work.get(parent.workItemId);
    if (item === null || item.state !== WorkStatus.Open || item.frozen || item.deleted)
      throw new Error('Delegation requires open, unfrozen work');
    if (parent.parentWorkflowInstanceId !== undefined)
      throw new Error('Watch workflows cannot delegate independent work');
    const rootWorkItemId = item.delegation?.rootWorkItemId ?? item.workItemId;
    const rootClaim = await this.claims.primaryWorkflowInstanceId(rootWorkItemId);
    if (rootClaim === undefined) throw new Error('Delegation root has no primary workflow');
    return {
      root: workflowInstanceId(rootClaim),
      parent: {
        workflowInstanceId: parent.workflowInstanceId,
        workItemId: item.workItemId,
        rootWorkItemId,
        ancestors: [...(item.delegation?.ancestors ?? []), item.workItemId],
      },
    };
  }

  private async assertReservable(
    caller: DelegationCaller,
    existing: readonly DelegationReservation[],
    reservation: DelegationReservation,
    limits: DelegationLimits,
  ): Promise<void> {
    const current = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    if (
      current.pendingActivation?.activationId !== caller.activationId ||
      current.status !== WorkflowStatus.Active
    )
      throw new Error('Delegation requires the current active activation');
    if (
      existing.some(
        (entry) =>
          entry.parentWorkflowInstanceId === reservation.parentWorkflowInstanceId &&
          entry.activationId === caller.activationId,
      )
    )
      throw new Error('Activation already committed a cohort');
    assertWithinRootLimits(existing, reservation, limits);
  }

  /** Validates inputs and pins the selected definition before anything is committed. */
  private async prepareChild(
    artifacts: DelegationArtifacts,
    parent: WorkflowInstanceView,
    child: DelegationReservation['children'][number],
    context: CommandContext,
  ): Promise<void> {
    await artifacts.validateInputs(parent, child.context);
    const definition = await this.definitions.resolve(
      {
        workflowName: child.workflowName,
        workflowDefinitionFingerprint: child.workflowFingerprint,
      },
      { journalFallback: true },
    );
    await this.definitions.register(
      child.workflowName,
      child.workflowFingerprint,
      definition,
      context,
    );
  }

  /** Appends the reservation only if the root stream is unchanged since `events` was read. */
  private async commit(
    root: WorkflowInstanceId,
    events: Awaited<ReturnType<DelegationLedger['events']>>,
    reservation: DelegationReservation,
    context: CommandContext,
  ): Promise<boolean> {
    const loaded = await this.repository.loadRequired(root);
    const rootEvents = await this.journal.readStream(workflowInstanceStream(root));
    const known = new Set(events.map((event) => event.event.eventId));
    if (
      rootEvents.length !== loaded.sequence ||
      rootEvents.some((e) => !known.has(e.event.eventId))
    )
      return false;
    try {
      await this.repository.append(root, loaded.sequence, [
        delegationDraft(
          context,
          `reserve:${reservation.cohortId}`,
          { eventType: OrchestrationEventType.DelegationReserved, payload: reservation },
          root,
        ),
      ]);
      return true;
    } catch (error) {
      if (error instanceof WrongExpectedSequenceError) return false;
      throw error;
    }
  }

  private async reconcileReservation(
    artifacts: DelegationArtifacts,
    reservation: DelegationReservation,
    context: CommandContext,
  ): Promise<void> {
    if (isJoined(await this.ledger.events(), reservation)) return;
    await this.ledger.appendOnce(
      reservation.parentWorkflowInstanceId,
      context,
      `wait:${reservation.cohortId}`,
      {
        eventType: OrchestrationEventType.DelegationWaitStarted,
        payload: { cohortId: reservation.cohortId, activationId: reservation.activationId },
      },
    );
    const root = await this.registerChildren(artifacts, reservation, context);
    for (const child of reservation.children)
      await this.advanceChild(artifacts, root, reservation, child, context);
    const results = selectedResults(await this.ledger.events(), reservation.cohortId);
    if (reservation.children.every((c) => results.some((r) => r.childWorkItemId === c.workItemId)))
      await this.join(reservation, results, context);
  }

  /** WorkItem, primary claim and artifact grant are each idempotent; none starts a workflow. */
  private async registerChildren(
    artifacts: DelegationArtifacts,
    reservation: DelegationReservation,
    context: CommandContext,
  ): Promise<WorkflowInstanceId> {
    const committed = reservedEvent(await this.ledger.events(), reservation).event;
    for (const child of reservation.children) {
      const childContext = {
        commandId: `delegation:${child.grantId}`,
        occurredAt: committed.occurredAt,
        correlationId: committed.correlationId,
        actor: committed.actor,
      };
      await this.work.create(
        {
          workItemId: child.workItemId,
          objective: child.objective,
          delegation: {
            parentWorkItemId: reservation.parentWorkItemId,
            rootWorkItemId: reservation.rootWorkItemId,
            ancestors: reservation.ancestors,
            assignmentId: child.assignmentId,
            criteria: child.criteria,
          },
        },
        childContext,
      );
      await this.claims.claimPrimary(child.workItemId, child.workflowInstanceId, childContext);
      await artifacts.registerChild(
        {
          delegationId: child.grantId,
          parentWorkItemId: reservation.parentWorkItemId,
          childWorkItemId: child.workItemId,
          childReferences: child.context,
        },
        childContext,
      );
    }
    const rootClaim = await this.claims.primaryWorkflowInstanceId(reservation.rootWorkItemId);
    if (rootClaim === undefined) throw new Error('Missing delegation root');
    const root = workflowInstanceId(rootClaim);
    await this.ledger.appendOnce(root, context, `registered:${reservation.cohortId}`, {
      eventType: OrchestrationEventType.DelegationRegistered,
      payload: { cohortId: reservation.cohortId },
    });
    return root;
  }

  /** Starts the pinned definition, then records the result only once the child qualifies. */
  private async advanceChild(
    artifacts: DelegationArtifacts,
    root: WorkflowInstanceId,
    reservation: DelegationReservation,
    child: DelegationReservation['children'][number],
    context: CommandContext,
  ): Promise<void> {
    const workflow = await this.workflows.execute(
      {
        workflowInstanceId: child.workflowInstanceId,
        workItemId: child.workItemId,
        workflowName: child.workflowName,
        workflowDefinitionFingerprint: child.workflowFingerprint,
        orchestrationGroupId: orchestrationGroupId(`primary:${child.workItemId}`),
      },
      { ...context, commandId: `delegation-start:${child.grantId}` },
    );
    // Accepted activation alone never qualifies: the workflow must complete successfully.
    if (
      workflow.status !== WorkflowStatus.Completed ||
      workflow.lastOutcome?.kind !== ActivityOutcomeKind.Done
    )
      return;
    const selected = selectedResults(await this.ledger.events(), reservation.cohortId);
    if (selected.some((result) => result.childWorkItemId === child.workItemId)) return;
    const outputs = await artifacts.qualifyingOutputs(workflow, child.outputs);
    if (outputs === null) return;
    const satisfied =
      outputs.length === child.outputs.length &&
      child.outputs.every(
        (required) =>
          outputs.filter(
            (output) =>
              output.name === required.name && output.reference.workItemId === child.workItemId,
          ).length === 1,
      );
    if (!satisfied) throw new Error('Invalid qualifying output contract');
    await this.ledger.appendOnce(root, context, `result:${child.grantId}`, {
      eventType: OrchestrationEventType.DelegationResultSelected,
      payload: { cohortId: reservation.cohortId, childWorkItemId: child.workItemId, outputs },
    });
  }

  /** Join and continuation commit together, so a duplicate trigger cannot resume the parent twice. */
  private async join(
    reservation: DelegationReservation,
    results: readonly DelegationResult[],
    context: CommandContext,
  ): Promise<void> {
    const parentId = reservation.parentWorkflowInstanceId;
    for (;;) {
      const loaded = await this.repository.loadRequired(parentId);
      const joinId = delegationEventId(parentId, `join:${reservation.cohortId}`);
      const events = await this.journal.readStream(workflowInstanceStream(parentId));
      if (events.some((event) => event.event.eventId === joinId)) return;
      if (loaded.view.delegationWait?.cohortId !== reservation.cohortId)
        throw new Error('Delegation wait changed');
      const definition = await this.workflows.definitionFor(loaded.view);
      const stage = definition.stages[loaded.view.currentStage];
      if (stage === undefined) throw new Error('Missing delegation continuation stage');
      const base = typeof stage.with === 'object' && stage.with !== null ? stage.with : {};
      const drafts = [
        delegationDraft(
          context,
          `join:${reservation.cohortId}`,
          {
            eventType: OrchestrationEventType.DelegationJoined,
            payload: { cohortId: reservation.cohortId, results },
          },
          parentId,
        ),
        delegationDraft(
          context,
          `continue:${reservation.cohortId}`,
          {
            eventType: OrchestrationEventType.ActivityRequested,
            payload: activation(
              loaded.view.workflowInstanceId,
              nextOrdinal(loaded.view),
              stage.activity,
              { ...base, delegation: { cohortId: reservation.cohortId, results } },
              {
                stage: loaded.view.currentStage,
                execution: stage.execution,
                sessionPolicy: 'fresh',
              },
            ),
          },
          parentId,
        ),
      ];
      try {
        await this.repository.append(parentId, loaded.sequence, drafts);
        return;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
  }
}
