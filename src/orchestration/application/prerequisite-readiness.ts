import { isDeepStrictEqual } from 'node:util';
import type { DeliverySnapshot } from '../../work/index.js';
import { WorkStatus } from '../../work/index.js';
import type { DelegationArtifacts, DelegationRepositories } from '../contracts/delegation-ports.js';
import type {
  DelegationInputs,
  DelegationPrerequisite,
  DelegationReservation,
} from '../contracts/delegation.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  PrerequisiteBlockCode as Code,
  DelegationPrerequisiteCondition as Condition,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import { isSuccessfulWorkflowCompletion } from '../domain/workflow-completion.js';
import { reservationsOf } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

type Child = DelegationReservation['children'][number];

export interface PrerequisiteAdmission {
  readonly reason: string | undefined;
  readonly abandoned: boolean;
}

export interface PrerequisiteBlock {
  readonly code: Code;
  readonly reason: string;
}

/** A bounded read pass: one journal/Work snapshot and one lookup per declared input. */
export class PrerequisiteReadiness {
  private readonly failedChildren = new Set<string>();
  private readonly children = new Map<string, Child>();
  private readonly owners = new Map<string, DelegationReservation>();
  private readonly receipts = new Map<string, DelegationInputs>();
  private readonly workflows = new Map<string, WorkflowInstanceView>();
  private readonly blockers = new Map<string, PrerequisiteBlock>();
  private readonly evaluated = new Map<string, Promise<PrerequisiteBlock | undefined>>();
  private readonly selected = new Map<
    string,
    Promise<DelegationInputs['consumed'][number] | PrerequisiteBlock>
  >();

  private readonly bases = new Map<string, Promise<PrerequisiteBlock | undefined>>();

  constructor(
    snapshot: Awaited<ReturnType<OrchestrationRepository['snapshot']>>,
    private readonly work: DeliverySnapshot,
    private readonly artifacts: DelegationArtifacts,
    private readonly repositories: DelegationRepositories | undefined,
  ) {
    const failures = new Set(
      snapshot.events.flatMap(({ event, stream }) =>
        event.eventType === OrchestrationEventType.DelegationFailed
          ? [JSON.stringify([stream.id, event.payload.cohortId])]
          : [],
      ),
    );
    for (const reservation of reservationsOf(snapshot.events))
      for (const child of reservation.children) {
        if (
          reservation.children.some((entry) => (entry.prerequisites?.length ?? 0) > 0) &&
          failures.has(JSON.stringify([reservation.parentWorkflowInstanceId, reservation.cohortId]))
        )
          this.failedChildren.add(child.workItemId);
        this.children.set(child.workItemId, child);
        this.owners.set(child.workItemId, reservation);
      }
    for (const { view } of snapshot.instances)
      if (view !== null) this.workflows.set(view.workflowInstanceId, view);
    for (const { event } of snapshot.events) {
      if (event.eventType === OrchestrationEventType.DelegationInputsResolved)
        this.receipts.set(event.payload.childWorkItemId, event.payload);
      if (event.eventType === OrchestrationEventType.DelegationChildBlocked)
        this.blockers.set(event.payload.childWorkItemId, {
          code: Code.Failed,
          reason: event.payload.reason,
        });
    }
  }

  abandoned(id: string) {
    return this.failedChildren.has(id);
  }

  inputs(id: string) {
    return this.receipts.get(id);
  }

  workflow(id: string) {
    return this.workflows.get(id);
  }

  async reason(id: string): Promise<string | undefined> {
    return (await this.block(id))?.reason;
  }

  block(id: string, seen = new Set<string>()): Promise<PrerequisiteBlock | undefined> {
    if (seen.has(id))
      return Promise.resolve({ code: Code.Cycle, reason: 'Prerequisite wait cycle' });
    let evaluated = this.evaluated.get(id);
    if (evaluated === undefined) {
      evaluated = this.evaluate(id, new Set([...seen, id])).catch((error) => ({
        code: Code.Unavailable,
        reason:
          'Prerequisite verification unavailable: ' +
          (error instanceof Error ? error.message : 'unknown error'),
      }));
      this.evaluated.set(id, evaluated);
    }
    return evaluated;
  }

  private async evaluate(id: string, seen: Set<string>): Promise<PrerequisiteBlock | undefined> {
    const blocked = this.blockers.get(id);
    if (blocked !== undefined) return blocked;
    const child = this.children.get(id);
    if (child === undefined || (child.prerequisites?.length ?? 0) === 0) return undefined;
    for (const upstream of child.prerequisiteWorkItemIds ?? []) {
      const block = await this.block(upstream, seen);
      if (block !== undefined) return block;
    }
    const current = await this.select(child, seen);
    if (!Array.isArray(current)) return current;
    const stored = this.inputs(id);
    if (stored === undefined)
      return { code: Code.Waiting, reason: 'Prerequisite inputs have not been pinned' };
    if (!isDeepStrictEqual(freshness(stored.consumed), freshness(current)))
      return {
        code: Code.Changed,
        reason: 'Consumed upstream output or base changed; agent assessment required',
      };
    return undefined;
  }

