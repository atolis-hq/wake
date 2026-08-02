import { ControlStreamKind } from '../control-plane/index.js';
import type { EventEnvelope } from '../kernel/index.js';
import type { WorkflowInstanceView } from '../orchestration/index.js';
import type { ResourceView } from '../resources/index.js';
import { fromWorkItemKey } from '../surfaces/api/contracts/work.js';
import {
  ApiCommandStatus,
  presentBoardCard,
  presentResource,
  presentStatus,
  presentWorkflowInstance,
  redactConfiguration,
  type ApiAdvanceCommandResult,
  type ApiApplications,
  type ApiSystemApplications,
  type AuditEventResponse,
} from '../surfaces/index.js';
import { analyticsProjection, type AnalyticsProjectionView } from './analytics-projection.js';
import {
  boardConditionCounts,
  boardProjection,
  type BoardProjectionView,
} from './board-projection.js';
import type { CompositionRoot } from './composition-root.js';
import { createExecutionApplications } from './surface-api-execution-applications.js';
import { projectionMeta, sampledMeta } from './surface-api-metadata.js';
import { projectionPage } from './surface-api-projection-pages.js';
import { createSurfaceWorkApplications } from './surface-api-work-applications.js';

export function createSurfaceApiApplications(
  root: CompositionRoot,
  now: () => string,
): ApiApplications {
  return {
    now,
    board: createBoardApplications(root, now),
    status: createStatusApplications(root, now),
    controlPlane: createControlPlaneApplications(root, now),
    work: createSurfaceWorkApplications(root, now),
    resources: createResourceApplications(root, now),
    orchestration: createOrchestrationApplications(root, now),
    execution: createExecutionApplications(root, now),
    events: createEventApplications(root, now),
    observability: createObservabilityApplications(root, now),
    system: createSystemApplications(root, now),
  };
}

function createBoardApplications(root: CompositionRoot, now: () => string) {
  return {
    async list(query: Parameters<NonNullable<ApiApplications['board']>['list']>[0]) {
      const stored = await root.projections.read<BoardProjectionView>(
        boardProjection.name,
        'global',
      );
      const cards = Object.values(stored?.value.cards ?? {}).sort((left, right) =>
        left.workItemId.localeCompare(right.workItemId),
      );
      const offset = query.cursor?.position ?? 0;
      return {
        items: cards.slice(offset, offset + query.limit).map((card) => presentBoardCard(card)),
        total: cards.length,
        ...(offset + query.limit < cards.length ? { nextPosition: offset + query.limit } : {}),
        conditionCounts: boardConditionCounts(stored?.value ?? boardProjection.initial('global')),
        meta: await projectionMeta(root.journal, stored === null ? [] : [stored], now()),
      };
    },
  };
}

function createStatusApplications(root: CompositionRoot, now: () => string) {
  return {
    async get() {
      const stored = await root.projections.read<BoardProjectionView>(
        boardProjection.name,
        'global',
      );
      return {
        data: presentStatus({
          conditionCounts: boardConditionCounts(stored?.value ?? boardProjection.initial('global')),
        }),
        meta: await projectionMeta(root.journal, stored === null ? [] : [stored], now()),
      };
    },
  };
}

function createResourceApplications(root: CompositionRoot, now: () => string) {
  return {
    async list(query: Parameters<ApiApplications['resources']['list']>[0]) {
      const stored = (await root.projections.list<ResourceView | null>('resources')).flatMap(
        (entry) => (entry.value === null ? [] : [{ ...entry, value: entry.value }]),
      );
      return projectionPage(root.journal, stored, query, presentResource, { emptyAsOf: now() });
    },
  };
}

function createOrchestrationApplications(root: CompositionRoot, now: () => string) {
  return {
    async list(query: Parameters<ApiApplications['orchestration']['list']>[0]) {
      const stored = (
        await root.projections.list<{ readonly view: WorkflowInstanceView | null }>('orchestration')
      ).flatMap((entry) =>
        entry.value.view === null ? [] : [{ ...entry, value: entry.value.view }],
      );
      const filtered = stored.filter(
        (entry) => query.state === undefined || entry.value.status === query.state,
      );
      return projectionPage(root.journal, filtered, query, presentWorkflowInstance, {
        emptyAsOf: now(),
        provenance: stored,
      });
    },
  };
}

function createEventApplications(root: CompositionRoot, now: () => string) {
  return {
    async list(query: Parameters<ApiApplications['events']['list']>[0]) {
      const all = await root.journal.readAll(0);
      const workItemKey = query.workItemKey;
      const workItemId =
        workItemKey === undefined
          ? undefined
          : (() => {
              try {
                return fromWorkItemKey(workItemKey);
              } catch {
                return workItemKey;
              }
            })();
      const filtered =
        workItemId === undefined
          ? all
          : all.filter(
              (event) =>
                event.stream.id === workItemId ||
                (typeof event.payload === 'object' &&
                  event.payload !== null &&
                  'workItemId' in event.payload &&
                  event.payload.workItemId === workItemId),
            );
      const events = filtered
        .filter((event) => event.globalPosition > (query.cursor?.position ?? 0))
        .slice(0, query.limit + 1);
      const visible = events.slice(0, query.limit);
      const newest = visible.at(-1);
      const meta = await projectionMeta(
        root.journal,
        newest === undefined
          ? query.cursor === undefined
            ? []
            : [{ lastGlobalPosition: query.cursor.position }]
          : [{ lastGlobalPosition: newest.globalPosition }],
        now(),
      );
      return {
        items: presentEvents(visible),
        meta,
        ...(events.length > query.limit && newest !== undefined
          ? { nextPosition: newest.globalPosition }
          : {}),
        ...(newest === undefined && query.cursor === undefined
          ? {}
          : { continuationPosition: newest?.globalPosition ?? query.cursor!.position }),
      };
    },
  };
}

