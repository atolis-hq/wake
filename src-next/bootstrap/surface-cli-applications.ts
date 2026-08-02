import { execFile as nodeExecFile } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ResidentHost, TickHost } from '../control-plane/index.js';
import { RunStatus } from '../execution/index.js';
import { correlationId, EventActorKind } from '../kernel/index.js';
import { ResourceCorrelationRole, resourceId } from '../resources/index.js';
import {
  createApiDispatcher,
  createApiHttpServer,
  createLoggedDockerCli,
  createPackagedAssetSource,
  createProcessLogSink,
  createSandboxDockerPort,
  runDoctor,
  runSandbox,
  runSelfUpdateLatestLoop,
  runTargetSmoke,
  waitForActiveRuns,
  type ApiApplications,
  type HostOptions,
  type WakeCliApplications,
} from '../surfaces/index.js';
import { workItemId } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';
import { runtimeProjectionDefinitions } from './projection-runtime.js';
import { createRunnerRegistry } from './runner-registry.js';
import { createSelfUpdateApplication } from './self-update-application.js';
import { createSourceUpdatePort } from './source-update-port.js';
import { createUpdateLedger } from './update-ledger.js';

const execFile = promisify(nodeExecFile);

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
    stop: {
      stop: async () => {
        await waitForActiveRuns({
          activeRunIds: async () =>
            (
              await root.projections.list<{
                readonly view: { readonly status: string; readonly runId: string } | null;
              }>('execution')
            )
              .filter(({ value }) => value.view?.status === RunStatus.Started)
              .map(({ value }) => String(value.view?.runId)),
          sleep: async (milliseconds) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
        });
        await closeAll(servers);
      },
    },
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
    operational: createOperationalApplications(root),
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

function createOperationalApplications(root: CompositionRoot) {
  return {
    init: async () => unsupportedOperationalCommand('init'),
    doctor: async (arguments_: readonly string[]) =>
      runDoctor({
        rebuildProjections: arguments_.includes('--rebuild-projections'),
        diagnose: async () => doctorDiagnostics(root),
        projections: {
          health: async () => projectionHealth(root),
          rebuild: async () => {
            for (const definition of runtimeProjectionDefinitions)
              await root.projectionRunner.rebuild(definition);
          },
        },
      }),
    sandbox: async (arguments_: readonly string[]) =>
      runSandbox(
        arguments_,
        createSandboxDockerPort(
          createLoggedDockerCli(
            {
              execute: async (arguments__) => {
                const result = await execFile('docker', arguments__, { cwd: root.paths.wakeRoot });
                return { stdout: result.stdout, stderr: result.stderr };
              },
            },
            createProcessLogSink(
              join(root.paths.wakeRoot, 'logs', 'sandbox.log'),
              { write: (value) => process.stdout.write(value) },
              { maxBytes: 10 * 1024 * 1024 },
            ),
          ),
          {
            wakeRoot: root.paths.wakeRoot,
            containerHomeRoot: root.paths.containerHomeRoot,
            image: root.config.host.sandbox.image,
            containerName: root.config.host.sandbox.containerName,
            wakeMountPath: root.config.host.sandbox.wakeMountPath,
            containerHomeMountPath: root.config.host.sandbox.containerHomeMountPath,
            extraMounts: root.config.host.sandbox.extraMounts,
            startEnabled: root.config.host.sandbox.start.enabled,
            inspect: createDockerInspection(root.paths.wakeRoot),
          },
        ),
      ),
    selfUpdate: async (arguments_: readonly string[]) => {
      if (root.config.host.development.mode !== 'source')
        throw new Error('wake self-update requires host.development.mode: source');
      const repoRoot = root.config.host.development.repoRoot;
      if (repoRoot === undefined)
        throw new Error('wake self-update requires host.development.repoRoot');
      const tag = optionalOperationalOption(arguments_, '--tag');
      const application = createSelfUpdateApplication({
        ledger: createUpdateLedger(root.paths.wakeRoot),
        source: createSourceUpdatePort({ repoRoot }),
      });
      const force = arguments_.includes('--force');
      if (arguments_.includes('--loop')) {
        const intervalMs = selfUpdateLoopInterval(arguments_);
        if (tag !== undefined)
          return runSelfUpdateLatestLoop(
            async () => application.update(tag, force),
            () => delay(intervalMs),
          );
        return runSelfUpdateLatestLoop(
          async () => application.updateLatest(force),
          () => delay(intervalMs),
        );
      }
      if (tag !== undefined) return { tag, updated: await application.update(tag, force) };
      return application.updateLatest(force);
    },
    smoke: async () =>
      runTargetSmoke(
        createRunnerRegistry(root.config.execution),
        root.config.execution.defaultRunnerPool,
        new AbortController().signal,
      ),
  };
}

