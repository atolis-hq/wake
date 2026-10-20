import type { CompiledWorkflow } from './config.js';
import type { DelegationAuthority, DelegationRepositories } from './delegation-ports.js';
import type { WorkflowInstanceView } from './views.js';

export interface DeliveryDependencies {
  readonly authority: DelegationAuthority;
  /** Resolves a repository source through the parent's own repository authority. */
  readonly repositories?: DelegationRepositories | undefined;
  readonly definitionFor: (parent: WorkflowInstanceView) => Promise<CompiledWorkflow>;
}
