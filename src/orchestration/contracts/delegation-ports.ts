import type { CommandContext } from '@atolis-hq/eventing';
import type { RepositoryAssignment } from '../../execution/index.js';
import type {
  DelegatedAssignment,
  DelegationCaller,
  DelegationPrerequisite,
  DelegationReservation,
  DelegationResult,
  DelegationRevisionReference,
  RepositoryAssignmentRequest,
} from './delegation.js';
import type { WorkflowInstanceView } from './views.js';

/** Trusted Bootstrap adapters; no provider, Run or session authority is supplied by assignments. */
export interface DelegationArtifacts {
  prerequisiteOutput?(
    child: WorkflowInstanceView,
    output: DelegatedAssignment['outputs'][number],
    condition: DelegationPrerequisite['condition'],
  ): Promise<DelegationResult['outputs'][number] | null>;
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

export interface DelegationAuthority {
  assertCaller(caller: DelegationCaller, parent: WorkflowInstanceView): Promise<void>;
  repositories(parent: WorkflowInstanceView): Promise<readonly string[]>;
  /**
   * Records the root's default repository scope from trusted provider identity when no
   * Repository Resource is yet correlated. Agent input never reaches this binding.
   */
  bindRepositoryScope?(root: WorkflowInstanceView, context: CommandContext): Promise<void>;
}

/** Resolves only repositories already authorized by the parent's resource scope. */
export interface DelegationRepositories {
  resolve(
    parent: WorkflowInstanceView,
    request: RepositoryAssignmentRequest,
  ): Promise<RepositoryAssignment>;
}
