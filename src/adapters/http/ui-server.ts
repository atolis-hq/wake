import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { ResourceIndex } from '../../core/contracts.js';
import type { WakeConfig } from '../../domain/types.js';
import type { createStateStore } from '../fs/state-store.js';
import { indexHtml } from './ui-assets.js';
import {
  buildBoard,
  buildConfigView,
  buildEventsFeed,
  buildHealth,
  buildItemDetail,
  buildRuns,
  buildStatus,
  buildWorkspaces,
} from './ui-data.js';

type StateStore = ReturnType<typeof createStateStore>;

export interface UiServerOptions {
  stateStore: StateStore;
  resourceIndex: ResourceIndex;
  config: WakeConfig;
  token?: string;
  now?: () => Date;
}

/**
 * The uri provider segment for the configured ticket source — the same choice
 * main.ts's buildRuntime makes when it names the source it wires in. The UI
 * resolves tickets against the index that source's events registered, so the
 * two must agree.
 */
function ticketProvider(config: WakeConfig): string {
  return config.sources.github.enabled ? 'github' : 'fake-ticketing';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string') {
    const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('wake_ui_token='));
    if (match !== undefined) {
      return match.slice('wake_ui_token='.length);
    }
  }
  return undefined;
}

/**
 * Parses `/items/<repo-with-slashes>/<issueNumber>[/events]` where repo itself
 * may contain a `/` (e.g. `owner/name`), so the split can't assume a fixed arity.
 */
function parseItemPath(segments: string[]): { repo: string; issueNumber: number; suffix?: string } | null {
  const trailingIsEvents = segments.at(-1) === 'events';
  const numberIndex = trailingIsEvents ? segments.length - 2 : segments.length - 1;
  const issueNumberRaw = segments[numberIndex];
  const issueNumber = issueNumberRaw === undefined ? Number.NaN : Number(issueNumberRaw);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || numberIndex < 1) {
    return null;
  }

  const repo = segments.slice(0, numberIndex).join('/');
  return {
    repo,
    issueNumber,
    ...(trailingIsEvents ? { suffix: 'events' } : {}),
  };
}

export function createUiServer(options: UiServerOptions) {
  const now = options.now ?? (() => new Date());

  return createServer((req, res) => {
    void handleRequest(req, res, options, now).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: UiServerOptions,
  now: () => Date,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');

  // Whether a token is required is a bind-time decision — the caller (see
  // ui-command.ts) only ever supplies a token when it configured a
  // non-loopback --host, so once set it gates every request rather than
  // trusting a per-connection remote-address check that docker's NAT/port
  // publishing can make unreliable.
  if (options.token !== undefined) {
    const provided = extractBearerToken(req);
    if (provided !== options.token) {
      sendJson(res, 401, { error: 'missing or invalid token' });
      return;
    }
  }

  if (!url.pathname.startsWith('/api/v1/')) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(indexHtml);
      return;
    }
    res.writeHead(404).end('not found');
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'this build only serves read endpoints; mutations are not implemented' });
    return;
  }

  const { stateStore, resourceIndex, config } = options;
  const segments = url.pathname.slice('/api/v1/'.length).split('/').filter((part) => part.length > 0).map((s) => decodeURIComponent(s));
  const resource = segments[0];

  if (resource === 'status' && segments.length === 1) {
    sendJson(res, 200, await buildStatus({ stateStore, config, now: now() }));
    return;
  }

  if (resource === 'board' && segments.length === 1) {
    sendJson(res, 200, await buildBoard({ stateStore, config, now: now() }));
    return;
  }

  if (resource === 'items' && segments.length >= 3) {
    const parsed = parseItemPath(segments.slice(1));
    if (parsed === null) {
      sendJson(res, 400, { error: 'expected /items/<repo>/<issueNumber>' });
      return;
    }

    const itemDetailInput = {
      stateStore,
      resourceIndex,
      provider: ticketProvider(config),
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
    };

    if (parsed.suffix === 'events') {
      const detail = await buildItemDetail(itemDetailInput);
      sendJson(res, 200, detail?.events ?? []);
      return;
    }

    const detail = await buildItemDetail(itemDetailInput);
    if (detail === null) {
      sendJson(res, 404, { error: 'item not found' });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  if (resource === 'runs' && segments.length === 1) {
    sendJson(res, 200, await buildRuns({
      stateStore,
      status: url.searchParams.get('status') ?? undefined,
      action: url.searchParams.get('action') ?? undefined,
      repo: url.searchParams.get('repo') ?? undefined,
    }));
    return;
  }

  if (resource === 'events' && segments.length === 1) {
    const limitParam = url.searchParams.get('limit');
    sendJson(res, 200, await buildEventsFeed({
      stateStore,
      workItemKey: url.searchParams.get('workItemKey') ?? undefined,
      direction: (url.searchParams.get('direction') as 'inbound' | 'outbound' | 'internal' | null) ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      limit: limitParam === null ? undefined : Number(limitParam),
    }));
    return;
  }

  if (resource === 'config' && segments.length === 1) {
    sendJson(res, 200, await buildConfigView({ config, stateStore, now: now() }));
    return;
  }

  if (resource === 'health' && segments.length === 1) {
    sendJson(res, 200, await buildHealth({ stateStore, config, now: now() }));
    return;
  }

  if (resource === 'workspaces' && segments.length === 1) {
    sendJson(res, 200, await buildWorkspaces({ stateStore }));
    return;
  }

  sendJson(res, 404, { error: `unknown endpoint: ${url.pathname}` });
}
