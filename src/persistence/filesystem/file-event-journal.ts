import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  Clock,
  EntityRef,
  EventDraft,
  EventEnvelope,
  EventJournal,
  JournalChangeSignal,
} from '../../kernel/index.js';
import {
  decodeEventEnvelope,
  InProcessJournalChangeSignal,
  WrongExpectedSequenceError,
} from '../../kernel/index.js';
import { withFileLock } from './file-lock.js';

export class FileEventJournal implements EventJournal {
  constructor(
    private readonly root: string,
    private readonly clock: Clock,
  ) {}

  private readonly changeSignalSource = new InProcessJournalChangeSignal();

  get changeSignal(): JournalChangeSignal {
    return this.changeSignalSource;
  }

  private cached:
    { readonly entries: readonly FileStat[]; readonly events: EventEnvelope[] } | undefined;

  // Every read (readStream/readAll/readLatest/latestGlobalPosition) reaches
  // scan(), and the resident host's tick loop calls those many times a
  // second while work is progressing. Without coalescing, calls that land
  // concurrently each independently decide the cache is stale and each
  // re-read and re-parse the entire on-disk journal — under I/O pressure
  // (e.g. a concurrently running build/test process competing for disk),
  // enough of these can overlap at once to exhaust the heap. Sharing one
  // in-flight decode among concurrent callers makes that impossible.
  private inFlightScan: Promise<EventEnvelope[]> | undefined;

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
        const file = `${day}.jsonl`;
        await appendFile(
          join(directory, file),
          newEnvelopes.map((event) => JSON.stringify(event)).join('\n') + '\n',
          'utf8',
        );
        await this.extendCache(file, current, newEnvelopes);
        this.changeSignalSource.notify();
      }
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

  // Extends the cache in place rather than invalidating it, so a self-caused
  // write doesn't force the next read (by this call or any other reader
  // sharing this instance) to re-parse the entire on-disk history. Only a
  // change this instance didn't make itself — another process writing to the
  // same journal — falls through to scan()'s full re-read.
  private async extendCache(
    file: string,
    priorEvents: readonly EventEnvelope[],
    newEnvelopes: readonly EventEnvelope[],
  ): Promise<void> {
    const info = await stat(join(this.root, 'events', file));
    const updatedEntry: FileStat = { file, size: info.size, mtimeMs: info.mtimeMs };
    const priorEntries = this.cached?.entries ?? [];
    const entries = priorEntries.some((entry) => entry.file === file)
      ? priorEntries.map((entry) => (entry.file === file ? updatedEntry : entry))
      : [...priorEntries, updatedEntry];
    this.cached = { entries, events: [...priorEvents, ...newEnvelopes] };
  }

  private scan(): Promise<EventEnvelope[]> {
    if (this.inFlightScan !== undefined) return this.inFlightScan;
    const run = this.scanUncoalesced().finally(() => {
      if (this.inFlightScan === run) this.inFlightScan = undefined;
    });
    this.inFlightScan = run;
    return run;
  }

  private async scanUncoalesced(): Promise<EventEnvelope[]> {
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
    const entries = await Promise.all(
      files.map(async (file): Promise<FileStat> => {
        const info = await stat(join(directory, file));
        return { file, size: info.size, mtimeMs: info.mtimeMs };
      }),
    );
    if (this.cached !== undefined && sameEntries(this.cached.entries, entries))
      return this.cached.events;
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
    this.cached = { entries, events };
    return events;
  }
}

interface FileStat {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
}

function sameEntries(a: readonly FileStat[], b: readonly FileStat[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index]!;
      return (
        entry.file === other.file && entry.size === other.size && entry.mtimeMs === other.mtimeMs
      );
    })
  );
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
