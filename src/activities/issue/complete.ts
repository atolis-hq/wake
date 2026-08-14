import { z } from 'zod';

import { createEventDraft, EventSourceKind, type EventJournal } from '../../kernel/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  resourceStream,
} from '../../resources/index.js';
import type { ActivityDefinition, ActivityInvocation } from '../contracts/activity.js';
import { ActivityEventType } from '../contracts/events.js';
import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityResourceRole,
  BuiltInActivityName,
} from '../contracts/vocabulary.js';

const inputSchema = z.object({ target: z.literal(ActivityResourceRole.Primary).default(ActivityResourceRole.Primary) }).strict();

type IssueCompleteOutcome =
  | { readonly kind: typeof ActivityOutcomeKind.Waiting; readonly data: { readonly intentEventId: string; readonly signalKind: 'delivery-result' } }
  | { readonly kind: typeof ActivityOutcomeKind.Blocked; readonly data: { readonly reason: 'missing-completable-primary-issue' } };

const outcomeSchema: z.ZodType<IssueCompleteOutcome> = z.union([
  z.object({ kind: z.literal(ActivityOutcomeKind.Waiting), data: z.object({ intentEventId: z.string(), signalKind: z.literal('delivery-result') }).strict() }).strict(),
  z.object({ kind: z.literal(ActivityOutcomeKind.Blocked), data: z.object({ reason: z.literal('missing-completable-primary-issue') }).strict() }).strict(),
]);

/** Requests completion of the one primary issue only; delivery owns provider effects. */
export function createIssueCompleteActivity(
  journal: EventJournal,
): ActivityDefinition<typeof BuiltInActivityName.IssueComplete, { readonly target: 'primary' }, IssueCompleteOutcome> {
  return {
    name: BuiltInActivityName.IssueComplete,
    inputSchema,
    outcomeSchema,
    outcomeKinds: [ActivityOutcomeKind.Waiting, ActivityOutcomeKind.Done, ActivityOutcomeKind.Blocked],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: { execute: (invocation, context) => execute(journal, invocation, context.occurredAt) },
  };
}

async function execute(
  journal: EventJournal,
  invocation: ActivityInvocation<{ readonly target: 'primary' }>,
  occurredAt: string,
): Promise<IssueCompleteOutcome> {
  const resource = invocation.resources.filter(
    (candidate) =>
      candidate.kind === BuiltInResourceKind.Issue &&
      candidate.capabilities.includes(BuiltInResourceCapability.Completable),
  );
  if (resource.length !== 1)
    return { kind: ActivityOutcomeKind.Blocked, data: { reason: 'missing-completable-primary-issue' } };
  const target = resource[0]!;
  const eventId = `${invocation.activationId}:${ActivityEventType.IssueCompleteRequested}`;
  const stream = resourceStream(target.resourceId);
  const existing = await journal.readStream(stream);
  if (!existing.some((event) => event.eventId === eventId)) {
    await journal.append(stream, existing.length, [
      createEventDraft({
        eventId,
        eventType: ActivityEventType.IssueCompleteRequested,
        occurredAt,
        correlationId: invocation.orchestrationGroupId,
        causationId: invocation.activationId,
        actor: { kind: 'system', id: 'activities-issue' },
        source: { kind: EventSourceKind.Internal, id: 'activities-issue' },
        stream,
        payload: {
          idempotencyKey: eventId,
          activationId: invocation.activationId,
          workflowInstanceId: invocation.workflowInstanceId,
          resourceId: target.resourceId,
        },
      }),
    ]);
  }
  return { kind: ActivityOutcomeKind.Waiting, data: { intentEventId: eventId, signalKind: 'delivery-result' } };
}
