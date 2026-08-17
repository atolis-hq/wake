import type { RunView } from '../../execution/index.js';
import type { CommandContext } from '../../kernel/index.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../../orchestration/index.js';
import type { ResourceService } from '../../resources/index.js';
import { WorkStatus } from '../../work/index.js';

export interface OrchestrationPort {
  reconcileChildCompletions(context: CommandContext): Promise<void>;
  listPendingActivations(
    workItemId?: string,
  ): Promise<readonly { workflow: WorkflowInstanceView; activation: ActivityActivationView }[]>;
  listWaiting(): Promise<readonly (WorkflowInstanceView | null)[]>;
  listAll?(): Promise<readonly WorkflowInstanceView[]>;
  validateActivationDispatch?(
    workflowInstanceId: string,
    context: CommandContext,
  ): Promise<boolean>;
  acceptOutcome(
    command: {
      workflowInstanceId: string;
      activationId: string;
      outcome: NonNullable<RunView['outcome']>;
    },
    context: CommandContext,
  ): Promise<WorkflowInstanceView>;
  resolveExecutionFailure?(
    workflowInstanceId: string,
    input: { readonly activationId: string; readonly runId: string; readonly reason: string },
    context: CommandContext,
  ): Promise<WorkflowInstanceView | null>;
  markActivationStarted(
    workflowInstanceId: string,
    activationId: string,
    context: CommandContext,
  ): Promise<WorkflowInstanceView | null>;
}

export interface ExecutionPort {
  recoverActive?(owner: string): Promise<readonly RunView[]>;
  attempt(
    activation: ActivityActivationView,
    context: {
      workItemId: WorkflowInstanceView['workItemId'];
      workflowInstanceId: WorkflowInstanceView['workflowInstanceId'];
      orchestrationGroupId: WorkflowInstanceView['orchestrationGroupId'];
      resources: readonly NonNullable<Awaited<ReturnType<ResourceService['get']>>>[];
      ineligibleRunners?: ReadonlySet<string>;
      sessionPolicy?: 'fresh' | 'resume-stage';
      awaitImmediateCompletion?: boolean;
    },
  ): Promise<RunView>;
  list(activationId?: ActivityActivationView['activationId']): Promise<readonly RunView[]>;
}

export interface AdvanceOnceDependencies {
  readonly ids: import('../../kernel/index.js').IdGenerator;
  readonly work?: {
    get(workItemId: string): Promise<{
      readonly state: WorkStatus;
      readonly frozen?: boolean;
      readonly deleted?: boolean;
    } | null>;
  };
  readonly runnerIneligibility?: () => Promise<ReadonlySet<string>>;
  readonly isDispatchPaused?: () => Promise<boolean>;
  readonly workspaceRecovery?: import('../../execution/index.js').WorkspaceRecovery;
  readonly transcriptRetention?: {
    markClosedWorkItem(workItemId: string): Promise<boolean>;
    sweep(): Promise<void>;
  };
  readonly closedWorkItemIds?: () => Promise<readonly string[]>;
  readonly dispatchPolicy?: import('../domain/dispatch-policy.js').DispatchPolicy;
  readonly maxConcurrentRuns?: number;
}
