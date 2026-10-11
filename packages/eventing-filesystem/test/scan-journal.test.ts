import { createEventData, scanJournal } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FakeClock } from './support/fake-clock.js';

const stream = { kind: 'test', id: 'scan' };
const draft = (index: number) =>
  createEventData({
    eventId: `event-${index}`,
    eventType: 'test.scanned',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: 'cause',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: { objective: 'Unicode é 🌅' },
  });

it('streams a cold journal snapshot without calling full-history reads or including concurrent appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-stream-snapshot-'));
  try {
    const writer = new FileEventJournal(root, new FakeClock());
    await writer.appendToStream(
      stream,
      0,
      Array.from({ length: 150 }, (_, index) => draft(index)),
    );
    const reader = new FileEventJournal(root, new FakeClock());
    const readAll = vi.spyOn(reader, 'readAll');
    const latest = vi.spyOn(reader, 'latestGlobalPosition');
    let seen = 0;
    for await (const event of scanJournal(reader)) {
      seen++;
      if (event.globalPosition === 1) await writer.appendToStream(stream, 150, [draft(151)]);
      expect(event.event.payload).toEqual({ objective: 'Unicode é 🌅' });
    }
    expect(seen).toBe(150);
    expect(readAll).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('stops a cold scan when aborted and reports incomplete trailing records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-stream-abort-'));
  try {
    const writer = new FileEventJournal(root, new FakeClock());
    await writer.appendToStream(
      stream,
      0,
      Array.from({ length: 200 }, (_, index) => draft(index)),
    );
    const controller = new AbortController();
    let seen = 0;
    const scan = async () => {
      for await (const _event of scanJournal(
        new FileEventJournal(root, new FakeClock()),
        controller.signal,
      )) {
        seen++;
        controller.abort();
      }
    };
    await expect(scan()).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toBe(1);
    const file = (await readdir(join(root, 'events'))).find((file) => file.endsWith('.jsonl'))!;
    const segment = join(root, 'events', file);
    await appendFile(segment, '{');
    const collect = async () => {
      for await (const _event of scanJournal(new FileEventJournal(root, new FakeClock()))) {
        /* consume */
      }
    };
    await expect(collect()).rejects.toThrow('Incomplete trailing line');
    const raw = await readFile(segment, 'utf8');
    await writeFile(segment, raw.slice(0, -1).replace(/\n/g, '\r\n'));
    let lines = 0;
    for await (const _event of scanJournal(new FileEventJournal(root, new FakeClock()))) lines++;
    expect(lines).toBe(200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
