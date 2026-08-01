import { once } from 'node:events';
import type { Server } from 'node:http';
import { ResidentHost, TickHost } from '../control-plane/index.js';
import { correlationId, EventActorKind } from '../kernel/index.js';
import { ResourceCorrelationRole, resourceId } from '../resources/index.js';
import {
  createApiDispatcher,
  createApiHttpServer,
  createPackagedAssetSource,
  type ApiApplications,
  type HostOptions,
  type WakeCliApplications,
} from '../surfaces/index.js';
import { workItemId } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';
import { runtimeProjectionDefinitions } from './projection-runtime.js';

export function createSurfaceCliApplications(
  root: CompositionRoot,
  api: ApiApplications,
  now: () => string,
): WakeCliApplications {
  const tick = new TickHost((options) => root.pipeline.run(options));
  const resident = new ResidentHost(tick);
  const servers = new Set<Server>();
  const startHttp = createHttpStarter(root, api, servers);
  return {
    tick,
    start: {
      async run(signal, budget) {
        if (root.config.surfaces.web.enabled) await startHttp({}, true);
        else if (root.config.surfaces.api.enabled) await startHttp({}, false);
        try {
          return await resident.run(signal, budget);
        } finally {
          await closeAll(servers);
        }
      },
    },
    stop: { stop: () => closeAll(servers) },
    api: { start: (options) => startHttp(options, false) },
    ui: { start: (options) => startHttp(options, true) },
    audit: {
      async read(id) {
        return (await root.journal.readAll(0))
          .filter((event) => event.stream.id === id)
          .map((event) => ({
            eventId: event.eventId,
            eventType: event.eventType,
            occurredAt: event.occurredAt,
            stream: `${event.stream.kind}:${event.stream.id}`,
            causationId: event.causationId,
            correlationId: event.correlationId,
          }));
      },
    },
    correlate: {
      async correlate(resource, work) {
        return root.resources.correlate(
          resourceId(resource),
          workItemId(work),
          ResourceCorrelationRole.Primary,
          commandContext(`correlate:${resource}:${work}`, now()),
        );
      },
    },
    validateState: createValidationApplications(root),
  };
}

function createHttpStarter(root: CompositionRoot, api: ApiApplications, servers: Set<Server>) {
  return async (options: HostOptions = {}, web = false): Promise<void> => {
    const assets = web ? createPackagedAssetSource() : undefined;
    if (web && (await assets!.get('/index.html')) === undefined)
      throw new Error('Packaged Wake web assets are missing');
    const server = createApiHttpServer(createApiDispatcher(api), assets);
    servers.add(server);
    server.listen(
      options.port ?? root.config.surfaces.api.port,
      options.host ?? root.config.surfaces.api.host,
    );
    try {
      await Promise.race([
        once(server, 'listening'),
        once(server, 'error').then(([error]) => Promise.reject(error)),
      ]);
    } catch (error) {
      servers.delete(server);
      throw error;
    }
  };
}

function createValidationApplications(root: CompositionRoot) {
  return {
    async health() {
      await root.journal.readAll(0, 1);
      await root.projections.list('work');
      await root.checkpoints.load('surface-health');
      return { journal: 'ok', projections: 'ok', checkpoints: 'ok' };
    },
    async rebuildProjections() {
      for (const definition of runtimeProjectionDefinitions)
        await root.projectionRunner.rebuild(definition);
    },
  };
}

function commandContext(commandId: string, occurredAt: string) {
  return {
    commandId,
    correlationId: correlationId(commandId),
    occurredAt,
    actor: { kind: EventActorKind.Operator, id: 'cli' },
  };
}

async function closeAll(servers: Set<Server>): Promise<void> {
  await Promise.all(
    [...servers].map(async (server) => {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
      servers.delete(server);
    }),
  );
}
