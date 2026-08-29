import { watch } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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

export interface FileEventJournalWatcher {
  unref(): void;
  close(): void;
  once(event: 'error', listener: () => void): unknown;
}

export type FileEventJournalWatcherFactory = (
  directory: string,
  notify: () => void,
) => Promise<FileEventJournalWatcher>;

export interface FileEventJournalOptions {
  readonly watcherFactory?: FileEventJournalWatcherFactory;
}

const createFileSystemWatcher: FileEventJournalWatcherFactory = async (directory, notify) =>
  watch(directory, { persistent: false }, notify);

export class FileEventJournal implements EventJournal {
  constructor(
    private readonly root: string,
    private readonly clock: Clock,
    private readonly options: FileEventJournalOptions = {},
  ) {}

  private readonly changeSignalSource = new InProcessJournalChangeSignal();
  private changeWatcher: FileEventJournalWatcher | undefined;
  private startingChangeWatcher: Promise<void> | undefined;

  get changeSignal(): JournalChangeSignal {
    return this.changeSignalSource;
  }

  private cached:
    | {
        readonly entries: readonly FileStat[];
        readonly events: EventEnvelope[];
        readonly eventsByStream: ReadonlyMap<string, readonly EventEnvelope[]>;
        readonly segments: readonly SegmentInfo[];
      }
    | undefined;

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
    return withFileLock(
      join(this.root, 'locks', 'event-journal.lock'),
      async () => {
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
            throw new Error(
              `Event id ${event.eventId} has already been used with different content`,
            );
        if (drafts.length > 0 && existing.every(isDefined)) return existing.filter(isDefined);
        const streamEvents = this.cachedEventsForStream(stream);
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
          // The manifest is derived data. The event append is authoritative, so
          // an index-write failure must not turn a successfully recorded event
          // into a failed append.
          await this.persistManifest().catch(() => undefined);
          this.changeSignalSource.notify();
        }
        return finalizedEnvelopes;
      },
      { waitMs: 5_000, retryIntervalMs: 25 },
    );
  }

  // Reads via the persisted per-segment manifest when the in-memory cache is
  // cold (fresh process, or an on-disk change this instance didn't make),
  // parsing only the segment files that can hold matching events instead of
  // the entire history. A missing or stale manifest degrades to scan()'s
  // full parse rather than to incorrect data. The next successful append
  // rebuilds the derived manifest.
  async readStream(stream: EntityRef) {
    const streamKey = key(stream);
    const entries = await this.readEntriesForRead();
    if (this.cached !== undefined) {
      if (sameEntries(this.cached.entries, entries))
        return this.cached.eventsByStream.get(streamKey) ?? [];
      await this.scan(entries);
      return this.cachedEventsForStream(stream);
    }
    const manifest = await this.loadManifest();
    if (manifest !== undefined && isCompleteIndex(manifest, entries)) {
      try {
        return await this.parseIndexedEntries(
          manifest.segments.flatMap((segment) =>
            segment.events
              .filter((event) => event.stream === streamKey)
              .map((event) => ({ ...event, file: segment.file })),
          ),
        );
      } catch {
        // The segment stats guarded the common stale-index case. If an index
        // is nevertheless internally inconsistent, the JSONL remains the
        // authority and retains the original read semantics.
      }
    }
    return (await this.scan(entries)).filter((event) => key(event.stream) === streamKey);
  }

  async readAll(after: number, limit = Number.POSITIVE_INFINITY) {
    const entries = await this.readEntriesForRead();
    if (this.cached !== undefined && sameEntries(this.cached.entries, entries))
      return this.cached.events.filter((event) => event.globalPosition > after).slice(0, limit);
    const manifest = await this.loadManifest();
    if (manifest !== undefined && isCompleteIndex(manifest, entries)) {
      try {
        return await this.parseIndexedEntries(
          manifest.segments
            .flatMap((segment) =>
              segment.events
                .filter((event) => event.globalPosition > after)
                .map((event) => ({ ...event, file: segment.file })),
            )
            .slice(0, limit),
        );
      } catch {
        // See readStream(): never let a derived index change journal reads.
      }
    }
    return (await this.scan(entries))
      .filter((event) => event.globalPosition > after)
      .slice(0, limit);
  }

  async readLatest(beforeGlobalPosition?: number, limit = Number.POSITIVE_INFINITY) {
    const events = await this.scan(await this.readEntriesForRead());
    const before = beforeGlobalPosition ?? events.length + 1;
    return events
      .slice(0, before - 1)
      .slice(-limit)
      .reverse();
  }

  async latestGlobalPosition(): Promise<number> {
    const events = await this.scan(await this.readEntriesForRead());
    return events.at(-1)?.globalPosition ?? 0;
  }

  async waitForEventsAfter(
    afterGlobalPosition: number,
    signal: AbortSignal,
    fallbackMs: number,
  ): Promise<void> {
    await this.ensureChangeWatcher();
    await waitForEventsAfter(
      () => this.latestGlobalPosition(),
      this.changeSignalSource,
      afterGlobalPosition,
      signal,
      fallbackMs,
    );
  }

  private ensureChangeWatcher(): Promise<void> {
    if (this.changeWatcher !== undefined) return Promise.resolve();
    if (this.startingChangeWatcher !== undefined) return this.startingChangeWatcher;
    const starting = this.startChangeWatcher().finally(() => {
      if (this.startingChangeWatcher === starting) this.startingChangeWatcher = undefined;
    });
    this.startingChangeWatcher = starting;
    return starting;
  }

  private async startChangeWatcher(): Promise<void> {
    const directory = join(this.root, 'events');
    try {
      await mkdir(directory, { recursive: true });
      const watcher = await (this.options.watcherFactory ?? createFileSystemWatcher)(
        directory,
        () => {
          this.changeSignalSource.notify();
        },
      );
      watcher.unref();
      watcher.once('error', () => {
        if (this.changeWatcher === watcher) this.changeWatcher = undefined;
        watcher.close();
        void this.ensureChangeWatcher();
      });
      this.changeWatcher = watcher;
    } catch {
      // This advisory accelerator is optional; fallback rereads stay correct.
    }
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
    const priorSegments = this.cached?.segments ?? [];
    const existingSegment = priorSegments.find((segment) => segment.file === file);
    let offset = existingSegment?.size ?? 0;
    const indexedEvents = newEnvelopes.map((event) => {
      const length = Buffer.byteLength(`${JSON.stringify(event)}\n`);
      const indexed = {
        globalPosition: event.globalPosition,
        stream: key(event.stream),
        offset,
        length,
      };
      offset += length;
      return indexed;
    });
    const segments = existingSegment
      ? priorSegments.map((segment) =>
          segment.file === file
            ? {
                ...updatedEntry,
                startPosition: segment.startPosition,
                count: segment.count + newEnvelopes.length,
                events: [...segment.events, ...indexedEvents],
              }
            : segment,
        )
      : [
          ...priorSegments,
          {
            ...updatedEntry,
            startPosition: priorEvents.length + 1,
            count: newEnvelopes.length,
            events: indexedEvents,
          },
        ];
    const events = [...priorEvents, ...newEnvelopes];
    this.cached = { entries, events, eventsByStream: indexEventsByStream(events), segments };
  }

  private manifestPath(): string {
    return join(this.root, 'events', 'index-manifest.json');
  }

  private cachedEventsForStream(stream: EntityRef): readonly EventEnvelope[] {
    return this.cached?.eventsByStream.get(key(stream)) ?? [];
  }

  // Persisted alongside the segments, so any reader of the same on-disk
  // journal — not just this instance — can skip straight to the segments
  // that can hold what it's looking for on a cold cache. append() extends its
  // contents from the concrete envelopes it has just written while locked.
  private async persistManifest(): Promise<void> {
    if (this.cached === undefined) return;
    const manifest: PersistedIndex = { segments: this.cached.segments };
    await writeFile(this.manifestPath(), JSON.stringify(manifest), 'utf8');
  }

  private async loadManifest(): Promise<PersistedIndex | undefined> {
    try {
      const raw = await readFile(this.manifestPath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isPersistedIndex(parsed) ? parsed : undefined;
    } catch {
      // Missing, corrupt, or foreign-shaped index: degrade to a full scan,
      // which is rebuilt by the next append.
      return undefined;
    }
  }

  private scan(precomputedEntries?: readonly FileStat[]): Promise<EventEnvelope[]> {
    if (this.inFlightScan !== undefined) return this.inFlightScan;
    const run = this.scanUncoalesced(precomputedEntries).finally(() => {
      if (this.inFlightScan === run) this.inFlightScan = undefined;
    });
    this.inFlightScan = run;
    return run;
  }

  private async readCurrentEntries(): Promise<FileStat[]> {
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
    return Promise.all(
      files.map(async (file): Promise<FileStat> => {
        const info = await stat(join(directory, file));
        return { file, size: info.size, mtimeMs: info.mtimeMs };
      }),
    );
  }

  private async readEntriesForRead(): Promise<readonly FileStat[]> {
    // The JSONL segments are authoritative. A manifest can remain unchanged
    // if a process crashes after appendFile() and before writing it, so every
    // warm read validates segment fingerprints before reusing decoded data.
    return this.readCurrentEntries();
  }

  // Reads exactly the indexed JSONL records. Byte offsets make tail reads and
  // stream reads proportional to the matching events, not segment size.
  private async parseIndexedEntries(
    entries: readonly (IndexedEvent & Pick<SegmentInfo, 'file'>)[],
  ): Promise<EventEnvelope[]> {
    const directory = join(this.root, 'events');
    const events: EventEnvelope[] = [];
    const grouped = new Map<string, (IndexedEvent & Pick<SegmentInfo, 'file'>)[]>();
    for (const entry of entries) {
      const group = grouped.get(entry.file) ?? [];
      group.push(entry);
      grouped.set(entry.file, group);
    }
    for (const [file, indexedEvents] of grouped) {
      const handle = await open(join(directory, file), 'r');
      try {
        for (const indexed of indexedEvents) {
          const buffer = Buffer.alloc(indexed.length);
          const { bytesRead } = await handle.read(buffer, 0, indexed.length, indexed.offset);
          events.push(this.decodeIndexedRecord(file, indexed, buffer, bytesRead));
        }
      } finally {
        await handle.close();
      }
    }
    return events;
  }

  private decodeIndexedRecord(
    file: string,
    indexed: IndexedEvent,
    buffer: Buffer,
    bytesRead: number,
  ): EventEnvelope {
    if (bytesRead !== indexed.length || buffer.at(-1) !== 10)
      throw new Error(`Incomplete indexed record in ${file}`);
    let input: unknown;
    try {
      input = JSON.parse(buffer.toString('utf8'));
      const event = decodeEventEnvelope(input);
      validateEnvelope(event, indexed.globalPosition);
      if (key(event.stream) !== indexed.stream) throw new Error('Indexed stream mismatch');
      return event;
    } catch (error) {
      const context = eventContext(input);
      throw new Error(
        `Corrupt indexed event at ${file}:${indexed.globalPosition}${context}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  private async scanUncoalesced(
    precomputedEntries?: readonly FileStat[],
  ): Promise<EventEnvelope[]> {
    const directory = join(this.root, 'events');
    const entries = precomputedEntries ?? (await this.readCurrentEntries());
    if (this.cached !== undefined && sameEntries(this.cached.entries, entries))
      return this.cached.events;
    const events: EventEnvelope[] = [];
    const segments: SegmentInfo[] = [];
    for (const entry of entries) {
      const { file } = entry;
      const raw = await readFile(join(directory, file), 'utf8');
      if (raw.length > 0 && !raw.endsWith('\n'))
        throw new Error(`Incomplete trailing line in ${file}`);
      const startPosition = events.length + 1;
      const indexedEvents: IndexedEvent[] = [];
      let offset = 0;
      for (const [index, line] of raw.split('\n').slice(0, -1).entries()) {
        let input: unknown;
        try {
          input = JSON.parse(line);
          const event = decodeEventEnvelope(input);
          validateEnvelope(event, events.length + 1);
          events.push(event);
          indexedEvents.push({
            globalPosition: event.globalPosition,
            stream: key(event.stream),
            offset,
            length: Buffer.byteLength(`${line}\n`),
          });
          offset += Buffer.byteLength(`${line}\n`);
        } catch (error) {
          const context = eventContext(input);
          throw new Error(
            `Corrupt event at ${file}:${index + 1}${context}: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }
      segments.push({
        ...entry,
        startPosition,
        count: events.length - startPosition + 1,
        events: indexedEvents,
      });
    }
    this.cached = { entries, events, eventsByStream: indexEventsByStream(events), segments };
    return events;
  }
}

