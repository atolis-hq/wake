import type { CommandContext } from '@atolis-hq/eventing';
import type { TriggerConfig } from '../contracts/config.js';
import {
  ControlEventType,
  ManualTriggerDisposition,
  selectControlEvent,
  TriggerRequestDisposition,
  TriggerSourceKind,
  type ControlEventPayloads,
  type ManualTriggerOutcome,
  type TriggerSource,
} from '../contracts/events.js';
import { TriggerSkipReason } from '../contracts/trigger-diagnostics.js';
import type { TriggerDiagnostics } from './trigger-diagnostics.js';
import { consumedTriggerRequest, sourceIdentity, type TriggerFactInput } from './trigger-facts.js';
import { maximumTriggerSources, type TriggerView } from './trigger-projection.js';
import { hasActiveInvocation } from './trigger-rules.js';
import type { TriggerServiceDependencies } from './trigger-service-ports.js';

interface ManualRequestPorts {
  readonly dependencies: TriggerServiceDependencies;
  readonly diagnostics: TriggerDiagnostics;
  readonly config: TriggerConfig | undefined;
  readonly coordinationKey: () => string;
  readonly view: () => Promise<TriggerView>;
  readonly recover: (context: CommandContext) => Promise<void>;
  readonly advance: (context: CommandContext) => Promise<void>;
  readonly emit: (
    input: TriggerFactInput,
    context: CommandContext,
    eventId: string,
  ) => Promise<void>;
}

export async function requestManualTrigger(
  ports: ManualRequestPorts,
  triggerId: string,
  context: CommandContext,
): Promise<ManualTriggerOutcome> {
  await ports.view();
  const coordinationKey = ports.coordinationKey();
  const eventId = `trigger:request:${triggerId}:manual:${context.commandId}`;
  const previous = await recoverManualOutcome(ports, triggerId, context);
  if (previous !== undefined) {
    await ports.recover(context);
    await ports.advance(context);
    return (await recoverManualOutcome(ports, triggerId, context)) ?? previous;
  }
  await ports.recover(context);
  const view = await ports.view();
  const config = ports.config;
  const active = hasActiveInvocation(view, coordinationKey);
  const reason =
    (await ports.diagnostics.ineligibleReason(
      view,
      triggerId,
      config,
      config !== undefined,
      active,
    )) ??
    ((view.coalesced[coordinationKey]?.sources.length ?? 0) >= maximumTriggerSources
      ? TriggerSkipReason.PendingLimit
      : undefined);
  const outcome: ManualTriggerOutcome =
    reason === undefined
      ? {
          disposition: active
            ? ManualTriggerDisposition.Coalesced
            : ManualTriggerDisposition.Started,
          ...activeWorkItem(view, coordinationKey),
        }
      : { disposition: ManualTriggerDisposition.Skipped, reason };
  const source: TriggerSource = {
    kind: TriggerSourceKind.Manual,
    commandId: context.commandId,
    operator: context.actor.id,
  };
  await ports.emit(
    {
      eventType: ControlEventType.TriggerRequestRecorded,
      payload: {
        triggerId,
        coordinationKey,
        source,
        manualOutcome: outcome,
        disposition:
          reason === undefined
            ? TriggerRequestDisposition.Coalesced
            : TriggerRequestDisposition.Skipped,
      },
    },
    context,
    eventId,
  );
  if (reason !== undefined) await ports.diagnostics.record(triggerId, source, reason);
  await ports.advance(context);
  return (await recoverManualOutcome(ports, triggerId, context)) ?? outcome;
}

