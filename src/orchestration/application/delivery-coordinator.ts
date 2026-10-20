import { WrongExpectedSequenceError, type CommandContext } from '@atolis-hq/eventing';
import type { ParentActionRequest } from '../../activities/index.js';
import {
  DelegationConflictError,
  delegationSubmissionSchema,
  type DelegationCaller,
} from '../contracts/delegation.js';
import type { DeliveryDependencies } from '../contracts/delivery-ports.js';
import {
  DeliveryRejectionError,
  deliveryCandidateCommandSchema,
  deliveryMaintenanceCommandSchema,
  deliveryQaCommandSchema,
  deliverySelectionCommandSchema,
  type DeliveryCandidate,
  type DeliveryCandidateCommand,
  type DeliveryMaintenanceCommand,
  type DeliveryQa,
  type DeliveryQaCommand,
  type DeliverySelectionCommand,
} from '../contracts/delivery.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { stageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  DelegationConflictCode,
  DeliveryCompletion,
  DeliveryRejection,
  QaVerdict,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import { planCandidate } from '../domain/delivery-candidate.js';
import { currentSelection, requirements, type DeliveryFacts } from '../domain/delivery-facts.js';
import { assertQa, completionDecision, deliveryState } from '../domain/delivery-qa.js';
import { originalOf } from '../domain/delivery-replacement.js';
import { reviseSelection } from '../domain/delivery-selection.js';
import { delegationDraft } from './delegation-ledger.js';
import { readDeliveryFacts } from './delivery-facts-reader.js';
import { DeliveryIntegrationService } from './delivery-integration-service.js';
import { DeliveryPreparation } from './delivery-preparation.js';
import { verifyCandidateSources } from './delivery-sources.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

type Draft = Parameters<typeof delegationDraft>[2];

/**
 * Agent-led parent QA over the delegated delivery. The parent agent chooses what to select,
 * assemble, test and repair; Wake only records those choices against exact outputs and revisions,
 * rejects anything that would waive a requirement or vouch for different code, and reports what
 * is stale, blocked or exhausted. Every fact lives in the parent's journal stream.
 */
