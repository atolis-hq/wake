import { ControlStreamKind } from '../control-plane/index.js';
import type { EventEnvelope } from '../kernel/index.js';
import type { WorkflowInstanceView } from '../orchestration/index.js';
import type { ResourceView } from '../resources/index.js';
import {
  ApiCommandStatus,
  presentResource,
  presentWorkflowInstance,
  redactConfiguration,
  type ApiAdvanceCommandResult,
  type ApiApplications,
  type ApiSystemApplications,
  type AuditEventResponse,
} from '../surfaces/index.js';
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
      const events = await root.journal.readAll(query.cursor?.position ?? 0, query.limit + 1);
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
    async metrics() {
      const events = await root.journal.readAll(0);
      const collectedAt = now();
      return {
        data: {
          collectedAt,
          values: {
            events: events.length,
            workItems: (await root.projections.list('work')).length,
            runs: (await root.execution.list()).length,
          },
        },
        meta: {
          asOf: collectedAt,
          ...(events.at(-1) === undefined ? {} : { position: events.at(-1)!.globalPosition }),
        },
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
  }));
}
