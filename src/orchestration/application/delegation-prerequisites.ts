import type { CommandContext } from '@atolis-hq/eventing';
import type { DeliverySnapshot, WorkService } from '../../work/index.js';
import type { DelegationArtifacts, DelegationRepositories } from '../contracts/delegation-ports.js';
import type { DelegationInputs, DelegationReservation } from '../contracts/delegation.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { PrerequisiteBlockCode } from '../contracts/vocabulary.js';
import type { DelegationLedger } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import { PrerequisiteReadiness, type PrerequisiteAdmission } from './prerequisite-readiness.js';

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

  async read(workSnapshot?: DeliverySnapshot): Promise<PrerequisiteReadiness> {
    const snapshot = await this.repository.snapshot();
    return new PrerequisiteReadiness(
      snapshot,
      workSnapshot ?? (await this.work.deliverySnapshot()),
      this.artifacts,
      this.repositories,
    );
  }

  async reasons(
    ids: readonly string[],
    workSnapshot?: DeliverySnapshot,
  ): Promise<ReadonlyMap<string, PrerequisiteAdmission>> {
    if (ids.length === 0) return new Map();
    const read = await this.read(workSnapshot);
    return new Map(
      await Promise.all(
        ids.map(
          async (id) =>
            [id, { reason: await read.reason(id), abandoned: read.abandoned(id) }] as const,
        ),
      ),
    );
  }

  async reason(id: string): Promise<string | undefined> {
    return (await this.read()).reason(id);
  }

  async prepare(
    reservation: DelegationReservation,
    child: Child,
    context: CommandContext,
    readiness?: PrerequisiteReadiness,
  ): Promise<boolean> {
    if ((child.prerequisites?.length ?? 0) === 0) return true;
    const read = readiness ?? (await this.read());
    const stored = read.inputs(child.workItemId);
    if (stored !== undefined) {
      await this.grant(reservation, child, stored, context);
      return this.check(reservation, child, context, read);
    }
    const consumed = await read.select(child, new Set([child.workItemId]));
    if (!Array.isArray(consumed)) {
      await this.diagnostic(reservation, child, consumed.reason, context);
      if (
        consumed.code === PrerequisiteBlockCode.Changed ||
        consumed.code === PrerequisiteBlockCode.Failed
      )
        await this.block(reservation, child, consumed.reason, context);
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
    return true;
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
    readiness?: PrerequisiteReadiness,
  ): Promise<boolean> {
    const read = readiness ?? (await this.read());
    const blocked = await read.block(child.workItemId);
    if (blocked === undefined) return true;
    await this.diagnostic(reservation, child, blocked.reason, context);
    if (
      blocked.code === PrerequisiteBlockCode.Changed ||
      blocked.code === PrerequisiteBlockCode.Failed
    )
      await this.block(reservation, child, blocked.reason, context);
    return false;
  }

  private async block(
    reservation: DelegationReservation,
    child: Child,
    reason: string,
    context: CommandContext,
  ) {
    await this.ledger.appendOnce(
      reservation.parentWorkflowInstanceId,
      context,
      'child-blocked:' + child.grantId,
      {
        eventType: OrchestrationEventType.DelegationChildBlocked,
        payload: { childWorkItemId: child.workItemId, reason },
      },
    );
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
      `prerequisite:${child.grantId}:${PrerequisiteBlockCode.Blocked}`,
      {
        eventType: OrchestrationEventType.DelegationPrerequisiteBlocked,
        payload: { childWorkItemId: child.workItemId, reason },
      },
    );
  }
}