  async select(
    child: Child,
    seen: Set<string>,
  ): Promise<DelegationInputs['consumed'] | PrerequisiteBlock> {
    const outputs: DelegationInputs['consumed'] = [];
    for (const [index, edge] of (child.prerequisites ?? []).entries()) {
      const upstream = this.children.get(child.prerequisiteWorkItemIds?.[index] ?? '');
      if (upstream === undefined)
        return { code: Code.Unavailable, reason: 'Prerequisite target unavailable' };
      const key = JSON.stringify([upstream.workItemId, edge.output, edge.condition]);
      let pending = this.selected.get(key);
      if (pending === undefined) {
        pending = this.selectOne(upstream, edge, seen);
        this.selected.set(key, pending);
      }
      const selected = await pending;
      if ('code' in selected) return selected;
      if (edge.useAsBase) {
        const reason = await this.baseReason(child, selected.reference);
        if (reason !== undefined) return reason;
      }
      outputs.push(selected);
    }
    return outputs;
  }

  private baseReason(child: Child, reference: DelegationInputs['consumed'][number]['reference']) {
    if ('revision' in reference && reference.merged === true && this.receipts.has(child.workItemId))
      return undefined;
    const key = JSON.stringify([
      this.owners.get(child.workItemId)?.parentWorkflowInstanceId,
      reference,
    ]);
    let pending = this.bases.get(key);
    if (pending === undefined) {
      pending = this.verifyBase(child, reference);
      this.bases.set(key, pending);
    }
    return pending;
  }

  private async selectOne(
    upstream: Child,
    edge: DelegationPrerequisite,
    seen: Set<string>,
  ): Promise<DelegationInputs['consumed'][number] | PrerequisiteBlock> {
    const blocked = await this.block(upstream.workItemId, new Set(seen));
    if (blocked !== undefined) return blocked;
    const workflow = this.workflows.get(upstream.workflowInstanceId);
    if (workflow === undefined)
      return { code: Code.Waiting, reason: `Waiting for upstream ${upstream.assignmentId}` };
    const availability = await this.upstreamAvailability(workflow);
    if (availability !== undefined)
      return { code: Code.Waiting, reason: `Upstream ${upstream.assignmentId}: ${availability}` };
    const statusReason = workflowReason(workflow, edge);
    if (statusReason !== undefined)
      return {
        code:
          workflow.status === WorkflowStatus.Completed ||
          workflow.status === WorkflowStatus.Superseded
            ? Code.Failed
            : Code.Waiting,
        reason: statusReason,
      };
    const output = upstream.outputs.find((entry) => entry.name === edge.output)!;
    const selected = await this.artifacts.prerequisiteOutput?.(workflow, output, edge.condition);
    if (
      selected == null ||
      selected.name !== edge.output ||
      selected.reference.workItemId !== upstream.workItemId
    )
      return {
        code: Code.Waiting,
        reason: `Waiting for ${edge.condition} output ${upstream.assignmentId}/${edge.output}`,
      };
    return selected;
  }

  private async upstreamAvailability(workflow: WorkflowInstanceView) {
    const snapshot = this.work;
    const item = snapshot.get(workflow.workItemId);
    if (
      isSuccessfulWorkflowCompletion(workflow) &&
      item?.state === WorkStatus.Closed &&
      !item.frozen &&
      !item.deleted
    ) {
      for (const ancestor of item.delegation?.ancestors ?? []) {
        const reason = snapshot.availability(ancestor).reason;
        if (reason !== undefined) return reason;
      }
      return undefined;
    }
    return snapshot.availability(workflow.workItemId).reason;
  }

  private async verifyBase(
    child: Child,
    reference: DelegationInputs['consumed'][number]['reference'],
  ): Promise<PrerequisiteBlock | undefined> {
    const owner = this.owners.get(child.workItemId);
    if (!('revision' in reference) || owner === undefined || this.repositories === undefined)
      return { code: Code.Unavailable, reason: 'Upstream Git base resolver unavailable' };
    const parent = this.workflows.get(owner.parentWorkflowInstanceId);
    if (parent === undefined)
      return { code: Code.Unavailable, reason: 'Upstream parent unavailable' };
    const resolved = await this.repositories.resolve(parent, {
      resourceId: reference.repositoryResourceId,
      sourceRef: reference.branch,
      pullRequestBase: reference.branch,
    });
    if (resolved.sourceRevision !== reference.revision)
      return { code: Code.Changed, reason: 'Upstream branch moved; agent assessment required' };
    return undefined;
  }
}

function workflowReason(workflow: WorkflowInstanceView, edge: DelegationPrerequisite) {
  if (workflow.status === WorkflowStatus.Completed && !isSuccessfulWorkflowCompletion(workflow))
    return 'Upstream workflow failed';
  if (edge.condition === Condition.DeliveryReady && !isSuccessfulWorkflowCompletion(workflow))
    return 'Waiting for delivery-ready upstream';
  if (workflow.status === WorkflowStatus.Superseded) return 'Upstream workflow was superseded';
  return undefined;
}

function freshness(outputs: DelegationInputs['consumed']) {
  return outputs.map(({ name, reference }) => {
    if (!('runId' in reference)) return { name, reference };
    const {
      runId: _run,
      baseRevision: _base,
      merged: _merged,
      pullRequestBase: _baseBranch,
      ...revision
    } = reference;
    return { name, reference: revision };
  });
}
