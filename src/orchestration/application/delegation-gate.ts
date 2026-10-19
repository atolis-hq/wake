import type { ActivationId } from '../../activities/index.js';
import type { DeliverySnapshot, WorkService } from '../../work/index.js';
import { DelegationPendingError } from '../contracts/delegation.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/** One admission policy for ordinary advancement while a committed cohort owns the parent. */
export class DelegationGate {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly work: WorkService,
  ) {}

  /** Standalone work keeps existing freeze semantics; only delegated trees and fenced parents are held. */
  private heldBy(snapshot: DeliverySnapshot, view: WorkflowInstanceView): boolean {
    if (
      snapshot.get(view.workItemId)?.delegation === undefined &&
      view.delegationFence === undefined
    )
      return false;
    return snapshot.availability(view.workItemId).reason !== undefined;
  }

  /** Commit-boundary check for one instance; batches use `filterAvailable`. */
  async unavailable(view: WorkflowInstanceView): Promise<boolean> {
    return this.heldBy(await this.work.deliverySnapshot(), view);
  }

  allows(view: WorkflowInstanceView): boolean {
    return view.delegationFence === undefined;
  }

  async fenced(id: WorkflowInstanceId): Promise<boolean> {
    const view = (await this.repository.load(id)).view;
    return view !== null && (!this.allows(view) || (await this.unavailable(view)));
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
    if (view !== null && (await this.unavailable(view))) throw new DelegationPendingError(id);
    if (view === null || this.allows(view)) return operation();
    if (view.delegationFence?.activationId !== activationId) throw new DelegationPendingError(id);
    return held();
  }

  /**
   * Admits the items whose workflow may advance, against one synchronisation
   * with Work however many items there are. Nothing is read when none are
   * unfenced, so a quiet tick costs no storage round trip.
   */
  async filterAvailable<T>(
    items: readonly T[],
    viewOf: (item: T) => WorkflowInstanceView | null,
  ): Promise<T[]> {
    const unfenced = items.filter((item) => {
      const view = viewOf(item);
      return view !== null && this.allows(view);
    });
    if (unfenced.length === 0) return [];
    const snapshot = await this.work.deliverySnapshot();
    return unfenced.filter((item) => !this.heldBy(snapshot, viewOf(item)!));
  }
}
