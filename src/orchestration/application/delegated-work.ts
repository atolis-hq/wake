import type { WorkItemId } from '../../work/index.js';
import type { DelegationAuthority } from '../contracts/delegation-ports.js';
/* eslint-disable max-lines */
import { WrongExpectedSequenceError, type CommandContext } from '@atolis-hq/eventing';
import type { ActivityName } from '../../activities/index.js';
import { activationId } from '../../activities/index.js';
import { WorkspaceMode } from '../../execution/index.js';
import { WorkStatus, type WorkService } from '../../work/index.js';
import type { DelegationArtifacts, DelegationRepositories } from '../contracts/delegation-ports.js';
import type {
  DelegatedAssignment,
  DelegationCaller,
  DelegationLimits,
  DelegationReservation,
  DelegationResult,
} from '../contracts/delegation.js';
import { DelegationConflictError } from '../contracts/delegation.js';
import { OrchestrationEventType } from '../contracts/events.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  type WorkflowInstanceId,
} from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  DelegationConflictCode,
  DelegationPrerequisiteCondition,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import { nextOrdinal } from '../domain/decision-events.js';
import { isSuccessfulWorkflowCompletion } from '../domain/workflow-completion.js';
import type { CoordinationClaims } from './coordination-claims.js';
import {
  DelegationAttention,
  type DelegationAttentionDependencies,
} from './delegation-attention.js';
import {
  delegationDraft,
  delegationEventId,
  DelegationLedger,
  isJoined,
  isSettled,
  reservationsOf,
  reservedEvent,
  selectedResults,
  unsettledReservations,
} from './delegation-ledger.js';
import { DelegationPrerequisites } from './delegation-prerequisites.js';
import {
  assertWithinRootLimits,
  buildReservation,
  matchesAssignments,
  type ReservationParent,
} from './delegation-reservation.js';
import { resolvePrerequisites } from './delegation-wait-graph.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { PrerequisiteReadiness } from './prerequisite-readiness.js';
import type { StartWorkflow } from './start-workflow.js';
import type { WorkflowDefinitionRegistry } from './workflow-definition-registry.js';

const defaultLimits: DelegationLimits = { maxDepth: 1, maxDescendants: 8 };

/**
 * Durable delegation of independent child WorkItems. Reservation is the single commit point;
 * every later boundary is reconciled idempotently from it, and the parent stays fenced until join.
 */
