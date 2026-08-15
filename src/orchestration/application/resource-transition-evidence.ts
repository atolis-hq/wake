import type { selectActivityEvent } from '../../activities/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { CompiledResourceTransition } from '../contracts/config.js';

export type ResourceTransitionFact = Parameters<typeof selectActivityEvent>[0];

export interface ResourceTransitionEvidenceInput {
  readonly workItemId: WorkItemId;
  readonly transitions: readonly CompiledResourceTransition[];
  readonly fact?: ResourceTransitionFact;
}

export interface ResourceTransitionEvidenceResolution {
  readonly transition: CompiledResourceTransition;
  readonly evidenceId: string;
}

export interface ResourceTransitionEvidence {
  /** Fact types the reactor tails on this policy's behalf. */
  readonly triggers: readonly string[];
  resolve(
    input: ResourceTransitionEvidenceInput,
  ): Promise<ResourceTransitionEvidenceResolution | null>;
}
