import type { EventJournal } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { InMemoryEventJournal, InMemoryProjectionStore } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { createSurfaceApiApplications } from '../../../src/bootstrap/surface-api-applications.js';
import { createApiDispatcher, createSurfaceHttpServer } from '../../../src/surfaces/index.js';
import { WorkEventType, workItemStream } from '../../../src/work/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

const now = '2026-08-01T12:30:00.000Z';

function fixture(journal: EventJournal = new InMemoryEventJournal({ now: () => new Date(now) })) {
  const root = {
    journal,
    projections: new InMemoryProjectionStore(),
  } as unknown as CompositionRoot;
  const dispatcher = createApiDispatcher(createSurfaceApiApplications(root, () => now));
  return { journal, dispatcher };
}

it('composes the registered report and independent summary, validates identifiers and preserves metrics', async () => {
  const { dispatcher } = fixture();
  expect(
    await dispatcher.dispatch('GET', '/api/v1/observability/reports', undefined),
  ).toMatchObject({
    status: 200,
    body: {
      data: [
        { id: 'run-outcomes-over-time' },
        { id: 'run-breakdowns-by-dimension' },
        { id: 'token-and-cost-usage' },
        { id: 'work-item-throughput' },
        { id: 'run-duration' },
      ],
    },
  });
  expect(
    await dispatcher.dispatch(
      'GET',
      '/api/v1/observability/reports?window=1d&report=run-outcomes-over-time',
      undefined,
    ),
  ).toMatchObject({ status: 200, body: { data: { buckets: expect.any(Array) } } });
  expect(
    await dispatcher.dispatch('GET', '/api/v1/observability/summary?window=1d', undefined),
  ).toMatchObject({
    status: 200,
    body: { data: { runs: 0, workItemsDone: 0, medianRunDurationMs: null } },
  });
  for (const query of [
    'window=2d',
    'window=1d&report=unknown',
    'window=1d&window=3d',
    'window=1d&extra=1',
  ]) {
    expect(
      await dispatcher.dispatch('GET', `/api/v1/observability/reports?${query}`, undefined),
    ).toMatchObject({ status: 422, body: { code: 'invalid-query' } });
  }
  expect(
    await dispatcher.dispatch('GET', '/api/v1/observability/metrics?days=1', undefined),
  ).toMatchObject({
    status: 200,
    body: { data: { values: { events: 0, runs: 0, workItems: 0 } } },
  });
});

it('serves another HTTP request during a cold filesystem scan and stops when the client disconnects', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-analytics-http-'));
  const clock = { now: () => new Date(now) };
  const writer = new FileEventJournal(home, clock);
  const stream = workItemStream(workId('large'));
  await writer.appendToStream(
    stream,
    0,
    Array.from(
      { length: 20_000 },
      (_, index) =>
        eventEnvelope(
          WorkEventType.ObjectiveRevised,
          { objective: 'Large scan' },
          stream,
          index + 1,
        ).event,
    ),
  );
  const reader = new FileEventJournal(home, clock);
  const { dispatcher } = fixture(reader);
  const original = reader.scanAll.bind(reader);
  let seen = 0,
    finished = false;
  const scans = vi.spyOn(reader, 'scanAll').mockImplementation(async function* (signal) {
    try {
      for await (const event of original(signal)) {
        seen++;
        yield event;
      }
    } finally {
      finished = true;
    }
  });
  const app = createSurfaceHttpServer({
    dispatcher,
    credentials: {
      accessKey: 'test',
      sessionPassword: Buffer.alloc(32).toString('base64url'),
      createdAt: now,
    },
    auth: { disabled: true, redeemGrant: async () => false },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const analytics = request(
    `${address}/api/v1/observability/reports?window=1d&report=run-outcomes-over-time`,
  );
  analytics.on('error', () => {});
  analytics.end();
  try {
    await vi.waitFor(() => expect(seen).toBeGreaterThan(0));
    const response = await fetch(`${address}/api/v1/status`);
    expect(response.status).toBe(200);
    expect(seen).toBeLessThan(20_000);
    expect(finished).toBe(false);
    analytics.destroy();
    await vi.waitFor(() => expect(finished).toBe(true));
    const stopped = seen;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toBe(stopped);
    expect(scans.mock.calls[0]?.[0]?.aborted).toBe(true);
  } finally {
    analytics.destroy();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20_000);

it('serves the registered live breakdown through the API', async () => {
  const { dispatcher } = fixture();
  expect(
    await dispatcher.dispatch(
      'GET',
      '/api/v1/observability/reports?window=1d&report=run-breakdowns-by-dimension',
      undefined,
    ),
  ).toMatchObject({
    status: 200,
    body: {
      data: {
        total: 0,
        dimensions: [
          { id: 'run-action', rows: [] },
          { id: 'run-stage', rows: [] },
          { id: 'run-runner', rows: [] },
          { id: 'run-model', rows: [] },
        ],
      },
    },
  });
});

it('serves the registered usage report with zero buckets and explicit units', async () => {
  const { dispatcher } = fixture();
  expect(
    await dispatcher.dispatch(
      'GET',
      '/api/v1/observability/reports?window=3d&report=token-and-cost-usage',
      undefined,
    ),
  ).toMatchObject({
    status: 200,
    body: {
      data: {
        window: { id: '3d' },
        series: [
          { id: 'total-tokens', unit: 'tokens' },
          { id: 'total-cost-usd', unit: 'USD' },
        ],
        totals: { 'total-tokens': 0, 'total-cost-usd': 0 },
        buckets: expect.arrayContaining([
          {
            from: expect.any(String),
            to: expect.any(String),
            values: { 'total-tokens': 0, 'total-cost-usd': 0 },
          },
        ]),
      },
    },
  });
});

it('serves registered throughput with empty duration rows and completion buckets', async () => {
  const { dispatcher } = fixture();
  expect(
    await dispatcher.dispatch(
      'GET',
      '/api/v1/observability/reports?window=1d&report=work-item-throughput',
      undefined,
    ),
  ).toMatchObject({
    status: 200,
    body: {
      data: {
        report: { id: 'work-item-throughput' },
        totals: { 'work-items-done': 0 },
        durationRows: [],
        excludedDurationCount: 0,
        buckets: expect.any(Array),
      },
    },
  });
});

it('serves the registered duration report with unavailable empty statistics', async () => {
  const { dispatcher } = fixture();
  expect(
    await dispatcher.dispatch(
      'GET',
      '/api/v1/observability/reports?window=1d&report=run-duration',
      undefined,
    ),
  ).toMatchObject({
    status: 200,
    body: {
      data: {
        statistics: { count: 0, medianMs: null, averageMs: null },
        groups: [{ id: 'run-action' }, { id: 'run-stage' }],
        buckets: expect.any(Array),
      },
    },
  });
});
