import {
  BuiltInActivityName,
  ParentActionKind,
  PullRequestDenialCode,
  PullRequestState,
  type ParentActionContext,
  type ParentActionDecision,
  type ParentActionRequest,
} from '../../activities/index.js';
import { resourceId } from '../../resources/index.js';
import type { DelegationCaller } from '../contracts/delegation.js';
import type { DeliveryDependencies } from '../contracts/delivery-ports.js';
import {
  DeliveryRejectionError,
  deliveryMaintenanceCommandSchema,
  type DeliveryMaintenance,
  type DeliveryMaintenanceCommand,
  type DeliveryOutputKey,
} from '../contracts/delivery.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  DeliveryCompletion,
  DeliveryRejection,
  IntegrationState,
  QaVerdict,
} from '../contracts/vocabulary.js';
import {
  currentSelection,
  isChange,
  outputKey,
  type DeliveryFacts,
} from '../domain/delivery-facts.js';
import { targetRequirements } from '../domain/delivery-integration-policy.js';
import { known, sameRevision, type IntegrationAssessment } from '../domain/delivery-integration.js';
import { deliveryState } from '../domain/delivery-qa.js';
import { readDeliveryFacts } from './delivery-facts-reader.js';
import { DeliveryIntegrationReader } from './delivery-integration-reader.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/**
 * Governed integration of child-owned pull requests by their parent delivery. Wake derives the
 * one planned next action from the parent's journal and provider facts, authorizes exactly that
 * target, and verifies what a maintaining agent actually produced. The agent chooses the repair;
 * nothing here authors a change, reopens a child or transfers a pull request.
 */