interface FileStat {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
}

// Rebuildable read model over each JSONL record. Byte positions are relative
// to their segment and remain authoritative only while its file stat matches.
interface SegmentInfo extends FileStat {
  readonly startPosition: number;
  readonly count: number;
  readonly events: readonly IndexedEvent[];
}

interface IndexedEvent {
  readonly globalPosition: number;
  readonly stream: string;
  readonly offset: number;
  readonly length: number;
}

interface PersistedIndex {
  readonly segments: readonly SegmentInfo[];
}

function isPersistedIndex(value: unknown): value is PersistedIndex {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { segments?: unknown }).segments) &&
    (value as PersistedIndex).segments.every(isSegmentInfo)
  );
}

function isSegmentInfo(value: unknown): value is SegmentInfo {
  if (typeof value !== 'object' || value === null) return false;
  const segment = value as Partial<SegmentInfo>;
  return (
    typeof segment.file === 'string' &&
    typeof segment.size === 'number' &&
    typeof segment.mtimeMs === 'number' &&
    typeof segment.startPosition === 'number' &&
    typeof segment.count === 'number' &&
    Array.isArray(segment.events) &&
    segment.events.every(isIndexedEvent)
  );
}

function isIndexedEvent(value: unknown): value is IndexedEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<IndexedEvent>;
  return (
    typeof event.globalPosition === 'number' &&
    typeof event.stream === 'string' &&
    typeof event.offset === 'number' &&
    typeof event.length === 'number'
  );
}

