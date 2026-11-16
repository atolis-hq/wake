import { WrongExpectedSequenceError, type CommandContext } from '@atolis-hq/eventing';
import { activationId, type ActivityName } from '../../activities/index.js';
import type { DelegationAttentionBlocker, DelegationReservation } from '../contracts/delegation.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { nextOrdinal } from '../domain/decision-events.js';
import { digest } from './delegation-attention-state.js';
import { delegationDraft, type DelegationLedger } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/** Returns false when a concurrent append won and the caller must re-read. */
export async function requestAssessment(
  dependencies: {
    readonly repository: OrchestrationRepository;
    readonly ledger: DelegationLedger;
    readonly supportsAttention: (activity: ActivityName) => boolean;
  },
  reservation: DelegationReservation,
  loaded: { readonly sequence: number; readonly view: WorkflowInstanceView },
  input: {
    readonly attentionKey: string;
    readonly blockers: DelegationAttentionBlocker[];
    readonly operator?: boolean;
  },
  context: CommandContext,
): Promise<boolean> {
  const { repository, ledger } = dependencies;
  const id = reservation.parentWorkflowInstanceId;
  const { events } = await repository.history(id);
  const original = events.find(
    (entry) =>
      entry.event.eventType === OrchestrationEventType.ActivityRequested &&
      entry.event.payload.activationId === reservation.activationId,
  );
  if (original?.event.eventType !== OrchestrationEventType.ActivityRequested)
    throw new Error('Missing delegating activation');
  const requested = original.event.payload;
  const keyId = digest(input.attentionKey);
  if (!dependencies.supportsAttention(requested.activity)) {
    await ledger.appendOnce(id, context, `attention-unsupported:${keyId}`, {
      eventType: OrchestrationEventType.DelegationReconciliationFailed,
      payload: {
        cohortId: reservation.cohortId,
        reason:
          'Child work needs attention but the delegating activity cannot assess it; ' +
          'an operator must inspect the blockers',
      },
    });
    return true;
  }
  const ordinal = nextOrdinal(loaded.view);
  const attentionActivation = activationId(`${id}:activity:${ordinal}`);
  try {
    await repository.append(id, loaded.sequence, [
      ...operatorRequest(input.operator === true, reservation, context, keyId),
      delegationDraft(
        context,
        `attention:${keyId}:${ordinal}`,
        {
          eventType: OrchestrationEventType.DelegationAttentionRequested,
          payload: {
            cohortId: reservation.cohortId,
            attentionKey: input.attentionKey,
            activationId: attentionActivation,
            revision: reservation.planRevision ?? 1,
            blockers: input.blockers,
          },
        },
        id,
      ),
      delegationDraft(
        context,
        `attention-activity:${keyId}:${ordinal}`,
        {
          eventType: OrchestrationEventType.ActivityRequested,
          payload: {
            ...requested,
            activationId: attentionActivation,
            ordinal,
            sessionPolicy: 'fresh',
          },
        },
        id,
      ),
    ]);
    return true;
  } catch (error) {
    if (error instanceof WrongExpectedSequenceError) return false;
    throw error;
  }
}

function operatorRequest(
  requested: boolean,
  reservation: DelegationReservation,
  context: CommandContext,
  keyId: string,
) {
  return requested
    ? [
        delegationDraft(
          context,
          'attention-command:' + keyId,
          {
            eventType: OrchestrationEventType.OperatorRetryRequested,
            payload: { activationId: reservation.activationId, commandId: context.commandId },
          },
          reservation.parentWorkflowInstanceId,
        ),
      ]
    : [];
}
