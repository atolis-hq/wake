import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createUiServer } from '../../src/adapters/http/ui-server.js';
import { readJsonFile } from '../../src/lib/json-file.js';

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
    expect(html).toContain('0.1.0-dev');
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
