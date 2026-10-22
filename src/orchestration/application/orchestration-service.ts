import type {
  DelegationArtifacts,
  DelegationAuthority,
  DelegationRepositories,
} from '../contracts/delegation-ports.js';
import type {
  DelegationAttentionReply,
  DelegationCaller,
  DelegationSubmission,
} from '../contracts/delegation.js';
import type { DeliveryDependencies, DeliveryIntegration } from '../contracts/delivery-ports.js';
import type {
  DeliveryCandidateCommand,
  DeliveryMaintenanceCommand,
  DeliveryQaCommand,
  DeliverySelectionCommand,
} from '../contracts/delivery.js';
import { expireTimedOutAwait } from '../domain/interpreter.js';
import { DeferredSignals } from './deferred-signals.js';
import { DelegatedWork } from './delegated-work.js';
import { DelegationCommands } from './delegation-commands.js';
import { DelegationGate } from './delegation-gate.js';
import { DeliveryCoordinator } from './delivery-coordinator.js';
import { expireTimedOutWaits } from './expire-timed-out-waits.js';
import { recoverPolicyBlockedMerges } from './policy-blocked-merge-recovery.js';
import type { ResourceTransitionEvidence } from './resource-transition-evidence.js';
/* eslint-disable max-lines */
import type { CommandContext, EventJournal, ProjectionStore } from '@atolis-hq/eventing';
import {
  type ActivationId,
  type ActivityOutcome,
  type ParentActionRequest,
} from '../../activities/index.js';
import type { ExecutionFailureCode, ExecutionMaintenance } from '../../execution/index.js';
import {
  WorkStatus,
  type DeliverySnapshot,
  type WorkItemId,
  type WorkItemView,
  type WorkService,
} from '../../work/index.js';
import type { StartWorkflowInstance } from '../contracts/commands.js';
import type { CompiledWorkflow, TransitionTarget } from '../contracts/config.js';
import { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import type {
  ChildWorkflowRequest,
  OrchestrationSignal,
  SignalExpectation,
  SupplementalActivityRequest,
} from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import {
  commandName,
  workflowInstanceId as toWorkflowInstanceId,
  type SignalName,
  type WorkflowInstanceId,
} from '../contracts/identifiers.js';
import { childOrchestrationGroupStream, workflowInstanceStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  ApprovalAuthorityKind,
  ConversationBuiltInCommand,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import {
  isGroupBudgetExtensionEligible,
  isNeedsClarificationResumeEligible,
  isPlainReplyResumeEligible,
  selectChangesResumeTargets,
} from '../domain/operator-retry-policy.js';
import { AcceptActivityOutcome } from './accept-activity-outcome.js';
import { AcceptSignal } from './accept-signal.js';
import { AdvanceWorkflow } from './advance-workflow.js';
import {
  applyBuiltInConversationCommand,
  continuationCommandRejection,
  conversationCommand,
  type ConversationCommandInput,
  type ConversationCommandResult,
} from './conversation-command.js';
import { CoordinationClaims } from './coordination-claims.js';
import { attentionVerdict } from './delegation-attention-state.js';
import { GroupBudgetRecorder } from './group-budget-recorder.js';
import { workflowsByWorkItemProjection } from './orchestration-projection.js';
import { OrchestrationRepository } from './orchestration-repository.js';
import type { AgentActivityClassifier } from './pending-activations.js';
import { RequestChild } from './request-child.js';
import { StartWorkflow } from './start-workflow.js';
import { continuesWaitingForSameWatchGate } from './watch-child-transitions.js';
import { WorkflowDefinitionRegistry } from './workflow-definition-registry.js';

export class OrchestrationService {
  private readonly delegationCommands: DelegationCommands;
  private readonly delegationGate: DelegationGate;
  private readonly delegatedWork: DelegatedWork;
  private readonly delivery: DeliveryCoordinator;
  private readonly prerequisiteReasons = (ids: readonly string[], snapshot?: DeliverySnapshot) =>
    this.delegatedWork.prerequisites.reasons(ids, snapshot);

  private readonly resumeClarification = (id: WorkflowInstanceId, context: CommandContext) =>
    this.advanceWorkflow.resumeNeedsClarificationStage(id, context);

  private readonly repository: OrchestrationRepository;
  private readonly deferredSignals: DeferredSignals;
  private readonly startWorkflow: StartWorkflow;
  private readonly acceptActivityOutcome: AcceptActivityOutcome;
  private readonly acceptWorkflowSignal: AcceptSignal;
  private readonly advanceWorkflow: AdvanceWorkflow;
  private readonly childWorkflows: RequestChild;
  private readonly projections: ProjectionStore | undefined;
  private coordinateAcceptSignal: OperationCoordinator = (operation) => operation();
  private watchChildCancellation: WatchChildCancellation | undefined;
  private readonly claims: CoordinationClaims;
  private readonly journal: EventJournal;
  private readonly definitions: WorkflowDefinitionRegistry;
  private readonly work: WorkService;

  // Composition root for the module's services; splitting it would only scatter the wiring.
  // eslint-disable-next-line max-lines-per-function
  constructor(
    journal: EventJournal,
    work: WorkService,
    definitions: Readonly<Record<string, CompiledWorkflow>>,
    projections?: ProjectionStore,
    isAgentActivity?: AgentActivityClassifier,
    delegation?: DelegationDependenciesFactory,
  ) {
    this.projections = projections;
    this.journal = journal;
    this.work = work;
    const repository = new OrchestrationRepository(journal, (id) =>
      this.delivery.completionBlock(id),
    );
    this.repository = repository;
    this.delegationGate = new DelegationGate(
      repository,
      work,
      delegation === undefined ? undefined : this.prerequisiteReasons,
    );
    const dependencies = delegation?.({
      isActivationAccepted: (id, item) => this.isActivationAccepted(id, item),
    });
    this.claims = new CoordinationClaims(journal);
    this.definitions = new WorkflowDefinitionRegistry(journal, projections, definitions);
    this.startWorkflow = new StartWorkflow(repository, this.claims, work, this.definitions);
    this.delegatedWork = new DelegatedWork(
      repository,
      work,
      this.claims,
      this.definitions,
      this.startWorkflow,
      {
        authority: dependencies?.authority,
        artifacts: dependencies?.artifacts ?? unavailableArtifacts,
        repositories: dependencies?.repositories,
        runHasEnded: dependencies?.runHasEnded ?? unavailableRunCompletion,
        supportsAttention: isAgentActivity,
        resumeChild: this.resumeClarification,
      },
    );
    this.delegationCommands = new DelegationCommands(
      repository,
      work,
      this.startWorkflow,
      this.definitions,
      this.delegatedWork,
      dependencies?.authority ?? unavailableDelegationAuthority,
    );
    this.delivery = new DeliveryCoordinator(
      repository,
      deliveryDependencies(
        dependencies,
        async (parent) => this.startWorkflow.definitionFor(parent),
        work,
      ),
    );
    this.advanceWorkflow = new AdvanceWorkflow(
      repository,
      this.startWorkflow,
      (command, context) => this.acceptOutcome(command, context),
      isAgentActivity,
    );
    this.acceptWorkflowSignal = new AcceptSignal(repository, this.startWorkflow, work);
    this.deferredSignals = new DeferredSignals(
      repository,
      (id, signal, context) =>
        this.delegationGate.run(id, () => this.acceptWorkflowSignal.execute(id, signal, context)),
      (id, target, evidenceId, context) =>
        this.delegationGate.run(id, () =>
          this.advanceWorkflow.applyResourceTransition(id, target, evidenceId, context),
        ),
      (ids) => this.delegationGate.fencedAmong(ids),
    );
    this.childWorkflows = new RequestChild(
      repository,
      this.claims,
      new GroupBudgetRecorder(journal),
      this.startWorkflow,
      this.advanceWorkflow,
    );
    this.acceptActivityOutcome = new AcceptActivityOutcome(
      repository,
      this.startWorkflow,
      async (context) => {
        await this.delegatedWork.reconcile(context);
        await this.childWorkflows.reconcileChildCompletions(context);
        await this.deferredSignals.reconcile(context);
      },
    );
  }

  deliveryStateFor(workflowInstanceId: string) {
    return this.delivery.inspect(workflowInstanceId);
  }

  deliveryQaPreparation(workflowInstanceId: string) {
    return this.delivery.prepare(workflowInstanceId);
  }

  repositoryAuthority(workItemId: string) {
    return this.delegatedWork.repositoryScope(workItemId);
  }

  changeOutputAssignments(workItemId: string) {
    return this.delegatedWork.changeOutputAssignments(workItemId);
  }

  delegatedAssignment(workItemId: string) {
    return this.delegatedWork.assignmentFor(workItemId);
  }

  repositoryAssignment(workItemId: string) {
    return this.delegatedWork.repositoryFor(workItemId);
  }

  async isActivationAccepted(id: string, item?: string): Promise<boolean> {
    return (await this.repository.list()).some(
      ({ view }) =>
        view !== null &&
        (item === undefined || view.workItemId === item) &&
        view.acceptedOutcomes.some((accepted) => accepted === id),
    );
  }

  async submitDelegation(
    caller: DelegationCaller,
    input: DelegationSubmission,
    context: CommandContext,
  ) {
    await this.delivery.assertReplacements(caller, input);
    return this.delegationCommands.submit(caller, input, context);
  }

  selectDelivery(
    caller: DelegationCaller,
    input: DeliverySelectionCommand,
    context: CommandContext,
  ) {
    return this.delivery.select(caller, input, context);
  }

  recordDeliveryCandidate(
    caller: DelegationCaller,
    input: DeliveryCandidateCommand,
    context: CommandContext,
  ) {
    return this.delivery.recordCandidate(caller, input, context);
  }

  recordDeliveryQa(caller: DelegationCaller, input: DeliveryQaCommand, context: CommandContext) {
    return this.delivery.recordQa(caller, input, context);
  }

  recordDeliveryMaintenance(
    caller: DelegationCaller,
    input: DeliveryMaintenanceCommand,
    context: CommandContext,
  ) {
    return this.delivery.recordMaintenance(caller, input, context);
  }

  authorizeParentAction(request: ParentActionRequest) {
    return this.delivery.authorizeParentAction(request);
  }

  /** The branch leases Execution must hold for the configured maintenance stage's activation. */
  async deliveryMaintenancePreparation(
    workflowInstanceId: string,
  ): Promise<ExecutionMaintenance | undefined> {
    const targets = await this.delivery.maintenanceTargets(workflowInstanceId);
    if (targets === undefined || targets.length === 0) return undefined;
    const prepared: ExecutionMaintenance['targets'][number][] = [];
    for (const target of targets) {
      // The same assignment that created the child's workspace, so its lease is reused exactly.
      const outputs = await this.delegatedWork.changeOutputAssignments(target.ownerWorkItemId);
      const repository =
        outputs?.find((output) => output.name === target.output.outputName)?.repository ??
        (await this.delegatedWork.repositoryFor(target.ownerWorkItemId));
      if (repository === undefined) continue;
      prepared.push({
        childWorkItemId: target.ownerWorkItemId,
        outputName: target.output.outputName,
        resourceId: target.resourceId,
        repository,
        branch: target.branch,
        revision: target.revision,
        pullRequestBase: target.pullRequestBase,
        ...(target.maintenance === undefined
          ? {}
          : { reason: `${target.maintenance}: ${target.detail ?? ''}`.trim() }),
      });
    }
    return prepared.length === 0 ? undefined : { targets: prepared };
  }

  async inspectDelegation(caller: DelegationCaller, context: CommandContext) {
    return {
      ...(await this.delegationCommands.inspect(caller, context)),
      delivery: await this.delivery.inspectFor(caller),
    };
  }

  deliveryTree(id: WorkItemId, options?: { readonly verify?: boolean }) {
    return this.delegatedWork.inspect(id, options);
  }

  deliveryRunLimit(id: WorkItemId) {
    return this.delegatedWork.runLimit(id);
  }

  async hasLiveDelegatedWork(id: WorkItemId): Promise<boolean> {
    // A concluded root can never join its cohorts, so nothing remains to wait for.
    const root = await this.work.get(id);
    if (root === null || root.deleted === true || root.state !== WorkStatus.Open) return false;
    return (await this.deliveryTree(id)).some(
      (cohort) =>
        !cohort.settled &&
        cohort.children.some(
          ({ work, workflow }) =>
            work !== null &&
            work.deleted !== true &&
            work.state === WorkStatus.Open &&
            (workflow === null ||
              (workflow.status !== WorkflowStatus.Completed &&
                workflow.status !== WorkflowStatus.Superseded)),
        ),
    );
  }

  joinedDelegationResults(id: WorkflowInstanceId, cohortId: string) {
    return this.delegatedWork.results(id, cohortId);
  }

  start(command: StartWorkflowInstance, context: CommandContext) {
    return this.startWorkflow.execute(command, context);
  }

  requestChild(
    request: ChildWorkflowRequest & { readonly maxPerGroup: number },
    context: CommandContext,
  ) {
    return this.childWorkflows.execute(request, context);
  }

  rejectCausalActivation(request: ChildWorkflowRequest, context: CommandContext) {
    return this.childWorkflows.rejectCausalActivation(request, context);
  }

  acceptOutcome(
    command: {
      workflowInstanceId: WorkflowInstanceId;
      activationId: ActivationId;
      outcome: ActivityOutcome;
    },
    context: CommandContext,
  ) {
    return this.transitionWatchChildren(context, () =>
      this.delegationGate.outcome(
        command.workflowInstanceId,
        command.activationId,
        () => this.acceptActivityOutcome.execute(command, context),
        async () => {
          await this.reconcileChildCompletions(context);
          return (await this.repository.loadRequired(command.workflowInstanceId)).view;
        },
        async (view) => view,
        () => this.endAttention(command, context),
      ),
    );
  }

  /**
   * Every ending restores the cohort wait, so independent members keep running and their
   * results stay joinable (a join that completed meanwhile then proceeds). A structured
   * human question is also recorded as an accepted outcome, which the ordinary publication
   * route delivers to a human; a failed assessment run is recorded and re-raised a bounded
   * number of times. The cohort is never settled or cancelled by the assessment itself.
   */
  private async endAttention(
    command: {
      workflowInstanceId: WorkflowInstanceId;
      activationId: ActivationId;
      outcome: ActivityOutcome;
    },
    context: CommandContext,
  ) {
    await this.delegatedWork.attention.resolve(
      command.workflowInstanceId,
      command.activationId,
      context,
      attentionVerdict(command.outcome),
    );
    await this.delegatedWork.reconcile(context);
    return (await this.repository.loadRequired(command.workflowInstanceId)).view;
  }

  /** Delegated children still blocked on a question this work item's parent escalated to a human. */
  async escalatedReplyTargets(workItemId: WorkItemId) {
    const targets: WorkItemId[] = [];
    for (const parent of await this.advanceWorkflow.listAll())
      if (parent.workItemId === workItemId)
        for (const target of await this.delegatedWork.attention.escalatedTargets(parent))
          targets.push(target.childWorkItemId as WorkItemId);
    return targets;
  }

  /** The open attention request when `activationId` is the attention activation, else null. */
  async openDelegationAttention(id: WorkflowInstanceId, activationId: ActivationId) {
    const view = (await this.repository.load(id)).view;
    if (view?.delegationAttention?.activationId !== activationId) return null;
    return this.delegatedWork.attention.current(view);
  }

  respondToDelegationAttention(
    caller: DelegationCaller,
    reply: DelegationAttentionReply,
    context: CommandContext,
  ) {
    return this.delegationCommands.respond(caller, reply, context);
  }

  waitForSignal(
    workflowInstanceId: WorkflowInstanceId,
    expectation: SignalExpectation,
    context: CommandContext,
  ) {
    return this.transitionWatchChildren(context, async () => {
      await this.delegationGate.run(workflowInstanceId, () =>
        this.acceptWorkflowSignal.wait(workflowInstanceId, expectation, context),
      );
      return this.deferredSignals.reconcileWorkflow(workflowInstanceId, context);
    });
  }

  acceptSignal(
    workflowInstanceId: WorkflowInstanceId,
    signal: OrchestrationSignal,
    context: CommandContext,
  ) {
    return this.coordinateAcceptSignal(() =>
      this.transitionWatchChildren(context, () =>
        this.deferredSignals.accept(workflowInstanceId, signal, context),
      ),
    );
  }

  setAcceptSignalOperationCoordinator(coordinator: OperationCoordinator): void {
    this.coordinateAcceptSignal = coordinator;
  }

  setWatchChildCancellation(cancellation: WatchChildCancellation): void {
    this.watchChildCancellation = cancellation;
  }

  requestSupplementalActivity(
    workflowInstanceId: WorkflowInstanceId,
    request: SupplementalActivityRequest,
    context: CommandContext,
  ) {
    return this.delegationGate.run(workflowInstanceId, () =>
      this.advanceWorkflow.requestSupplementalActivity(workflowInstanceId, request, context),
    );
  }

  async applyConversationCommand(
    workItemId: WorkItemId,
    input: ConversationCommandInput,
    context: CommandContext,
  ): Promise<boolean> {
    return (await this.applyConversationCommandWithFeedback(workItemId, input, context)).applied;
  }

  async applyConversationCommandWithFeedback(
    workItemId: WorkItemId,
    input: ConversationCommandInput,
    context: CommandContext,
  ): Promise<ConversationCommandResult> {
    const command = conversationCommand(input.body);
    if (command === null) return { applied: false, reason: 'Message contains no command.' };
    const continuationRejection = continuationCommandRejection(input, command);
    if (continuationRejection !== null) return { applied: false, reason: continuationRejection };
    const reviewAuthorized = input.reviewAuthorized === true;
    if (!input.authorized && !reviewAuthorized)
      return {
        applied: false,
        reason:
          'Verified repository write, maintain, or admin permission is required for work control; independent-review authority is required for approval.',
      };
    // A command is causally adjacent to its conversation entry; projections may lag
    // the journal, so command application must read the authoritative workflow state.
    const workflows = (await this.advanceWorkflow.listAll()).filter(
      (workflow) => workflow.workItemId === workItemId,
    );
    if (conversationCommandAlreadyApplied(workflows, context.commandId)) return { applied: true };
    const work = await this.work.get(workItemId);
    if (!isWorkControllable(work))
      return { applied: false, reason: 'Work item must be open, unfrozen, and not deleted.' };
    if (!input.authorized && !isReviewConversationCommand(command))
      return { applied: false, reason: 'Verified repository work-control authority is required.' };
    // Explicit continuation invokes the owning recovery command; ordinary commands keep configured precedence.
    if (
      !input.continuation &&
      (await this.applyConfiguredConversationCommands(command, workflows, context))
    )
      return { applied: true };
    return applyBuiltInConversationCommand({
      command,
      capabilities: input.capabilities,
      reviewAuthorized,
      workAuthorized: input.authorized,
      continuation: input.continuation === true,
      workflows,
      context,
      acceptSignal: async (id, outcome) => {
        const updated = await this.acceptSignal(
          id,
          {
            kind: (workflows.find((workflow) => workflow.workflowInstanceId === id)?.waitingFor
              ?.signalKind ?? 'approved') as SignalName,
            outcome,
            actorId: input.actorId,
            actorDecision: { authorized: true, evidenceId: context.commandId },
            providerEventId: context.commandId,
            authority: { kind: ApprovalAuthorityKind.Human },
          },
          context,
        );
        return updated.acceptedSignalIds.includes(context.commandId);
      },
      retry: (id) => this.retryBlockedFailedStage(id, context),
      restart: (id) => this.restartBlockedFailedStage(id, context),
      extend: (id) =>
        this.extendBlockedGroupBudget(id, { kind: ApprovalAuthorityKind.Human }, context),
      resumeChanges: async (id) => {
        if (!input.authorized) return false;
        const updated = await this.resumeBlockedStageForChanges(id, context);
        return updated?.operatorRetryCommandIds.includes(context.commandId) === true;
      },
    });
  }

  private async applyConfiguredConversationCommands(
    command: string,
    workflows: readonly WorkflowInstanceView[],
    context: CommandContext,
  ): Promise<boolean> {
    let supplemental = false;
    for (const workflow of workflows) {
      const definition = await this.definitions.resolve(workflow);
      if (definition.commands[command as keyof typeof definition.commands] === undefined) continue;
      supplemental = true;
      await this.requestSupplementalActivity(
        workflow.workflowInstanceId,
        { command: commandName(command) },
        context,
      );
    }
    return supplemental;
  }

  markActivationStarted(
    workflowInstanceId: WorkflowInstanceId,
    activationId: ActivationId,
    context: CommandContext,
  ) {
    return this.advanceWorkflow.markActivationStarted(workflowInstanceId, activationId, context);
  }

  async validateActivationDispatch(
    workflowInstanceId: WorkflowInstanceId,
    context: CommandContext,
  ) {
    const view = (await this.repository.load(workflowInstanceId)).view;
    if (view !== null && (await this.delegationGate.unavailable(view))) return false;
    return this.childWorkflows.validateChildDispatch(workflowInstanceId, context);
  }

  block(workflowInstanceId: WorkflowInstanceId, reason: string, context: CommandContext) {
    return this.transitionWatchChildren(context, () =>
      this.advanceWorkflow.block(workflowInstanceId, reason, context),
    );
  }

  blockAwaitingActivation(
    workflowInstanceId: WorkflowInstanceId,
    activationId: ActivationId,
    reason: string,
    context: CommandContext,
  ) {
    return this.transitionWatchChildren(context, () =>
      this.advanceWorkflow.blockAwaitingActivation(
        workflowInstanceId,
        activationId,
        reason,
        context,
      ),
    );
  }

  resolveExecutionFailure(
    workflowInstanceId: WorkflowInstanceId,
    input: {
      readonly activationId: ActivationId;
      readonly runId: string;
      readonly reason: string;
      readonly failureKind?: ExecutionFailureCode;
    },
    context: CommandContext,
  ) {
    return this.transitionWatchChildren(context, () =>
      this.delegationGate.run(workflowInstanceId, () =>
        this.advanceWorkflow.resolveExecutionFailure(workflowInstanceId, input, context),
      ),
    );
  }

  retryRunnerQuotaFailure(
    workflowInstanceId: WorkflowInstanceId,
    input: {
      readonly activationId: ActivationId;
      readonly runId: string;
      readonly runnerName: string;
      readonly message: string;
    },
    context: CommandContext,
  ) {
    return this.transitionWatchChildren(context, () =>
      this.delegationGate.run(workflowInstanceId, () =>
        this.advanceWorkflow.retryRunnerQuotaFailure(workflowInstanceId, input, context),
      ),
    );
  }

  retryBlockedFailedStage(workflowInstanceId: WorkflowInstanceId, context: CommandContext) {
    return this.transitionWatchChildren(context, () =>
      this.delegationGate.run(workflowInstanceId, () =>
        this.advanceWorkflow.retryBlockedFailedStage(workflowInstanceId, context),
      ),
    );
  }

  restartBlockedFailedStage(workflowInstanceId: WorkflowInstanceId, context: CommandContext) {
    return this.transitionWatchChildren(context, () =>
      this.delegationGate.run(workflowInstanceId, () =>
        this.advanceWorkflow.restartBlockedFailedStage(workflowInstanceId, context),
      ),
    );
  }

  async resumeBlockedStageForChanges(
    workflowInstanceId: WorkflowInstanceId,
    context: CommandContext,
  ) {
    const current = await this.advanceWorkflow.get(workflowInstanceId);
    if (current === null) return null;
    const work = await this.work.get(current.workItemId);
    if (work === null || work.deleted || work.frozen || work.state !== WorkStatus.Open)
      return current;
    if (
      !current.operatorRetryCommandIds.includes(context.commandId) &&
      !selectChangesResumeTargets(
        (await this.advanceWorkflow.listAll()).filter(
          (workflow) => workflow.workItemId === current.workItemId,
        ),
      ).some((workflow) => workflow.workflowInstanceId === workflowInstanceId)
    )
      return current;
    return this.transitionWatchChildren(context, () =>
      this.delegationGate.run(workflowInstanceId, () =>
        this.advanceWorkflow.resumeBlockedStageForChanges(workflowInstanceId, context),
      ),
    );
  }

  async resumeBlockedStageForReply(
    workflowInstanceId: WorkflowInstanceId,
    context: CommandContext,
  ) {
    const current = await this.advanceWorkflow.get(workflowInstanceId);
    if (current === null || !isPlainReplyResumeEligible(current)) return current;
    return this.resumeBlockedStageForChanges(workflowInstanceId, context);
  }

  async resumeNeedsClarificationStage(
    workflowInstanceId: WorkflowInstanceId,
    context: CommandContext,
  ) {
    const current = await this.advanceWorkflow.get(workflowInstanceId);
    if (current === null || !isNeedsClarificationResumeEligible(current)) return current;
    return this.resumeBlockedStageForChanges(workflowInstanceId, context);
  }

  async extendBlockedGroupBudget(
    workflowInstanceId: WorkflowInstanceId,
    authority: { readonly kind: string },
    context: CommandContext,
  ) {
    if (authority.kind !== ApprovalAuthorityKind.Human)
      throw new GroupBudgetExtensionIneligibleError(
        'A group budget extension requires human authority',
      );
    const parent = await this.advanceWorkflow.get(workflowInstanceId);
    if (parent === null || !isGroupBudgetExtensionEligible(parent))
      throw new GroupBudgetExtensionIneligibleError(
        'Workflow is not blocked on a gate budget exhaustion',
      );
    const exhausted = (
      await journalGroupBudgetExhaustion(this.journal, parent.workflowInstanceId)
    ).at(-1);
    if (exhausted === undefined)
      throw new GroupBudgetExtensionIneligibleError(
        'Workflow has no durable gate budget exhaustion to extend',
      );
    const workflowName =
      exhausted.workflowName ??
      this.definitions
        .currentDefinition(parent.workflowName)
        .definition.watches.find((watch) => watch.id === exhausted.watchId)?.workflow;
    if (workflowName === undefined)
      throw new GroupBudgetExtensionIneligibleError(
        'Workflow has no durable gate definition to extend',
      );
    const group = childOrchestrationGroupStream(parent.orchestrationGroupId, exhausted.watchId);
    await this.claims.grantBudget(group, exhausted.requestId, context, authority);
    await this.waitForSignal(
      parent.workflowInstanceId,
      { ...parent.waitingFor!, suppressWatchDispatch: true },
      context,
    );
    return this.requestChild(
      {
        ...exhausted,
        workflowName,
        maxPerGroup: exhausted.maxPerGroup,
        requestId: toWorkflowInstanceId(exhausted.requestId),
      },
      { ...context, commandId: `${context.commandId}:dispatch` },
    );
  }

  get(id: WorkflowInstanceId) {
    return this.advanceWorkflow.get(id);
  }

  getPrimaryWorkflowInstanceId(workItemId: WorkItemId) {
    return this.childWorkflows.getPrimaryWorkflowInstanceId(workItemId);
  }

  async listPendingActivations(workItemId?: string) {
    const entries = await this.advanceWorkflow.listPendingActivations(workItemId);
    return this.delegationGate.filterAvailable(entries, (entry) => entry.workflow);
  }

  listWaiting(signalKind?: SignalName) {
    return this.advanceWorkflow.listWaiting(signalKind);
  }

  async expireTimedOutWaits(context: CommandContext) {
    // Only instances whose await has actually timed out need the gate, which is almost never any.
    const due = (await this.repository.list()).filter(
      ({ view }) =>
        view !== null &&
        expireTimedOutAwait(view, {
          occurredAt: context.occurredAt,
          causationId: context.commandId,
        }).kind !== 'ignored',
    );
    return expireTimedOutWaits(
      this.repository,
      context,
      await this.delegationGate.filterAvailable(due, ({ view }) => view),
    );
  }

  listAll() {
    return this.advanceWorkflow.listAll();
  }

  listCurrentDefinitions() {
    return this.definitions.currentDefinitions();
  }

  watchEventTypes(): readonly string[] {
    return [
      ...new Set(
        this.definitions
          .currentDefinitions()
          .flatMap(({ definition }) =>
            definition.watches.flatMap((watch) => watch.on?.events ?? []),
          ),
      ),
    ];
  }

  definitionFor(view: {
    readonly workflowName: WorkflowInstanceView['workflowName'];
    readonly workflowDefinitionFingerprint?: string;
  }) {
    return this.definitions.resolve(view);
  }

  async listForWorkItem(workItemId: WorkItemId) {
    if (this.projections === undefined)
      return (await this.advanceWorkflow.listAll()).filter(
        (workflow) => workflow.workItemId === workItemId,
      );
    const stored = await this.projections.read<readonly WorkflowInstanceId[]>(
      workflowsByWorkItemProjection.name,
      workItemId,
    );
    const workflows = await Promise.all(
      (stored?.value ?? []).map((workflowInstanceId) =>
        this.advanceWorkflow.get(workflowInstanceId),
      ),
    );
    return workflows.filter(
      (workflow): workflow is NonNullable<typeof workflow> => workflow !== null,
    );
  }

  async reconcileChildCompletions(context: CommandContext) {
    await this.delegatedWork.reconcile(context);
    return this.transitionWatchChildren(context, async () => {
      await this.childWorkflows.reconcileChildCompletions(context);
      await this.deferredSignals.reconcile(context);
    });
  }

  private async transitionWatchChildren<Result>(
    context: CommandContext,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const before = await this.advanceWorkflow.listAll();
    const result = await operation();
    const after = new Map(
      (await this.advanceWorkflow.listAll()).map((workflow) => [
        workflow.workflowInstanceId,
        workflow,
      ]),
    );
    for (const prior of before) {
      if (continuesWaitingForSameWatchGate(prior, after.get(prior.workflowInstanceId) ?? null))
        continue;
      const superseded = await this.childWorkflows.supersedeChildrenForWait(
        prior.workflowInstanceId,
        prior.waitingFor,
        context,
      );
      if (superseded.length > 0)
        await this.watchChildCancellation?.cancelSupersededWatchChildren(superseded);
    }
    return result;
  }

  isCausalRepeat(
    workflowInstanceId: WorkflowInstanceId,
    triggerId: string,
    causalCycleId: string | undefined,
    requestId?: string,
  ) {
    return this.childWorkflows.isCausalRepeat(
      workflowInstanceId,
      triggerId,
      causalCycleId,
      requestId,
    );
  }

  listWatchMatches(
    event: Parameters<AdvanceWorkflow['listWatchMatches']>[0],
    context?: CommandContext,
  ) {
    return this.advanceWorkflow.listWatchMatches(event, context);
  }

  recoverPolicyBlockedMerges(evidence: ResourceTransitionEvidence, context: CommandContext) {
    return recoverPolicyBlockedMerges(
      new OrchestrationRepository(this.journal),
      this.startWorkflow,
      evidence,
      context,
    );
  }

  listResourceTransitionMatches(
    event: Parameters<AdvanceWorkflow['listResourceTransitionMatches']>[0],
  ) {
    return this.advanceWorkflow.listResourceTransitionMatches(event);
  }

  applyResourceTransition(
    workflowInstanceId: WorkflowInstanceId,
    target: TransitionTarget,
    evidenceId: string,
    context: CommandContext,
  ) {
    return this.transitionWatchChildren(context, () =>
      this.deferredSignals.applyTransition(workflowInstanceId, target, evidenceId, context),
    );
  }
}

export class GroupBudgetExtensionIneligibleError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'GroupBudgetExtensionIneligibleError';
  }
}

