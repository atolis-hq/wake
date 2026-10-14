import { recoverPolicyBlockedMerges } from './policy-blocked-merge-recovery.js';
import type { ResourceTransitionEvidence } from './resource-transition-evidence.js';
/* eslint-disable max-lines */
import type { CommandContext, EventJournal, ProjectionStore } from '@atolis-hq/eventing';
import type { ActivationId, ActivityOutcome } from '../../activities/index.js';
import {
  WorkStatus,
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
import { ApprovalAuthorityKind, ConversationBuiltInCommand } from '../contracts/vocabulary.js';
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
import { GroupBudgetRecorder } from './group-budget-recorder.js';
import { workflowsByWorkItemProjection } from './orchestration-projection.js';
import { OrchestrationRepository } from './orchestration-repository.js';
import type { AgentActivityClassifier } from './pending-activations.js';
import { RequestChild } from './request-child.js';
import { StartWorkflow } from './start-workflow.js';
import { continuesWaitingForSameWatchGate } from './watch-child-transitions.js';
import { WorkflowDefinitionRegistry } from './workflow-definition-registry.js';

export class OrchestrationService {
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

  constructor(
    journal: EventJournal,
    work: WorkService,
    definitions: Readonly<Record<string, CompiledWorkflow>>,
    projections?: ProjectionStore,
    isAgentActivity?: AgentActivityClassifier,
  ) {
    this.projections = projections;
    this.journal = journal;
    this.work = work;
    const repository = new OrchestrationRepository(journal);
    this.claims = new CoordinationClaims(journal);
    this.definitions = new WorkflowDefinitionRegistry(journal, projections, definitions);
    this.startWorkflow = new StartWorkflow(repository, this.claims, work, this.definitions);
    this.advanceWorkflow = new AdvanceWorkflow(repository, this.startWorkflow, isAgentActivity);
    this.acceptWorkflowSignal = new AcceptSignal(repository, this.startWorkflow, work);
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
      (context) => this.childWorkflows.reconcileChildCompletions(context),
    );
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
      this.acceptActivityOutcome.execute(command, context),
    );
  }

  waitForSignal(
    workflowInstanceId: WorkflowInstanceId,
    expectation: SignalExpectation,
    context: CommandContext,
  ) {
    return this.transitionWatchChildren(context, () =>
      this.acceptWorkflowSignal.wait(workflowInstanceId, expectation, context),
    );
  }

  acceptSignal(
    workflowInstanceId: WorkflowInstanceId,
    signal: OrchestrationSignal,
    context: CommandContext,
  ) {
    return this.coordinateAcceptSignal(() =>
      this.transitionWatchChildren(context, () =>
        this.acceptWorkflowSignal.execute(workflowInstanceId, signal, context),
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
    return this.advanceWorkflow.requestSupplementalActivity(workflowInstanceId, request, context);
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

  validateActivationDispatch(workflowInstanceId: WorkflowInstanceId, context: CommandContext) {
    return this.childWorkflows.validateChildDispatch(workflowInstanceId, context);
  }

  block(workflowInstanceId: WorkflowInstanceId, reason: string, context: CommandContext) {
    return this.transitionWatchChildren(context, () =>
      this.advanceWorkflow.block(workflowInstanceId, reason, context),
    );
  }

  resolveExecutionFailure(
    workflowInstanceId: WorkflowInstanceId,
    input: { readonly activationId: ActivationId; readonly runId: string; readonly reason: string },
    context: CommandContext,
  ) {
    return this.transitionWatchChildren(context, () =>
      this.advanceWorkflow.resolveExecutionFailure(workflowInstanceId, input, context),
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
      this.advanceWorkflow.retryRunnerQuotaFailure(workflowInstanceId, input, context),
    );
  }

  retryBlockedFailedStage(workflowInstanceId: WorkflowInstanceId, context: CommandContext) {
    return this.transitionWatchChildren(context, () =>
      this.advanceWorkflow.retryBlockedFailedStage(workflowInstanceId, context),
    );
  }

  restartBlockedFailedStage(workflowInstanceId: WorkflowInstanceId, context: CommandContext) {
    return this.transitionWatchChildren(context, () =>
      this.advanceWorkflow.restartBlockedFailedStage(workflowInstanceId, context),
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
      this.advanceWorkflow.resumeBlockedStageForChanges(workflowInstanceId, context),
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

  listPendingActivations(workItemId?: string) {
    return this.advanceWorkflow.listPendingActivations(workItemId);
  }

  listWaiting(signalKind?: SignalName) {
    return this.advanceWorkflow.listWaiting(signalKind);
  }

  expireTimedOutWaits(context: CommandContext) {
    return this.advanceWorkflow.expireTimedOutWaits(context);
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

  reconcileChildCompletions(context: CommandContext) {
    return this.transitionWatchChildren(context, () =>
      this.childWorkflows.reconcileChildCompletions(context),
    );
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
      this.advanceWorkflow.applyResourceTransition(workflowInstanceId, target, evidenceId, context),
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
) => new OrchestrationService(journal, work, definitions, projections, isAgentActivity);

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
