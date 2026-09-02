import { correlationId, EventActorKind, type CommandContext } from '@atolis-hq/eventing';
import { ResourceEventType, type ResourceEvent } from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import type { ResourceCorrelationView } from '../contracts/views.js';
import type { ResourceExternalOutcome } from '../contracts/vocabulary.js';
import { ResourceCorrelationRole } from '../contracts/vocabulary.js';
import {
  appendResourceEvent,
  resourceDraft,
  type ResourceDraftInput,
} from './resource-event-support.js';
import type { ResourceRepository } from './resource-repository.js';

export async function observeExternalOutcome(
  repository: ResourceRepository,
  resourceId: ResourceId,
  observation: {
    readonly sourceObservationId: string;
    readonly outcome?: ResourceExternalOutcome;
    readonly revision: string;
  },
  context: CommandContext,
): Promise<void> {
  if (observation.outcome === undefined) {
    await appendResourceEvent(
      repository,
      resourceId,
      resourceDraft(context, {
        eventType: ResourceEventType.ExternalOutcomeReopened,
        payload: { revision: observation.revision },
      }),
    );
    return;
  }
  await appendResourceEvent(
    repository,
    resourceId,
    resourceDraft(context, {
      eventType: ResourceEventType.ExternalOutcomeObserved,
      payload: {
        sourceObservationId: observation.sourceObservationId,
        outcome: observation.outcome,
        revision: observation.revision,
      },
    }),
  );
}

export async function pendingExternalOutcomes(repository: ResourceRepository): Promise<
  readonly {
    readonly resourceId: ResourceId;
    readonly outcome: ResourceExternalOutcome;
    readonly sourceObservationId: string;
  }[]
> {
  const pending: {
    resourceId: ResourceId;
    outcome: ResourceExternalOutcome;
    sourceObservationId: string;
  }[] = [];
  for (const resourceId of await repository.listResourceIds()) {
    const resource = (await repository.load(resourceId)).resource;
    if (resource?.view.pendingExternalOutcome !== undefined && hasPrimary(resource.correlations))
      pending.push({ resourceId, ...resource.view.pendingExternalOutcome });
  }
  return pending;
}

export async function noteMissingPrimaryCorrelation(
  repository: ResourceRepository,
  resourceId: ResourceId,
  reason: string,
  context: CommandContext,
): Promise<void> {
  const loaded = await repository.load(resourceId);
  if (loaded.resource === null || hasPrimary(loaded.resource.correlations)) return;
  if (loaded.resource.view.correlationStatus === 'unresolvable') return;
  if (retryAttempts(loaded.resource.events) > 0) return;
  await repository.append(resourceId, loaded.sequence, [
    resourceDraft(context, {
      eventType: ResourceEventType.WorkCorrelationRetryPending,
      payload: { attemptCount: 1, lastFailureReason: reason },
    }),
  ]);
}

export async function retryPendingWorkCorrelations(
  repository: ResourceRepository,
): Promise<number> {
  let processed = 0;
  for (const resourceId of await repository.listResourceIds()) {
    const loaded = await repository.load(resourceId);
    if (loaded.resource === null || hasPrimary(loaded.resource.correlations)) continue;
    if (loaded.resource.view.correlationStatus === 'unresolvable') continue;
    const attempts = retryAttempts(loaded.resource.events);
    if (attempts === 0) continue;
    const last = [...loaded.resource.events]
      .reverse()
      .map((event) => event.event)
      .find(isCorrelationRetryPending);
    const reason =
      last?.payload.lastFailureReason ?? 'Resource has no active primary WorkItem correlation';
    const attemptCount = attempts + 1;
    const context: CommandContext = {
      commandId: `resource:${resourceId}:missing-primary:${attemptCount}`,
      correlationId: correlationId(`resource:${resourceId}:missing-primary`),
      occurredAt: new Date().toISOString(),
      actor: { kind: EventActorKind.System, id: 'resource-service' },
    };
    const input: ResourceDraftInput =
      attemptCount >= 4
        ? {
            eventType: ResourceEventType.WorkCorrelationUnresolvable,
            payload: {
              externalKey: loaded.resource.view.externalKey,
              attemptCount,
              lastFailureReason: reason,
            },
          }
        : {
            eventType: ResourceEventType.WorkCorrelationRetryPending,
            payload: { attemptCount, lastFailureReason: reason },
          };
    const draft = resourceDraft(context, input);
    await repository.append(resourceId, loaded.sequence, [draft]);
    processed += 1;
  }
  return processed;
}

function isCorrelationRetryPending(
  event: ResourceEvent['event'],
): event is Extract<
  ResourceEvent['event'],
  { eventType: typeof ResourceEventType.WorkCorrelationRetryPending }
> {
  return event.eventType === ResourceEventType.WorkCorrelationRetryPending;
}

function hasPrimary(correlations: readonly ResourceCorrelationView[]): boolean {
  return correlations.some((value) => value.role === ResourceCorrelationRole.Primary);
}

function retryAttempts(events: readonly ResourceEvent[]): number {
  let attempts = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      event.event.eventType === ResourceEventType.WorkCorrelationEstablished &&
      event.event.payload.role === ResourceCorrelationRole.Primary
    )
      break;
    if (event.event.eventType === ResourceEventType.WorkCorrelationRetryPending)
      attempts = Math.max(attempts, event.event.payload.attemptCount);
  }
  return attempts;
}
