import type { PullRequestMergeability, PullRequestState } from '../../activities/index.js';
import type { CompiledWorkflow } from './config.js';
import type { DelegationAuthority, DelegationRepositories } from './delegation-ports.js';
import type { WorkflowInstanceView } from './views.js';

export interface DeliveryPullRequest {
  readonly state: PullRequestState;
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly mergeRevision?: string | undefined;
  readonly mergeability?: PullRequestMergeability | undefined;
}

/** Trusted Bootstrap adapters over provider-observed facts and Execution's Run records. */
export interface DeliveryIntegration {
  /** The current provider-observed pull request, or null when it has not been observed. */
  observe(resourceId: string): Promise<DeliveryPullRequest | null>;
  verifyTarget(request: {
    readonly ownerWorkItemId: string;
    readonly resourceId: string;
    readonly repositoryResourceId: string;
    readonly branch: string;
    readonly revision: string;
    readonly pullRequestBase: string;
    readonly baseRevision?: string | undefined;
    readonly maintenanceRecordedAt?: string | undefined;
    readonly maintenanceRunId?: string | undefined;
    readonly requireReview: boolean;
    readonly requireChecks: boolean;
  }): Promise<boolean>;
  /**
   * Proves the Run was durably prepared with the target's branch lease, and that no earlier
   * maintenance Run of the same target is still unresolved or ambiguous.
   */
  assertMaintenanceWriter(request: {
    readonly workflowInstanceId: string;
    readonly activationId: string;
    readonly runId: string;
    readonly childWorkItemId: string;
    readonly resourceId: string;
    readonly revision: string;
  }): Promise<void>;
}

export interface DeliveryDependencies {
  readonly authority: DelegationAuthority;
  /** Resolves a repository source through the parent's own repository authority. */
  readonly repositories?: DelegationRepositories | undefined;
  readonly integration?: DeliveryIntegration | undefined;
  /**
   * Reasons integration must not touch a child's output: the child or any ancestor is frozen,
   * cancelled or deleted. A finished producing workflow is not a reason.
   */
  readonly unavailable?:
    ((childWorkItemIds: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined;
  readonly definitionFor: (parent: WorkflowInstanceView) => Promise<CompiledWorkflow>;
}
