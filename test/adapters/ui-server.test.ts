import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createUiServer } from '../../src/adapters/http/ui-server.js';
import { readJsonFile } from '../../src/lib/json-file.js';
import { wakeVersion } from '../../src/version.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createWakePaths } from '../../src/lib/paths.js';

function workId(issueNumber: number): string {
  return `work-01JZ${String(issueNumber).padStart(22, '0')}`;
}

type StateStore = ReturnType<typeof createStateStore>;

describe('ui-server', () => {
  let root: string;
  let store: StateStore;
  let server: ReturnType<typeof createUiServer>;
  let baseUrl: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-ui-server-'));
    store = createStateStore({ wakeRoot: root });
    await store.ensureWakeRoot();
    const config = createDefaultWakeConfig(root);

    server = createUiServer({
      stateStore: store,
      resourceIndex: createFakeResourceIndex(),
      config,
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it('serves the static index page at /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Wake control plane');
    expect(html).toContain(wakeVersion);
    expect(html).toContain('data-view="analytics"');
    expect(html).toContain('/metrics?window=');
    expect(html).toContain('&metric=');
    expect(html).toContain('AbortController');
    expect(html).toContain('Loading...');
  });

  it('serves status and board JSON under /api/v1', async () => {
    const status = await fetch(`${baseUrl}/api/v1/status`);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { loopState: string };
    expect(statusBody.loopState).toBe('idle');

    const board = await fetch(`${baseUrl}/api/v1/board`);
    expect(board.status).toBe(200);
    expect(await board.json()).toEqual([]);
  });

  it('serves selected analytics metrics under /api/v1/metrics', async () => {
    await store.writeRunRecord({
      schemaVersion: 1,
      runId: 'run-metrics',
      workItemKey: workId(91),
      repo: 'atolis-hq/wake',
      issueNumber: 91,
      action: 'implement',
      status: 'completed',
      startedAt: '2026-07-25T10:00:00.000Z',
      finishedAt: '2026-07-25T10:01:00.000Z',
      tokenUsage: { inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
    });

    const res = await fetch(`${baseUrl}/api/v1/metrics?window=1d&metric=tokens-over-time`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: string;
      metric: string;
      summary: { totalRuns: number; totalTokens: number };
      detail: { kind: string; rows: Array<{ tokens: number }> };
    };
    expect(body.window).toBe('1d');
    expect(body.metric).toBe('tokens-over-time');
    expect(body.summary.totalRuns).toBe(1);
    expect(body.summary.totalTokens).toBe(15);
    expect(body.detail.kind).toBe('tokens-over-time');
  });

  it('404s unknown api routes and rejects non-GET mutation attempts', async () => {
    const unknown = await fetch(`${baseUrl}/api/v1/nope`);
    expect(unknown.status).toBe(404);

    const post = await fetch(`${baseUrl}/api/v1/pause`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('records a force-tick request through the mutation endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tick`, { method: 'POST' });
    expect(res.status).toBe(202);

    const body = (await res.json()) as { requestId: string; requestedAt: string };
    expect(body.requestId).toMatch(/[0-9a-f-]{36}/i);
    expect(body.requestedAt).toBeTruthy();

    await expect(readJsonFile(store.paths.tickRequestFile)).resolves.toMatchObject({
      requestId: body.requestId,
      requestedBy: 'ui',
    });
  });

  it('clears a runner quota-pause via POST /runners/:name/unpause', async () => {
    await store.writeLedger({
      schemaVersion: 1,
      runners: {
        'fake-primary': {
          pausedUntil: '2099-01-01T00:00:00.000Z',
          pausedUntilSource: 'reported',
          failureCount: 3,
          lastFailureAt: '2026-07-24T10:00:00.000Z',
        },
      },
    });

    const res = await fetch(`${baseUrl}/api/v1/runners/fake-primary/unpause`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runnerName: string; unpaused: boolean };
    expect(body).toMatchObject({ runnerName: 'fake-primary', unpaused: true });

    const ledger = await store.readLedger();
    expect(ledger?.runners['fake-primary']).toMatchObject({ failureCount: 0 });
    expect(ledger?.runners['fake-primary']?.pausedUntil).toBeUndefined();
  });

  it('returns 200 for unpause of a runner not in the ledger (idempotent)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runners/nonexistent/unpause`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runnerName: string; unpaused: boolean };
    expect(body).toMatchObject({ runnerName: 'nonexistent', unpaused: true });
  });

  it('serves transcripts by work item key', async () => {
    const config = createDefaultWakeConfig(root);
    config.transcripts.enabled = true;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    server = createUiServer({
      stateStore: store,
      resourceIndex: createFakeResourceIndex(),
      config,
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const key = workId(42);
    await store.writeRunRecord({
      schemaVersion: 1,
      runId: 'run-42',
      workItemKey: key,
      repo: 'atolis-hq/wake',
      issueNumber: 42,
      action: 'implement',
      status: 'completed',
      startedAt: '2026-07-05T12:00:00.000Z',
    });
    const sessionDir = createWakePaths(root).transcriptSessionDir(key, 'run-42');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'run-42.codex.implement.prompt.txt'), 'prompt text');

    const res = await fetch(`${baseUrl}/api/v1/work-items/${key}/transcripts`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      sessions: Array<{ entries: Array<{ runId: string; role: string; text: string }> }>;
    };
    expect(body.enabled).toBe(true);
    expect(body.sessions[0]?.entries[0]).toMatchObject({
      runId: 'run-42',
      role: 'user',
      text: 'prompt text',
    });
  });
});

describe('ui-server retry endpoint', () => {
  let root: string;
  let store: StateStore;
  let server: ReturnType<typeof createUiServer>;
  let baseUrl: string;
  let resourceIndex: ReturnType<typeof createFakeResourceIndex>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-ui-retry-'));
    store = createStateStore({ wakeRoot: root });
    await store.ensureWakeRoot();
    const config = createDefaultWakeConfig(root);
    resourceIndex = createFakeResourceIndex();

    server = createUiServer({ stateStore: store, resourceIndex, config });
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  async function seedFailedItem(issueNumber: number): Promise<string> {
    const key = workId(issueNumber);
    const updater = createProjectionUpdater({ stateStore: store, resourceIndex });
    await updater.rebuildFromEvents([
      createEventEnvelope({
        eventId: `issue-${issueNumber}`,
        workItemKey: key,
        streamScope: 'global-intake',
        direction: 'inbound',
        sourceSystem: 'github',
        sourceEventType: 'ticket.upsert',
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber,
          sourceUrl: `https://example.test/issues/${issueNumber}`,
        },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'immediate',
        payload: {
          ticket: {
            repo: 'atolis-hq/wake',
            number: issueNumber,
            title: 'Test',
            body: 'body',
            labels: ['wake:implement'],
            assignees: [],
            isPullRequest: false,
            state: 'open',
            url: `https://example.test/issues/${issueNumber}`,
            createdAt: '2026-07-05T12:00:00.000Z',
            updatedAt: '2026-07-05T12:00:00.000Z',
          },
        },
      }),
      createEventEnvelope({
        eventId: `run-${issueNumber}-completed`,
        workItemKey: key,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: 'wake.run.completed',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber, runId: `run-${issueNumber}` },
        occurredAt: '2026-07-05T12:01:00.000Z',
        ingestedAt: '2026-07-05T12:01:00.000Z',
        trigger: 'immediate',
        payload: {
          action: 'implement',
          sentinel: 'FAILED',
          runId: `run-${issueNumber}`,
          failureClass: 'task',
          reason: 'runner:failed',
          body: 'something went wrong',
        },
      }),
    ]);
    return key;
  }

  it('returns 404 for an unknown work item key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/work-items/work-UNKNOWNKEY/retry`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 when last run is not failed', async () => {
    const key = workId(55);
    const updater = createProjectionUpdater({ stateStore: store, resourceIndex });
    await updater.rebuildFromEvents([
      createEventEnvelope({
        eventId: 'issue-55',
        workItemKey: key,
        streamScope: 'global-intake',
        direction: 'inbound',
        sourceSystem: 'github',
        sourceEventType: 'ticket.upsert',
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 55,
          sourceUrl: 'https://example.test/issues/55',
        },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'immediate',
        payload: {
          ticket: {
            repo: 'atolis-hq/wake',
            number: 55,
            title: 'Test',
            body: 'body',
            labels: ['wake:implement'],
            assignees: [],
            isPullRequest: false,
            state: 'open',
            url: 'https://example.test/issues/55',
            createdAt: '2026-07-05T12:00:00.000Z',
            updatedAt: '2026-07-05T12:00:00.000Z',
          },
        },
      }),
    ]);
    const res = await fetch(`${baseUrl}/api/v1/work-items/${key}/retry`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('clears failed state and writes a tick request on success', async () => {
    const key = await seedFailedItem(77);
    const itemBefore = await store.readIssueState(key);
    expect((itemBefore?.context as Record<string, unknown>).lastRunSentinel).toBe('FAILED');

    const res = await fetch(`${baseUrl}/api/v1/work-items/${key}/retry`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { workItemKey: string; retryEventId: string };
    expect(body.workItemKey).toBe(key);
    expect(body.retryEventId).toMatch(/^retry-/);

    const itemAfter = await store.readIssueState(key);
    const ctx = itemAfter?.context as Record<string, unknown>;
    expect(ctx.lastRunSentinel).toBeUndefined();
    expect(ctx.lastFailureClass).toBeUndefined();
    expect(ctx.blockedFromStage).toBeUndefined();

    await expect(readJsonFile(store.paths.tickRequestFile)).resolves.toMatchObject({
      requestedBy: 'ui:retry',
    });
  });
});

describe('ui-server token gating', () => {
  let root: string;
  let server: ReturnType<typeof createUiServer>;
  let baseUrl: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-ui-server-token-'));
    const stateStore = createStateStore({ wakeRoot: root });
    await stateStore.ensureWakeRoot();
    const config = createDefaultWakeConfig(root);

    server = createUiServer({
      stateStore,
      resourceIndex: createFakeResourceIndex(),
      config,
      token: 'expected-token',
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it('rejects requests without a valid bearer token even from a loopback client', async () => {
    // A connection that looks loopback to the server (e.g. from the same
    // container over docker's published port) must still be gated once a
    // token is configured — the bind address, not the client's address, is
    // what makes the token mandatory. See ui-server.ts for the rationale.
    const noAuth = await fetch(`${baseUrl}/api/v1/status`);
    expect(noAuth.status).toBe(401);

    const wrongAuth = await fetch(`${baseUrl}/api/v1/status`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(wrongAuth.status).toBe(401);
  });

  it('accepts requests with the matching bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/v1/status`, {
      headers: { authorization: 'Bearer expected-token' },
    });
    expect(res.status).toBe(200);
  });
});
