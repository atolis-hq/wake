import type { CommandContext } from '@atolis-hq/eventing';
import { isDeepStrictEqual } from 'node:util';
import { WorkStatus, type WorkService } from '../../work/index.js';
import type { DelegationArtifacts, DelegationRepositories } from '../contracts/delegation-ports.js';
import type {
  DelegationInputs,
  DelegationPrerequisite,
  DelegationReservation,
} from '../contracts/delegation.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  DelegationPrerequisiteCondition as Condition,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import { isSuccessfulWorkflowCompletion } from '../domain/workflow-completion.js';
import { isJoined, reservationsOf, type DelegationLedger } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

type Child = DelegationReservation['children'][number];

/** Immutable consumption receipts and live eligibility; never chooses a repair. */
export class DelegationPrerequisites {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly ledger: DelegationLedger,
    private readonly artifacts: DelegationArtifacts,
    private readonly repositories: DelegationRepositories | undefined,
    private readonly work: WorkService,
  ) {}

  async inputs(id: string): Promise<DelegationInputs | undefined> {
    return (await this.ledger.events()).flatMap(({ event }) =>
      event.eventType === OrchestrationEventType.DelegationInputsResolved &&
      event.payload.childWorkItemId === id
        ? [event.payload]
        : [],
    )[0];
  }

  async reason(id: string, seen = new Set<string>()): Promise<string | undefined> {
    try {
      return await this.evaluate(id, seen);
    } catch (error) {
      return `Prerequisite verification unavailable: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  }

  private async evaluate(id: string, seen: Set<string>): Promise<string | undefined> {
    const events = await this.ledger.events();
    const all = reservationsOf(events);
    const reservation = all.find((entry) =>
      entry.children.some((child) => child.workItemId === id),
    );
    const child = reservation?.children.find((entry) => entry.workItemId === id);
    if (seen.has(id)) return 'Prerequisite wait cycle';
    seen.add(id);
    for (const joined of all.filter(
      (entry) => entry.parentWorkItemId === id && isJoined(events, entry),
    )) {
      for (const result of joined.children) {
        const reason = await this.reason(result.workItemId, new Set(seen));
        if (reason !== undefined) return reason;
      }
    }
    return child === undefined ? undefined : this.consumedReason(child, all, seen);
  }

  private async consumedReason(
    child: Child,
    all: readonly DelegationReservation[],
    seen: Set<string>,
  ) {
    if ((child.prerequisites?.length ?? 0) === 0) return undefined;
    const stored = await this.inputs(child.workItemId);
    const current = await this.select(child, all, seen);
    if (typeof current === 'string') return current;
    if (stored === undefined) return 'Prerequisite inputs have not been pinned';
    if (!isDeepStrictEqual(freshness(stored.consumed), freshness(current)))
      return 'Consumed upstream output or base changed; agent assessment required';
    return undefined;
  }

  async prepare(
    reservation: DelegationReservation,
    child: Child,
    context: CommandContext,
  ): Promise<boolean> {
    if ((child.prerequisites?.length ?? 0) === 0) return true;
    const stored = await this.inputs(child.workItemId);
    if (stored !== undefined) {
      await this.grant(reservation, child, stored, context);
      return this.check(reservation, child, context);
    }
    const consumed = await this.select(
      child,
      await this.ledger.reservations(),
      new Set([child.workItemId]),
    );
    if (typeof consumed === 'string') {
      await this.diagnostic(reservation, child, consumed, context);
      return false;
    }
    const repository = await this.resolveBase(reservation, child, consumed);
    await this.ledger.appendOnce(
      reservation.parentWorkflowInstanceId,
      context,
      `inputs:${child.grantId}`,
      {
        eventType: OrchestrationEventType.DelegationInputsResolved,
        payload: {
          childWorkItemId: child.workItemId,
          consumed,
          ...(repository === undefined ? {} : { repository }),
        },
      },
    );
    const pinned = await this.inputs(child.workItemId);
    if (pinned === undefined) throw new Error('Missing committed prerequisite inputs');
    await this.grant(reservation, child, pinned, context);
    return this.check(reservation, child, context);
  }

  private async resolveBase(
    reservation: DelegationReservation,
    child: Child,
    consumed: DelegationInputs['consumed'],
  ) {
    const index = child.prerequisites?.findIndex((edge) => edge.useAsBase) ?? -1;
    if (index < 0) return child.repository;
    const reference = consumed[index]!.reference;
    if (
      !('revision' in reference) ||
      child.repository === undefined ||
      this.repositories === undefined
    )
      throw new Error('Upstream Git base resolver unavailable');
    const parent = (await this.repository.loadRequired(reservation.parentWorkflowInstanceId)).view;
    return this.repositories.resolve(parent, {
      resourceId: child.repository.resourceId,
      sourceRef: reference.branch,
      sourceRevision: reference.revision,
      pullRequestBase: reference.branch,
    });
  }

  private async grant(
    reservation: DelegationReservation,
    child: Child,
    inputs: DelegationInputs,
    context: CommandContext,
  ) {
    const references = inputs.consumed.flatMap(({ reference }) =>
      'revisionId' in reference ? [reference] : [],
    );
    await this.artifacts.registerChild(
      {
        delegationId: `${child.grantId}:prerequisites`,
        parentWorkItemId: reservation.parentWorkItemId,
        childWorkItemId: child.workItemId,
        childReferences: references,
      },
      context,
    );
  }

  async check(
    reservation: DelegationReservation,
    child: Child,
    context: CommandContext,
  ): Promise<boolean> {
    const reason = await this.reason(child.workItemId);
    if (reason === undefined) return true;
    await this.diagnostic(reservation, child, reason, context);
    return false;
  }

  private async diagnostic(
    reservation: DelegationReservation,
    child: Child,
    reason: string,
    context: CommandContext,
  ) {
    await this.ledger.appendOnce(
      reservation.parentWorkflowInstanceId,
      context,
      `prerequisite:${child.grantId}:${reason}`,
      {
        eventType: OrchestrationEventType.DelegationPrerequisiteBlocked,
        payload: { childWorkItemId: child.workItemId, reason },
      },
    );
  }

  private async select(
    child: Child,
    all: readonly DelegationReservation[],
    seen: Set<string>,
  ): Promise<DelegationInputs['consumed'] | string> {
    const outputs: DelegationInputs['consumed'] = [];
    for (const [index, edge] of (child.prerequisites ?? []).entries()) {
      const upstream = all
        .flatMap((entry) => entry.children)
        .find((entry) => entry.workItemId === child.prerequisiteWorkItemIds?.[index]);
      if (upstream === undefined) return 'Prerequisite target unavailable';
      const selected = await this.selectOne(upstream, edge, seen);
      if (typeof selected === 'string') return selected;
      if (edge.useAsBase) {
        const reason = await this.verifyBase(child, selected.reference, all);
        if (reason !== undefined) return reason;
      }
      outputs.push(selected);
    }
    return outputs;
  }

  private async selectOne(
    upstream: Child,
    edge: DelegationPrerequisite,
    seen: Set<string>,
  ): Promise<DelegationInputs['consumed'][number] | string> {
    const reason = await this.reason(upstream.workItemId, new Set(seen));
    if (reason !== undefined) return `Upstream ${upstream.assignmentId}: ${reason}`;
    const workflow = (await this.repository.load(upstream.workflowInstanceId)).view;
    if (workflow === null) return `Waiting for upstream ${upstream.assignmentId}`;
    const availability = await this.upstreamAvailability(workflow);
    if (availability !== undefined) return `Upstream ${upstream.assignmentId}: ${availability}`;
    const statusReason = workflowReason(workflow, edge);
    if (statusReason !== undefined) return statusReason;
    const output = upstream.outputs.find((entry) => entry.name === edge.output)!;
    const selected = await this.artifacts.prerequisiteOutput?.(workflow, output, edge.condition);
    if (
      selected == null ||
      selected.name !== edge.output ||
      selected.reference.workItemId !== upstream.workItemId
    )
      return `Waiting for ${edge.condition} output ${upstream.assignmentId}/${edge.output}`;
    return selected;
  }

  private async upstreamAvailability(workflow: WorkflowInstanceView) {
    const snapshot = await this.work.deliverySnapshot();
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
    all: readonly DelegationReservation[],
  ) {
    const owner = all.find((entry) =>
      entry.children.some((entry) => entry.workItemId === child.workItemId),
    );
    if (!('revision' in reference) || owner === undefined || this.repositories === undefined)
      return 'Upstream Git base resolver unavailable';
    const parent = (await this.repository.loadRequired(owner.parentWorkflowInstanceId)).view;
    const resolved = await this.repositories.resolve(parent, {
      resourceId: reference.repositoryResourceId,
      sourceRef: reference.branch,
      pullRequestBase: reference.branch,
    });
    if (resolved.sourceRevision !== reference.revision)
      return 'Upstream branch moved; agent assessment required';
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
    const { runId: _run, ...revision } = reference;
    return { name, reference: revision };
  });
}
