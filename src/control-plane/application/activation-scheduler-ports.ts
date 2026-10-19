import type { CommandContext } from '@atolis-hq/eventing';
import type {
  ExecutionFailureCode,
  RepositoryAssignment,
  RunView,
  WorkspaceRecovery,
} from '../../execution/index.js';
import type { IdGenerator } from '../../kernel/index.js';
import type {
  ActivityActivationView,
  PendingActivationPriority,
  WorkflowInstanceView,
} from '../../orchestration/index.js';
import type { ResourceService } from '../../resources/index.js';
import type { DeliverySnapshot, WorkDelegation, WorkItemId, WorkStatus } from '../../work/index.js';
import type { DispatchPolicy } from '../domain/dispatch-policy.js';

export interface OrchestrationPort {
  reconcileChildCompletions(context: CommandContext): Promise<void>;
  listPendingActivations(workItemId?: string): Promise<
    readonly {
      workflow: WorkflowInstanceView;
      activation: ActivityActivationView;
      priority?: PendingActivationPriority;
    }[]
  >;
  listWaiting(): Promise<readonly (WorkflowInstanceView | null)[]>;
  repositoryAssignment?(workItemId: string): Promise<RepositoryAssignment | undefined>;
  get?(workflowInstanceId: string): Promise<WorkflowInstanceView | null>;
  expireTimedOutWaits?(context: CommandContext): Promise<readonly WorkflowInstanceView[]>;
  listAll?(): Promise<readonly WorkflowInstanceView[]>;
  deliveryRunLimit?(id: WorkItemId): Promise<number | undefined>;
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
    input: {
      readonly activationId: string;
      readonly runId: string;
      readonly reason: string;
      readonly failureKind?: ExecutionFailureCode;
    },
    context: CommandContext,
  ): Promise<WorkflowInstanceView | null>;
  retryRunnerQuotaFailure?(
    workflowInstanceId: string,
    input: {
      readonly activationId: string;
      readonly runId: string;
      readonly runnerName: string;
      readonly message: string;
    },
    context: CommandContext,
  ): Promise<WorkflowInstanceView | null>;
  markActivationStarted(
    workflowInstanceId: string,
    activationId: string,
    context: CommandContext,
  ): Promise<WorkflowInstanceView | null>;
  block?(
    workflowInstanceId: string,
    reason: string,
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
      repositoryAssignment?: RepositoryAssignment;
      resources: readonly NonNullable<Awaited<ReturnType<ResourceService['get']>>>[];
      ineligibleRunners?: ReadonlySet<string>;
      sessionPolicy?: 'fresh' | 'resume-stage';
      awaitImmediateCompletion?: boolean;
    },
  ): Promise<RunView>;
  list(activationId?: ActivityActivationView['activationId']): Promise<readonly RunView[]>;
}

/** Protects one complete scheduler pass across local or competing processes. */
export type ActivationSchedulerSerialiser = <Value>(
  operation: () => Promise<Value>,
  signal?: AbortSignal,
) => Promise<Value>;

export interface ActivationSchedulerDependencies {
  readonly ids: IdGenerator;
  readonly work?: {
    get(workItemId: string): Promise<{
      readonly state: WorkStatus;
      readonly delegation?: WorkDelegation;
      readonly frozen?: boolean;
      readonly deleted?: boolean;
    } | null>;
    deliverySnapshot(): Promise<DeliverySnapshot>;
  };
  readonly runnerIneligibility?: () => Promise<ReadonlySet<string>>;
  readonly isDispatchPaused?: () => Promise<boolean>;
  readonly workspaceRecovery?: WorkspaceRecovery;
  readonly transcriptRetention?: {
    markClosedWorkItem(workItemId: string): Promise<boolean>;
    sweep(): Promise<void>;
  };
  readonly closedWorkItemIds?: () => Promise<readonly string[]>;
  readonly dispatchPolicy?: DispatchPolicy;
  readonly maxConcurrentRuns?: number;
  readonly maxOpenWorkItems?: number | null;
  readonly maxDispatches?: number;
  readonly schedulerSerialiser?: ActivationSchedulerSerialiser;
}
