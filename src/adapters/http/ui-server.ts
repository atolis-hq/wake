import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ResourceIndex } from '../../core/contracts.js';
import { createLabelsEvent } from '../../core/event-builders.js';
import { createProjectionUpdater } from '../../core/projection-updater.js';
import {
  CORRELATION_RETRACTED_EVENT,
  RETRY_REQUESTED_EVENT,
  RUN_REQUESTED_EVENT,
  WORK_ITEM_DELETED_EVENT,
  WORK_ITEM_FROZEN_EVENT,
  WORK_ITEM_UNFROZEN_EVENT,
} from '../../domain/event-types.js';
import { configuredTicketSource } from '../../domain/sources.js';
import type { EventEnvelope, IssueStateRecord, WakeConfig } from '../../domain/types.js';
import { isWorkItemDeleted, isWorkItemFrozen } from '../../domain/work-item-lifecycle.js';
import { createEventEnvelope } from '../../lib/event-log.js';
import { writeJsonFile } from '../../lib/json-file.js';
import type { createStateStore } from '../fs/state-store.js';
import { labelsForWorkItem } from '../../domain/work-item-labels.js';
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

async function writeTickRequest(
  stateStore: StateStore,
  now: () => Date,
  requestedBy: string,
): Promise<void> {
  await writeJsonFile(stateStore.paths.tickRequestFile, {
    requestId: randomUUID(),
    requestedAt: now().toISOString(),
    requestedBy,
  });
}

function buildUiWorkItemEvent(input: {
  item: IssueStateRecord;
  eventId: string;
  sourceEventType: string;
  occurredAt: string;
}): EventEnvelope {
  return createEventEnvelope({
    eventId: input.eventId,
    workItemKey: input.item.workItemKey,
    streamScope: 'work-item',
    direction: 'internal',
    sourceSystem: 'wake',
    sourceEventType: input.sourceEventType,
    sourceRefs: { repo: input.item.issue.repo, issueNumber: input.item.issue.number },
    occurredAt: input.occurredAt,
    ingestedAt: input.occurredAt,
    trigger: 'immediate',
    payload: { requestedBy: 'ui' },
  });
}

