import type { z } from 'zod';
import type { ResourceCapability, ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
export interface ResourceRequirement {
  readonly capability: ResourceCapability;
  readonly cardinality: 'zero-or-one' | 'exactly-one' | 'one-or-more';
  readonly role?: 'primary' | 'secondary';
}
export interface ActivityInvocation<Input = unknown> {
  readonly activationId: string;
  readonly activity: string;
  readonly workItemId: WorkItemId;
  readonly workflowInstanceId: string;
  readonly orchestrationGroupId: string;
  readonly causationId: string;
  readonly input: Input;
  readonly resources: readonly ResourceView[];
}
export interface ActivityOutcome<Kind extends string = string, Data = unknown> {
  readonly kind: Kind;
  readonly data?: Data;
}
export interface WaitingActivityOutcome extends ActivityOutcome<
  'waiting',
  { readonly intentEventId: string; readonly signalKind: string }
> {
  readonly data: { readonly intentEventId: string; readonly signalKind: string };
}
export interface ActivityExecutionContext {
  readonly signal: AbortSignal;
  readonly occurredAt: string;
  reportExternalExecution(reference: {
    readonly kind: 'process' | 'remote-session';
    readonly id: string;
    readonly startedAt: string;
  }): Promise<void>;
}
export interface ActivityHandler<Input = unknown> {
  execute(
    invocation: ActivityInvocation<Input>,
    context: ActivityExecutionContext,
  ): Promise<ActivityOutcome>;
}
export interface ActivityDefinition<Input = unknown> {
  readonly name: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly outcomeSchema: z.ZodType<ActivityOutcome>;
  readonly resources: readonly ResourceRequirement[];
  readonly executionKind: 'agent' | 'script' | 'deterministic';
  readonly handler: ActivityHandler<Input>;
}
