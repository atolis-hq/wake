import type { CommandContext } from '@atolis-hq/eventing';
import { readDeliveryAvailability, type WorkService } from '../../work/index.js';
import type { DelegationAuthority } from '../contracts/delegation-ports.js';
import {
  delegationSubmissionSchema,
  type DelegationCaller,
  type DelegationSubmission,
} from '../contracts/delegation.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import type { DelegatedWork } from './delegated-work.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';
import type { WorkflowDefinitionRegistry } from './workflow-definition-registry.js';

/** Agent inputs describe work; authority comes from the current Run and workflow. */
export class DelegationCommands {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly work: WorkService,
    private readonly workflows: StartWorkflow,
    private readonly definitions: WorkflowDefinitionRegistry,
    private readonly delegated: DelegatedWork,
    private readonly authority: DelegationAuthority,
  ) {}

  async submit(caller: DelegationCaller, input: DelegationSubmission, context: CommandContext) {
    const command = delegationSubmissionSchema.parse(input);
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    await this.authority.assertCaller(caller, parent);
    if (
      (parent.pendingActivation?.activationId ?? parent.delegationFence?.activationId) !==
        caller.activationId ||
      (parent.status !== WorkflowStatus.Active && parent.status !== WorkflowStatus.Waiting)
    )
      throw new Error('Delegation requires the current active activation');
    const availability = await readDeliveryAvailability(parent.workItemId, this.work);
    if (availability.reason !== undefined) throw new Error(availability.reason);
    const policy = (await this.workflows.definitionFor(parent)).delegation;
    if (policy === undefined) throw new Error('Workflow delegation is disabled');
    const root = await this.rootFor(parent);
    const rootPolicy = (await this.workflows.definitionFor(root)).delegation;
    const rootRepositories = await this.authority.repositories(root);
    const inherited = (await this.authority.repositories(parent)).filter((id) =>
      rootRepositories.includes(id),
    );
    const assignments = command.assignments.map((assignment) => {
      if (
        !policy.workflows.includes(assignment.workflowName) ||
        rootPolicy === undefined ||
        !rootPolicy.workflows.includes(assignment.workflowName)
      )
        throw new Error('Delegation workflow is not allowed');
      const repositories =
        assignment.repositoryResourceIds ??
        inherited.filter(
          (id) => policy.repositories === undefined || policy.repositories.includes(id),
        );
      if (
        repositories.some(
          (id) =>
            !inherited.includes(id) ||
            (policy.repositories !== undefined && !policy.repositories.includes(id)),
        )
      )
        throw new Error('Delegation repository authority exceeded');
      return {
        ...assignment,
        ...(repositories.length === 0 ? {} : { repositoryResourceIds: repositories }),
        workflowFingerprint: this.definitions.currentDefinition(assignment.workflowName)
          .fingerprint,
      };
    });
    return this.delegated.reserve(caller, command.cohortId, assignments, context, {
      maxDepth: policy.maxDepth,
      maxDescendants: policy.maxDescendants,
      maxConcurrentRuns: policy.maxConcurrentRuns,
    });
  }

  async inspect(caller: DelegationCaller) {
    const parent = (await this.repository.loadRequired(caller.workflowInstanceId)).view;
    await this.authority.assertCaller(caller, parent);
    return {
      policy: (await this.workflows.definitionFor(parent)).delegation ?? null,
      tree: await this.delegated.inspect(parent.workItemId),
    };
  }

  private async rootFor(parent: WorkflowInstanceView) {
    const item = await this.work.get(parent.workItemId);
    if (item?.delegation === undefined) return parent;
    const root = (await this.repository.list()).find(
      ({ view }) =>
        view !== null &&
        view.workItemId === item.delegation?.rootWorkItemId &&
        view.parentWorkflowInstanceId === undefined,
    )?.view;
    if (root == null) throw new Error('Delegation root workflow is unavailable');
    return root;
  }
}