async function recoverManualOutcome(
  ports: ManualRequestPorts,
  triggerId: string,
  context: CommandContext,
): Promise<ManualTriggerOutcome | undefined> {
  // Command identity survives changes to the configured coordination scope.
  let position = 0;
  let request: ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded] | undefined;
  let pauseCleared = false;
  const latest = await ports.dependencies.journal.latestGlobalPosition();
  while (position < latest) {
    const batch = await ports.dependencies.journal.readAll(position, 256);
    if (batch.length === 0) throw new Error('Manual command journal cursor did not advance');
    for (const envelope of batch) {
      const event = selectControlEvent(envelope);
      request = matchingManualRequest(event, triggerId, context.commandId) ?? request;
      if (
        event?.event.eventType === ControlEventType.TriggerPaused &&
        event.event.payload.coordinationKey === request?.coordinationKey
      )
        pauseCleared = true;
      position = envelope.globalPosition;
    }
  }
  return resolvePausedRequest(ports, request, pauseCleared, context);
}

async function resolvePausedRequest(
  ports: ManualRequestPorts,
  request: ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded] | undefined,
  pauseCleared: boolean,
  context: CommandContext,
): Promise<ManualTriggerOutcome | undefined> {
  if (request?.manualOutcome === undefined) return undefined;
  if (settledManualOutcome(request.manualOutcome)) return request.manualOutcome;
  const history = await ports.dependencies.history();
  const invocation = history.find(
    (invocation) =>
      invocation.claim.triggerId === request.triggerId &&
      invocation.claim.sources.some(
        (source) => sourceIdentity(source) === sourceIdentity(request.source),
      ),
  );
  if (
    request.manualOutcome.disposition === ManualTriggerDisposition.Coalesced &&
    (!pauseCleared || invocation !== undefined)
  )
    return request.manualOutcome;
  if (invocation?.startedAt !== undefined) {
    const outcome: ManualTriggerOutcome = {
      disposition: ManualTriggerDisposition.Started,
      workItemId: invocation.claim.workItemId,
    };
    await ports.emit(
      {
        eventType: ControlEventType.TriggerRequestRecorded,
        payload: {
          ...request,
          disposition: TriggerRequestDisposition.Started,
          manualOutcome: outcome,
        },
      },
      context,
      'trigger:result:' + request.triggerId + ':' + sourceIdentity(request.source),
    );
    return outcome;
  }
  if (!pauseCleared || invocation !== undefined) return request.manualOutcome;
  // Pause clears unclaimed requests, but a committed claim still recovers normally.
  const fact = consumedTriggerRequest(request, TriggerSkipReason.Paused);
  await ports.emit(
    fact,
    context,
    'trigger:consume:' + request.triggerId + ':' + sourceIdentity(request.source),
  );
  await ports.diagnostics.record(request.triggerId, request.source, TriggerSkipReason.Paused);
  return { disposition: ManualTriggerDisposition.Skipped, reason: TriggerSkipReason.Paused };
}

function matchingManualRequest(
  event: ReturnType<typeof selectControlEvent>,
  triggerId: string,
  commandId: string,
): ControlEventPayloads[typeof ControlEventType.TriggerRequestRecorded] | undefined {
  if (
    event?.event.eventType === ControlEventType.TriggerRequestRecorded &&
    event.event.payload.triggerId === triggerId &&
    event.event.payload.source.kind === TriggerSourceKind.Manual &&
    event.event.payload.source.commandId === commandId &&
    event.event.payload.manualOutcome !== undefined
  )
    return event.event.payload;
  return undefined;
}

function activeWorkItem(
  view: TriggerView,
  coordinationKey: string,
): { readonly activeWorkItemId?: string } {
  const invocation = view.invocations.find(
    (entry) => entry.claim.coordinationKey === coordinationKey && entry.result === undefined,
  );
  return invocation === undefined ? {} : { activeWorkItemId: invocation.claim.workItemId };
}

function settledManualOutcome(outcome: ManualTriggerOutcome): boolean {
  return (
    outcome.disposition === ManualTriggerDisposition.Skipped ||
    (outcome.disposition === ManualTriggerDisposition.Started && outcome.workItemId !== undefined)
  );
}
