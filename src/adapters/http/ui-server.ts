import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { ResourceIndex } from '../../core/contracts.js';
import { createProjectionUpdater } from '../../core/projection-updater.js';
import { configuredTicketSource } from '../../domain/sources.js';
import type { WakeConfig } from '../../domain/types.js';
import { createEventEnvelope } from '../../lib/event-log.js';
import { writeJsonFile } from '../../lib/json-file.js';
import type { createStateStore } from '../fs/state-store.js';
import { indexHtml } from './ui-assets.js';
import {
  buildBoard,
  buildConfigView,
  buildEventsFeed,
  buildHealth,
  buildItemDetail,
  buildItemTranscripts,
  buildMetrics,
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
    const match = cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('wake_ui_token='));
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
function parseItemPath(
  segments: string[],
): { repo: string; issueNumber: number; suffix?: string } | null {
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

type ProjectionUpdater = ReturnType<typeof createProjectionUpdater>;

export function createUiServer(options: UiServerOptions) {
  const now = options.now ?? (() => new Date());
  const projectionUpdater = createProjectionUpdater({
    stateStore: options.stateStore,
    resourceIndex: options.resourceIndex,
    config: options.config,
  });

  return createServer((req, res) => {
    void handleRequest(req, res, options, now, projectionUpdater).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: UiServerOptions,
  now: () => Date,
  projectionUpdater: ProjectionUpdater,
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

  const { stateStore, resourceIndex, config } = options;
  const segments = url.pathname
    .slice('/api/v1/'.length)
    .split('/')
    .filter((part) => part.length > 0)
    .map((s) => decodeURIComponent(s));
  const resource = segments[0];

  if (
    req.method === 'POST' &&
    resource === 'work-items' &&
    segments.length === 3 &&
    segments[2] === 'retry'
  ) {
    const workItemKey = segments[1] ?? '';
    const item = await stateStore.readIssueState(workItemKey);
    if (item === null) {
      sendJson(res, 404, { error: 'work item not found' });
      return;
    }

    const context = item.context as Record<string, unknown>;
    if (context.lastRunSentinel !== 'FAILED') {
      sendJson(res, 409, { error: 'work item last run is not failed' });
      return;
    }

    const occurredAt = now().toISOString();
    const retryId = `retry-${workItemKey}-${now().getTime()}`;
    const retryEvent = createEventEnvelope({
      eventId: retryId,
      workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.retry.requested',
      sourceRefs: { repo: item.issue.repo, issueNumber: item.issue.number },
      occurredAt,
      ingestedAt: occurredAt,
      trigger: 'immediate',
      payload: { requestedBy: 'ui' },
    });

    const appended = await stateStore.appendEventEnvelope(retryEvent);
    await projectionUpdater.rebuildFromEvents([appended]);

    const tickRequest = {
      requestId: randomUUID(),
      requestedAt: now().toISOString(),
      requestedBy: 'ui:retry',
    };
    await writeJsonFile(stateStore.paths.tickRequestFile, tickRequest);

    sendJson(res, 202, { workItemKey, retryEventId: retryId });
    return;
  }

  if (
    req.method === 'GET' &&
    resource === 'work-items' &&
    segments.length === 3 &&
    segments[2] === 'transcripts'
  ) {
    sendJson(
      res,
      200,
      await buildItemTranscripts({
        stateStore,
        config,
        workItemKey: segments[1] ?? '',
      }),
    );
    return;
  }

  if (req.method === 'POST' && resource === 'tick' && segments.length === 1) {
    const request = {
      requestId: randomUUID(),
      requestedAt: now().toISOString(),
      requestedBy: 'ui',
    };
    await writeJsonFile(stateStore.paths.tickRequestFile, request);
    sendJson(res, 202, request);
    return;
  }

  if (
    req.method === 'POST' &&
    resource === 'runners' &&
    segments.length === 3 &&
    segments[2] === 'unpause'
  ) {
    const runnerName = segments[1] as string;
    const ledger = await stateStore.readLedger();
    const existingRunners = ledger?.runners ?? {};
    if (existingRunners[runnerName] !== undefined) {
      await stateStore.writeLedger({
        schemaVersion: 1,
        runners: { ...existingRunners, [runnerName]: { failureCount: 0 } },
      });
    }
    sendJson(res, 200, { runnerName, unpaused: true });
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: `method not allowed for ${url.pathname}` });
    return;
  }

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
      provider: configuredTicketSource(config),
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
    sendJson(
      res,
      200,
      await buildRuns({
        stateStore,
        status: url.searchParams.get('status') ?? undefined,
        action: url.searchParams.get('action') ?? undefined,
        repo: url.searchParams.get('repo') ?? undefined,
      }),
    );
    return;
  }

  if (resource === 'metrics' && segments.length === 1) {
    sendJson(
      res,
      200,
      await buildMetrics({
        stateStore,
        config,
        now: now(),
        window: url.searchParams.get('window') ?? undefined,
        metric: url.searchParams.get('metric') ?? undefined,
      }),
    );
    return;
  }

  if (resource === 'events' && segments.length === 1) {
    const limitParam = url.searchParams.get('limit');
    sendJson(
      res,
      200,
      await buildEventsFeed({
        stateStore,
        workItemKey: url.searchParams.get('workItemKey') ?? undefined,
        direction:
          (url.searchParams.get('direction') as 'inbound' | 'outbound' | 'internal' | null) ??
          undefined,
        type: url.searchParams.get('type') ?? undefined,
        limit: limitParam === null ? undefined : Number(limitParam),
      }),
    );
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