async function appendLabelSyncEvent(input: {
  item: IssueStateRecord;
  stateStore: StateStore;
  projectionUpdater: ProjectionUpdater;
  config: WakeConfig;
  now: () => Date;
  action: 'freeze' | 'unfreeze';
}): Promise<string> {
  const occurredAt = input.now().toISOString();
  const labelEvent = createLabelsEvent({
    projection: input.item,
    runId: `${input.action}-${input.item.workItemKey}-${input.now().getTime()}`,
    ...labelsForWorkItem(input.item, input.config),
    occurredAt,
  });
  const appended = await input.stateStore.appendEventEnvelope(labelEvent);
  await input.projectionUpdater.rebuildFromEvents([appended]);
  return labelEvent.eventId;
}

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
    (segments[2] === 'freeze' || segments[2] === 'unfreeze')
  ) {
    const workItemKey = segments[1] ?? '';
    const item = await stateStore.readIssueState(workItemKey);
    if (item === null) {
      sendJson(res, 404, { error: 'work item not found' });
      return;
    }
    if (isWorkItemDeleted(item)) {
      sendJson(res, 409, { error: 'work item is deleted' });
      return;
    }

    const action = segments[2];
    const alreadyInDesiredState =
      action === 'freeze' ? isWorkItemFrozen(item) : !isWorkItemFrozen(item);
    if (alreadyInDesiredState) {
      sendJson(res, 202, { workItemKey, changed: false });
      return;
    }

    const occurredAt = now().toISOString();
    const eventId = `${action}-${workItemKey}-${now().getTime()}`;
    const event = buildUiWorkItemEvent({
      item,
      eventId,
      sourceEventType: action === 'freeze' ? WORK_ITEM_FROZEN_EVENT : WORK_ITEM_UNFROZEN_EVENT,
      occurredAt,
    });
    const appended = await stateStore.appendEventEnvelope(event);
    await projectionUpdater.rebuildFromEvents([appended]);
    const updated = (await stateStore.readIssueState(workItemKey)) ?? item;
    const labelEventId = await appendLabelSyncEvent({
      item: updated,
      stateStore,
      projectionUpdater,
      config,
      now,
      action,
    });
    await writeTickRequest(stateStore, now, `ui:${action}`);

    sendJson(res, 202, { workItemKey, eventId, labelEventId, changed: true });
    return;
  }

  if (
    req.method === 'POST' &&
    resource === 'work-items' &&
    segments.length === 3 &&
    segments[2] === 'delete'
  ) {
    const workItemKey = segments[1] ?? '';
    const item = await stateStore.readIssueState(workItemKey);
    if (item === null) {
      sendJson(res, 404, { error: 'work item not found' });
      return;
    }
    if (isWorkItemDeleted(item)) {
      sendJson(res, 202, { workItemKey, changed: false });
      return;
    }

    const occurredAt = now().toISOString();
    const deleteEventId = `delete-${workItemKey}-${now().getTime()}`;
    const events = [
      buildUiWorkItemEvent({
        item,
        eventId: deleteEventId,
        sourceEventType: WORK_ITEM_DELETED_EVENT,
        occurredAt,
      }),
      ...item.correlatedResources.map((resourceRef) =>
        createEventEnvelope({
          eventId: `${deleteEventId}-retract-${resourceRef.resourceUri.replace(/[^a-z0-9]+/gi, '-')}`,
          workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: CORRELATION_RETRACTED_EVENT,
          sourceRefs: {
            repo: item.issue.repo,
            issueNumber: item.issue.number,
            resourceUri: resourceRef.resourceUri,
          },
          occurredAt,
          ingestedAt: occurredAt,
          trigger: 'context-only',
          payload: { resourceUri: resourceRef.resourceUri, requestedBy: 'ui' },
        }),
      ),
    ];
    const appended = [];
    for (const event of events) {
      appended.push(await stateStore.appendEventEnvelope(event));
    }
    await projectionUpdater.rebuildFromEvents(appended);
    await writeTickRequest(stateStore, now, 'ui:delete');

    sendJson(res, 202, {
      workItemKey,
      deleteEventId,
      retractedResources: item.correlatedResources.map((resourceRef) => resourceRef.resourceUri),
      changed: true,
    });
    return;
  }

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
      sourceEventType: RETRY_REQUESTED_EVENT,
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
    req.method === 'POST' &&
    resource === 'work-items' &&
    segments.length === 3 &&
    segments[2] === 'run'
  ) {
    const workItemKey = segments[1] ?? '';
    const item = await stateStore.readIssueState(workItemKey);
    if (item === null) {
      sendJson(res, 404, { error: 'work item not found' });
      return;
    }

    if (!item.issue.labels.includes('wake:scheduled-workflow')) {
      sendJson(res, 409, { error: 'work item is not a scheduled workflow' });
      return;
    }

    const occurredAt = now().toISOString();
    const runRequestId = `run-${workItemKey}-${now().getTime()}`;
    const runRequestEvent = createEventEnvelope({
      eventId: runRequestId,
      workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: RUN_REQUESTED_EVENT,
      sourceRefs: { repo: item.issue.repo, issueNumber: item.issue.number },
      occurredAt,
      ingestedAt: occurredAt,
      trigger: 'immediate',
      payload: { requestedBy: 'ui' },
    });

    const appended = await stateStore.appendEventEnvelope(runRequestEvent);
    await projectionUpdater.rebuildFromEvents([appended]);

    const tickRequest = {
      requestId: randomUUID(),
      requestedAt: now().toISOString(),
      requestedBy: 'ui:run',
    };
    await writeJsonFile(stateStore.paths.tickRequestFile, tickRequest);

    sendJson(res, 202, { workItemKey, runEventId: runRequestId });
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

  if (req.method === 'POST' && resource === 'pause' && segments.length === 1) {
    await mkdir(dirname(stateStore.paths.pauseFile), { recursive: true });
    await writeFile(stateStore.paths.pauseFile, `${now().toISOString()}\n`, 'utf8');
    sendJson(res, 200, { paused: true });
    return;
  }

  if (req.method === 'DELETE' && resource === 'pause' && segments.length === 1) {
    await rm(stateStore.paths.pauseFile, { force: true });
    sendJson(res, 200, { paused: false });
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
