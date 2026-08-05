import { ControlStreamKind } from '../control-plane/index.js';
import type { EventEnvelope, EventJournal } from '../kernel/index.js';
import type { WorkflowInstanceView } from '../orchestration/index.js';
import type { ResourceView } from '../resources/index.js';
import {
  ApiCommandStatus,
  fromWorkItemKey,
  presentBoardCard,
  presentResource,
  presentStatus,
  presentWorkflowInstance,
  redactConfiguration,
  type ApiApplications,
  type ApiSystemApplications,
  type ApiTickCommandResult,
  type AuditEventResponse,
} from '../surfaces/index.js';
import { analyticsProjection, type AnalyticsProjectionView } from './analytics-projection.js';
import {
  boardConditionCounts,
  boardProjection,
  type BoardProjectionView,
} from './board-projection.js';
import type { CompositionRoot } from './composition-root.js';
import { primaryExternalRef } from './external-ref.js';
import { createSelfUpdateFailureLog } from './self-update-failure-log.js';
import { createExecutionApplications } from './surface-api-execution-applications.js';
import { projectionMeta, sampledMeta } from './surface-api-metadata.js';
import { projectionPage } from './surface-api-projection-pages.js';
import { createSurfaceWorkApplications } from './surface-api-work-applications.js';
import { wakeVersion } from './version.js';

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
      const nowMs = Date.parse(now());
      const stored = await root.projections.read<BoardProjectionView>(
        boardProjection.name,
        'global',
      );
      const cards = Object.values(stored?.value.cards ?? {}).sort((left, right) =>
        cardRecency(right).localeCompare(cardRecency(left)),
      );
      const offset = query.cursor?.position ?? 0;
      const page = cards.slice(offset, offset + query.limit);
      const items = await Promise.all(
        page.map(async (card) => {
          const externalRef = await primaryExternalRef(root, card.workItemId);
          const { activeRun, ...withoutActiveRun } = card;
          return presentBoardCard({
            ...withoutActiveRun,
            totalDurationMs: card.totalDurationMs ?? 0,
            ...(externalRef === undefined ? {} : { externalRef }),
            ...(card.lastRunAt === undefined
              ? {}
              : { lastRunAgeMs: elapsedSince(card.lastRunAt, nowMs) }),
            ...(activeRun === undefined
              ? {}
              : {
                  activeRun: {
                    ...activeRun,
                    elapsedMs: elapsedSince(activeRun.startedAt, nowMs),
                  },
                }),
          });
        }),
      );
      return {
        items,
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
      return projectionPage(
        root.journal,
        stored,
        query,
        presentResource(root.resolveResourceLink),
        {
          emptyAsOf: now(),
        },
      );
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
      const events = await recentEvents(
        root.journal,
        query.cursor?.position,
        query.limit + 1,
        (event) =>
          workItemId === undefined ||
          event.stream.id === workItemId ||
          (typeof event.payload === 'object' &&
            event.payload !== null &&
            'workItemId' in event.payload &&
            event.payload.workItemId === workItemId),
      );
      const visible = events.slice(0, query.limit);
      const newest = visible[0];
      const oldest = visible.at(-1);
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
        ...(events.length > query.limit && oldest !== undefined
          ? { nextPosition: oldest.globalPosition }
          : {}),
        ...(newest === undefined && query.cursor === undefined
          ? {}
          : { continuationPosition: oldest?.globalPosition ?? query.cursor!.position }),
      };
    },
  };
}

async function recentEvents(
  journal: EventJournal,
  beforeGlobalPosition: number | undefined,
  limit: number,
  include: (event: EventEnvelope) => boolean,
): Promise<readonly EventEnvelope[]> {
  const batchSize = Math.max(limit, 200);
  const selected: EventEnvelope[] = [];
  let before = beforeGlobalPosition;
  while (selected.length < limit) {
    const batch =
      journal.readLatest === undefined
        ? (await journal.readAll(0))
            .filter((event) => before === undefined || event.globalPosition < before)
            .slice(-batchSize)
            .reverse()
        : await journal.readLatest(before, batchSize);
    if (batch.length === 0) return selected;
    for (const event of batch) {
      if (include(event)) selected.push(event);
      if (selected.length === limit) return selected;
    }
    const oldest = batch.at(-1);
    if (oldest === undefined || batch.length < batchSize) return selected;
    before = oldest.globalPosition;
  }
  return selected;
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
      const selfUpdateFailure = await createSelfUpdateFailureLog(root.paths.wakeRoot).read();
      const checks = [
        { name: 'journal', status: 'ok' as const },
        { name: 'projections', status: 'ok' as const },
        { name: 'checkpoints', status: 'ok' as const },
        selfUpdateFailure === null
          ? { name: 'self-update', status: 'ok' as const }
          : {
              name: 'self-update',
              status: 'degraded' as const,
              detail: `rolled back from ${selfUpdateFailure.tag} at ${selfUpdateFailure.occurredAt}: ${selfUpdateFailure.message}`,
            },
      ];
      return {
        data: {
          status: checks.some((check) => check.status === 'degraded') ? 'degraded' : 'ok',
          version: wakeVersion,
          checkedAt,
          checks,
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
  const activeTicks = new Map<string, Promise<ApiTickCommandResult>>();
  const recentTicks = new Map<string, ApiTickCommandResult>();
  let commandSequence = 0;
  return {
    status: () => readControlPlaneStatus(root, now),
    tick(command: { readonly idempotencyKey: string }) {
      const completed = recentTicks.get(command.idempotencyKey);
      if (completed !== undefined) return Promise.resolve(completed);
      const active = activeTicks.get(command.idempotencyKey);
      if (active !== undefined) return active;
      const pending = performTick(root, now, command, ++commandSequence).then(
        (result) => {
          activeTicks.delete(command.idempotencyKey);
          rememberRecentTick(recentTicks, command.idempotencyKey, result);
          return result;
        },
        (error: unknown) => {
          activeTicks.delete(command.idempotencyKey);
          throw error;
        },
      );
      activeTicks.set(command.idempotencyKey, pending);
      return pending;
    },
  };
}

const recentAdvanceLimit = 100;

function rememberRecentTick(
  commands: Map<string, ApiTickCommandResult>,
  key: string,
  result: ApiTickCommandResult,
): void {
  commands.set(key, result);
  while (commands.size > recentAdvanceLimit) {
    const oldest = commands.keys().next().value;
    if (oldest === undefined) return;
    commands.delete(oldest);
  }
}

async function performTick(
  root: CompositionRoot,
  now: () => string,
  command: { readonly idempotencyKey: string },
  sequence: number,
): Promise<ApiTickCommandResult> {
  const acceptedAt = now();
  await root.projectionRunner.runRegisteredOnce();
  await root.advanceOnce({ maxProgress: 1 });
  await root.projectionRunner.runRegisteredOnce();
  return {
    commandId: `tick:${acceptedAt}:${sequence}`,
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

function cardRecency(card: { readonly dwellSince: string; readonly lastRunAt?: string }): string {
  return card.lastRunAt ?? card.dwellSince;
}

export function elapsedSince(timestamp: string, nowMs: number): number {
  return nowMs - Date.parse(timestamp);
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