function createDockerInspection(wakeRoot: string) {
  return {
    async imageExists(image: string): Promise<boolean> {
      try {
        await execFile('docker', ['image', 'inspect', image], { cwd: wakeRoot });
        return true;
      } catch {
        return false;
      }
    },
    async containerState(containerName: string): Promise<'live' | 'halted' | null> {
      try {
        const result = await execFile(
          'docker',
          ['container', 'inspect', '-f', '{{.State.Running}}', containerName],
          { cwd: wakeRoot },
        );
        return result.stdout.trim() === 'true' ? 'live' : 'halted';
      } catch {
        return null;
      }
    },
  };
}

async function doctorDiagnostics(root: CompositionRoot) {
  const failures: string[] = [];
  const notices: string[] = [];
  try {
    createRunnerRegistry(root.config.execution).resolve(root.config.execution.defaultRunnerPool);
  } catch (error) {
    failures.push(`runner pool availability: ${(error as Error).message}`);
  }
  for (const provider of root.providers) {
    if (provider.adapter.trim().length === 0)
      failures.push('configured provider has no adapter identity');
  }
  if (root.providers.length === 0 && Object.keys(root.config.integrations).length > 0)
    notices.push('no enabled integration provider is available');
  try {
    await execFile('docker', ['version', '--format', '{{.Server.Version}}'], {
      cwd: root.paths.wakeRoot,
    });
  } catch {
    notices.push('Docker sandbox is unavailable; sandbox commands will remain unavailable');
  }
  for (const [name, path] of Object.entries({
    config: join(root.paths.wakeRoot, 'config.yaml'),
    workflows: join(root.paths.wakeRoot, 'config.workflows.yaml'),
    implementationPrompt: join(root.paths.wakeRoot, 'prompts', 'implement.md'),
    events: root.paths.eventsRoot,
    projections: root.paths.projectionsRoot,
    checkpoints: root.paths.checkpointsRoot,
    locks: root.paths.locksRoot,
    transcripts: root.paths.transcriptsRoot,
    workspaces: root.paths.workspacesRoot,
  })) {
    try {
      await access(path);
    } catch {
      failures.push(name + ' runtime directory is not accessible: ' + path);
    }
  }
  return { failures, notices };
}

async function projectionHealth(root: CompositionRoot) {
  const failures: string[] = [];
  try {
    await root.journal.readAll(0, 1);
  } catch (error) {
    failures.push(`journal: ${(error as Error).message}`);
  }
  for (const definition of runtimeProjectionDefinitions) {
    try {
      await root.projections.list(definition.name);
    } catch (error) {
      failures.push(`${definition.name}: ${(error as Error).message}`);
    }
  }
  try {
    await root.checkpoints.load('surface-health');
  } catch (error) {
    failures.push(`checkpoints: ${(error as Error).message}`);
  }
  return {
    journal: failures.some((failure) => failure.startsWith('journal:')) ? 'unhealthy' : 'ok',
    projections: failures.filter(
      (failure) => !failure.startsWith('journal:') && !failure.startsWith('checkpoints:'),
    ),
    checkpoints: failures.some((failure) => failure.startsWith('checkpoints:'))
      ? 'unhealthy'
      : 'ok',
  };
}

function selfUpdateLoopInterval(arguments_: readonly string[]): number {
  const value = optionalOperationalOption(arguments_, '--loop-interval-ms');
  if (value === undefined) return 60_000;
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval <= 0)
    throw new Error('wake self-update --loop-interval-ms must be a positive integer');
  return interval;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function optionalOperationalOption(
  arguments_: readonly string[],
  option: string,
): string | undefined {
  const index = arguments_.indexOf(option);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error(`wake self-update requires ${option} <value>`);
  return value;
}

function unsupportedOperationalCommand(command: string): never {
  throw new Error(`wake ${command} has not been composed`);
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
