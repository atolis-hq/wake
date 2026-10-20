import { z } from 'zod';
import { brandedStringSchema } from '../../kernel/index.js';
import type { ResourceId } from '../../resources/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import type { ActivationId } from '../contracts/identifiers.js';
import type { PullRequestDenialCode } from './vocabulary.js';

/** The one action a parent delivery may ask of a child-owned pull request. */
export const ParentActionKind = { Approve: 'approve', Merge: 'merge-pr' } as const;

export type ParentActionKind = (typeof ParentActionKind)[keyof typeof ParentActionKind];

/**
 * Activity input that selects the delivery's next planned target instead of the invoking
 * WorkItem's own pull request. It names no target: Wake derives it from the parent's journal.
 */
export interface ParentDeliveryScope {
  readonly delivery: 'next';
}

export const parentDeliveryScopeSchema: z.ZodType<ParentDeliveryScope> = z
  .object({ delivery: z.literal('next') })
  .strict();

/**
 * Durable context recorded on the delivery intent. The requesting parent and the resource owner
 * stay separate: the child remains the PR's primary owner and nothing is transferred.
 */
export const parentActionContextSchema = z
  .object({
    requestingWorkItemId: brandedStringSchema(workItemId),
    ownerWorkItemId: brandedStringSchema(workItemId),
    output: z
      .object({ childWorkItemId: brandedStringSchema(workItemId), outputName: z.string().min(1) })
      .strict(),
    candidateId: z.string().min(1),
    selectionRevision: z.number().int().positive(),
    qaId: z.string().min(1),
  })
  .strict();

export interface ParentActionContext {
  readonly requestingWorkItemId: WorkItemId;
  readonly ownerWorkItemId: WorkItemId;
  readonly output: { readonly childWorkItemId: WorkItemId; readonly outputName: string };
  readonly candidateId: string;
  readonly selectionRevision: number;
  readonly qaId: string;
}

export interface ParentActionRequest {
  readonly workflowInstanceId: string;
  readonly activationId: ActivationId;
  readonly action: ParentActionKind;
}

export type ParentActionDecision =
  | {
      readonly kind: 'target';
      readonly context: ParentActionContext;
      readonly resourceId: ResourceId;
      readonly revision: string;
    }
  | { readonly kind: 'fully-integrated' }
  | { readonly kind: 'denied'; readonly reason: PullRequestDenialCode };

/** Validated by Orchestration; Activities hold only this narrow port, never the delivery model. */
export interface ParentActionAuthorizer {
  authorize(request: ParentActionRequest): Promise<ParentActionDecision>;
}