export class DeliveryIntegrationService {
  private readonly reader: DeliveryIntegrationReader;

  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly dependencies: DeliveryDependencies,
  ) {
    this.reader = new DeliveryIntegrationReader(dependencies);
  }

  assess(facts: DeliveryFacts): Promise<IntegrationAssessment> {
    return this.reader.assess(facts);
  }

  async authorize(request: ParentActionRequest): Promise<ParentActionDecision> {
    const denied = (reason: PullRequestDenialCode): ParentActionDecision => ({
      kind: 'denied',
      reason,
    });
    const parent = (await this.repository.load(request.workflowInstanceId)).view;
    if (parent === null) return denied(PullRequestDenialCode.OutsideDelivery);
    if (!(await this.dispatchedMerge(parent, request)))
      return denied(PullRequestDenialCode.OutsideDelivery);
    const facts = await this.facts(parent);
    const state = deliveryState(facts);
    if (!state.candidateCurrent || !state.qaEffective || state.qa?.verdict !== QaVerdict.Pass)
      return denied(PullRequestDenialCode.DeliveryNotReady);
    // Current and effective imply a candidate and QA exist; narrow them for the context below.
    if (state.candidate === null || state.qa === null)
      return denied(PullRequestDenialCode.DeliveryNotReady);
    const assessment = await this.reader.assess(facts);
    if (assessment.complete) return { kind: 'fully-integrated' };
    const { next, blocking } = assessment;
    if (next === null) return denied(blockReason(blocking));
    if (!(await this.verifySelected(facts, next.output, request.action)))
      return denied(PullRequestDenialCode.DeliveryNotReady);
    const context: ParentActionContext = {
      requestingWorkItemId: parent.workItemId,
      ownerWorkItemId: next.ownerWorkItemId,
      output: { childWorkItemId: next.output.childWorkItemId, outputName: next.output.outputName },
      candidateId: state.candidate.candidateId,
      selectionRevision: state.selectionRevision,
      qaId: state.qa.qaId,
    };
    return {
      kind: 'target',
      context,
      resourceId: resourceId(next.resourceId),
      revision: next.revision,
    };
  }

  private async verifySelected(
    facts: DeliveryFacts,
    output: DeliveryOutputKey,
    action: ParentActionRequest['action'],
  ) {
    const { reference } = selectedChange(facts, output);
    return (
      (await this.dependencies.integration?.verifyTarget({
        ...reference,
        maintenanceRunId: facts.maintenance
          .filter((item) => outputKey(item.target) === outputKey(output))
          .at(-1)?.producer.runId,
        ownerWorkItemId: reference.workItemId,
        ...targetRequirements(facts, output, action),
      })) === true
    );
  }

  /**
   * Validates one maintenance report against the selected subject and the provider. The result is
   * a new immutable subject; the replaced head, its reviews, checks and QA stay historical.
   */
  async planMaintenance(
    facts: DeliveryFacts,
    input: DeliveryMaintenanceCommand,
    caller: DelegationCaller,
  ): Promise<MaintenancePlan> {
    const command = deliveryMaintenanceCommandSchema.parse(input);
    const { reference, childWorkItemId } = selectedChange(facts, command.target);
    const recorded = facts.maintenance.find((item) => item.maintenanceId === command.maintenanceId);
    if (recorded !== undefined) return replayPlan(recorded, command);
    if (!sameRevision(command.expectedRevision, reference.revision))
      throw new DeliveryRejectionError(
        DeliveryRejection.MaintenanceMismatch,
        `Maintenance must start from the current subject ${reference.revision}, not ${command.expectedRevision}`,
      );
    await this.assertAvailable(childWorkItemId);
    const observed = await this.observeOpen(reference.resourceId);
    if (!sameRevision(observed.headRevision, command.revision))
      throw new DeliveryRejectionError(
        DeliveryRejection.MaintenanceMismatch,
        `The provider reports head ${observed.headRevision}, not the reported ${command.revision}`,
      );
    if (
      sameRevision(command.revision, reference.revision) &&
      command.pullRequestBase === reference.pullRequestBase &&
      observed.baseRevision === reference.baseRevision
    )
      throw new DeliveryRejectionError(
        DeliveryRejection.NotMaintainable,
        'Maintenance changed neither the head nor the base subject',
      );
    if (
      !(await this.dependencies.integration?.verifyTarget({
        ...reference,
        ownerWorkItemId: reference.workItemId,
        revision: command.revision,
        pullRequestBase: command.pullRequestBase,
        requireReview: false,
        requireChecks: false,
      }))
    )
      throw new DeliveryRejectionError(
        DeliveryRejection.MaintenanceMismatch,
        'The provider must verify the maintained repository, branch, head, base and original owner',
      );
    // The Run must hold this target's branch lease, and no earlier writer may be unresolved.
    await this.dependencies.integration!.assertMaintenanceWriter({
      workflowInstanceId: caller.workflowInstanceId,
      activationId: caller.activationId,
      runId: caller.runId,
      childWorkItemId: reference.workItemId,
      resourceId: reference.resourceId,
      revision: reference.revision,
    });
    const maintenance: DeliveryMaintenance = {
      maintenanceId: command.maintenanceId,
      target: command.target,
      kind: command.kind,
      resourceId: reference.resourceId,
      repositoryResourceId: reference.repositoryResourceId,
      previous: {
        revision: reference.revision,
        pullRequestBase: reference.pullRequestBase,
        ...(reference.baseRevision === undefined ? {} : { baseRevision: reference.baseRevision }),
      },
      current: {
        revision: command.revision,
        pullRequestBase: command.pullRequestBase,
        ...(known(observed.baseRevision) ? { baseRevision: observed.baseRevision } : {}),
      },
      producer: { runId: caller.runId, activationId: caller.activationId },
    };
    return {
      result: { maintenance, replay: false },
      draft: {
        eventType: OrchestrationEventType.DeliveryMaintenanceRecorded,
        payload: maintenance,
      },
    };
  }

  /** Only the invocation Wake dispatched for this parent may ask, and only for its own action. */
  private async dispatchedMerge(
    parent: WorkflowInstanceView,
    request: ParentActionRequest,
  ): Promise<boolean> {
    const policy = (await this.dependencies.definitionFor(parent)).delegation;
    const expected =
      request.action === ParentActionKind.Merge
        ? BuiltInActivityName.PullRequestMerge
        : BuiltInActivityName.PullRequestApprove;
    return (
      policy?.qa !== undefined &&
      policy.completion === DeliveryCompletion.MergeRequired &&
      parent.pendingActivation?.activationId === request.activationId &&
      parent.pendingActivation.activity === expected
    );
  }

  private async assertAvailable(childWorkItemId: string): Promise<void> {
    const unavailable = await this.dependencies.unavailable?.([childWorkItemId]);
    if (unavailable?.has(childWorkItemId) === true)
      throw new DeliveryRejectionError(
        DeliveryRejection.NotMaintainable,
        unavailable.get(childWorkItemId)!,
      );
  }

  private async observeOpen(resourceId: string) {
    const integration = this.dependencies.integration;
    if (integration === undefined)
      throw new DeliveryRejectionError(
        DeliveryRejection.MaintenanceMismatch,
        'Provider verification of maintenance is unavailable',
      );
    const observed = await integration.observe(resourceId);
    if (observed === null)
      throw new DeliveryRejectionError(
        DeliveryRejection.MaintenanceMismatch,
        'The pull request has not been observed from the provider',
      );
    if (observed.state !== PullRequestState.Open)
      throw new DeliveryRejectionError(
        DeliveryRejection.NotMaintainable,
        `A ${observed.state} pull request cannot be maintained`,
      );
    return observed;
  }

  /**
   * The open pull requests a maintenance stage may lease. Merged, closed or held targets cannot
   * be written to, so they are never offered.
   */
  async maintenanceTargets(parent: WorkflowInstanceView) {
    const assessment = await this.reader.assess(await this.facts(parent));
    const open: readonly IntegrationState[] = [
      IntegrationState.Ready,
      IntegrationState.AwaitingLowerLayer,
      IntegrationState.MaintenanceRequired,
    ];
    return assessment.targets.filter((target) => open.includes(target.state));
  }

  private async facts(parent: WorkflowInstanceView): Promise<DeliveryFacts> {
    const { events } = await this.repository.history(parent.workflowInstanceId);
    return readDeliveryFacts(this.repository, parent, events);
  }
}

