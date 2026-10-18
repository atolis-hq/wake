import type { WorkItemId } from '../../work/index.js';
import type { DelegationAuthority } from '../contracts/delegation-ports.js';
/* eslint-disable max-lines */
import { WrongExpectedSequenceError, type CommandContext } from '@atolis-hq/eventing';
import { activationId } from '../../activities/index.js';
import { readDeliveryAvailability, WorkStatus, type WorkService } from '../../work/index.js';
import type { DelegationArtifacts } from '../contracts/delegation-ports.js';
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
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import { nextOrdinal } from '../domain/decision-events.js';
import { isSuccessfulWorkflowCompletion } from '../domain/workflow-completion.js';
import type { CoordinationClaims } from './coordination-claims.js';
import {
  delegationDraft,
  delegationEventId,
  DelegationLedger,
  isJoined,
  isSettled,
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

const defaultLimits: DelegationLimits = { maxDepth: 1, maxDescendants: 8 };

/**
 * Durable delegation of independent child WorkItems. Reservation is the single commit point;
 * every later boundary is reconciled idempotently from it, and the parent stays fenced until join.
 */
export class DelegatedWork {
  private readonly ledger: DelegationLedger;
  private readonly artifacts: DelegationArtifacts;
  private readonly runHasEnded: (runId: string) => Promise<boolean>;

  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly work: WorkService,
    private readonly claims: CoordinationClaims,
    private readonly definitions: WorkflowDefinitionRegistry,
    private readonly workflows: StartWorkflow,
    private readonly dependencies: {
      readonly artifacts: DelegationArtifacts;
      readonly runHasEnded: (runId: string) => Promise<boolean>;
      readonly authority?: DelegationAuthority | undefined;
    },
  ) {
    this.ledger = new DelegationLedger(repository);
    this.artifacts = dependencies.artifacts;
    this.runHasEnded = dependencies.runHasEnded;
  }

  async inspect(id: WorkItemId) {
    const item = await this.work.get(id);
    const root = item?.delegation?.rootWorkItemId ?? id;
    const reservations = (await this.ledger.reservations()).filter(
      (entry) => entry.rootWorkItemId === root,
    );
    return Promise.all(
      reservations.map(async (reservation) => ({
        ...reservation,
        children: await Promise.all(
          reservation.children.map(async (child) => ({
            ...child,
            work: await this.work.get(child.workItemId),
            workflow: (await this.repository.load(child.workflowInstanceId)).view,
          })),
        ),
      })),
    );
  }

  async runLimit(id: WorkItemId): Promise<number | undefined> {
    const item = await this.work.get(id);
    const root = item?.delegation?.rootWorkItemId ?? id;
    const reserved = (await this.ledger.reservations()).find(
      (entry) => entry.rootWorkItemId === root,
    )?.maxConcurrentRuns;
    if (reserved !== undefined) return reserved;
    const claim = await this.claims.primaryWorkflowInstanceId(root);
    if (claim === undefined) return undefined;
    const view = (await this.repository.load(workflowInstanceId(claim))).view;
    if (view === null) return undefined;
    return (await this.definitions.resolve(view)).delegation?.maxConcurrentRuns;
  }

  async contextWorkItems(parent: WorkflowInstanceView): Promise<ReadonlySet<string>> {
    const item = await this.work.get(parent.workItemId);
    const allowed = new Set<string>([parent.workItemId, ...(item?.delegation?.ancestors ?? [])]);
    for (const reservation of await this.ledger.reservations())
      if (reservation.parentWorkItemId === parent.workItemId)
        for (const child of reservation.children) allowed.add(child.workItemId);
    return allowed;
  }

  async results(id: WorkflowInstanceId, cohortId: string): Promise<readonly DelegationResult[]> {
    const events = await this.ledger.events();
    const joined = events.find(
      (entry) =>
        entry.stream.id === id &&
        entry.event.eventType === OrchestrationEventType.DelegationJoined &&
        entry.event.payload.cohortId === cohortId,
    );
    return joined?.event.eventType === OrchestrationEventType.DelegationJoined
      ? joined.event.payload.results
      : [];
  }

  async reserve(
    caller: DelegationCaller,
    cohortId: string,
    assignments: readonly DelegatedAssignment[],
    context: CommandContext,
    limits: DelegationLimits = defaultLimits,
  ): Promise<DelegationReservation> {
    const artifacts = this.artifacts;
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    const identity = await this.parentIdentity(parent);
    let reservation = buildReservation(identity.parent, caller, cohortId, assignments, limits);
    for (let attempt = 0; attempt < 8; attempt++) {
      const { events: rootFacts, sequence } = await this.repository.history(identity.root);
      const events = await this.ledger.events();
      const all = reservationsOf(rootFacts).filter(
        (entry) => entry.rootWorkItemId === reservation.rootWorkItemId,
      );
      const rootLimits = {
        ...rootRunLimit(all, limits),
        maxDepth: all[0]?.maxDepth ?? limits.maxDepth,
        maxDescendants: all[0]?.maxDescendants ?? limits.maxDescendants,
      };
      reservation = buildReservation(identity.parent, caller, cohortId, assignments, rootLimits);
      const prior = all.find((entry) => entry.cohortId === cohortId);
      if (prior !== undefined) {
        if (!sameDelegation(prior, reservation)) throw new Error('Delegation replay conflict');
        await this.reconcile(context);
        return prior;
      }
      await this.assertReservable(
        caller,
        await this.capacityReservations(all, events),
        reservation,
        rootLimits,
      );
      for (const child of reservation.children)
        await this.prepareChild(artifacts, parent, child, context);
      if (await this.commit(identity.root, sequence, reservation, context)) {
        await this.reconcile(context);
        return reservation;
      }
    }
    throw new Error('Delegation reservation contention exceeded retry limit');
  }

  async reconcile(context: CommandContext): Promise<void> {
    const all = await this.ledger.reservations();
    if (all.length === 0) return;
    const events = await this.ledger.events();
    const reservations = all.filter((reservation) => !isSettled(events, reservation));
    if (reservations.length === 0) return;
    const artifacts = this.artifacts;
    for (const reservation of reservations) {
      try {
        await this.reconcileReservation(artifacts, reservation, context);
      } catch (error) {
        // Registration faults remain retryable, but cannot interrupt other cohorts or watch children.
        const reason =
          error instanceof Error && error.message.length > 0
            ? error.message
            : 'Delegation reconciliation failed';
        const reasonCode = 'reconciliation-unavailable';
        try {
          await this.ledger.appendOnce(
            reservation.parentWorkflowInstanceId,
            context,
            `reconcile-failed:${reservation.cohortId}:${reasonCode}`,
            {
              eventType: OrchestrationEventType.DelegationReconciliationFailed,
              payload: { cohortId: reservation.cohortId, reason },
            },
          );
        } catch (diagnosticError) {
          console.warn(
            `Delegation ${reservation.cohortId} diagnostic could not be persisted`,
            diagnosticError,
          );
        }
      }
    }
  }

  private async capacityReservations(
    reservations: readonly DelegationReservation[],
    events: Awaited<ReturnType<DelegationLedger['events']>>,
  ): Promise<readonly DelegationReservation[]> {
    const capacity = [];
    for (const reservation of reservations) {
      // Only a failed cohort releases capacity, and only for children that have terminated;
      // joined and unsettled cohorts keep every reservation so the root bound stays durable.
      if (isJoined(events, reservation) || !isSettled(events, reservation)) {
        capacity.push(reservation);
        continue;
      }
      const children = [];
      for (const child of reservation.children) {
        const view = (await this.repository.load(child.workflowInstanceId)).view;
        if (
          view?.status === WorkflowStatus.Active ||
          view?.status === WorkflowStatus.Waiting ||
          view?.status === WorkflowStatus.Blocked
        )
          children.push(child);
      }
      capacity.push({ ...reservation, children });
    }
    return capacity;
  }

  private async parentIdentity(
    parent: WorkflowInstanceView,
  ): Promise<{ parent: ReservationParent; root: WorkflowInstanceId }> {
    const availability = await readDeliveryAvailability(parent.workItemId, this.work);
    if (availability.reason !== undefined) throw new Error(availability.reason);
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
    const availability = await readDeliveryAvailability(reservation.parentWorkItemId, this.work);
    if (availability.reason !== undefined) throw new Error(availability.reason);
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
    const allowed = await this.contextWorkItems(parent);
    if (child.context.some((reference) => !allowed.has(reference.workItemId)))
      throw new Error('Delegation context is outside the parent hierarchy');
    await artifacts.validateInputs(parent, child.context);
    const current = this.definitions.currentDefinition(child.workflowName);
    if (current.fingerprint !== child.workflowFingerprint)
      throw new Error('Delegation workflow fingerprint must match current configuration');
    const definition = current.definition;
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
    expectedSequence: number,
    reservation: DelegationReservation,
    context: CommandContext,
  ): Promise<boolean> {
    try {
      await this.repository.append(root, expectedSequence, [
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
    if (isSettled(await this.ledger.events(), reservation)) return;
    if (
      (await readDeliveryAvailability(reservation.parentWorkItemId, this.work)).reason !== undefined
    )
      return;
    const parent = (await this.repository.loadRequired(reservation.parentWorkflowInstanceId)).view;
    if (parent.status !== WorkflowStatus.Active && parent.status !== WorkflowStatus.Waiting) {
      await this.fail(reservation, 'Delegating parent is no longer active or waiting', context);
      return;
    }
    if (!(await this.ensureWait(reservation, context))) return;
    const root = await this.registerChildren(artifacts, reservation, context);
    for (const child of reservation.children) {
      if (isSettled(await this.ledger.events(), reservation)) break;
      await this.advanceChild(artifacts, root, reservation, child, context);
    }
    const results = selectedResults(await this.ledger.events(), reservation);
    if (reservation.children.every((c) => results.some((r) => r.childWorkItemId === c.workItemId)))
      await this.join(reservation, results, context);
  }

  private async ensureWait(
    reservation: DelegationReservation,
    context: CommandContext,
  ): Promise<boolean> {
    const id = reservation.parentWorkflowInstanceId;
    for (;;) {
      const loaded = await this.repository.loadRequired(id);
      if (
        loaded.view.status !== WorkflowStatus.Active &&
        loaded.view.status !== WorkflowStatus.Waiting
      )
        return false;
      if (loaded.view.delegationWait?.cohortId === reservation.cohortId) return true;
      // The reservation commits on the root stream, so the parent's delegating activation is
      // re-validated here under the parent's own sequence guard before any child can start.
      if (loaded.view.pendingActivation?.activationId !== reservation.activationId) {
        await this.fail(reservation, 'Delegating activation is no longer current', context);
        return false;
      }
      try {
        await this.repository.append(id, loaded.sequence, [
          delegationDraft(
            context,
            `wait:${reservation.cohortId}`,
            {
              eventType: OrchestrationEventType.DelegationWaitStarted,
              payload: { cohortId: reservation.cohortId, activationId: reservation.activationId },
            },
            id,
          ),
        ]);
        return true;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
  }

  private async fail(
    reservation: DelegationReservation,
    reason: string,
    context: CommandContext,
  ): Promise<void> {
    const id = reservation.parentWorkflowInstanceId;
    for (;;) {
      const loaded = await this.repository.loadRequired(id);
      if (isSettled(await this.ledger.events(), reservation)) return;
      const drafts = [
        delegationDraft(
          context,
          `failed:${reservation.cohortId}`,
          {
            eventType: OrchestrationEventType.DelegationFailed,
            payload: { cohortId: reservation.cohortId, reason },
          },
          id,
        ),
      ];
      if (
        loaded.view.status === WorkflowStatus.Active ||
        loaded.view.status === WorkflowStatus.Waiting
      )
        drafts.push(
          delegationDraft(
            context,
            `block:${reservation.cohortId}`,
            {
              eventType: OrchestrationEventType.InstanceBlocked,
              payload: { reason },
            },
            id,
          ),
        );
      try {
        await this.repository.append(id, loaded.sequence, drafts);
        return;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
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
          },
        },
        childContext,
      );
      await this.dependencies.authority?.registerRepositories(child, childContext);
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
    if (
      (await readDeliveryAvailability(reservation.parentWorkItemId, this.work)).reason !== undefined
    )
      return;
    const existing = await this.repository.load(child.workflowInstanceId);
    if (await this.childWorkTerminated(child.workItemId, existing.view)) {
      await this.fail(reservation, 'Delegated child work is no longer open', context);
      return;
    }
    const workflow =
      existing.view ??
      (await this.workflows.execute(
        {
          workflowInstanceId: child.workflowInstanceId,
          workItemId: child.workItemId,
          workflowName: child.workflowName,
          workflowDefinitionFingerprint: child.workflowFingerprint,
          orchestrationGroupId: orchestrationGroupId(`primary:${child.workItemId}`),
        },
        { ...context, commandId: `delegation-start:${child.grantId}` },
      ));
    // Accepted activation alone never qualifies: the workflow must complete successfully.
    if (
      workflow.status === WorkflowStatus.Superseded ||
      (workflow.status === WorkflowStatus.Completed && !isSuccessfulWorkflowCompletion(workflow))
    ) {
      await this.fail(reservation, `Child ${child.workItemId} terminated without success`, context);
      return;
    }
    if (workflow.status !== WorkflowStatus.Completed) return;
    const selected = selectedResults(await this.ledger.events(), reservation);
    if (selected.some((result) => result.childWorkItemId === child.workItemId)) return;
    const outputs = await artifacts.qualifyingOutputs(workflow, child.outputs);
    if (outputs === null) {
      await this.missingOutputs(root, reservation, child, context);
      return;
    }
    const satisfied =
      outputs.length === child.outputs.length &&
      child.outputs.every(
        (required) =>
          outputs.filter(
            (output) =>
              output.name === required.name && output.reference.workItemId === child.workItemId,
          ).length === 1,
      );
    if (!satisfied) {
      await this.fail(reservation, 'Invalid qualifying output contract', context);
      return;
    }
    await this.ledger.appendOnce(root, context, `result:${child.grantId}`, {
      eventType: OrchestrationEventType.DelegationResultSelected,
      payload: { cohortId: reservation.cohortId, childWorkItemId: child.workItemId, outputs },
    });
  }

  private async childWorkTerminated(
    id: DelegationReservation['parentWorkItemId'],
    view: WorkflowInstanceView | null,
  ): Promise<boolean> {
    if (view?.status === WorkflowStatus.Completed) return false;
    const item = await this.work.get(id);
    return item === null || item.deleted === true || item.state !== WorkStatus.Open;
  }

  private async missingOutputs(
    root: WorkflowInstanceId,
    reservation: DelegationReservation,
    child: DelegationReservation['children'][number],
    context: CommandContext,
  ): Promise<void> {
    const key = `outputs-pending:${child.grantId}`;
    const observed = (await this.ledger.events()).find(
      (entry) => entry.event.eventId === delegationEventId(root, key),
    );
    if (observed === undefined) {
      await this.ledger.appendOnce(root, context, key, {
        eventType: OrchestrationEventType.DelegationReconciliationFailed,
        payload: {
          cohortId: reservation.cohortId,
          reason: 'Completed child outputs are not yet visible',
        },
      });
      return;
    }
    if (observed.event.causationId !== context.commandId)
      await this.fail(
        reservation,
        `Child ${child.workItemId} completed without required outputs`,
        context,
      );
  }

  private endedRun(id: string): Promise<boolean> {
    return this.runHasEnded(id);
  }

  private async canJoin(reservation: DelegationReservation): Promise<boolean> {
    return (
      (await this.endedRun(reservation.runId)) &&
      (await readDeliveryAvailability(reservation.parentWorkItemId, this.work)).reason === undefined
    );
  }

  /** Join and continuation commit together, so a duplicate trigger cannot resume the parent twice. */
  private async join(
    reservation: DelegationReservation,
    results: readonly DelegationResult[],
    context: CommandContext,
  ): Promise<void> {
    if (!(await this.canJoin(reservation))) return;
    const parentId = reservation.parentWorkflowInstanceId;
    for (;;) {
      const loaded = await this.repository.loadRequired(parentId);
      const joinId = delegationEventId(parentId, `join:${reservation.cohortId}`);
      const { events } = await this.repository.history(parentId);
      if (events.some((event) => event.event.eventId === joinId)) return;
      if (
        loaded.view.status !== WorkflowStatus.Waiting ||
        loaded.view.delegationWait?.cohortId !== reservation.cohortId ||
        isSettled(await this.ledger.events(), reservation)
      )
        return;
      const original = events.find(
        (entry) =>
          entry?.event.eventType === OrchestrationEventType.ActivityRequested &&
          entry.event.payload.activationId === reservation.activationId,
      );
      if (original?.event.eventType !== OrchestrationEventType.ActivityRequested)
        throw new Error('Missing delegating activation');
      const requested = original.event.payload;
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
            payload: {
              ...requested,
              activationId: activationId(`${parentId}:activity:${nextOrdinal(loaded.view)}`),
              ordinal: nextOrdinal(loaded.view),
              sessionPolicy: 'fresh',
            },
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

function rootRunLimit(
  reservations: readonly DelegationReservation[],
  limits: DelegationLimits,
): Pick<DelegationLimits, 'maxConcurrentRuns'> {
  const maxConcurrentRuns = reservations[0]?.maxConcurrentRuns ?? limits.maxConcurrentRuns;
  return maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns };
}
