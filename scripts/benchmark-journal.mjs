import { createEventData } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Run after npm run build. Recovery and fixture creation are reported separately
// from steady-state operations; every fixture uses one immutable file per event.
const execute = promisify(execFile);
const clock = { now: () => new Date('2026-07-30T12:00:00.000Z') };
const fixed = { kind: 'test', id: 'detail' };
const samples = 40;
const threshold = Number(process.env.JOURNAL_BENCHMARK_RATIO ?? 1.5);
const sizes = [100_000, 500_000];
const roots = [];
const fixtureRoot = process.env.JOURNAL_BENCHMARK_ROOT;
const runId = String(Date.now());
const results = [];

function summary(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    p50: ordered[Math.floor(ordered.length * 0.5)],
    p95: ordered[Math.floor(ordered.length * 0.95)],
  };
}

async function measure(operation) {
  for (let index = 0; index < 5; index++) await operation();
  const values = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    await operation();
    values.push(performance.now() - start);
  }
  return summary(values);
}

async function seed(root, count) {
  const directory = join(root, 'events');
  await mkdir(directory, { recursive: true });
  const existing = new Set(await readdir(directory));
  const payload = { text: 'x'.repeat(4096) };
  for (let first = 1; first <= count; first += 128) {
    await Promise.all(
      Array.from({ length: Math.min(128, count - first + 1) }, async (_, offset) => {
        const position = first + offset;
        const detail = position <= 100;
        const record = {
          eventId: `seed-${position}`,
          eventType: 'test.created',
          schemaVersion: 1,
          occurredAt: clock.now().toISOString(),
          recordedAt: clock.now().toISOString(),
          correlationId: 'benchmark',
          causationId: `seed-${position}`,
          actor: { kind: 'system', id: 'benchmark' },
          source: { kind: 'internal', id: 'benchmark' },
          stream: detail ? fixed : { kind: 'test', id: `background-${position % 40}` },
          payload,
          sequence: detail ? position : Math.floor((position - 101) / 40) + 1,
          globalPosition: position,
        };
        const file =
          position === 1
            ? '2026-07-30.jsonl'
            : `2026-07-30~${String(position).padStart(20, '0')}.jsonl`;
        if (existing.has(file)) return;
        await writeFile(join(directory, file), `${JSON.stringify(record)}\n`);
      }),
    );
  }
}

try {
  for (const size of sizes) {
    const root = fixtureRoot
      ? join(fixtureRoot, String(size))
      : await mkdtemp(join(tmpdir(), 'wake-journal-benchmark-'));
    await mkdir(root, { recursive: true });
    roots.push(root);
    console.log(`Seeding ${size} one-event segments (4 KiB payloads)`);
    await seed(root, size);
    const journal = new FileEventJournal(root, clock);
    const recoveryStart = performance.now();
    await journal.latestGlobalPosition();
    const recoveryMs = performance.now() - recoveryStart;
    const baselineHead = await journal.latestGlobalPosition();
    console.log(`Recovery at ${size}: ${recoveryMs.toFixed(1)} ms`);
    let sequence = 0;
    const draft = createEventData({
      eventId: 'append',
      eventType: 'test.created',
      occurredAt: clock.now().toISOString(),
      correlationId: 'benchmark',
      causationId: 'append',
      actor: { kind: 'system', id: 'benchmark' },
      source: { kind: 'internal', id: 'benchmark' },
      payload: { value: 1 },
    });
    const operations = {
      append: () =>
        journal.appendToStream({ kind: 'test', id: `append-${runId}` }, sequence++, [draft]),
      head: () => journal.latestGlobalPosition(),
      latest100: () => journal.readLatest(undefined, 100),
      afterHead100: () => journal.readAll(baselineHead - 100, 100),
      detail100: () => journal.readStream(fixed),
      idleHead: () => journal.latestGlobalPosition(),
      coldFirstRead: async () => {
        const code = `
          import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
          const start = performance.now();
          const journal = new FileEventJournal(${JSON.stringify(root)}, { now: () => new Date() });
          if ((await journal.readStream({ kind: 'test', id: 'detail' })).length !== 100) throw new Error('Invalid detail');
          console.log(performance.now() - start);
        `;
        const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', code]);
        return Number(stdout.trim());
      },
    };
    const measurements = {};
    for (const [name, operation] of Object.entries(operations)) {
      if (name === 'coldFirstRead') {
        const values = [];
        for (let index = 0; index < samples; index++) values.push(await operation());
        measurements[name] = summary(values);
      } else measurements[name] = await measure(operation);
    }
    results.push({ size, recoveryMs, measurements });
    console.log(JSON.stringify(results.at(-1)));
  }
  const ratios = Object.fromEntries(
    Object.keys(results[0].measurements).map((name) => [
      name,
      {
        p50: results[1].measurements[name].p50 / results[0].measurements[name].p50,
        p95: results[1].measurements[name].p95 / results[0].measurements[name].p95,
      },
    ]),
  );
  console.log(JSON.stringify({ units: 'milliseconds', threshold, results, ratios }, null, 2));
  if (Object.values(ratios).some(({ p50, p95 }) => p50 > threshold || p95 > threshold))
    process.exitCode = 1;
} finally {
  if (!fixtureRoot) for (const root of roots) await rm(root, { recursive: true, force: true });
}
