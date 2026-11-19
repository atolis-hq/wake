import { createEventData } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { createBenchmarkDetailApplication } from '../../../scripts/benchmark-journal-detail.js';

it('uses the composed indexed detail feed with cross-stream OR matches, deduplication, and cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-detail-events-'));
  try {
    const journal = new FileEventJournal(root, { now: () => new Date('2026-07-30T12:00:00Z') });
    const draft = (id: string, payload: unknown) =>
      createEventData({
        eventId: id,
        eventType: 'test.created',
        occurredAt: '2026-07-30T12:00:00Z',
        correlationId: 'test',
        causationId: id,
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        payload,
      });
    await journal.appendToStream({ kind: 'work', id: 'work-00000000000000000000000001' }, 0, [
      draft('both', { workItemId: 'work-00000000000000000000000001' }),
    ]);
    await journal.appendToStream({ kind: 'run', id: 'another' }, 0, [
      draft('payload', { workItemId: 'work-00000000000000000000000001' }),
    ]);
    await journal.appendToStream({ kind: 'resource', id: 'work-00000000000000000000000001' }, 0, [
      draft('stream', {}),
    ]);
    await journal.appendToStream(
      { kind: 'test', id: 'unrelated' },
      0,
      Array.from({ length: 250 }, (_, index) => draft(`other-${index}`, { workItemId: 'other' })),
    );
    const global = vi.spyOn(journal, 'readLatest');
    const indexed = vi.spyOn(journal, 'readLatestMatching');
    const composed = await createBenchmarkDetailApplication(root, journal);
    expect((await composed()).items.map((event) => event.position)).toEqual([3, 2, 1]);
    expect(indexed).toHaveBeenCalledOnce();
    expect(global).not.toHaveBeenCalled();
    const first = await composed({ limit: 1 });
    const second = await composed({ limit: 1, cursor: { position: first.nextPosition! } });
    expect(first.items.map((event) => event.position)).toEqual([3]);
    expect(first.meta.position).toBe(3);
    expect(second.items.map((event) => event.position)).toEqual([2]);
    const index = new DatabaseSync(join(root, 'journal-index.sqlite'));
    index.exec("DELETE FROM payload_strings WHERE field = 'workItemId' AND position = 2");
    index.close();
    expect((await composed()).items.map((event) => event.position)).toEqual([3, 2, 1]);
    const corrupt = new DatabaseSync(join(root, 'journal-index.sqlite'));
    corrupt.exec(`
      UPDATE payload_strings SET value = (SELECT value FROM payload_strings WHERE field = 'workItemId' AND position = 2) WHERE field = 'workItemId' AND position = 4;
      UPDATE integrity_counts SET attributes = (SELECT attributes FROM head WHERE id = 1) WHERE id = 1;
    `);
    corrupt.close();
    expect((await composed()).items.map((event) => event.position)).toEqual([3, 2, 1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