function createObservabilityApplications(root: CompositionRoot, now: () => string) {
  return {
    async metrics(query = { days: 7 }) {
      const collectedAt = now();
      const stored = await root.projections.read<AnalyticsProjectionView>(
        analyticsProjection.name,
        'global',
      );
      const analytics = stored?.value ?? analyticsProjection.initial('global');
      const window = analyticsWindow(analytics, collectedAt, query.days);
      return {
        data: { collectedAt, window: window.range, values: window.values },
        meta: await projectionMeta(root.journal, stored === null ? [] : [stored], collectedAt),
      };
    },
  };
}

function createSystemApplications(root: CompositionRoot, now: () => string): ApiSystemApplications {
  return {
    async health() {
      const checkedAt = now();
      return {
        data: {
          status: 'ok',
          checkedAt,
          checks: [
            { name: 'journal', status: 'ok' },
            { name: 'projections', status: 'ok' },
            { name: 'checkpoints', status: 'ok' },
          ],
        },
        meta: sampledMeta(checkedAt),
      };
    },
    async configuration() {
      const sampledAt = now();
      return {
        data: { configuration: redactConfiguration(root.config) },
        meta: sampledMeta(sampledAt),
      };
    },
  };
}

function createControlPlaneApplications(root: CompositionRoot, now: () => string) {
  const activeAdvances = new Map<string, Promise<ApiAdvanceCommandResult>>();
  const recentAdvances = new Map<string, ApiAdvanceCommandResult>();
  let commandSequence = 0;
  return {
    status: () => readControlPlaneStatus(root, now),
    advance(command: { readonly idempotencyKey: string }) {
      const completed = recentAdvances.get(command.idempotencyKey);
      if (completed !== undefined) return Promise.resolve(completed);
      const active = activeAdvances.get(command.idempotencyKey);
      if (active !== undefined) return active;
      const pending = performAdvance(root, now, command, ++commandSequence).then(
        (result) => {
          activeAdvances.delete(command.idempotencyKey);
          rememberRecentAdvance(recentAdvances, command.idempotencyKey, result);
          return result;
        },
        (error: unknown) => {
          activeAdvances.delete(command.idempotencyKey);
          throw error;
        },
      );
      activeAdvances.set(command.idempotencyKey, pending);
      return pending;
    },
  };
}

const recentAdvanceLimit = 100;

function rememberRecentAdvance(
  commands: Map<string, ApiAdvanceCommandResult>,
  key: string,
  result: ApiAdvanceCommandResult,
): void {
  commands.set(key, result);
  while (commands.size > recentAdvanceLimit) {
    const oldest = commands.keys().next().value;
    if (oldest === undefined) return;
    commands.delete(oldest);
  }
}

async function performAdvance(
  root: CompositionRoot,
  now: () => string,
  command: { readonly idempotencyKey: string },
  sequence: number,
): Promise<ApiAdvanceCommandResult> {
  const acceptedAt = now();
  await root.projectionRunner.runRegisteredOnce();
  await root.advanceOnce({ maxProgress: 1 });
  await root.projectionRunner.runRegisteredOnce();
  return {
    commandId: `advance:${acceptedAt}:${sequence}`,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    status: ApiCommandStatus.Completed,
    result: await readControlPlaneStatus(root, now),
  };
}

async function readControlPlaneStatus(root: CompositionRoot, now: () => string) {
  const stored = await root.projections.read<{
    readonly pausedUntil: string | null;
    readonly reason?: string;
  }>(ControlStreamKind.Global, 'global');
  const meta = await projectionMeta(root.journal, stored === null ? [] : [stored], now());
  return {
    data: {
      paused: stored?.value.pausedUntil !== null && stored?.value.pausedUntil !== undefined,
      ...(stored?.value.pausedUntil == null ? {} : { pausedUntil: stored.value.pausedUntil }),
      ...(stored?.value.reason === undefined ? {} : { reason: stored.value.reason }),
      updatedAt: meta.asOf,
    },
    meta,
  };
}

function presentEvents(events: readonly EventEnvelope[]): readonly AuditEventResponse[] {
  return events.map((event) => ({
    id: event.eventId,
    type: event.eventType,
    occurredAt: event.occurredAt,
    position: event.globalPosition,
    stream: event.stream,
    causationId: event.causationId,
    correlationId: event.correlationId,
    payload: event.payload,
  }));
}

function analyticsWindow(analytics: AnalyticsProjectionView, collectedAt: string, days: number) {
  const end = collectedAt.slice(0, 10);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  const from = startDate.toISOString().slice(0, 10);
  const values = Object.entries(analytics.days)
    .filter(([day]) => day >= from && day <= end)
    .reduce(
      (totals, [, bucket]) => ({
        events: totals.events + bucket.events,
        workItems: totals.workItems + bucket.workItems,
        runs: totals.runs + bucket.runs,
      }),
      { events: 0, workItems: 0, runs: 0 },
    );
  return { range: { days, from, to: end }, values };
}
