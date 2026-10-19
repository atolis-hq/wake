import type {
  EventData,
  EventEnvelope,
  EventingClock,
  EventJournal,
  JournalChangeSignal,
  StreamRef,
} from '@atolis-hq/eventing';
import { decodeEventEnvelope, WrongExpectedSequenceError, yieldScan } from '@atolis-hq/eventing';
import { InProcessJournalChangeSignal } from '@atolis-hq/eventing/memory';
import { createReadStream, watch } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomically } from './atomic-write.js';
import { decodeEventRecord, encodeEventRecord } from './event-record-codec.js';
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

// A directory timestamp only proves "unchanged" once it is older than the
// filesystem's timestamp granularity, otherwise a second change inside the same
// tick would leave it identical. Younger stamps are re-listed, never trusted.
const unchangedStampMinAgeMs = 2_500;
const statBatchSize = 256;

export class FileEventJournal implements EventJournal {
  constructor(
    private readonly root: string,
    private readonly clock: EventingClock,
    private readonly options: FileEventJournalOptions = {},
  ) {}

  private readonly changeSignalSource = new InProcessJournalChangeSignal();
  private changeWatcher: FileEventJournalWatcher | undefined;
  private startingChangeWatcher: Promise<void> | undefined;

  get changeSignal(): JournalChangeSignal {
    return this.changeSignalSource;
  }

  // The most complete snapshot seen so far. Readers never build on it after an
  // await: a scan returns its own snapshot, because a slower scan of older
  // entries may finish after a newer one and must not be mistaken for it.
  private cached: JournalSnapshot | undefined;

  // Every read (readStream/readAll/readLatest/latestGlobalPosition) reaches
  // scan(), and the resident host's tick loop calls those many times a
  // second while work is progressing. Without coalescing, calls that land
  // concurrently each independently decide the cache is stale and each
  // re-read and re-parse the entire on-disk journal — under I/O pressure
  // (e.g. a concurrently running build/test process competing for disk),
  // enough of these can overlap at once to exhaust the heap. Sharing a decode
  // only for the same segment fingerprints keeps that protection without
  // letting an append reuse a scan from before another process wrote.
  private inFlightScan:
    { readonly entries: readonly FileStat[]; readonly run: Promise<JournalSnapshot> } | undefined;

  // Segments are immutable: each is published by atomic rename to a name that is
  // never reused, and nothing rewrites or deletes one. A segment seen once is
  // therefore never stat'ed again, and a listing costs a directory stat, one
  // readdir and a stat of the names not seen before. There is no validity
  // window: every read reflects every append committed before it was called,
  // including appends by other processes sharing the directory.
  private readonly knownSegments = new Map<string, FileStat>();
  private latestEntries: readonly FileStat[] = [];
  private listing: { readonly stamp: DirectoryStamp; readonly startedAtMs: number } | undefined;

  private runningListing: Promise<readonly FileStat[]> | undefined;
  private queuedListing: Promise<readonly FileStat[]> | undefined;
  private temporariesReclaimed = false;

  async appendToStream(
    stream: StreamRef,
    expectedSequence: number,
    drafts: readonly EventData[],
  ): Promise<readonly EventEnvelope[]> {
    if (drafts.length === 0) throw new Error('appendToStream requires at least one event');
    return withFileLock(
      join(this.root, 'locks', 'event-journal.lock'),
      async () => {
        if (!this.temporariesReclaimed) {
          await reclaimStaleSegmentTemps(join(this.root, 'events'));
          this.temporariesReclaimed = true;
        }
        const snapshot = await this.scan();
        const current = snapshot.events;
        const streamEvents = snapshot.eventsByStream.get(key(stream)) ?? [];
        if (streamEvents.length !== expectedSequence)
          throw new WrongExpectedSequenceError(
            `Expected sequence ${expectedSequence} for ${key(stream)}, actual ${streamEvents.length}`,
          );
        const recordedAt = this.clock.now().toISOString();
        const envelopes = drafts.map((draft, index): EventEnvelope => ({
          event: draft,
          stream,
          recordedAt,
          sequence: streamEvents.length + index + 1,
          globalPosition: current.length + index + 1,
        }));
        const finalizedEnvelopes = envelopes.map((event) => decodeEventEnvelope(event));
        const directory = join(this.root, 'events');
        await mkdir(directory, { recursive: true });
        const file = await this.nextSegmentFile(directory, recordedAt, current.length + 1);
        await writeSegmentAtomically(
          join(directory, file),
          finalizedEnvelopes.map(encodeEventRecord).join('\n') + '\n',
        );
        const next = await this.extendCache(file, snapshot, finalizedEnvelopes);
        // The manifest is derived data. The event append is authoritative, so
        // an index-write failure must not turn a successfully recorded event
        // into a failed append.
        await this.persistManifest(next).catch(() => undefined);
        this.changeSignalSource.notify();
        return finalizedEnvelopes;
      },
      { waitMs: 5_000, retryIntervalMs: 25 },
    );
  }