interface MaintenancePlan {
  readonly result: { readonly maintenance: DeliveryMaintenance; readonly replay: boolean };
  readonly draft:
    | {
        readonly eventType: typeof OrchestrationEventType.DeliveryMaintenanceRecorded;
        readonly payload: DeliveryMaintenance;
      }
    | undefined;
}

function selectedChange(facts: DeliveryFacts, target: DeliveryOutputKey) {
  const entry = currentSelection(facts)?.entries.find(
    (candidate) =>
      candidate.childWorkItemId === target.childWorkItemId &&
      candidate.output.name === target.outputName,
  );
  if (entry === undefined || !isChange(entry.output))
    throw new DeliveryRejectionError(
      DeliveryRejection.NotMaintainable,
      `${outputKey(target)} is not a selected change`,
    );
  return { reference: entry.output.reference, childWorkItemId: entry.childWorkItemId };
}

/** A repeated report is idempotent only when it says exactly what was recorded. */
function replayPlan(recorded: DeliveryMaintenance, command: DeliveryMaintenanceCommand) {
  const same =
    outputKey(recorded.target) === outputKey(command.target) &&
    recorded.kind === command.kind &&
    sameRevision(recorded.current.revision, command.revision) &&
    recorded.current.pullRequestBase === command.pullRequestBase &&
    sameRevision(recorded.previous.revision, command.expectedRevision);
  if (!same)
    throw new DeliveryRejectionError(
      DeliveryRejection.Conflict,
      `Maintenance ${command.maintenanceId} was already recorded differently`,
    );
  return {
    result: { maintenance: recorded, replay: true },
    draft: undefined,
  } satisfies MaintenancePlan;
}

function blockReason(blocking: IntegrationAssessment['blocking']): PullRequestDenialCode {
  switch (blocking?.state) {
    case IntegrationState.Held:
      return PullRequestDenialCode.TargetHeld;
    case IntegrationState.MaintenanceRequired:
    case IntegrationState.AwaitingLowerLayer:
      return PullRequestDenialCode.MaintenanceRequired;
    case IntegrationState.Closed:
      return PullRequestDenialCode.Closed;
    case IntegrationState.Unobserved:
      return PullRequestDenialCode.MissingResource;
    default:
      return PullRequestDenialCode.DeliveryNotReady;
  }
}
