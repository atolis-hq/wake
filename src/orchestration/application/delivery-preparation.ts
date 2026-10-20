import { WorkspaceMode, type ExecutionCandidate } from '../../execution/index.js';
import type { DelegationReservation } from '../contracts/delegation.js';
import type { DeliveryDependencies } from '../contracts/delivery-ports.js';
import type { DeliveryCompletionBlock } from '../contracts/delivery.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { CandidateSourceKind, DeliveryCompletion } from '../contracts/vocabulary.js';
import { type DeliveryFacts } from '../domain/delivery-facts.js';
import { completionDecision, deliveryState } from '../domain/delivery-qa.js';
import { readDeliveryFacts } from './delivery-facts-reader.js';
import { verifyCandidateSources } from './delivery-sources.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

export class DeliveryPreparation {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly dependencies: DeliveryDependencies,
  ) {}

  async completionBlock(id: string): Promise<DeliveryCompletionBlock | undefined> {
    const parent = (await this.repository.loadRequired(id)).view;
    const definition = await this.dependencies.definitionFor(parent);
    // Existing direct workflows retain their configured routes.
    if (definition.delegation?.qa === undefined && definition.delegation?.completion === undefined)
      return undefined;
    const facts = await this.facts(parent);
    if (facts.reservations.length === 0) return undefined;
    const decision = completionDecision(
      deliveryState(facts),
      definition.delegation?.completion ?? DeliveryCompletion.QaApproved,
    );
    const retryStage = await this.delegatingStage(id, facts.reservations.at(-1)!);
    const blocked = (reason: string): DeliveryCompletionBlock => ({
      reason,
      deliveryGate: { retryStage },
    });
    if (!decision.complete) return blocked(decision.reason!);
    try {
      await verifyCandidateSources(
        parent,
        this.dependencies.repositories,
        facts.candidates.at(-1)!,
        facts,
      );
      return undefined;
    } catch (error) {
      return blocked(
        error instanceof Error ? error.message : 'Operational candidate source verification failed',
      );
    }
  }

  async prepare(id: string): Promise<ExecutionCandidate | undefined> {
    const parent = (await this.repository.loadRequired(id)).view;
    const policy = (await this.dependencies.definitionFor(parent)).delegation?.qa;
    if (policy === undefined || parent.pendingActivation?.stage !== policy.stage) return undefined;
    if (parent.pendingActivation.execution?.workspace !== WorkspaceMode.ReadOnly)
      throw new Error('Candidate QA requires read-only workspaces');
    const facts = await this.facts(parent);
    const state = deliveryState(facts);
    if (!state.candidateCurrent || state.candidate === null)
      throw new Error('QA preparation needs a current complete candidate');
    const candidate = state.candidate;
    await verifyCandidateSources(parent, this.dependencies.repositories, candidate, facts);
    return {
      candidateId: candidate.candidateId,
      selectionRevision: candidate.selectionRevision,
      criteria: candidate.criteria,
      inputs: facts.selections.at(-1)!.entries.map((entry) => ({
        workItemId: entry.output.reference.workItemId,
        outputName: entry.output.name,
        revision:
          'revisionId' in entry.output.reference
            ? entry.output.reference.revisionId
            : entry.output.reference.revision,
      })),
      ...(policy.recipe === undefined ? {} : { recipe: policy.recipe }),
      repositories: candidate.repositories.map((entry) => ({
        resourceId: entry.resourceId,
        sourceRef:
          entry.source.kind === CandidateSourceKind.RetainedRef ? entry.source.ref : entry.revision,
        sourceRevision: entry.revision,
        pullRequestBase: entry.pullRequestBase,
        ...(entry.source.kind === CandidateSourceKind.RetainedRef
          ? { requiredSourceRef: entry.source.ref }
          : {}),
      })),
    };
  }

  async noDescendantCapacity(facts: DeliveryFacts): Promise<boolean> {
    const root = facts.reservations[0];
    if (root === undefined) return false;
    const reservations = new Map<string, number>();
    for (const { event } of await this.repository.events()) {
      if (
        event.eventType !== OrchestrationEventType.DelegationReserved ||
        event.payload.rootWorkItemId !== root.rootWorkItemId
      )
        continue;
      const reservation = event.payload;
      reservations.set(
        reservation.parentWorkflowInstanceId + '/' + reservation.cohortId,
        reservation.children.length,
      );
    }
    return [...reservations.values()].reduce((sum, count) => sum + count, 0) >= root.maxDescendants;
  }

  private async delegatingStage(id: string, reservation: DelegationReservation) {
    const original = (await this.repository.history(id)).events.find(
      ({ event }) =>
        event.eventType === OrchestrationEventType.ActivityRequested &&
        event.payload.activationId === reservation.activationId,
    );
    if (
      original?.event.eventType !== OrchestrationEventType.ActivityRequested ||
      original.event.payload.stage === undefined
    )
      throw new Error('Missing delegating activation stage');
    return original.event.payload.stage;
  }

  private async facts(parent: WorkflowInstanceView): Promise<DeliveryFacts> {
    return readDeliveryFacts(
      this.repository,
      parent,
      (await this.repository.history(parent.workflowInstanceId)).events,
    );
  }
}