export class DeliveryCoordinator {
  private readonly preparation: DeliveryPreparation;
  private readonly integration: DeliveryIntegrationService;
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly dependencies: DeliveryDependencies,
  ) {
    this.preparation = new DeliveryPreparation(repository, dependencies);
    this.integration = new DeliveryIntegrationService(repository, dependencies);
  }

  authorizeParentAction(request: ParentActionRequest) {
    return this.integration.authorize(request);
  }

  /** The targets the configured maintenance stage will lease, or undefined for other stages. */
  async maintenanceTargets(id: string) {
    const parent = (await this.repository.loadRequired(id)).view;
    const stage = (await this.dependencies.definitionFor(parent)).delegation?.maintenance?.stage;
    if (stage === undefined || parent.pendingActivation?.stage !== stage) return undefined;
    return this.integration.maintenanceTargets(parent);
  }

  /** Records what the maintaining agent actually produced as a new immutable subject. */
  async recordMaintenance(
    caller: DelegationCaller,
    input: DeliveryMaintenanceCommand,
    context: CommandContext,
  ) {
    const command = deliveryMaintenanceCommandSchema.parse(input);
    const parent = await this.parent(caller);
    await this.assertCoordinatorStage(parent);
    return this.commit(parent, context, `maintenance:${command.maintenanceId}`, (facts) =>
      this.integration.planMaintenance(facts, command, caller),
    );
  }

  async select(caller: DelegationCaller, input: DeliverySelectionCommand, context: CommandContext) {
    const command = deliverySelectionCommandSchema.parse(input);
    const parent = await this.parent(caller);
    await this.assertCoordinatorStage(parent);
    return this.commit(parent, context, `selection:${command.requestId}`, async (facts) => {
      const { selection, replay } = reviseSelection(facts, command);
      return {
        result: { selection, replay },
        draft: replay
          ? undefined
          : { eventType: OrchestrationEventType.DeliverySelectionRevised, payload: selection },
      };
    });
  }

  async recordCandidate(
    caller: DelegationCaller,
    input: DeliveryCandidateCommand,
    context: CommandContext,
  ) {
    const command = deliveryCandidateCommandSchema.parse(input);
    const parent = await this.parent(caller);
    await this.assertCoordinatorStage(parent);
    const policy = (await this.dependencies.definitionFor(parent)).delegation?.qa;
    return this.commit(parent, context, `candidate:${command.candidateId}`, async (facts) => {
      const root = facts.reservations[0]?.rootWorkItemId;
      if (root === undefined)
        throw new DeliveryRejectionError(DeliveryRejection.NoSelection, 'No delegated work');
      const { candidate } = planCandidate(facts, command, root);
      const existing = facts.candidates.find((entry) => entry.candidateId === command.candidateId);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(candidate))
        throw new DeliveryRejectionError(
          DeliveryRejection.Conflict,
          `Candidate ${command.candidateId} already exists with different contents`,
        );
      if (policy !== undefined && policy.recipe !== command.recipe)
        throw new Error('Candidate must use the configured QA recipe');
      // A replay re-proves the sources, so a restart cannot revive a candidate whose ref is gone.
      await verifyCandidateSources(parent, this.dependencies.repositories, candidate, facts);
      return {
        result: { candidate, replay: existing !== undefined },
        draft:
          existing !== undefined
            ? undefined
            : { eventType: OrchestrationEventType.DeliveryCandidateRecorded, payload: candidate },
      };
    });
  }

  async recordQa(caller: DelegationCaller, input: DeliveryQaCommand, context: CommandContext) {
    const command = deliveryQaCommandSchema.parse(input);
    const parent = await this.parent(caller);
    const definition = await this.dependencies.definitionFor(parent);
    const policy = definition.delegation?.qa;
    if (policy === undefined || parent.pendingActivation?.stage !== policy.stage)
      throw new Error('QA verdicts require the configured QA stage');
    return this.commit(parent, context, `qa:${command.qaId}`, async (facts) => {
      const qa = assertQa(facts, command);
      const candidate = facts.candidates.find((entry) => entry.candidateId === qa.candidateId)!;
      await this.assertQaActor(caller, facts, candidate, qa, policy.recipe);
      const recorded = facts.qa.find((entry) => entry.qaId === command.qaId);
      if (recorded !== undefined) {
        if (
          JSON.stringify({
            ...recorded,
            exhausted: undefined,
            runId: undefined,
            activationId: undefined,
          }) !== JSON.stringify(qa)
        )
          throw new DeliveryRejectionError(
            DeliveryRejection.Conflict,
            `QA ${command.qaId} was already recorded differently`,
          );
        return { result: { qa: recorded, replay: true }, draft: undefined };
      }
      if (qa.verdict === QaVerdict.Pass) {
        // A pass is only meaningful while the exact sources remain reconstructable.
        const candidate = facts.candidates.find((entry) => entry.candidateId === qa.candidateId)!;
        await verifyCandidateSources(parent, this.dependencies.repositories, candidate, facts);
      }
      const route = definition.stages[stageName(policy.stage)]?.on.failed;
      const routeExhausted =
        route?.repeat !== undefined && (parent.repeatCounts[route.id] ?? 0) >= route.repeat.max;
      const exhausted =
        qa.verdict === QaVerdict.Fail &&
        (routeExhausted || (await this.preparation.noDescendantCapacity(facts)));
      const payload = {
        ...qa,
        runId: caller.runId,
        activationId: caller.activationId,
        ...(exhausted ? { exhausted } : {}),
      };
      return {
        result: { qa: payload, replay: false },
        draft: { eventType: OrchestrationEventType.DeliveryQaRecorded, payload },
      };
    });
  }

  /** The inspectable delivery state: selection, staleness, candidate, QA, repair and completion. */
  async inspectFor(caller: DelegationCaller) {
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    await this.dependencies.authority.assertCaller(caller, parent);
    return this.inspect(parent.workflowInstanceId);
  }

  async inspect(id: string) {
    const parent = (await this.repository.loadRequired(id)).view;
    const facts = await this.facts(parent);
    const state = deliveryState(facts);
    const mode =
      (await this.dependencies.definitionFor(parent)).delegation?.completion ??
      DeliveryCompletion.QaApproved;
    // Only merge-required deliveries pay for provider reads; QA-approved ones never integrate.
    const integration =
      mode === DeliveryCompletion.MergeRequired ? await this.integration.assess(facts) : null;
    return {
      ...state,
      integration,
      maintenance: facts.maintenance,
      required: requirements(facts.reservations).map((requirement) => ({
        cohortId: requirement.cohortId,
        assignmentId: requirement.assignmentId,
        outputName: requirement.outputName,
        childWorkItemId: requirement.child.workItemId,
      })),
      selection: currentSelection(facts) ?? null,
      history: facts.qa,
      completion:
        parent.deliveryGateBlock !== undefined
          ? { complete: false, reason: parent.blockReason! }
          : completionDecision(state, mode, integration ?? undefined),
    };
  }

  /**
   * Replacement children keep the original acceptance criteria and repository; a terminal original
   * is replaced by a new child, while correcting a still-running one is not supported.
   */
  async assertReplacements(caller: DelegationCaller, input: unknown): Promise<void> {
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    await this.assertCoordinatorStage(parent);
    const submission = delegationSubmissionSchema.safeParse(input);
    const replacements = submission.success
      ? submission.data.assignments.filter((entry) => entry.replaces !== undefined)
      : [];
    if (replacements.length === 0) return;
    await this.dependencies.authority.assertCaller(caller, parent);
    const facts = await this.facts(parent);
    for (const assignment of replacements) {
      const original = originalOf(facts, assignment.replaces!);
      const view = (await this.repository.load(original.workflowInstanceId)).view;
      if (view?.status !== WorkflowStatus.Completed && view?.status !== WorkflowStatus.Superseded)
        throw new DelegationConflictError(
          DelegationConflictCode.ReplacementUnsupported,
          'Correcting a child that is still running is not supported; replace it once it is complete or superseded',
        );
    }
  }

  completionBlock(id: string) {
    return this.preparation.completionBlock(id);
  }

  prepare(id: string) {
    return this.preparation.prepare(id);
  }

  private async assertQaActor(
    caller: DelegationCaller,
    facts: DeliveryFacts,
    candidate: DeliveryCandidate,
    qa: DeliveryQa,
    recipe: string | undefined,
  ) {
    if (
      !deliveryState(facts).candidateCurrent ||
      facts.candidates.at(-1)?.candidateId !== qa.candidateId
    )
      throw new Error('QA candidate is no longer current');
    if (this.dependencies.authority.assertQaCaller === undefined)
      throw new Error('QA Run authority is unavailable');
    await this.dependencies.authority.assertQaCaller(
      caller,
      qa.candidateId,
      candidate.selectionRevision,
      qa.revisions,
    );
    if (qa.environment.recipe !== recipe) throw new Error('QA must use the configured recipe');
  }

  private async assertCoordinatorStage(parent: WorkflowInstanceView): Promise<void> {
    const policy = (await this.dependencies.definitionFor(parent)).delegation?.qa;
    if (policy !== undefined && parent.pendingActivation?.stage === policy.stage)
      throw new Error('The QA stage cannot choose its own candidate or selection');
  }

  private async parent(caller: DelegationCaller): Promise<WorkflowInstanceView> {
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    await this.dependencies.authority.assertCaller(caller, parent);
    if (
      parent.pendingActivation?.activationId !== caller.activationId ||
      (parent.status !== WorkflowStatus.Active && parent.status !== WorkflowStatus.Waiting)
    )
      throw new Error('Delivery changes require the current active activation');
    return parent;
  }

  private async facts(parent: WorkflowInstanceView): Promise<DeliveryFacts> {
    const { events } = await this.repository.history(parent.workflowInstanceId);
    return readDeliveryFacts(this.repository, parent, events);
  }

  /** Re-derives facts from fresh history on every optimistic-concurrency retry. */
  private async commit<R>(
    parent: WorkflowInstanceView,
    context: CommandContext,
    key: string,
    build: (facts: DeliveryFacts) => Promise<{ result: R; draft: Draft | undefined }>,
  ): Promise<R> {
    for (;;) {
      const { events, sequence } = await this.repository.history(parent.workflowInstanceId);
      const { result, draft } = await build(
        await readDeliveryFacts(this.repository, parent, events),
      );
      if (draft === undefined) return result;
      try {
        await this.repository.append(parent.workflowInstanceId, sequence, [
          delegationDraft(context, key, draft, parent.workflowInstanceId),
        ]);
        return result;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
  }
}
