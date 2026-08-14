import type { ActivationId, ActivityOutcome } from '../../activities/index.js';
import type { CommandContext, EventJournal, ProjectionStore } from '../../kernel/index.js';
import type { WorkItemId, WorkService } from '../../work/index.js';
import type { StartWorkflowInstance } from '../contracts/commands.js';
import type { CompiledWorkflow } from '../contracts/config.js';
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
import { OrchestrationRepository } from './orchestration-repository.js';
import { RequestChild } from './request-child.js';
import { StartWorkflow } from './start-workflow.js';
import { WorkflowDefinitionRegistry } from './workflow-definition-registry.js';

export class OrchestrationService {
  private readonly startWorkflow: StartWorkflow;
  private readonly acceptActivityOutcome: AcceptActivityOutcome;
  private readonly acceptWorkflowSignal: AcceptSignal;
  private readonly advanceWorkflow: AdvanceWorkflow;
  private readonly childWorkflows: RequestChild;

  constructor(
    journal: EventJournal,
    work: WorkService,
    definitions: Readonly<Record<string, CompiledWorkflow>>,
    projections?: ProjectionStore,
  ) {
    const repository = new OrchestrationRepository(journal);
    const claims = new CoordinationClaims(journal);
    this.startWorkflow = new StartWorkflow(
      repository,
      claims,
      work,
      new WorkflowDefinitionRegistry(journal, projections, definitions),
    );
    this.acceptWorkflowSignal = new AcceptSignal(repository, this.startWorkflow, work);
    this.advanceWorkflow = new AdvanceWorkflow(repository, this.startWorkflow);
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
    return this.acceptActivityOutcome.execute(command, context);
  }

  waitForSignal(
    workflowInstanceId: WorkflowInstanceId,
    expectation: SignalExpectation,
    context: CommandContext,
  ) {
    return this.acceptWorkflowSignal.wait(workflowInstanceId, expectation, context);
  }

  acceptSignal(
    workflowInstanceId: WorkflowInstanceId,
    signal: OrchestrationSignal,
    context: CommandContext,
  ) {
    return this.acceptWorkflowSignal.execute(workflowInstanceId, signal, context);
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

  block(workflowInstanceId: WorkflowInstanceId, reason: string, context: CommandContext) {
    return this.advanceWorkflow.block(workflowInstanceId, reason, context);
  }

  resolveExecutionFailure(
    workflowInstanceId: WorkflowInstanceId,
    input: { readonly activationId: ActivationId; readonly runId: string; readonly reason: string },
    context: CommandContext,
  ) {
    return this.advanceWorkflow.resolveExecutionFailure(workflowInstanceId, input, context);
  }

  retryBlockedFailedStage(workflowInstanceId: WorkflowInstanceId, context: CommandContext) {
    return this.advanceWorkflow.retryBlockedFailedStage(workflowInstanceId, context);
  }

  resumeBlockedStageForChanges(workflowInstanceId: WorkflowInstanceId, context: CommandContext) {
    return this.advanceWorkflow.resumeBlockedStageForChanges(workflowInstanceId, context);
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

  reconcileChildCompletions(context: CommandContext) {
    return this.childWorkflows.reconcileChildCompletions(context);
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
}

export const createOrchestrationService = (
  journal: EventJournal,
  work: WorkService,
  definitions: Readonly<Record<string, CompiledWorkflow>>,
  projections?: ProjectionStore,
) => new OrchestrationService(journal, work, definitions, projections);
