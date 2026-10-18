import {
  cachedJournalView,
  WrongExpectedSequenceError,
  type CachedJournalView,
  type CommandContext,
  type EventJournal,
} from '@atolis-hq/eventing';
import type { TransitionTarget } from '../contracts/config.js';
import { DelegationPendingError } from '../contracts/delegation.js';
import { selectWorkflowOrchestrationEvent, signalSchema } from '../contracts/event-decoder.js';
import {
  OrchestrationEventType,
  ResourceTransitionSignal,
  type DeferredWorkflowSignal,
  type OrchestrationSignal,
} from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import { workflowInstanceStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { DelegationLedger } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/** Retains authority-bearing inputs while delegation owns advancement; ordinary wait validation replays them. */
export class DeferredSignals {
  private readonly present: CachedJournalView<boolean>;
  private readonly ledger: DelegationLedger;
  constructor(
    private readonly journal: EventJournal,
    private readonly repository: OrchestrationRepository,
    private readonly deliver: (
      id: WorkflowInstanceId,
      signal: OrchestrationSignal,
      context: CommandContext,
    ) => Promise<WorkflowInstanceView>,
    private readonly transition: (
      id: WorkflowInstanceId,
      target: TransitionTarget,
      evidenceId: string,
      context: CommandContext,
    ) => Promise<WorkflowInstanceView | null>,
    private readonly fenced: (id: WorkflowInstanceId) => Promise<boolean>,
  ) {
    this.ledger = new DelegationLedger(journal, repository);
    this.present = cachedJournalView(journal, (events) =>
      events.some((entry) => entry.event.eventType === OrchestrationEventType.SignalDeferred),
    );
  }

  async accept(id: WorkflowInstanceId, signal: OrchestrationSignal, context: CommandContext) {
    const scope = (await this.repository.loadRequired(id)).view;
    try {
      return await this.deliver(id, signal, context);
    } catch (error) {
      if (!(error instanceof DelegationPendingError)) throw error;
      return this.record(id, signal, context, scope);
    }
  }

  async applyTransition(
    id: WorkflowInstanceId,
    target: TransitionTarget,
    evidenceId: string,
    context: CommandContext,
  ) {
    const scope = (await this.repository.loadRequired(id)).view;
    try {
      return await this.transition(id, target, evidenceId, context);
    } catch (error) {
      if (!(error instanceof DelegationPendingError)) throw error;
      return this.record(
        id,
        {
          kind: scope.waitingFor?.signalKind ?? ResourceTransitionSignal,
          actorId: 'resource-transition',
          actorDecision: { authorized: true, evidenceId },
          providerEventId: evidenceId,
        },
        context,
        scope,
        target,
      );
    }
  }

  private async record(
    id: WorkflowInstanceId,
    signal: OrchestrationSignal,
    context: CommandContext,
    view: WorkflowInstanceView,
    target?: TransitionTarget,
  ) {
    const parsed = signalSchema.parse(signal);
    await this.ledger.appendOnce(id, context, `defer:${signal.providerEventId}`, {
      eventType: OrchestrationEventType.SignalDeferred,
      payload: {
        stage: view.currentStage,
        ...(view.waitingFor?.intentEventId === undefined
          ? {}
          : { intentEventId: view.waitingFor.intentEventId }),
        ...(view.waitingFor?.resourceId === undefined
          ? {}
          : { resourceId: view.waitingFor.resourceId }),
        ...(view.waitingFor?.revision === undefined ? {} : { revision: view.waitingFor.revision }),
        signal: parsed,
        ...(target === undefined ? {} : { target }),
      },
    });
    return view;
  }

  async reconcile(context: CommandContext): Promise<void> {
    if (!(await this.present.get())) return;
    for (const loaded of await this.repository.list()) {
      if (loaded.view !== null)
        await this.reconcileWorkflow(loaded.view.workflowInstanceId, context);
    }
  }

  async reconcileWorkflow(
    id: WorkflowInstanceId,
    context: CommandContext,
  ): Promise<WorkflowInstanceView> {
    if ((await this.present.get()) && !(await this.fenced(id))) {
      const events = await this.journal.readStream(workflowInstanceStream(id));
      for (const raw of events) {
        const event = selectWorkflowOrchestrationEvent(raw);
        if (event?.event.eventType !== OrchestrationEventType.SignalDeferred) continue;
        const deferred = event.event.payload;
        const loaded = await this.repository.loadRequired(id);
        const view = loaded.view;
        if (!matchesDeferredWait(view, deferred)) continue;
        const deliveryContext = {
          ...context,
          commandId: `replay:${event.event.eventId}`,
          expectedSequence: loaded.sequence,
          correlationId: event.event.correlationId,
          actor: event.event.actor,
        };
        try {
          if (deferred.target === undefined)
            await this.deliver(id, deferred.signal, deliveryContext);
          else
            await this.transition(
              id,
              deferred.target,
              deferred.signal.providerEventId,
              deliveryContext,
            );
        } catch (error) {
          if (
            !(error instanceof DelegationPendingError) &&
            !(error instanceof WrongExpectedSequenceError)
          )
            throw error;
          break;
        }
      }
    }
    return (await this.repository.loadRequired(id)).view;
  }
}

function matchesDeferredWait(
  view: WorkflowInstanceView,
  deferred: DeferredWorkflowSignal,
): boolean {
  return (
    !view.acceptedSignalIds.includes(deferred.signal.providerEventId) &&
    view.currentStage === deferred.stage &&
    view.waitingFor !== undefined &&
    view.waitingFor.intentEventId === deferred.intentEventId &&
    view.waitingFor.resourceId === deferred.resourceId &&
    view.waitingFor.revision === deferred.revision
  );
}
