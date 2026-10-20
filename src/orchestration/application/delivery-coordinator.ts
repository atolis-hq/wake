import { WrongExpectedSequenceError, type CommandContext } from '@atolis-hq/eventing';
import type { DelegationAuthority, DelegationRepositories } from '../contracts/delegation-ports.js';
import {
  DelegationConflictError,
  delegationSubmissionSchema,
  type DelegationCaller,
} from '../contracts/delegation.js';
import {
  DeliveryRejectionError,
  deliveryCandidateCommandSchema,
  deliveryQaCommandSchema,
  deliverySelectionCommandSchema,
  type DeliveryCandidateCommand,
  type DeliveryQaCommand,
  type DeliverySelectionCommand,
} from '../contracts/delivery.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  DelegationConflictCode,
  DeliveryRejection,
  QaVerdict,
  WorkflowStatus,
  type DeliveryCompletion,
} from '../contracts/vocabulary.js';
import { planCandidate } from '../domain/delivery-candidate.js';
import { requirements, type DeliveryFacts } from '../domain/delivery-facts.js';
import { assertQa, completionDecision, deliveryState } from '../domain/delivery-qa.js';
import { assertCriteriaPreserving, originalOf } from '../domain/delivery-replacement.js';
import { reviseSelection } from '../domain/delivery-selection.js';
import { delegationDraft } from './delegation-ledger.js';
import { readDeliveryFacts } from './delivery-facts-reader.js';
import { verifyCandidateSources } from './delivery-sources.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

type Draft = Parameters<typeof delegationDraft>[2];

export interface DeliveryDependencies {
  readonly authority: DelegationAuthority;
  /** Resolves a repository source through the parent's own repository authority. */
  readonly repositories?: DelegationRepositories | undefined;
  readonly completionFor: (parent: WorkflowInstanceView) => Promise<DeliveryCompletion>;
}

/**
 * Agent-led parent QA over the delegated delivery. The parent agent chooses what to select,
 * assemble, test and repair; Wake only records those choices against exact outputs and revisions,
 * rejects anything that would waive a requirement or vouch for different code, and reports what
 * is stale, blocked or exhausted. Every fact lives in the parent's journal stream.
 */
export class DeliveryCoordinator {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly dependencies: DeliveryDependencies,
  ) {}

  async select(caller: DelegationCaller, input: DeliverySelectionCommand, context: CommandContext) {
    const command = deliverySelectionCommandSchema.parse(input);
    const parent = await this.parent(caller);
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
    return this.commit(parent, context, `qa:${command.qaId}`, async (facts) => {
      const qa = assertQa(facts, command);
      const recorded = facts.qa.find((entry) => entry.qaId === command.qaId);
      if (recorded !== undefined) {
        if (JSON.stringify({ ...recorded, exhausted: undefined }) !== JSON.stringify(qa))
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
      const exhausted = qa.verdict === QaVerdict.Fail && noDescendantCapacity(facts);
      const payload = exhausted ? { ...qa, exhausted } : qa;
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
    const facts = await this.facts(parent);
    const state = deliveryState(facts);
    return {
      ...state,
      required: requirements(facts.reservations).map((requirement) => ({
        cohortId: requirement.cohortId,
        assignmentId: requirement.assignmentId,
        outputName: requirement.outputName,
        childWorkItemId: requirement.child.workItemId,
      })),
      selection: facts.selections.at(-1) ?? null,
      history: facts.qa,
      completion: completionDecision(state, await this.dependencies.completionFor(parent)),
    };
  }

  /**
   * Replacement children keep the original acceptance criteria and repository; a terminal original
   * is replaced by a new child, while correcting a still-running one is not supported.
   */
  async assertReplacements(caller: DelegationCaller, input: unknown): Promise<void> {
    const submission = delegationSubmissionSchema.safeParse(input);
    const replacements = submission.success
      ? submission.data.assignments.filter((entry) => entry.replaces !== undefined)
      : [];
    if (replacements.length === 0) return;
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
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
      assertCriteriaPreserving(facts, original, { ...assignment, workflowFingerprint: '' });
    }
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

/** The shared root bound is the existing repair budget; reaching it is an escalation. */
function noDescendantCapacity(facts: DeliveryFacts): boolean {
  const root = facts.reservations[0];
  if (root === undefined) return false;
  const used = facts.reservations.reduce((count, entry) => count + entry.children.length, 0);
  return used >= root.maxDescendants;
}
