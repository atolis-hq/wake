import { execFile as nodeExecFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, copyFile, mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { BuiltInActivityName, agentActivityDefinition } from '../activities/index.js';
import { ResidentHost, TickHost } from '../control-plane/index.js';
import { RunStatus, loadPromptTemplate } from '../execution/index.js';
import { EventActorKind, correlationId } from '../kernel/index.js';
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
  runSandboxSetup,
  runSelfUpdateLatestLoop,
  runTargetSmoke,
  waitForActiveRuns,
  type ApiApplications,
  type DockerProcessChunk,
  type HostOptions,
  type SandboxDockerInspection,
  type WakeCliApplications,
} from '../surfaces/index.js';
import { workItemId } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';
import { loadConfig } from './config/load-config.js';
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
  const resident = new ResidentHost(
    tick,
    (signal) => sleepUntilAbort(signal, root.config.controlPlane.resident?.idleBackoffMs ?? 1000),
    async (error) => {
      process.stderr.write(
        `Wake resident tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  );
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
    sandboxRuntime: createSandboxRuntimeApplications(root),
    operational: createOperationalApplications(root),
  };
}

function sleepUntilAbort(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
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

function createSandboxRuntimeApplications(root: CompositionRoot) {
  const docker = createSandboxDockerPort(
    createLoggedDockerCli(
      {
        execute: (arguments_, onChunk, options) => spawnDocker(arguments_, onChunk, root.paths.wakeRoot, options),
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
      development: root.config.host.development,
      containerName: root.config.host.sandbox.containerName,
      ...(root.config.surfaces.api.enabled ? { publishedPort: root.config.surfaces.api.port } : {}),
      wakeMountPath: root.config.host.sandbox.wakeMountPath,
      containerHomeMountPath: root.config.host.sandbox.containerHomeMountPath,
      extraMounts: root.config.host.sandbox.extraMounts,
      startEnabled: root.config.host.sandbox.start.enabled,
      inspect: createDockerInspection(root.paths.wakeRoot),
    },
  );
  const wakeInvocation =
    root.config.host.development.mode === 'source'
      ? ['node', '/app/dist-next/src-next/main.js']
      : ['wake'];
  return {
    async hasDockerfile(): Promise<boolean> {
      try {
        await access(join(root.paths.wakeRoot, 'docker', 'Dockerfile'));
        return true;
      } catch {
        return false;
      }
    },
    exec: (arguments_: readonly string[]) => docker.exec([...wakeInvocation, ...arguments_]),
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
    sandboxSetup: async (arguments_: readonly string[]) => {
      if (arguments_.length > 0) throw new Error('wake sandbox-setup accepts no arguments');
      await runSandboxSetup(
        createSandboxSetupDependencies(root.config.host.sandbox.containerHomeMountPath),
      );
    },
    sandbox: async (arguments_: readonly string[]) =>
      runSandbox(
        arguments_,
        createSandboxDockerPort(
          createLoggedDockerCli(
            {
              execute: (arguments__, onChunk, options) =>
                spawnDocker(arguments__, onChunk, root.paths.wakeRoot, options),
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
      development: root.config.host.development,
            containerName: root.config.host.sandbox.containerName,
      ...(root.config.surfaces.api.enabled ? { publishedPort: root.config.surfaces.api.port } : {}),
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

function createDockerInspection(wakeRoot: string): SandboxDockerInspection {
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

/**
 * Spawns `docker` directly (not execFile) so stdout/stderr chunks reach the
 * caller as they arrive, letting the sandbox log sink write incrementally
 * during a long `build`/`up` instead of buffering until exit. Rejects on a
 * non-zero exit, matching execFile's throw-on-failure contract.
 */
function spawnDocker(
  arguments_: readonly string[],
  onChunk: (chunk: DockerProcessChunk) => void | Promise<void>,
  cwd: string,
  options?: { readonly interactive?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...arguments_], options?.interactive ? { cwd, stdio: 'inherit' } : { cwd });
    if (options?.interactive) {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('docker ' + arguments_.join(' ') + ' exited with code ' + String(code)));
      });
      return;
    }
    let chain = Promise.resolve();
    let stderrTail = '';
    const enqueue = (stream: DockerProcessChunk['stream'], text: string) => {
      if (stream === 'stderr') stderrTail = `${stderrTail}${text}`.slice(-4000);
      chain = chain.then(() => onChunk({ stream, text }));
    };
    child.stdout!.on('data', (buffer: Buffer) => enqueue('stdout', buffer.toString('utf8')));
    child.stderr!.on('data', (buffer: Buffer) => enqueue('stderr', buffer.toString('utf8')));
    child.on('error', (error) => {
      void chain.then(() => reject(error));
    });
    child.on('close', (code) => {
      void chain.then(() => {
        if (code === 0) resolve();
        else {
          const detail = stderrTail.trim();
          reject(
            new Error(
              `docker ${arguments_.join(' ')} exited with code ${String(code)}` +
                (detail.length > 0 ? `: ${detail}` : ''),
            ),
          );
        }
      });
    });
  });
}

async function doctorDiagnostics(root: CompositionRoot) {
  const failures: string[] = [];
  const notices: string[] = [];
  try {
    createRunnerRegistry(root.config.execution).resolve(root.config.execution.defaultRunnerPool);
  } catch (error) {
    failures.push(`runner pool availability: ${(error as Error).message}`);
  }
  try {
    await loadConfig(root.paths.wakeRoot);
  } catch (error) {
    failures.push(`configuration validation failed: ${(error as Error).message}`);
  }
  for (const name of referencedPromptTemplateNames(root.config.orchestration.workflows)) {
    try {
      await loadPromptTemplate(root.paths.wakeRoot, name);
    } catch (error) {
      failures.push(`prompt template "${name}" is not readable: ${(error as Error).message}`);
    }
  }
  await checkProviders(root, failures, notices);
  notices.push(...(await dockerSandboxHealthNotices(root)));
  for (const [name, path] of Object.entries({
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

// Derives the prompt template names doctor must validate from what configured
// workflows actually reference, rather than a hardcoded filename that may not
// correspond to anything a given deployment's workflows use.
function referencedPromptTemplateNames(
  workflows: CompositionRoot['config']['orchestration']['workflows'],
): readonly string[] {
  const names = new Set<string>();
  for (const workflow of Object.values(workflows)) {
    for (const stage of Object.values(workflow.stages)) {
      if (stage.activity !== BuiltInActivityName.Agent) continue;
      const parsed = agentActivityDefinition.inputSchema.safeParse(stage.with);
      if (parsed.success && parsed.data.template !== undefined) names.add(parsed.data.template);
    }
  }
  return [...names];
}

async function checkProviders(
  root: CompositionRoot,
  failures: string[],
  notices: string[],
): Promise<void> {
  for (const provider of root.providers) {
    if (provider.adapter.trim().length === 0) {
      failures.push('configured provider has no adapter identity');
      continue;
    }
    if (provider.checkConnectivity === undefined) continue;
    try {
      await provider.checkConnectivity();
    } catch (error) {
      failures.push(`provider "${provider.adapter}" is not reachable: ${(error as Error).message}`);
    }
  }
  if (root.providers.length === 0 && Object.keys(root.config.integrations).length > 0)
    notices.push('no enabled integration provider is available');
}

// Docker/sandbox absence must never fail doctor: target deployments may not
// use the Docker sandbox at all, so every outcome here is informational.
async function dockerSandboxHealthNotices(root: CompositionRoot): Promise<string[]> {
  const inspect = createDockerInspection(root.paths.wakeRoot);
  const image = root.config.host.sandbox.image;
  const containerName = root.config.host.sandbox.containerName;
  if (!(await inspect.imageExists(image)))
    return [
      `Docker sandbox image "${image}" was not found (or Docker is unavailable) ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â run \`wake sandbox build\` if this deployment uses the Docker sandbox`,
    ];
  const state = await inspect.containerState(containerName);
  if (state === 'halted')
    return [
      `Docker sandbox container "${containerName}" is stopped ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â run \`wake sandbox up\` to resume it`,
    ];
  if (state === null)
    return [
      `Docker sandbox container "${containerName}" was not found ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â run \`wake sandbox up\` if this deployment uses the Docker sandbox`,
    ];
  return [];
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

function createSandboxSetupDependencies(home: string) {
  const codexHome = join(home, '.codex');
  const codexRuntimeHome = join(home, '.codex-runtime');
  return {
    prompt: async (message: string): Promise<boolean> => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^(y|yes)$/i.test((await readline.question(`${message} `)).trim());
      } finally {
        readline.close();
      }
    },
    runInteractive,
    ensureSshKey: async (): Promise<void> => {
      const sshDirectory = join(home, '.ssh');
      const privateKey = join(sshDirectory, 'id_ed25519');
      if (await isReadable(privateKey)) return;
      await mkdir(sshDirectory, { recursive: true, mode: 0o700 });
      await runInteractive('ssh-keygen', ['-t', 'ed25519', '-f', privateKey, '-N', '']);
    },
    prepareCodexHome: async (): Promise<void> => {
      await mkdir(codexRuntimeHome, { recursive: true });
      const config = join(codexHome, 'config.toml');
      if (await isReadable(config)) await copyFile(config, join(codexRuntimeHome, 'config.toml'));
      const sourceAuth = join(codexHome, 'auth.json');
      const targetAuth = join(codexRuntimeHome, 'auth.json');
      if ((await isReadable(sourceAuth)) && !(await isReadable(targetAuth)))
        await copyFile(sourceAuth, targetAuth);
    },
    log: (message: string) => process.stdout.write(`${message}\n`),
  };
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runInteractive(command: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...arguments_], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}