  private async nextSegmentFile(
    directory: string,
    recordedAt: string,
    firstGlobalPosition: number,
  ): Promise<string> {
    const day = recordedAt.slice(0, 10);
    const daily = `${day}.jsonl`;
    try {
      await stat(join(directory, daily));
      return `${day}~${String(firstGlobalPosition).padStart(20, '0')}.jsonl`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return daily;
      throw error;
    }
  }

  // Reads via the persisted per-segment manifest when the in-memory cache is
  // cold (fresh process, or an on-disk change this instance didn't make),
  // parsing only the segment files that can hold matching events instead of
  // the entire history. A missing or stale manifest degrades to scan()'s
  // full parse rather than to incorrect data. The next successful append
  // rebuilds the derived manifest.
  async readStream(stream: StreamRef) {
    const streamKey = key(stream);
    const entries = await this.currentEntries();
    const warm = this.cached;
    if (warm !== undefined) {
      const snapshot = sameEntries(warm.entries, entries) ? warm : await this.scan(entries);
      return snapshot.eventsByStream.get(streamKey) ?? [];
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
    return (await this.scan(entries)).events.filter((event) => key(event.stream) === streamKey);
  }

  /** Live readers bypass the full-history cache and stop at captured segment sizes. */
  async *scanAll(signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    signal?.throwIfAborted();
    const entries = await this.currentEntries();
    let position = 0;
    for (const entry of entries) {
      let lineNumber = 0;
      for await (const line of this.scanSegment(entry, signal)) {
        if (position % 100 === 0) await yieldScan(signal);
        signal?.throwIfAborted();
        yield this.decodeScanRecord(entry.file, ++lineNumber, line, ++position);
      }
    }
  }

  private async *scanSegment(entry: FileStat, signal?: AbortSignal): AsyncIterable<string> {
    if (entry.size === 0) return;
    const source = createReadStream(join(this.root, 'events', entry.file), {
      encoding: 'utf8',
      end: entry.size - 1,
      ...(signal === undefined ? {} : { signal }),
    });
    let pending = '',
      bytes = 0;
    try {
      for await (const chunk of source) {
        signal?.throwIfAborted();
        const text = String(chunk);
        bytes += Buffer.byteLength(text);
        pending += text;
        let offset = 0,
          newline = pending.indexOf('\n');
        while (newline !== -1) {
          yield pending.slice(offset, newline);
          offset = newline + 1;
          newline = pending.indexOf('\n', offset);
        }
        pending = pending.slice(offset);
      }
      signal?.throwIfAborted();
      if (pending !== '' || bytes !== entry.size)
        throw new Error(`Incomplete trailing line in ${entry.file}`);
    } finally {
      source.destroy();
    }
  }

  private decodeScanRecord(
    file: string,
    lineNumber: number,
    line: string,
    position: number,
  ): EventEnvelope {
    let input: unknown;
    try {
      input = JSON.parse(line);
      const event = decodeEventRecord(input);
      validateEnvelope(event, position);
      return event;
    } catch (error) {
      throw new Error(
        `Corrupt event at ${file}:${lineNumber}${eventContext(input)}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  async readAll(after: number, limit = Number.POSITIVE_INFINITY) {
    const entries = await this.currentEntries();
    const warm = this.cached;
    if (warm !== undefined && sameEntries(warm.entries, entries))
      return warm.events.filter((event) => event.globalPosition > after).slice(0, limit);
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
    return (await this.scan(entries)).events
      .filter((event) => event.globalPosition > after)
      .slice(0, limit);
  }

  async readLatest(beforeGlobalPosition?: number, limit = Number.POSITIVE_INFINITY) {
    if (beforeGlobalPosition !== undefined && beforeGlobalPosition <= 0) return [];
    if (limit <= 0) return [];
    const { events } = await this.scan(await this.currentEntries());
    const before = beforeGlobalPosition ?? events.length + 1;
    return events
      .slice(0, before - 1)
      .slice(-limit)
      .reverse();
  }

  async latestGlobalPosition(): Promise<number> {
    const { events } = await this.scan(await this.currentEntries());
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
        () => this.changeSignalSource.notify(),
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
    prior: JournalSnapshot,
    newEnvelopes: readonly EventEnvelope[],
  ): Promise<JournalSnapshot> {
    const priorEvents = prior.events;
    const info = await stat(join(this.root, 'events', file));
    const updatedEntry: FileStat = { file, size: info.size, mtimeMs: info.mtimeMs };
    const priorEntries = prior.entries;
    const entries = priorEntries.some((entry) => entry.file === file)
      ? priorEntries.map((entry) => (entry.file === file ? updatedEntry : entry))
      : [...priorEntries, updatedEntry];
    const priorSegments = prior.segments;
    const existingSegment = priorSegments.find((segment) => segment.file === file);
    let offset = existingSegment?.size ?? 0;
    const indexedEvents = newEnvelopes.map((event) => {
      const length = Buffer.byteLength(`${encodeEventRecord(event)}\n`);
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
    const next = { entries, events, eventsByStream: indexEventsByStream(events), segments };
    this.adopt(next);
    this.knownSegments.set(file, updatedEntry);
    if (entries.length >= this.latestEntries.length) this.latestEntries = entries;
    return next;
  }

  // Journals only grow, so the snapshot with more events is the newer one.
  private adopt(snapshot: JournalSnapshot): void {
    if (this.cached === undefined || snapshot.events.length >= this.cached.events.length)
      this.cached = snapshot;
  }

  private manifestPath(): string {
    return join(this.root, 'events', 'index-manifest.json');
  }

  // Persisted alongside the segments, so any reader of the same on-disk
  // journal — not just this instance — can skip straight to the segments
  // that can hold what it's looking for on a cold cache. appendToStream() extends its
  // contents from the concrete envelopes it has just written while locked.
  private async persistManifest(snapshot: JournalSnapshot): Promise<void> {
    const manifest: PersistedIndex = { segments: snapshot.segments };
    await writeFileAtomically(this.manifestPath(), JSON.stringify(manifest));
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

  private async scan(precomputedEntries?: readonly FileStat[]): Promise<JournalSnapshot> {
    const entries = precomputedEntries ?? (await this.currentEntries());
    const inFlight = this.inFlightScan;
    if (inFlight !== undefined && sameEntries(inFlight.entries, entries)) return inFlight.run;
    const run = this.scanUncoalesced(entries).finally(() => {
      if (this.inFlightScan?.run === run) this.inFlightScan = undefined;
    });
    this.inFlightScan = { entries, run };
    return run;
  }

  // Resolves with a listing that reflects every append committed before the
  // call. A listing already running may have read the directory before the
  // call, so it cannot answer it; every caller arriving while one runs shares a
  // single follow-up listing. Any number of concurrent reads cost at most two.
  private currentEntries(): Promise<readonly FileStat[]> {
    if (this.queuedListing !== undefined) return this.queuedListing;
    const running = this.runningListing;
    if (running === undefined) return this.startListing();
    const queued = running
      .catch(() => undefined)
      .then(() => {
        this.queuedListing = undefined;
        return this.startListing();
      });
    this.queuedListing = queued;
    return queued;
  }

  private startListing(): Promise<readonly FileStat[]> {
    const run = this.listSegments().finally(() => {
      if (this.runningListing === run) this.runningListing = undefined;
    });
    this.runningListing = run;
    return run;
  }

  private async listSegments(): Promise<readonly FileStat[]> {
    const directory = join(this.root, 'events');
    const startedAtMs = Date.now();
    let stamp: DirectoryStamp;
    try {
      const info = await stat(directory);
      stamp = { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.knownSegments.clear();
      this.listing = undefined;
      this.latestEntries = [];
      return [];
    }
    const previous = this.listing;
    if (
      previous !== undefined &&
      sameStamp(previous.stamp, stamp) &&
      previous.startedAtMs - Math.max(stamp.mtimeMs, stamp.ctimeMs) > unchangedStampMinAgeMs &&
      this.latestEntries.length === this.knownSegments.size
    )
      return this.latestEntries;
    // The stamp is taken before the listing so a change during it cannot be hidden.
    const names = (await readdir(directory)).filter(
      (name) => this.knownSegments.has(name) || segmentName.test(name),
    );
    const present = new Set(names);
    let removed = false;
    for (const name of this.knownSegments.keys())
      if (!present.has(name)) {
        this.knownSegments.delete(name);
        removed = true;
      }
    const unseen = names.filter((name) => !this.knownSegments.has(name)).sort();
    for (let index = 0; index < unseen.length; index += statBatchSize)
      await Promise.all(
        unseen.slice(index, index + statBatchSize).map(async (file) => {
          try {
            const info = await stat(join(directory, file));
            this.knownSegments.set(file, { file, size: info.size, mtimeMs: info.mtimeMs });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }),
      );
    this.listing = { stamp, startedAtMs };
    const added = unseen.flatMap((file) => this.knownSegments.get(file) ?? []);
    const last = this.latestEntries.at(-1);
    const consistent = this.latestEntries.length + added.length === this.knownSegments.size;
    if (!removed && added.length === 0 && consistent) return this.latestEntries;
    // Anything inconsistent with what has been seen is rebuilt from it, never patched.
    this.latestEntries =
      !removed && consistent && (last === undefined || added[0]!.file > last.file)
        ? [...this.latestEntries, ...added]
        : [...this.knownSegments.values()].sort((a, b) => (a.file < b.file ? -1 : 1));
    return this.latestEntries;
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
      const event = decodeEventRecord(input);
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

  private async scanUncoalesced(entries: readonly FileStat[]): Promise<JournalSnapshot> {
    const directory = join(this.root, 'events');
    const warm = this.cached;
    if (warm !== undefined && sameEntries(warm.entries, entries)) return warm;
    // Segments are immutable, so when the cached segments are an unchanged
    // prefix of the listing only the segments after it need reading. A foreign
    // append then costs one segment, not a re-parse of the whole history.
    const prefix = warm;
    const reuse =
      prefix !== undefined &&
      prefix.entries.length <= entries.length &&
      sameEntries(prefix.entries, entries.slice(0, prefix.entries.length));
    const events: EventEnvelope[] = reuse ? [...prefix.events] : [];
    const segments: SegmentInfo[] = reuse ? [...prefix.segments] : [];
    for (const entry of reuse ? entries.slice(prefix.entries.length) : entries) {
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
          const event = decodeEventRecord(input);
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
    const snapshot = { entries, events, eventsByStream: indexEventsByStream(events), segments };
    this.adopt(snapshot);
    return snapshot;
  }
}

interface JournalSnapshot {
  readonly entries: readonly FileStat[];
  readonly events: EventEnvelope[];
  readonly eventsByStream: ReadonlyMap<string, readonly EventEnvelope[]>;
  readonly segments: readonly SegmentInfo[];
}

interface DirectoryStamp {
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

const segmentName = /^\d{4}-\d{2}-\d{2}(?:~\d{20})?\.jsonl$/;

function sameStamp(a: DirectoryStamp, b: DirectoryStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
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
    a === b ||
    (a.length === b.length &&
      a.every((entry, index) => {
        const other = b[index]!;
        return (
          entry.file === other.file && entry.size === other.size && entry.mtimeMs === other.mtimeMs
        );
      }))
  );
}

const key = (stream: StreamRef) => `${stream.kind}:${stream.id}`;

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

function validateEnvelope(event: EventEnvelope, expectedPosition: number): void {
  if (event.globalPosition !== expectedPosition) throw new Error('Invalid event envelope position');
}

function eventContext(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('eventId' in input)) return '';
  const eventId = input.eventId;
  return typeof eventId === 'string' && eventId.length > 0 ? ` event ${eventId}` : '';
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

async function writeSegmentAtomically(path: string, contents: string): Promise<void> {
  await writeFileAtomically(path, contents);
}

const staleSegmentTempName =
  /^\d{4}-\d{2}-\d{2}(?:~\d{20})?\.jsonl\.\d+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

async function reclaimStaleSegmentTemps(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && staleSegmentTempName.test(entry.name))
      .map((entry) => rm(join(directory, entry.name), { force: true }).catch(() => undefined)),
  );
}
