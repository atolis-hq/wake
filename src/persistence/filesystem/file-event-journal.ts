import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  Clock,
  EntityRef,
  EventDraft,
  EventEnvelope,
  EventJournal,
} from '../../kernel/index.js';
import { decodeEventEnvelope, WrongExpectedSequenceError } from '../../kernel/index.js';
import { withFileLock } from './file-lock.js';

export class FileEventJournal implements EventJournal {
  constructor(
    private readonly root: string,
    private readonly clock: Clock,
  ) {}

  private cached: { readonly fingerprint: string; readonly events: EventEnvelope[] } | undefined;

  async append(
    stream: EntityRef,
    expectedSequence: number,
    drafts: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]> {
    return withFileLock(join(this.root, 'locks', 'event-journal.lock'), async () => {
      const current = await this.scan();
      const byId = new Map(current.map((event) => [event.eventId, event]));
      const batchIds = new Set<string>();
      for (const draft of drafts) {
        if (batchIds.has(draft.eventId))
          throw new Error(`Event id ${draft.eventId} is repeated in one append`);
        batchIds.add(draft.eventId);
      }
      const existing = drafts.map((draft) => byId.get(draft.eventId));
      for (const [index, event] of existing.entries())
        if (event !== undefined && !sameDraft(event, drafts[index]!))
          throw new Error(`Event id ${event.eventId} has already been used with different content`);
      if (drafts.length > 0 && existing.every(isDefined)) return existing.filter(isDefined);
      const streamEvents = current.filter((event) => key(event.stream) === key(stream));
      if (streamEvents.length !== expectedSequence)
        throw new WrongExpectedSequenceError(
          `Expected sequence ${expectedSequence} for ${key(stream)}, actual ${streamEvents.length}`,
        );
      for (const draft of drafts)
        if (key(draft.stream) !== key(stream)) throw new Error('Event stream mismatch');
      const recordedAt = this.clock.now().toISOString();
      let newCount = 0;
      const envelopes = drafts.map((draft, index): EventEnvelope => {
        const prior = existing[index];
        if (prior !== undefined) return prior;
        newCount += 1;
        return {
          ...draft,
          recordedAt,
          sequence: streamEvents.length + newCount,
          globalPosition: current.length + newCount,
        };
      });
      const finalizedEnvelopes = envelopes.map((event) => decodeEventEnvelope(event));
      const newEnvelopes = finalizedEnvelopes.filter((event) => !byId.has(event.eventId));
      if (newEnvelopes.length > 0) {
        const directory = join(this.root, 'events');
        await mkdir(directory, { recursive: true });
        const day = recordedAt.slice(0, 10);
        await appendFile(
          join(directory, `${day}.jsonl`),
          newEnvelopes.map((event) => JSON.stringify(event)).join('\n') + '\n',
          'utf8',
        );
      }
      this.cached = undefined;
      return finalizedEnvelopes;
    });
  }

  async readStream(stream: EntityRef) {
    return (await this.scan()).filter((event) => key(event.stream) === key(stream));
  }

  async readAll(after: number, limit = Number.POSITIVE_INFINITY) {
    return (await this.scan()).filter((event) => event.globalPosition > after).slice(0, limit);
  }

  async readLatest(beforeGlobalPosition?: number, limit = Number.POSITIVE_INFINITY) {
    const events = await this.scan();
    const before = beforeGlobalPosition ?? events.length + 1;
    return events
      .slice(0, before - 1)
      .slice(-limit)
      .reverse();
  }

  async latestGlobalPosition(): Promise<number> {
    const events = await this.scan();
    return events.at(-1)?.globalPosition ?? 0;
  }

  private async scan(): Promise<EventEnvelope[]> {
    const directory = join(this.root, 'events');
    let files: string[];
    try {
      files = (await readdir(directory))
        .filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const fingerprint = (
      await Promise.all(
        files.map(async (file) => {
          const info = await stat(join(directory, file));
          return `${file}:${info.size}:${info.mtimeMs}`;
        }),
      )
    ).join('|');
    if (this.cached?.fingerprint === fingerprint) return this.cached.events;
    const events: EventEnvelope[] = [];
    for (const file of files) {
      const raw = await readFile(join(directory, file), 'utf8');
      if (raw.length > 0 && !raw.endsWith('\n'))
        throw new Error(`Incomplete trailing line in ${file}`);
      for (const [index, line] of raw.split('\n').slice(0, -1).entries()) {
        let input: unknown;
        try {
          input = JSON.parse(line);
          const event = decodeEventEnvelope(input);
          validateEnvelope(event, events.length + 1);
          events.push(event);
        } catch (error) {
          const context = eventContext(input);
          throw new Error(
            `Corrupt event at ${file}:${index + 1}${context}: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }
    }
    this.cached = { fingerprint, events };
    return events;
  }
}
const key = (stream: EntityRef) => `${stream.kind}:${stream.id}`;
const sameDraft = (event: EventEnvelope, draft: EventDraft) =>
  isDeepStrictEqual(
    {
      eventId: event.eventId,
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      occurredAt: event.occurredAt,
      correlationId: event.correlationId,
      causationId: event.causationId,
      actor: event.actor,
      source: event.source,
      stream: event.stream,
      payload: event.payload,
    },
    draft,
  );

function validateEnvelope(event: EventEnvelope, expectedPosition: number): void {
  if (event.globalPosition !== expectedPosition) throw new Error('Invalid event envelope position');
}

function eventContext(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('eventId' in input)) return '';
  const eventId = input.eventId;
  return typeof eventId === 'string' && eventId.length > 0 ? ` event ${eventId}` : '';
}

function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}