function isCompleteIndex(index: PersistedIndex, entries: readonly FileStat[]): boolean {
  if (!sameEntries(index.segments, entries)) return false;
  let position = 1;
  return index.segments.every((segment) => {
    let offset = 0;
    const complete =
      segment.startPosition === position &&
      segment.count === segment.events.length &&
      segment.events.every((event) => {
        const matches =
          event.globalPosition === position &&
          event.offset === offset &&
          Number.isSafeInteger(event.length) &&
          event.length > 0;
        position += 1;
        offset += event.length;
        return matches;
      }) &&
      offset === segment.size;
    return complete;
  });
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

function indexEventsByStream(
  events: readonly EventEnvelope[],
): ReadonlyMap<string, readonly EventEnvelope[]> {
  const indexed = new Map<string, EventEnvelope[]>();
  for (const event of events) {
    const streamKey = key(event.stream);
    const streamEvents = indexed.get(streamKey);
    if (streamEvents === undefined) indexed.set(streamKey, [event]);
    else streamEvents.push(event);
  }
  return indexed;
}

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

async function waitForEventsAfter(
  latestGlobalPosition: () => Promise<number>,
  changeSignal: JournalChangeSignal,
  afterGlobalPosition: number,
  signal: AbortSignal,
  fallbackMs: number,
): Promise<void> {
  if (signal.aborted) return;
  const observedGeneration = changeSignal.revision();
  const waiting = new AbortController();
  const abort = () => waiting.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const wake = changeSignal.waitForChangeAfter(observedGeneration, waiting.signal, fallbackMs);
    if ((await latestGlobalPosition()) > afterGlobalPosition) return;
    await wake;
  } finally {
    waiting.abort();
    signal.removeEventListener('abort', abort);
  }
}
