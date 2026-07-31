import {
  type CommandContext,
  type EventJournal,
  WrongExpectedSequenceError,
} from '../../kernel/index.js';
import type { ResourceStreamRef } from '../../resources/index.js';
import type { WorkItemStreamRef } from '../../work/index.js';
import type { ActivityFactDraft } from '../contracts/events.js';

export type IntentAppendResult = 'appended' | 'known' | 'ambiguous' | 'failed';

export interface IntentAppender {
  append(
    stream: ResourceStreamRef | WorkItemStreamRef,
    intent: ActivityFactDraft,
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
  intent: ActivityFactDraft,
): Promise<IntentAppendResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const events = await journal.readStream(stream);
    if (events.some((event) => event.eventId === intent.eventId)) return 'known';
    try {
      await journal.append(stream, events.length, [intent]);
      return 'appended';
    } catch (error) {
      const observed = await journal.readStream(stream);
      if (observed.some((event) => event.eventId === intent.eventId)) return 'known';
      if (!(error instanceof WrongExpectedSequenceError)) return 'failed';
    }
  }
  const reconciled = await journal.readStream(stream);
  return reconciled.some((event) => event.eventId === intent.eventId) ? 'known' : 'failed';
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
    actor: { kind: 'system', id: 'activities-pr' },
  };
}
