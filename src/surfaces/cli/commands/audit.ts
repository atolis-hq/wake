import type { EventEnvelope } from '../../../kernel/index.js';

export interface AuditJournal {
  readAll(afterGlobalPosition: number, limit?: number): Promise<readonly EventEnvelope[]>;
}

export interface AuditWork {
  get(workItemId: string): Promise<unknown>;
}

export interface AuditFact {
  readonly event: EventEnvelope['event'] & Omit<EventEnvelope, 'event'>;
  readonly causalLinks: { readonly causationId: string; readonly correlationId: string };
}

/** Reads canonical journal facts, not a projection, so it remains useful during rebuilds. */
export async function audit(
  journal: AuditJournal,
  work: AuditWork,
  workItemId: string,
): Promise<readonly AuditFact[]> {
  await work.get(workItemId);
  return (await journal.readAll(0))
    .filter((event) => event.stream.id === workItemId)
    .map((event) => ({
      event: {
        ...event.event,
        stream: event.stream,
        recordedAt: event.recordedAt,
        sequence: event.sequence,
        globalPosition: event.globalPosition,
      },
      causalLinks: {
        causationId: event.event.causationId,
        correlationId: event.event.correlationId,
      },
    }));
}