export class DelegatedWork {
  private readonly ledger: DelegationLedger;
  readonly prerequisites: DelegationPrerequisites;
  readonly attention: DelegationAttention;
  private readonly artifacts: DelegationArtifacts;
  private readonly repositories: DelegationRepositories | undefined;
  private readonly runHasEnded: (runId: string) => Promise<boolean>;

  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly work: WorkService,
    private readonly claims: CoordinationClaims,
    private readonly definitions: WorkflowDefinitionRegistry,
    private readonly workflows: StartWorkflow,
    private readonly dependencies: {
      readonly artifacts: DelegationArtifacts;
      readonly repositories?: DelegationRepositories | undefined;
      readonly runHasEnded: (runId: string) => Promise<boolean>;
      readonly authority?: DelegationAuthority | undefined;
      readonly supportsAttention?: ((activity: ActivityName) => boolean) | undefined;
      readonly resumeChild?: DelegationAttentionDependencies['resumeChild'] | undefined;
    },
  ) {
    this.ledger = new DelegationLedger(repository);
    this.artifacts = dependencies.artifacts;
    this.attention = new DelegationAttention(repository, this.ledger, {
      artifacts: dependencies.artifacts,
      supportsAttention: (activity) => dependencies.supportsAttention?.(activity) ?? true,
      resumeChild: (id, context) =>
        dependencies.resumeChild?.(id, context) ?? Promise.resolve(null),
      contextWorkItems: (parent) => this.contextWorkItems(parent),
      canContinue: (reservation) => this.canJoin(reservation),
    });
    this.prerequisites = new DelegationPrerequisites(
      repository,
      this.ledger,
      dependencies.artifacts,
      dependencies.repositories,
      work,
    );
    this.repositories = dependencies.repositories;
    this.runHasEnded = dependencies.runHasEnded;
  }

  async inspect(id: WorkItemId) {
    const item = await this.work.get(id);
    const root = item?.delegation?.rootWorkItemId ?? id;
    const events = await this.ledger.events();
    const reservations = reservationsOf(events).filter((entry) => entry.rootWorkItemId === root);
    const read = await this.prerequisites.read();
    return Promise.all(
      reservations.map(async (reservation) => ({
        ...reservation,
        settled: isSettled(events, reservation),
        failureReason: events.flatMap(({ event, stream }) =>
          stream.id === reservation.parentWorkflowInstanceId &&
          event.eventType === OrchestrationEventType.DelegationFailed &&
          event.payload.cohortId === reservation.cohortId
            ? [event.payload.reason]
            : [],
        )[0],
        children: await Promise.all(
          reservation.children.map(async (child) => ({
            ...child,
            work: await this.work.get(child.workItemId),
            prerequisiteBlocker:
              (await read.reason(child.workItemId)) ?? childBlocker(events, child.workItemId),
            consumedInputs: read.inputs(child.workItemId),
            workflow: read.workflow(child.workflowInstanceId) ?? null,
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

  async repositoryScope(workItemId: string) {
    const child = (await this.ledger.reservations())
      .flatMap((entry) => entry.children)
      .find((entry) => entry.workItemId === workItemId);
    if (child === undefined) return undefined;
    return (
      child.repositoryResourceIds ??
      (child.repository === undefined ? [] : [child.repository.resourceId])
    );
  }

  async repositoryFor(workItemId: string) {
    const inputs = await this.prerequisites.inputs(workItemId);
    if (inputs?.repository !== undefined) return inputs.repository;
    return (await this.ledger.reservations())
      .flatMap((entry) => entry.children)
      .find((child) => child.workItemId === workItemId)?.repository;
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
    expectedPlanRevision?: number,
  ): Promise<DelegationReservation> {
    const artifacts = this.artifacts;
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    const identity = await this.parentIdentity(parent);
    const prior = (await this.ledger.reservations()).find(
      (entry) =>
        entry.rootWorkItemId === identity.parent.rootWorkItemId && entry.cohortId === cohortId,
    );
    if (prior !== undefined) {
      assertReplay(prior, caller, assignments);
      await this.reconcile(context);
      return prior;
    }
    const pinned = await this.pinAssignments(parent, assignments);
    let reservation = buildReservation(identity.parent, caller, cohortId, pinned, limits);
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
      reservation = buildReservation(identity.parent, caller, cohortId, pinned, rootLimits);
      const prior = all.find((entry) => entry.cohortId === cohortId);
      if (prior !== undefined) {
        assertReplay(prior, caller, assignments);
        await this.reconcile(context);
        return prior;
      }
      await this.assertReservable(
        caller,
        await this.capacityReservations(all, events),
        reservation,
        rootLimits,
      );
      assertPlanRevision(expectedPlanRevision, all.length);
      reservation = { ...reservation, planRevision: all.length + 1 };
      reservation = await resolvePrerequisites(
        reservation,
        all,
        this.ledger,
        this.definitions,
        async (target, name) => {
          const view = (await this.repository.load(target.workflowInstanceId)).view;
          const output = target.outputs.find((entry) => entry.name === name);
          return (
            view !== null &&
            output !== undefined &&
            (await artifacts.prerequisiteOutput?.(
              view,
              output,
              DelegationPrerequisiteCondition.MergedChange,
            )) != null
          );
        },
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

  private async pinAssignments(
    parent: WorkflowInstanceView,
    assignments: readonly DelegatedAssignment[],
  ) {
    return Promise.all(
      assignments.map(async (assignment) => {
        if (assignment.repository === undefined) return assignment;
        if (this.repositories === undefined)
          throw new Error('Delegation repository resolver unavailable');
        return {
          ...assignment,
          repository: await this.repositories.resolve(parent, assignment.repository),
        };
      }),
    );
  }

  async reconcile(context: CommandContext): Promise<void> {
    const events = await this.ledger.events();
    const reservations = unsettledReservations(events);
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
    const availability = await this.deliveryAvailability(parent.workItemId);
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
    const availability = await this.deliveryAvailability(reservation.parentWorkItemId);
    if (availability.reason !== undefined) throw new Error(availability.reason);
    const current = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    // One unresolved cohort per parent: a second cohort cannot share the waiting parent, so
    // replacements are submitted once the cohort settles and the parent is resumed.
    if (current.delegationAttention !== undefined)
      throw new DelegationConflictError(
        DelegationConflictCode.AttentionOpen,
        'Submit replacement work after the cohort settles; an open attention assessment cannot start a second cohort',
      );
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
    if (
      child.repository === undefined &&
      Object.values(definition.stages).some(
        (stage) =>
          stage.execution?.workspace === WorkspaceMode.Branch ||
          stage.execution?.workspace === WorkspaceMode.ReadOnly,
      )
    )
      throw new Error('Workspace-using child workflows require an explicit repository assignment');
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
    if ((await this.deliveryAvailability(reservation.parentWorkItemId)).reason !== undefined)
      return;
    const parent = (await this.repository.loadRequired(reservation.parentWorkflowInstanceId)).view;
    if (parent.status !== WorkflowStatus.Active && parent.status !== WorkflowStatus.Waiting) {
      await this.fail(reservation, 'Delegating parent is no longer active or waiting', context);
      return;
    }
    if (!(await this.ensureWait(reservation, context))) return;
    const root = await this.registerChildren(artifacts, reservation, context);
    await this.advanceMembers(artifacts, root, reservation, context);
    // Live attention only while independent members are unfinished; a fully terminal batch takes
    // the ordinary unsuccessful continuation, which already carries every blocker.
    if (!this.allTerminal(await this.ledger.events(), reservation))
      await this.attention.raise(reservation, context);
    if (await this.settleUnusable(reservation, context)) return;
    const results = selectedResults(await this.ledger.events(), reservation);
    if (await this.childrenQualified(reservation, results, context))
      await this.join(reservation, results, context);
  }

  /** Independent members keep advancing; a blocked member is skipped, never retried blindly. */
  private async advanceMembers(
    artifacts: DelegationArtifacts,
    root: WorkflowInstanceId,
    reservation: DelegationReservation,
    context: CommandContext,
  ): Promise<void> {
    const read = await this.prerequisites.read();
    for (const child of reservation.children) {
      const events = await this.ledger.events();
      if (isSettled(events, reservation)) break;
      if (childBlocker(events, child.workItemId) !== undefined) continue;
      if (await this.preparePrerequisites(root, reservation, child, context, read))
        await this.advanceChild(artifacts, root, reservation, child, context);
    }
  }

  private async settleUnusable(
    reservation: DelegationReservation,
    context: CommandContext,
  ): Promise<boolean> {
    const events = await this.ledger.events();
    const failed = failedChildren(events, reservation);
    if (failed.size === 0) return false;
    if (this.allTerminal(events, reservation)) {
      if (!(await this.canJoin(reservation))) return true;
      await this.abandon(reservation, failed, context);
      await this.join(
        reservation,
        [],
        context,
        'Delegated inputs or child failed; inspect blockers and submit replacement work',
      );
    }
    return true;
  }

  /** Every member either failed (with its dependents) or produced its selected result. */
  private allTerminal(
    events: Awaited<ReturnType<DelegationLedger['events']>>,
    reservation: DelegationReservation,
  ): boolean {
    const failed = failedChildren(events, reservation);
    const selected = new Set(
      selectedResults(events, reservation).map((result) => result.childWorkItemId),
    );
    return (
      failed.size > 0 &&
      reservation.children.every(
        (child) => failed.has(child.workItemId) || selected.has(child.workItemId),
      )
    );
  }

  private async abandon(
    reservation: DelegationReservation,
    failed: ReadonlySet<string>,
    context: CommandContext,
  ) {
    for (const child of reservation.children) {
      if (!failed.has(child.workItemId)) continue;
      const view = (await this.repository.load(child.workflowInstanceId)).view;
      if (
        view === null ||
        view.status === WorkflowStatus.Completed ||
        view.status === WorkflowStatus.Superseded
      )
        continue;
      await this.ledger.appendOnce(
        child.workflowInstanceId,
        context,
        'abandoned:' + child.grantId,
        { eventType: OrchestrationEventType.InstanceSuperseded, payload: {} },
      );
    }
  }

  private async preparePrerequisites(
    root: WorkflowInstanceId,
    reservation: DelegationReservation,
    child: DelegationReservation['children'][number],
    context: CommandContext,
    read: PrerequisiteReadiness,
  ): Promise<boolean> {
    try {
      return await this.prerequisites.prepare(reservation, child, context, read);
    } catch (error) {
      await this.ledger.appendOnce(root, context, 'child-unavailable:' + child.grantId, {
        eventType: OrchestrationEventType.DelegationReconciliationFailed,
        payload: {
          cohortId: reservation.cohortId,
          reason:
            'Child ' +
            child.assignmentId +
            ': ' +
            (error instanceof Error ? error.message : 'reconciliation unavailable'),
        },
      });
      return false;
    }
  }

  private async childrenQualified(
    reservation: DelegationReservation,
    results: readonly DelegationResult[],
    context: CommandContext,
  ): Promise<boolean> {
    if (
      !reservation.children.every((child) =>
        results.some((result) => result.childWorkItemId === child.workItemId),
      )
    )
      return false;
    const read = await this.prerequisites.read();
    return (
      await Promise.all(
        reservation.children.map((child) =>
          this.prerequisites.check(reservation, child, context, read),
        ),
      )
    ).every(Boolean);
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
    if ((await this.deliveryAvailability(reservation.parentWorkItemId)).reason !== undefined)
      return;
    const existing = await this.repository.load(child.workflowInstanceId);
    if (await this.childWorkTerminated(child.workItemId, existing.view)) {
      await this.failChild(reservation, child, 'Delegated child work is no longer open', context);
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
      await this.failChild(
        reservation,
        child,
        `Child ${child.workItemId} terminated without success`,
        context,
      );
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
      await this.failChild(reservation, child, 'Invalid qualifying output contract', context);
      return;
    }
    await this.ledger.appendOnce(root, context, `result:${child.grantId}`, {
      eventType: OrchestrationEventType.DelegationResultSelected,
      payload: { cohortId: reservation.cohortId, childWorkItemId: child.workItemId, outputs },
    });
  }

  private async failChild(
    reservation: DelegationReservation,
    child: DelegationReservation['children'][number],
    reason: string,
    context: CommandContext,
  ): Promise<void> {
    // Every cohort keeps independent members running: the failure is a durable blocker the
    // parent assesses, and the cohort settles unsuccessfully only once all members are terminal.
    await this.ledger.appendOnce(
      reservation.parentWorkflowInstanceId,
      context,
      'child-blocked:' + child.grantId,
      {
        eventType: OrchestrationEventType.DelegationChildBlocked,
        payload: { childWorkItemId: child.workItemId, reason },
      },
    );
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
      await this.failChild(
        reservation,
        child,
        `Child ${child.workItemId} completed without required outputs`,
        context,
      );
  }

  private endedRun(id: string): Promise<boolean> {
    return this.runHasEnded(id);
  }

  /** Commit-boundary read: observes appends from other hosts, then answers from memory. */
  private async deliveryAvailability(id: string) {
    return (await this.work.deliverySnapshot()).availability(id);
  }

  private async canJoin(reservation: DelegationReservation): Promise<boolean> {
    return (
      (await this.endedRun(reservation.runId)) &&
      (await this.deliveryAvailability(reservation.parentWorkItemId)).reason === undefined
    );
  }

  /** Settlement and continuation commit together; failures request assessment without a successful join. */
  private async join(
    reservation: DelegationReservation,
    results: readonly DelegationResult[],
    context: CommandContext,
    failureReason?: string,
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
        settlementDraft(context, reservation, results, failureReason),
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

/** Recorded blockers plus the dependents that can no longer start. */
function failedChildren(
  events: Awaited<ReturnType<DelegationLedger['events']>>,
  reservation: DelegationReservation,
): Set<string> {
  const members = new Set(reservation.children.map((child) => child.workItemId));
  const failed = new Set(
    events.flatMap(({ event }) =>
      event.eventType === OrchestrationEventType.DelegationChildBlocked &&
      members.has(event.payload.childWorkItemId)
        ? [event.payload.childWorkItemId]
        : [],
    ),
  );
  if (failed.size === 0) return failed;
  for (let pass = 0; pass < reservation.children.length; pass++)
    for (const child of reservation.children)
      if (child.prerequisiteWorkItemIds?.some((id) => failed.has(id))) failed.add(child.workItemId);
  return failed;
}

function rootRunLimit(
  reservations: readonly DelegationReservation[],
  limits: DelegationLimits,
): Pick<DelegationLimits, 'maxConcurrentRuns'> {
  const maxConcurrentRuns = reservations[0]?.maxConcurrentRuns ?? limits.maxConcurrentRuns;
  return maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns };
}

function assertReplay(
  prior: DelegationReservation,
  caller: DelegationCaller,
  assignments: readonly DelegatedAssignment[],
): void {
  if (
    prior.parentWorkflowInstanceId !== caller.workflowInstanceId ||
    prior.activationId !== caller.activationId ||
    !matchesAssignments(prior, assignments)
  )
    throw new Error('Delegation replay conflict');
}

function assertPlanRevision(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual)
    throw new DelegationConflictError(
      DelegationConflictCode.StalePlan,
      'Delegation plan revision changed; inspect before submitting again',
    );
}

function childBlocker(
  events: Awaited<ReturnType<DelegationLedger['events']>>,
  id: string,
): string | undefined {
  return events.flatMap(({ event }) =>
    event.eventType === OrchestrationEventType.DelegationChildBlocked &&
    event.payload.childWorkItemId === id
      ? [event.payload.reason]
      : [],
  )[0];
}

function settlementDraft(
  context: CommandContext,
  reservation: DelegationReservation,
  results: readonly DelegationResult[],
  reason: string | undefined,
) {
  return delegationDraft(
    context,
    'join:' + reservation.cohortId,
    reason === undefined
      ? {
          eventType: OrchestrationEventType.DelegationJoined,
          payload: { cohortId: reservation.cohortId, results },
        }
      : {
          eventType: OrchestrationEventType.DelegationFailed,
          payload: { cohortId: reservation.cohortId, reason },
        },
    reservation.parentWorkflowInstanceId,
  );
}
