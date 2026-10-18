import type { ActivationId } from '../../activities/index.js';
import { DelegationPendingError } from '../contracts/delegation.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/** One admission policy for ordinary advancement while a committed cohort owns the parent. */
export class DelegationGate {
  constructor(private readonly repository: OrchestrationRepository) {}

  allows(view: WorkflowInstanceView): boolean {
    return view.delegationFence === undefined;
  }

  async fenced(id: WorkflowInstanceId): Promise<boolean> {
    const view = (await this.repository.load(id)).view;
    return view !== null && !this.allows(view);
  }

  async run<T>(id: WorkflowInstanceId, operation: () => Promise<T>): Promise<T> {
    if (await this.fenced(id)) throw new DelegationPendingError(id);
    return operation();
  }

  async outcome<T>(
    id: WorkflowInstanceId,
    activationId: ActivationId,
    operation: () => Promise<T>,
    held: () => Promise<T>,
  ): Promise<T> {
    const view = (await this.repository.load(id)).view;
    if (view === null || this.allows(view)) return operation();
    if (view.delegationFence?.activationId !== activationId) throw new DelegationPendingError(id);
    return held();
  }

  async availableInstances() {
    return (await this.repository.list()).filter(({ view }) => view !== null && this.allows(view));
  }
}
