import type { EventEnvelope, EventJournal } from '@atolis-hq/eventing';
import { ActivityOutcomeKind, type ObservedStream } from '../../activities/index.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { signalName } from '../contracts/identifiers.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import { activation, nextOrdinal, stateDraft } from '../domain/decision-events.js';
import type { DelegationGate } from './delegation-gate.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import { reactorCommandContext } from './reactor-command-context.js';

/** Catch up from the read snapshot, including facts arriving before the wait was recorded. */
export async function retryObservedState(
  repository: OrchestrationRepository,
  journal: EventJournal,
  gate: DelegationGate,
  trigger: EventEnvelope,
): Promise<boolean> {
  for (const { view } of await repository.list()) {
    if (view?.waitingFor?.observed === undefined) continue;
    await gate.run(view.workflowInstanceId, async () => {
      const loaded = await repository.loadRequired(view.workflowInstanceId);
      const state = loaded.view;
      if (!eligible(state)) return state;
      const advanced = await advancingEvent(journal, state);
      if (advanced === undefined) return state;
      await repository.append(
        state.workflowInstanceId,
        loaded.sequence,
        retryEvents(state, advanced, trigger),
      );
      return (await repository.loadRequired(state.workflowInstanceId)).view;
    });
  }
  return (await repository.list()).some(({ view }) => view !== null && eligible(view));
}

function eligible(state: WorkflowInstanceView): boolean {
  return (
    state.status === WorkflowStatus.Waiting &&
    state.pendingActivation !== undefined &&
    state.lastOutcome?.kind === ActivityOutcomeKind.Blocked &&
    state.waitingFor?.signalKind === signalName(ActivityOutcomeKind.Blocked) &&
    state.waitingFor.observed !== undefined &&
    !(
      state.observedRetry?.activationId === state.pendingActivation.activationId &&
      state.observedRetry.exhausted
    )
  );
}

async function advancingEvent(journal: EventJournal, state: WorkflowInstanceView) {
  const snapshots = await Promise.all(
    state.waitingFor!.observed!.map(async (observation) => ({
      observation,
      events: await journal.readStream(observation.stream),
    })),
  );
  const consumed = retryChain(state)?.observed;
  for (const { observation, events } of snapshots) {
    const cursor = consumed?.find(
      ({ stream }) =>
        stream.kind === observation.stream.kind && stream.id === observation.stream.id,
    );
    const version = Math.max(observation.version, cursor?.version ?? 0);
    // An activity's own decision/audit writes do not invalidate its read set.
    const advanced = events.find((event) => {
      const cause: string = event.event.causationId;
      return event.sequence > version && cause !== state.pendingActivation!.activationId;
    });
    if (advanced !== undefined)
      return {
        event: advanced,
        observed: snapshots.map(({ observation: read, events: facts }) => ({
          stream: read.stream,
          version: facts.length,
        })),
      };
  }
  return undefined;
}

function retryEvents(
  state: WorkflowInstanceView,
  advanced: { event: EventEnvelope; observed: readonly ObservedStream[] },
  trigger: EventEnvelope,
) {
  const pending = state.pendingActivation!;
  const chain = retryChain(state);
  const context = reactorCommandContext(
    advanced.event,
    `observed-state-retry:${pending.activationId}`,
    'observed-state-reactor',
  );
  const input = { occurredAt: trigger.event.occurredAt, causationId: context.commandId };
  const count = chain?.count ?? 0;
  const exhausted = count >= 5;
  const next = nextActivation(state, pending);
  const events = [
    stateDraft(
      state,
      input,
      {
        eventType: OrchestrationEventType.ObservedStateRetryRecorded,
        payload: {
          rootActivationId: chain?.rootActivationId ?? pending.activationId,
          activationId: exhausted ? pending.activationId : next.activationId,
          triggerEventId: advanced.event.event.eventId,
          observed: advanced.observed,
          count: exhausted ? count : count + 1,
          exhausted,
        },
      },
      1,
    ),
  ];
  if (!exhausted)
    events.push(
      stateDraft(
        state,
        input,
        {
          eventType: OrchestrationEventType.ActivityRequested,
          payload: next,
        },
        2,
      ),
    );
  return events;
}

function retryChain(state: WorkflowInstanceView) {
  return state.observedRetry?.activationId === state.pendingActivation?.activationId
    ? state.observedRetry
    : undefined;
}

function nextActivation(state: WorkflowInstanceView, pending: ActivityActivationView) {
  return activation(state.workflowInstanceId, nextOrdinal(state), pending.activity, pending.input, {
    execution: pending.execution,
    ...(pending.stage === undefined ? {} : { stage: pending.stage }),
    ...(pending.followOnIndex === undefined ? {} : { followOnIndex: pending.followOnIndex }),
    ...(pending.supplemental === undefined ? {} : { supplemental: pending.supplemental }),
    ...(pending.sessionPolicy === undefined ? {} : { sessionPolicy: pending.sessionPolicy }),
    ...(pending.watchDriven === undefined ? {} : { watchDriven: pending.watchDriven }),
  });
}
