import type * as FsPromises from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEventData, type EntityRef } from '../../src/kernel/index.js';
import { FileEventJournal, FileProjectionStore } from '../../src/persistence/index.js';
import { FakeClock } from '../e2e/support/world.js';

// journal-full-scan-boundaries.test.ts exempts src/persistence/** from the
// readAll(0) syntax rule on the strength of a specific claim: the journal
// and projection stores "already gate full rescans behind a last-seen-
// position check", so a resident loop only pays the full-history cost when
// the journal has actually moved. That claim is about runtime behavior, not
// call-site syntax, so no ESLint rule can verify it — only exercising the
// real implementation can. This is that verification: appending or writing
// must never force the *next* read to re-derive history the process itself
// already produced. (The August 2026 concurrent-runs OOM crash traced back
// to exactly this gap: FileEventJournal.appendToStream() and
// FileProjectionStore.write() each invalidated their whole cache on every
// self-caused write, so any active tick re-parsed the entire on-disk
// history on its very next read.)
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  readFileMock.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileMock };
});

describe('persistence write-path cache incrementality', () => {
  it('FileEventJournal.appendToStream() does not force the next read to re-parse prior history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-architecture-journal-'));
    const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
    const draft = (id: string, sequence: number) =>
      createEventData({
        eventId: id,
        eventType: 'work.item-created',
        occurredAt: '2026-07-30T12:00:00Z',
        correlationId: 'corr',
        causationId: id,
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        payload: { objective: `event ${sequence}` },
      });
    const journal = new FileEventJournal(root, new FakeClock());
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await journal.appendToStream(stream, sequence - 1, [draft(`event-${sequence}`, sequence)]);
    }
    await journal.readAll(0);

    readFileMock.mockClear();
    await journal.appendToStream(stream, 5, [draft('event-6', 6)]);
    await journal.readAll(0);
    await journal.latestGlobalPosition();
    const journalFileReads = readFileMock.mock.calls.filter(([path]) =>
      String(path).endsWith('.jsonl'),
    );
    expect(journalFileReads).toHaveLength(0);
  });

  it('FileProjectionStore.write() does not force the next list() to re-read the namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-architecture-projections-'));
    const store = new FileProjectionStore(root);
    for (let index = 1; index <= 5; index += 1) {
      await store.write({
        namespace: 'work',
        key: `work:${index}`,
        lastGlobalPosition: index,
        value: { n: index },
      });
    }
    await store.list('work');

    readFileMock.mockClear();
    await store.write({ namespace: 'work', key: 'work:6', lastGlobalPosition: 6, value: { n: 6 } });
    const entries = await store.list('work');
    expect(entries).toHaveLength(6);
    expect(readFileMock).not.toHaveBeenCalled();
  });
});