async function journalGroupBudgetExhaustion(
  journal: EventJournal,
  workflowInstanceId: WorkflowInstanceId,
) {
  return (await journal.readStream(workflowInstanceStream(workflowInstanceId))).flatMap((event) => {
    const owned = selectOrchestrationEvent(event);
    return owned?.event.eventType === OrchestrationEventType.GroupBudgetExhausted
      ? [owned.event.payload]
      : [];
  });
}

export type OperationCoordinator = <Result>(operation: () => Promise<Result>) => Promise<Result>;

export interface WatchChildCancellation {
  cancelSupersededWatchChildren(workflowInstanceIds: readonly string[]): Promise<unknown>;
}

export const createOrchestrationService = (
  journal: EventJournal,
  work: WorkService,
  definitions: Readonly<Record<string, CompiledWorkflow>>,
  projections?: ProjectionStore,
  isAgentActivity?: AgentActivityClassifier,
  delegation?: DelegationDependenciesFactory,
) => new OrchestrationService(journal, work, definitions, projections, isAgentActivity, delegation);

function isWorkControllable(work: WorkItemView | null): boolean {
  return work !== null && !work.deleted && !work.frozen && work.state === WorkStatus.Open;
}

function conversationCommandAlreadyApplied(
  workflows: readonly WorkflowInstanceView[],
  commandId: string,
): boolean {
  return workflows.some(
    (workflow) =>
      workflow.operatorRetryCommandIds.includes(commandId) ||
      workflow.acceptedSignalIds.includes(commandId),
  );
}

