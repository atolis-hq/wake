import type { ActivationId } from '../../activities/index.js';
import type { DeliverySnapshot, WorkService } from '../../work/index.js';
import { DelegationPendingError } from '../contracts/delegation.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { PrerequisiteAdmission } from './prerequisite-readiness.js';

/** One admission policy for ordinary advancement while a committed cohort owns the parent. */
export class DelegationGate {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly work: WorkService,
    private readonly prerequisiteReasons?: (
      ids: readonly string[],
      snapshot?: DeliverySnapshot,
    ) => Promise<ReadonlyMap<string, PrerequisiteAdmission>>,
  ) {}

  /** Standalone work keeps existing freeze semantics; only delegated trees and fenced parents are held. */
  private heldBy(snapshot: DeliverySnapshot, view: WorkflowInstanceView): boolean {
    if (snapshot.invalid(view.workItemId)) return true;
    if (
      snapshot.get(view.workItemId)?.delegation === undefined &&
      view.delegationFence === undefined
    )
      return false;
    return snapshot.availability(view.workItemId).reason !== undefined;
  }

  /** Commit-boundary check for one instance; batches use `filterAvailable`. */
  async unavailable(view: WorkflowInstanceView): Promise<boolean> {
    const snapshot = await this.work.deliverySnapshot();
    return (
      this.heldBy(snapshot, view) ||
      (await this.prerequisiteReasons?.([view.workItemId], snapshot))?.get(view.workItemId)
        ?.reason !== undefined
    );
  }

  allows(view: WorkflowInstanceView): boolean {
    return view.delegationFence === undefined;
  }

  async fenced(id: WorkflowInstanceId): Promise<boolean> {
    const view = (await this.repository.load(id)).view;
    return view !== null && (!this.allows(view) || (await this.unavailable(view)));
  }

  /** The subset of `ids` whose workflow is fenced or held, against one Work synchronisation. */
  async fencedAmong(ids: readonly WorkflowInstanceId[]): Promise<ReadonlySet<WorkflowInstanceId>> {
    if (ids.length === 0) return new Set<WorkflowInstanceId>();
    const requested = new Set(ids);
    const views = (await this.repository.list()).flatMap(({ view }) =>
      view !== null && requested.has(view.workflowInstanceId)
        ? [[view.workflowInstanceId, view] as const]
        : [],
    );
    const snapshot = views.some(([, view]) => this.allows(view))
      ? await this.work.deliverySnapshot()
      : undefined;
    const reasons = await this.prerequisiteReasons?.(
      views.filter(([, view]) => this.allows(view)).map(([, view]) => view.workItemId),
      snapshot,
    );
    return new Set(
      views
        .filter(
          ([, view]) =>
            !this.allows(view) ||
            this.heldBy(snapshot!, view) ||
            reasons?.get(view.workItemId)?.reason !== undefined,
        )
        .map(([id]) => id),
    );
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
    historical: (view: WorkflowInstanceView) => Promise<T>,
  ): Promise<T> {
    const view = (await this.repository.load(id)).view;
    if (view === null) return operation();
    const snapshot = await this.work.deliverySnapshot();
    if (this.heldBy(snapshot, view)) throw new DelegationPendingError(id);
    const admission = (await this.prerequisiteReasons?.([view.workItemId]))?.get(view.workItemId);
    if (admission?.abandoned === true) return historical(view);
    if (admission?.reason !== undefined) throw new DelegationPendingError(id);
    if (this.allows(view)) return operation();
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
    const reasons = await this.prerequisiteReasons?.(
      unfenced.map((item) => viewOf(item)!.workItemId),
      snapshot,
    );
    return unfenced.filter(
      (item) =>
        !this.heldBy(snapshot, viewOf(item)!) &&
        reasons?.get(viewOf(item)!.workItemId)?.reason === undefined,
    );
  }
}
