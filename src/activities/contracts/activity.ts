import type { z } from 'zod';
import type { Brand } from '../../kernel/index.js';
import type { ResourceCapability, ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { ActivationId, ActivityName } from './identifiers.js';
import type {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityResourceCardinality,
  ActivityResourceRole,
  ActivityRunnerTransportStatus,
  ActivityWorkspaceMode,
  ExternalExecutionKind,
} from './vocabulary.js';

export interface ResourceRequirement {
  readonly capability: ResourceCapability;
  readonly cardinality: ActivityResourceCardinality;
  readonly role?: ActivityResourceRole;
}

export type ActivityWorkflowInstanceId = Brand<string, 'WorkflowInstanceId'>;

export type ActivityOrchestrationGroupId = Brand<string, 'OrchestrationGroupId'>;

export const activityWorkflowInstanceId = (value: string): ActivityWorkflowInstanceId => {
  if (value.trim().length === 0) throw new Error('WorkflowInstance id must not be empty');
  return value as ActivityWorkflowInstanceId;
};

export const activityOrchestrationGroupId = (value: string): ActivityOrchestrationGroupId => {
  if (value.trim().length === 0) throw new Error('Orchestration group id must not be empty');
  return value as ActivityOrchestrationGroupId;
};

export interface ActivityInvocation<Input = unknown> {
  readonly activationId: ActivationId;
  readonly activity: ActivityName;
  readonly workItemId: WorkItemId;
  readonly workflowInstanceId: ActivityWorkflowInstanceId;
  readonly orchestrationGroupId: ActivityOrchestrationGroupId;
  readonly causationId: string;
  readonly input: Input;
  readonly resources: readonly ResourceView[];
}

export interface ActivityOutcome<Kind extends string = string, Data = unknown> {
  readonly kind: Kind;
  readonly data?: Data;
}

export interface WaitingActivityOutcome extends ActivityOutcome<
  typeof ActivityOutcomeKind.Waiting,
  { readonly intentEventId: string; readonly signalKind: string }
> {
  readonly data: { readonly intentEventId: string; readonly signalKind: string };
}

export interface AgentRunnerPort {
  start(
    request: {
      readonly runId: string;
      readonly prompt: string;
      readonly model?: string;
      readonly effort?: string;
      readonly allowedTools: readonly string[];
      readonly maxTurns?: number;
      /** Opaque prior adapter session selected by Execution for this activation. */
      readonly resumeSessionId?: string;
      readonly usageBaseline?: {
        readonly input: number;
        readonly output: number;
        readonly cacheRead?: number;
        readonly cacheWrite?: number;
      };
      readonly context?: {
        readonly runnerName: string;
        readonly action: string;
        readonly activationOrdinal: number;
      };
    },
    signal: AbortSignal,
  ): Promise<{
    readonly identity?: {
      readonly kind: ExternalExecutionKind;
      readonly id: string;
      readonly startedAt: string;
    };
    readonly result: Promise<{
      readonly transport: ActivityRunnerTransportStatus;
      readonly output: string;
      readonly runner?: string | undefined;
      readonly sessionId?: string | undefined;
      readonly tokenUsage?:
        | {
            readonly input: number;
            readonly output: number;
            readonly cacheRead?: number | undefined;
            readonly cacheWrite?: number | undefined;
            readonly costUsd?: number | undefined;
          }
        | undefined;
      readonly failure?: { readonly kind: string; readonly message: string } | undefined;
    }>;
  }>;
}

export interface ActivityExecutionContext {
  readonly signal: AbortSignal;
  readonly occurredAt: string;
  /** Durable Execution Run identity when the activity is invoked by Execution. */
  readonly runId?: string;
  /** Opaque prior adapter session selected by Execution for this activation. */
  readonly resumeSessionId?: string;
  readonly usageBaseline?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
  /** Isolated workspace leased by Execution for this invocation, when requested. */
  readonly workspace?: { readonly path: string; readonly mode: ActivityWorkspaceMode };
  readonly runner?: AgentRunnerPort;
  readonly runnerContext?: {
    readonly runnerName: string;
    /** CLI identity configured for the resolved runner. */
    readonly runnerCli?: string;
    readonly activationOrdinal: number;
    readonly model?: string;
    readonly effort?: string;
  };
  /** Optional operational capture of the exact agent conversation. */
  readonly transcriptRecorder?: {
    capturePrompt(capture: {
      readonly workItemId: string;
      readonly runId: string;
      readonly cli: string;
      readonly timestamp: string;
      readonly text: string;
    }): Promise<void>;
    captureResponse(capture: {
      readonly workItemId: string;
      readonly runId: string;
      readonly cli: string;
      readonly sessionId?: string | undefined;
      readonly timestamp: string;
      readonly text: string;
    }): Promise<void>;
    finalisePrompt?(capture: {
      readonly workItemId: string;
      readonly runId: string;
      readonly cli: string;
      readonly timestamp: string;
    }): Promise<void>;
  };
  /** Best-effort operational diagnostics that must not affect activity execution. */
  readonly logOperationalError?: (error: unknown) => void;
  reportExternalExecution(reference: {
    readonly kind: ExternalExecutionKind;
    readonly id: string;
    readonly startedAt: string;
  }): Promise<void>;
  reportRunnerResult?(result: {
    readonly transport: ActivityRunnerTransportStatus;
    readonly output: string;
    readonly runner: string;
    readonly model?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly tokenUsage?:
      | {
          readonly input: number;
          readonly output: number;
          readonly cacheRead?: number | undefined;
          readonly cacheWrite?: number | undefined;
          readonly costUsd?: number | undefined;
        }
      | undefined;
    readonly failure?: { readonly kind: string; readonly message: string } | undefined;
  }): Promise<void>;
}

export interface ActivityHandler<Input, Outcome extends ActivityOutcome> {
  execute(
    invocation: ActivityInvocation<Input>,
    context: ActivityExecutionContext,
  ): Promise<Outcome>;
}

export interface ActivityDefinition<
  Name extends ActivityName = ActivityName,
  Input = unknown,
  Outcome extends ActivityOutcome = ActivityOutcome,
> {
  readonly name: Name;
  readonly inputSchema: z.ZodType<Input>;
  readonly outcomeSchema: z.ZodType<Outcome>;
  readonly outcomeKinds: readonly Outcome['kind'][];
  readonly resources: readonly ResourceRequirement[];
  readonly executionKind: ActivityExecutionKind;
  readonly handler: ActivityHandler<Input, Outcome>;
}
