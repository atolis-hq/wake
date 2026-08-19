import type { ActivationId, ActivityOutcome } from '../../activities/index.js';
import type { CommandContext, EventJournal, ProjectionStore } from '../../kernel/index.js';
import type { WorkItemId, WorkService } from '../../work/index.js';
import type { StartWorkflowInstance } from '../contracts/commands.js';
import type { CompiledWorkflow, TransitionTarget } from '../contracts/config.js';
import type {
  ChildWorkflowRequest,
  OrchestrationSignal,
  SignalExpectation,
  SupplementalActivityRequest,
} from '../contracts/events.js';
import type { SignalName, WorkflowInstanceId } from '../contracts/identifiers.js';
import { AcceptActivityOutcome } from './accept-activity-outcome.js';
import { AcceptSignal } from './accept-signal.js';
import { AdvanceWorkflow } from './advance-workflow.js';
import { CoordinationClaims } from './coordination-claims.js';
import { GroupBudgetRecorder } from './group-budget-recorder.js';
import { workflowsByWorkItemProjection } from './orchestration-projection.js';
import { OrchestrationRepository } from './orchestration-repository.js';
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

  constructor(
    journal: EventJournal,
    work: WorkService,
    definitions: Readonly<Record<string, CompiledWorkflow>>,
    projections?: ProjectionStore,
  ) {
    this.projections = projections;
    const repository = new OrchestrationRepository(journal);
    const claims = new CoordinationClaims(journal);
    this.startWorkflow = new StartWorkflow(
      repository,
      claims,
      work,
      new WorkflowDefinitionRegistry(journal, projections, definitions),
    );
    this.advanceWorkflow = new AdvanceWorkflow(repository, this.startWorkflow);
    this.acceptWorkflowSignal = new AcceptSignal(repository, this.startWorkflow, work);
    this.childWorkflows = new RequestChild(
      repository,
      claims,
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

  resumeBlockedStageForChanges(workflowInstanceId: WorkflowInstanceId, context: CommandContext) {
    return this.transitionWatchChildren(context, () =>
      this.advanceWorkflow.resumeBlockedStageForChanges(workflowInstanceId, context),
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

  listAll() {
    return this.advanceWorkflow.listAll();
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

export type OperationCoordinator = <Result>(operation: () => Promise<Result>) => Promise<Result>;

export interface WatchChildCancellation {
  cancelSupersededWatchChildren(workflowInstanceIds: readonly string[]): Promise<unknown>;
}

export const createOrchestrationService = (
  journal: EventJournal,
  work: WorkService,
  definitions: Readonly<Record<string, CompiledWorkflow>>,
  projections?: ProjectionStore,
) => new OrchestrationService(journal, work, definitions, projections);