function isReviewConversationCommand(command: string): boolean {
  return (
    command === ConversationBuiltInCommand.Approved ||
    command === ConversationBuiltInCommand.Accepted ||
    command === ConversationBuiltInCommand.Changes
  );
}

/** Immutable dependencies are resolved once; callbacks may refer to services composed later. */
type DelegationDependenciesFactory = (queries: {
  isActivationAccepted: (activationId: string, workItemId?: string) => Promise<boolean>;
}) => {
  artifacts: DelegationArtifacts;
  authority?: DelegationAuthority;
  repositories?: DelegationRepositories;
  integration?: DeliveryIntegration;
  runHasEnded: (runId: string) => Promise<boolean>;
};

async function unavailableRunCompletion(): Promise<never> {
  throw new Error('Delegation adapters unavailable');
}

function deliveryDependencies(
  dependencies: ReturnType<DelegationDependenciesFactory> | undefined,
  definitionFor: DeliveryDependencies['definitionFor'],
  work: WorkService,
): DeliveryDependencies {
  return {
    authority: dependencies?.authority ?? unavailableDelegationAuthority,
    repositories: dependencies?.repositories,
    integration: dependencies?.integration,
    // A finished producing workflow (a Closed child) is deliberately not a hold.
    unavailable: async (ids) => {
      const snapshot = await work.deliverySnapshot();
      const reasons = new Map<string, string>();
      for (const id of ids) {
        const lineage = [id, ...(snapshot.get(id)?.delegation?.ancestors ?? [])];
        const held = lineage.find((member) => {
          const state = snapshot.get(member);
          return (
            snapshot.invalid(member) ||
            state === null ||
            state.deleted === true ||
            state.frozen === true ||
            state.state === WorkStatus.Cancelled ||
            (member !== id && state.state !== WorkStatus.Open)
          );
        });
        if (held !== undefined) reasons.set(id, `Delivery work ${held} is unavailable`);
      }
      return reasons;
    },
    definitionFor,
  };
}

const unavailableArtifacts: DelegationArtifacts = {
  validateInputs: unavailableRunCompletion,
  registerChild: unavailableRunCompletion,
  qualifyingOutputs: unavailableRunCompletion,
};

const unavailableDelegationAuthority: DelegationAuthority = {
  assertCaller: unavailableRunCompletion,
  repositories: unavailableRunCompletion,
};
