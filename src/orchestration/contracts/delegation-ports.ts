import type { CommandContext } from '@atolis-hq/eventing';
import type {
  DelegatedAssignment,
  DelegationReservation,
  DelegationResult,
  DelegationRevisionReference,
} from './delegation.js';
import type { WorkflowInstanceView } from './views.js';

/** Trusted Bootstrap adapters; no provider, Run or session authority is supplied by assignments. */
export interface DelegationArtifacts {
  validateInputs(
    parent: WorkflowInstanceView,
    references: readonly DelegationRevisionReference[],
  ): Promise<void>;
  registerChild(
    grant: {
      readonly delegationId: string;
      readonly parentWorkItemId: DelegationReservation['parentWorkItemId'];
      readonly childWorkItemId: DelegationReservation['parentWorkItemId'];
      readonly childReferences: readonly DelegationRevisionReference[];
    },
    context: CommandContext,
  ): Promise<void>;
  qualifyingOutputs(
    child: WorkflowInstanceView,
    outputs: DelegatedAssignment['outputs'],
  ): Promise<DelegationResult['outputs'] | null>;
}
