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
import { watch } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { scheduler } from 'node:timers/promises';
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
  /** Diagnostic readers never create locks, indexes, or recovery files. */
  readonly readOnly?: boolean;
}

const createFileSystemWatcher: FileEventJournalWatcherFactory = async (directory, notify) =>
  watch(directory, { persistent: false }, notify);

// The JSONL files are authoritative. SQLite contains only rebuildable byte
// locations; its B-trees bound page reads/writes without a growing JS manifest.
export class FileEventJournal implements EventJournal {
  constructor(
    private readonly root: string,
    private readonly clock: EventingClock,
    private readonly options: FileEventJournalOptions = {},
  ) {}

  private readonly changeSignalSource = new InProcessJournalChangeSignal();
  private changeWatcher: FileEventJournalWatcher | undefined;
  private startingChangeWatcher: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly envelopeCache = new Map<string, EventEnvelope>();

  get changeSignal(): JournalChangeSignal {
    return this.changeSignalSource;
  }

  private get indexPath(): string {
    return join(this.root, 'journal-index.sqlite');
  }

  private get dirtyPath(): string {
    return join(this.root, 'journal-index.dirty');
  }

  // Serialise local writes and recovery before competing for the process lock.
  private serialised<T>(operation: (db: DatabaseSync) => Promise<T>): Promise<T> {
    if (this.options.readOnly) return this.readOnlyIndex(operation);
    const run = this.queue
      .catch(() => undefined)
      .then(() =>
        withFileLock(
          join(this.root, 'locks', 'event-journal.lock'),
          async () => {
            await mkdir(join(this.root, 'events'), { recursive: true });
            let db: DatabaseSync;
            try {
              db = this.openIndex();
            } catch {
              await rm(this.indexPath, { force: true });
              db = this.openIndex();
            }
            try {
              let valid = false;
              try {
                const head = db.prepare('SELECT stamp, position FROM head WHERE id = 1').get();
                valid =
                  head?.stamp === (await this.directoryStamp()) && head?.position === this.head(db);
              } catch {
                db.close();
                await rm(this.indexPath, { force: true });
                db = this.openIndex();
              }
              if (!valid || (await exists(this.dirtyPath))) await this.rebuild(db);
              return await operation(db);
            } finally {
              db.close();
            }
          },
          { waitMs: 30_000, retryIntervalMs: 10 },
        ),
      );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readOnlyIndex<T>(operation: (db: DatabaseSync) => Promise<T>): Promise<T> {
    let db: DatabaseSync | undefined;
    let ready = false;
    try {
      const stamp = await this.directoryStamp();
      const dirty = await exists(this.dirtyPath);
      db = this.openIndex(this.indexPath, true);
      db.exec('BEGIN');
      const head = db.prepare('SELECT stamp, position FROM head WHERE id = 1').get();
      if (head?.stamp !== stamp || head?.position !== this.head(db) || dirty)
        throw new Error('Journal index requires recovery');
      ready = true;
      return await operation(db);
    } catch {
      db?.close();
      db = undefined;
      if (!this.options.readOnly)
        return this.serialised(async (index) => {
          if (ready) await this.rebuild(index);
          return operation(index);
        });
      // Read-only diagnostics can inspect legacy or damaged indexes without
      // changing runtime state. Their recovery index exists only in memory.
      const memory = this.openIndex(':memory:');
      try {
        await this.rebuild(memory, false);
        return await operation(memory);
      } finally {
        memory.close();
      }
    } finally {
      db?.close();
    }
  }

  private openIndex(path = this.indexPath, readOnly = false): DatabaseSync {
    const db = new DatabaseSync(path, { readOnly });
    try {
      db.exec(`
        PRAGMA cache_size = -2048;
        PRAGMA mmap_size = 0;
        PRAGMA temp_store = MEMORY;
        PRAGMA busy_timeout = 5000;
      `);
      if (!readOnly)
        db.exec(`
        CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY CHECK (id = 1), stamp TEXT NOT NULL, position INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS records (
          position INTEGER PRIMARY KEY,
          stream TEXT NOT NULL, sequence INTEGER NOT NULL,
          file TEXT NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL,
          size INTEGER NOT NULL, mtime REAL NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS stream_sequence ON records (stream, sequence);
      `);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private async directoryStamp(): Promise<string> {
    try {
      const info = await stat(join(this.root, 'events'), { bigint: true });
      return `${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  private head(db: DatabaseSync): number {
    return Number(
      db.prepare('SELECT position FROM records ORDER BY position DESC LIMIT 1').get()?.position ??
        0,
    );
  }

  async appendToStream(
    stream: StreamRef,
    expectedSequence: number,
    drafts: readonly EventData[],
  ): Promise<readonly EventEnvelope[]> {
    if (this.options.readOnly) throw new Error('Read-only journal cannot append');
    if (drafts.length === 0) throw new Error('appendToStream requires at least one event');
    return this.serialised(async (db) => {
      await this.indexedRead(db, 'SELECT * FROM records ORDER BY position DESC LIMIT 1', []);
      const streamTail = await this.indexedRead(
        db,
        'SELECT * FROM records WHERE stream = ? ORDER BY sequence DESC LIMIT 1',
        [key(stream)],
      );
      const sequence = streamTail[0]?.sequence ?? 0;
      if (sequence !== expectedSequence)
        throw new WrongExpectedSequenceError(
          `Expected sequence ${expectedSequence} for ${key(stream)}, actual ${sequence}`,
        );
      const position = this.head(db);
      const recordedAt = this.clock.now().toISOString();
      const events = drafts.map((event, index) =>
        decodeEventEnvelope({
          event,
          stream,
          recordedAt,
          sequence: sequence + index + 1,
          globalPosition: position + index + 1,
        }),
      );
      const day = recordedAt.slice(0, 10);
      const file = (await exists(join(this.root, 'events', `${day}.jsonl`)))
        ? `${day}~${String(position + 1).padStart(20, '0')}.jsonl`
        : `${day}.jsonl`;
      // Persist the recovery intent before publishing the authoritative segment.
      // A crash or failed index write leaves it behind for the next locked call.
      await writeFileAtomically(this.dirtyPath, 'pending');
      const raw = events.map(encodeEventRecord).join('\n') + '\n';
      await writeSegmentAtomically(join(this.root, 'events', file), raw);
      try {
        db.exec('BEGIN');
        await this.indexSegment(db, file, raw, position);
        await this.commitHead(db);
        await rm(this.dirtyPath, { force: true });
      } catch {
        if (db.isTransaction) db.exec('ROLLBACK');
        // An index failure cannot undo a committed JSONL append.
      }
      this.changeSignalSource.notify();
      return events;
    });
  }

  private async commitHead(db: DatabaseSync): Promise<void> {
    db.prepare('INSERT OR REPLACE INTO head VALUES (1, ?, ?)').run(
      await this.directoryStamp(),
      this.head(db),
    );
    db.exec('COMMIT');
  }

  private async rebuild(db: DatabaseSync, persist = true): Promise<void> {
    if (persist) {
      await writeFile(this.dirtyPath, 'rebuilding');
      await reclaimStaleSegmentTemps(join(this.root, 'events'));
    }
    let names: string[];
    try {
      names = await readdir(join(this.root, 'events'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      names = [];
    }
    const files = names.filter((file) => segmentName.test(file));
    // Sort by the first persisted position, rather than clock order. Clock skew
    // never changes global ordering or requires rewriting historical segments.
    const segments: { file: string; position: number }[] = [];
    for (const file of files) {
      const suffix = /~(\d{20})\.jsonl$/.exec(file);
      if (suffix !== null) segments.push({ file, position: Number(suffix[1]) });
      else {
        const raw = await readFile(join(this.root, 'events', file), 'utf8');
        if (raw !== '' && !raw.endsWith('\n'))
          throw new Error(`Incomplete trailing line in ${file}`);
        const first = raw.split('\n', 1)[0];
        let position = 0;
        if (first) {
          try {
            position = decodeEventRecord(JSON.parse(first)).globalPosition;
          } catch {
            decodeLine(file, 1, first, 1);
          }
        }
        segments.push({ file, position });
      }
    }
    segments.sort((a, b) => a.position - b.position || a.file.localeCompare(b.file));
    db.exec('BEGIN; DELETE FROM records; DELETE FROM head;');
    try {
      let position = 0;
      for (const { file } of segments) {
        position = await this.indexSegment(
          db,
          file,
          await readFile(join(this.root, 'events', file), 'utf8'),
          position,
        );
        if (position % 100 === 0) await scheduler.yield();
      }
      await this.commitHead(db);
      if (persist) await rm(this.dirtyPath, { force: true });
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  private async indexSegment(
    db: DatabaseSync,
    file: string,
    raw: string,
    previous: number,
  ): Promise<number> {
    if (raw.length > 0 && !raw.endsWith('\n'))
      throw new Error(`Incomplete trailing line in ${file}`);
    const info = await stat(join(this.root, 'events', file));
    const insert = db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let offset = 0,
      position = previous;
    for (const [lineNumber, line] of raw.split('\n').slice(0, -1).entries()) {
      const event = decodeLine(file, lineNumber + 1, line, ++position);
      const length = Buffer.byteLength(line + '\n');
      insert.run(
        position,
        key(event.stream),
        event.sequence,
        file,
        offset,
        length,
        info.size,
        info.mtimeMs,
      );
      offset += length;
    }
    return position;
  }

  private async indexedRead(
    db: DatabaseSync,
    query: string,
    parameters: SQLInputValue[],
    recover = true,
  ): Promise<EventEnvelope[]> {
    try {
      return await this.readRecords(db, query, parameters);
    } catch (error) {
      if (!recover || this.options.readOnly) throw error;
      await this.rebuild(db);
      return this.readRecords(db, query, parameters);
    }
  }

  private async readRecords(
    db: DatabaseSync,
    query: string,
    parameters: SQLInputValue[],
  ): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];
    const rows = db.prepare(query).all(...parameters);
    // Release SQLite's shared lock before asynchronous segment I/O. Immutable
    // locations preserve this snapshot while another process appends.
    if (db.isTransaction) db.exec('COMMIT');
    for (const row of rows) {
      const { position, stream, sequence, file, offset, length, size, mtime } = row;
      if (
        typeof file !== 'string' ||
        !segmentName.test(file) ||
        typeof position !== 'number' ||
        typeof offset !== 'number' ||
        typeof length !== 'number' ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length <= 0 ||
        typeof size !== 'number' ||
        offset + length > size
      )
        throw new Error('Invalid journal index entry');
      const cacheKey = JSON.stringify([file, offset, length, size, mtime]);
      const cached = this.envelopeCache.get(cacheKey);
      if (cached !== undefined) {
        const info = await stat(join(this.root, 'events', file));
        if (
          info.size !== size ||
          info.mtimeMs !== mtime ||
          cached.globalPosition !== position ||
          key(cached.stream) !== stream ||
          cached.sequence !== sequence
        )
          throw new Error('Stale journal cache entry');
        this.envelopeCache.delete(cacheKey);
        this.envelopeCache.set(cacheKey, cached);
        events.push(cached);
        continue;
      }
      const handle = await open(join(this.root, 'events', file), 'r');
      try {
        const info = await handle.stat();
        if (info.size !== size || info.mtimeMs !== mtime)
          throw new Error('Stale journal index entry');
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length || buffer.at(-1) !== 10)
          throw new Error('Incomplete indexed record');
        const event = decodeLine(file, position, buffer.toString('utf8'), position);
        if (key(event.stream) !== stream || event.sequence !== sequence)
          throw new Error('Indexed stream mismatch');
        this.envelopeCache.set(cacheKey, event);
        if (this.envelopeCache.size > 256)
          this.envelopeCache.delete(this.envelopeCache.keys().next().value!);
        events.push(event);
      } finally {
        await handle.close();
      }
    }
    return events;
  }

  async readStream(stream: StreamRef): Promise<readonly EventEnvelope[]> {
    return this.readOnlyIndex((db) =>
      this.indexedRead(
        db,
        'SELECT * FROM records WHERE stream = ? ORDER BY sequence',
        [key(stream)],
        false,
      ),
    );
  }

  async readAll(
    after: number,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<readonly EventEnvelope[]> {
    if (Number.isNaN(after) || limit <= 0) return [];
    return this.readOnlyIndex((db) =>
      this.indexedRead(
        db,
        'SELECT * FROM records WHERE position > ? ORDER BY position LIMIT ?',
        [Math.max(0, Math.floor(after)), sqlLimit(limit)],
        false,
      ),
    );
  }

  async readLatest(
    before?: number,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<readonly EventEnvelope[]> {
    if ((before !== undefined && before <= 0) || limit <= 0) return [];
    return this.readOnlyIndex((db) =>
      this.indexedRead(
        db,
        'SELECT * FROM records WHERE position < ? ORDER BY position DESC LIMIT ?',
        [before ?? this.head(db) + 1, sqlLimit(limit)],
        false,
      ),
    );
  }

  async latestGlobalPosition(): Promise<number> {
    return this.readOnlyIndex(async (db) => {
      const latest = await this.indexedRead(
        db,
        'SELECT * FROM records ORDER BY position DESC LIMIT 1',
        [],
        false,
      );
      return latest[0]?.globalPosition ?? 0;
    });
  }

  async *scanAll(signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    signal?.throwIfAborted();
    const head = await this.readOnlyIndex(async (db) => this.head(db));
    let after = 0;
    while (after < head) {
      signal?.throwIfAborted();
      const events = await this.readOnlyIndex((db) =>
        this.indexedRead(
          db,
          'SELECT * FROM records WHERE position > ? AND position <= ? ORDER BY position LIMIT 100',
          [after, head],
          false,
        ),
      );
      if (events.length === 0) throw new Error('Journal snapshot has a missing position');
      for (const event of events) {
        signal?.throwIfAborted();
        yield event;
        after = event.globalPosition;
      }
      await yieldScan(signal);
    }
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
    if (this.options.readOnly) return Promise.resolve();
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
}

const segmentName = /^\d{4}-\d{2}-\d{2}(?:~\d{20})?\.jsonl$/;
const key = (stream: StreamRef): string => JSON.stringify([stream.kind, stream.id]);
const sqlLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : -1;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function decodeLine(file: string, line: number, raw: string, position: number): EventEnvelope {
  let input: unknown;
  try {
    input = JSON.parse(raw);
    const event = decodeEventRecord(input);
    if (event.globalPosition !== position) throw new Error('Invalid event envelope position');
    return event;
  } catch (error) {
    const eventId =
      typeof input === 'object' && input !== null && 'eventId' in input
        ? String(input.eventId)
        : '';
    throw new Error(
      `Corrupt event at ${file}:${line} event ${eventId}: ${(error as Error).message}`,
      { cause: error },
    );
  }
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
