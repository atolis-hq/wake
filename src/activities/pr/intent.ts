import {
  type CommandContext,
  EventActorKind,
  type EventJournal,
  WrongExpectedSequenceError,
} from '../../kernel/index.js';
import type { ResourceStreamRef } from '../../resources/index.js';
import type { WorkItemStreamRef } from '../../work/index.js';
import type { ActivityFactEventData } from '../contracts/events.js';
import { IntentAppendStatus } from '../contracts/vocabulary.js';

export type IntentAppendResult =
  | typeof IntentAppendStatus.Appended
  | typeof IntentAppendStatus.Known
  | typeof IntentAppendStatus.Ambiguous
  | typeof IntentAppendStatus.Failed;

export interface IntentAppender {
  append(
    stream: ResourceStreamRef | WorkItemStreamRef,
    intent: ActivityFactEventData,
  ): Promise<IntentAppendResult>;
}

export function createJournalIntentAppender(journal: EventJournal): IntentAppender {
  return {
    append: (stream, intent) => appendIntentOnce(journal, stream, intent),
  };
}

export async function appendIntentOnce(
  journal: EventJournal,
  stream: ResourceStreamRef | WorkItemStreamRef,
  intent: ActivityFactEventData,
): Promise<IntentAppendResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const events = await journal.readStream(stream);
    if (events.some((event) => event.event.eventId === intent.eventId))
      return IntentAppendStatus.Known;
    try {
      await journal.appendToStream(stream, events.length, [intent]);
      return IntentAppendStatus.Appended;
    } catch (error) {
      const observed = await journal.readStream(stream);
      if (observed.some((event) => event.event.eventId === intent.eventId))
        return IntentAppendStatus.Known;
      if (!(error instanceof WrongExpectedSequenceError)) return IntentAppendStatus.Failed;
    }
  }
  const reconciled = await journal.readStream(stream);
  return reconciled.some((event) => event.event.eventId === intent.eventId)
    ? IntentAppendStatus.Known
    : IntentAppendStatus.Failed;
}

export function activityCommandContext(
  activationId: string,
  orchestrationGroupId: string,
  occurredAt: string,
): CommandContext {
  return {
    commandId: activationId,
    correlationId: orchestrationGroupId as CommandContext['correlationId'],
    occurredAt,
    actor: { kind: EventActorKind.System, id: 'activities-pr' },
  };
}
