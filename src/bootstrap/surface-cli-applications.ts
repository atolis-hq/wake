import { EventActorKind, JOURNAL_CHANGE_FALLBACK_MS, correlationId } from '@atolis-hq/eventing';
import { withFileLock } from '@atolis-hq/eventing-filesystem';
import type { FastifyInstance } from 'fastify';
import { execFile as nodeExecFile, spawn } from 'node:child_process';
import { access, copyFile, mkdir, writeFile as writeFileContent } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { BuiltInActivityName, agentActivityDefinition } from '../activities/index.js';
import {
  IntakeHost,
  ResidentHost,
  TickHost,
  type HostBudget,
  type HostResult,
} from '../control-plane/index.js';
import {
  ExecutionFailureCode,
  RunStatus,
  isActiveRunStatus,
  loadPromptTemplate,
} from '../execution/index.js';
import { ResourceCorrelationRole, resourceId } from '../resources/index.js';
import {
  DockerProcessError,
  createApiDispatcher,
  createLoggedDockerCli,
  createPackagedAssetSource,
  createPairingGrant,
  createProcessLogSink,
  createSandboxDockerPort,
  createSurfaceHttpServer,
  drainProcessOutput,
  loadOrCreateCredentials,
  promoteSandboxImage,
  redeemPairingGrant,
  replaceAccessKey,
  runDoctor,
  runSandbox,
  runSandboxEntrypoint,
  runSandboxSetup,
  runSelfUpdateLatestLoop,
  runTargetSmoke,
  verifyResidentStart,
  waitForActiveRuns,
  waitForever,
  type ApiApplications,
  type DockerCli,
  type DockerInvocationResult,
  type DockerInvokeOptions,
  type DockerProcessChunk,
  type HostOptions,
  type SandboxDockerInspection,
  type SandboxDockerOptions,
  type SandboxEntrypointDependencies,
  type WakeCliApplications,
} from '../surfaces/index.js';
import { WorkStreamKind, workItemId } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';
import { loadConfig } from './config/load-config.js';
import { createNpmUpdatePort } from './npm-update-port.js';
import { runtimeProjectionDefinitions } from './projection-runtime.js';
import { createRunnerRegistry } from './runner-registry.js';
import {
  createOneShotRunnerAdvance,
  createResidentRunnerAdvance,
  withFinalProjectionCatchUp,
} from './runner-tick-adapter.js';
import {
  createSelfUpdateApplication,
  type SelfUpdateQuiescePort,
} from './self-update-application.js';
import { createSelfUpdateFailureLog } from './self-update-failure-log.js';
import { createSourceUpdatePort } from './source-update-port.js';
import { createUpdateLedger } from './update-ledger.js';
import { UpdateMaintenancePhase } from './update-maintenance-lease.js';
import { resolveWakeVersion, wakePackageVersion } from './version.js';

const execFile = promisify(nodeExecFile);

export function createSurfaceCliApplications(
  root: CompositionRoot,
  api: ApiApplications,
  now: () => string,
): WakeCliApplications {
  const runnerTick = new TickHost(createOneShotRunnerAdvance(root));
  const runnerResidentTick = new TickHost(createResidentRunnerAdvance(root));
  const intakeHost = new IntakeHost((signal) => root.intakePipeline.run(signal));
  const runnerIdleWait = createRunnerIdleWait(root, root.config.controlPlane?.resident);
  const reportResidentError = (label: 'intake' | 'runner') => async (error: unknown) => {
    process.stderr.write(
      `Wake ${label} tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  };
  // Intake owns provider polling, so only its resident loop backs off
  // exponentially when idle. The runner loop owns schedules, reconciliation,
  // and delivery; it stays on a fast cadence when there is no local work.
  // The independent durable subscriber owns activation scheduling. Delivery
  // can still hit an external API, so consecutive errors back off
  // independently of ordinary idle ticks.
  const runnerResident = new ResidentHost(
    runnerResidentTick,
    runnerIdleWait,
    reportResidentError('runner'),
  );
  const intakeResident = new ResidentHost(
    intakeHost,
    (signal, { consecutiveIdleTicks }) =>
      sleepUntilAbort(
        signal,
        nextPollBackoffMs(root.config.controlPlane?.resident, consecutiveIdleTicks),
      ),
    reportResidentError('intake'),
  );
  const servers = new Set<FastifyInstance>();
  const startHttp = createHttpStarter(root, api, servers);
  return {
    tick: {
      async run(budget) {
        return withFinalProjectionCatchUp(
          async () => {
            await root.projectionSubscriptions.catchUpOnce();
            // Mirrors legacy's combined one-shot `runTick`: intake once, then
            // let the runner loop drain up to its own budget.
            await intakeHost.run(budget);
            return await runnerTick.run(budget);
          },
          () => root.projectionSubscriptions.catchUpOnce(),
        );
      },
    },
    start: {
      async run(signal, budget) {
        if (root.config.surfaces.web.enabled) await startHttp({}, true);
        else if (root.config.surfaces.api.enabled) await startHttp({}, false);
        return runResidentLifecycle({
          signal,
          budget,
          processorRuntime: root.processorRuntime,
          activationSchedulerSubscriber: root.activationSchedulerSubscriber,
          intakeResident,
          runnerResident,
          close: () => closeResidentRuntime(root.execution, () => closeAll(servers)),
        });
      },
    },
    stop: {
      stop: async () => {
        await waitForActiveRuns({
          activeRunIds: () => activeExecutionRunIds(root),
          sleep: async (milliseconds) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
        });
        await closeAll(servers);
      },
    },
    api: { start: (options) => startHttp(options, false) },
    ui: { start: (options) => startHttp(options, true) },
    auth: {
      async token(accessKey: string | undefined) {
        if (root.config.surfaces.web.auth.disabled)
          return 'UI authentication is disabled by surfaces.web.auth.disabled.';
        if (accessKey !== undefined)
          await replaceAccessKey(root.paths.wakeRoot, accessKey, serialiseCredentialMutation);
        const grant = await createPairingGrant(
          root.paths.wakeRoot,
          undefined,
          serialiseCredentialMutation,
        );
        const localHost =
          root.config.surfaces.api.host === '0.0.0.0' ? 'localhost' : root.config.surfaces.api.host;
        const local = `http://${localHost}:${root.config.surfaces.api.port}/?grant=${encodeURIComponent(grant.value)}`;
        const publicUrl = root.config.surfaces.web.publicUrl;
        return [
          'Wake login link (single use; expires in 10 minutes):',
          `  Local:  ${local}`,
          ...(publicUrl === undefined
            ? []
            : [
                `  Public: ${new URL(`?grant=${encodeURIComponent(grant.value)}`, publicUrl).href}`,
              ]),
          '',
          'Open a link on this device or scan its QR code from a mobile device. Do not share the link.',
          '',
        ].join('\n');
      },
    },
    audit: {
      async read(id) {
        return (await root.journal.readAll(0))
          .filter(
            (event) => event.stream.kind === WorkStreamKind.WorkItem && event.stream.id === id,
          )
          .map((event) => ({
            eventId: event.event.eventId,
            eventType: event.event.eventType,
            occurredAt: event.event.occurredAt,
            stream: `${event.stream.kind}:${event.stream.id}`,
            causationId: event.event.causationId,
            correlationId: event.event.correlationId,
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
    runs: {
      async resolve(runId, resolution) {
        const context = commandContext(`run:${runId}:resolve`, now());
        const run = await root.recovery.resolve(
          runId,
          resolution.status === RunStatus.Succeeded
            ? { kind: RunStatus.Succeeded, outcome: resolution.outcome }
            : {
                kind: RunStatus.Failed,
                failure: { kind: ExecutionFailureCode.Unexpected, message: resolution.reason },
              },
          context,
        );
        if (resolution.status === RunStatus.Succeeded)
          await root.orchestration.acceptOutcome(
            {
              workflowInstanceId: run.workflowInstanceId,
              activationId: run.activationId,
              outcome: run.outcome!,
            },
            context,
          );
        else
          await root.orchestration.resolveExecutionFailure(
            run.workflowInstanceId,
            { activationId: run.activationId, runId: run.runId, reason: resolution.reason },
            context,
          );
        return run;
      },
    },
    validateState: createValidationApplications(root),
    sandboxRuntime: createSandboxRuntimeApplications(root),
    operational: createOperationalApplications(root),
  };
}

export function createRunnerIdleWait(
  root: Pick<CompositionRoot, 'journal'>,
  resident: { readonly pollBackoffMs: number; readonly maxPollBackoffMs?: number } | undefined,
) {
  // Cursor initialization stays inside the resident lifecycle. The first
  // wait starts at the origin so an append during the first pass remains
  // visible; each subsequent cursor is sampled before waiting.
  let priorPosition: Promise<number> | undefined;
  return (
    signal: AbortSignal,
    {
      consecutiveIdleTicks: _consecutiveIdleTicks,
      consecutiveErrorTicks,
    }: { readonly consecutiveIdleTicks: number; readonly consecutiveErrorTicks: number },
  ): Promise<void> => {
    if (consecutiveErrorTicks > 0)
      return sleepUntilAbort(signal, nextPollBackoffMs(resident, consecutiveErrorTicks));
    const initializing = priorPosition === undefined;
    const cursor = priorPosition ?? Promise.resolve(0);
    return waitForRunnerEvents(
      root,
      cursor,
      signal,
      resident,
      _consecutiveIdleTicks,
      initializing,
    ).then((position) => {
      priorPosition = Promise.resolve(position);
    });
  };
}

export interface ResidentLifecycleHost {
  run(signal: AbortSignal, budget: HostBudget): Promise<HostResult>;
}

export interface ResidentLifecycleInput {
  readonly signal: AbortSignal;
  readonly budget: HostBudget;
  readonly processorRuntime: Pick<CompositionRoot['processorRuntime'], 'start'>;
  readonly activationSchedulerSubscriber: Pick<
    CompositionRoot['activationSchedulerSubscriber'],
    'start'
  >;
  readonly intakeResident: ResidentLifecycleHost;
  readonly runnerResident: ResidentLifecycleHost;
  readonly close: () => Promise<void>;
}

/** Starts one processor registry before its resident consumers. */
export async function runResidentLifecycle(input: ResidentLifecycleInput): Promise<HostResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal.aborted) abort();
  else input.signal.addEventListener('abort', abort, { once: true });
  let processorRun: ReturnType<ResidentLifecycleInput['processorRuntime']['start']> | undefined;
  let schedulerRun:
    ReturnType<ResidentLifecycleInput['activationSchedulerSubscriber']['start']> | undefined;
  let intakeRun: Promise<HostResult> | undefined;
  const failures: unknown[] = [];
  let result: HostResult | undefined;
  try {
    processorRun = input.processorRuntime.start(controller.signal);
    schedulerRun = input.activationSchedulerSubscriber.start(controller.signal);
    intakeRun = input.intakeResident.run(controller.signal, input.budget);
    result = await input.runnerResident.run(controller.signal, input.budget);
  } catch (error) {
    failures.push(error);
  } finally {
    captureCleanupFailure(failures, () => controller.abort());
    captureCleanupFailure(failures, () => processorRun?.abort());
    captureCleanupFailure(failures, () => schedulerRun?.abort());
    await captureAsyncCleanupFailure(failures, async () => {
      failures.push(
        ...(await settledRunFailures([intakeRun, processorRun?.done, schedulerRun?.done])),
      );
    });
    captureCleanupFailure(failures, () => input.signal.removeEventListener('abort', abort));
    await captureAsyncCleanupFailure(failures, () => input.close());
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Resident lifecycle failed');
  return result!;
}

interface ExecutionShutdown {
  shutdown(): Promise<void>;
}

export async function closeResidentRuntime(
  execution: ExecutionShutdown,
  closeResources: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  await captureAsyncCleanupFailure(failures, () => execution.shutdown());
  await captureAsyncCleanupFailure(failures, closeResources);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Resident execution and resource cleanup failed');
}

function captureCleanupFailure(failures: unknown[], cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    failures.push(error);
  }
}

async function captureAsyncCleanupFailure(
  failures: unknown[],
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
}

async function settledRunFailures(
  runs: readonly (Promise<unknown> | undefined)[],
): Promise<unknown[]> {
  const settled = await Promise.allSettled(runs.filter((run) => run !== undefined));
  return settled.flatMap((run) => (run.status === 'fulfilled' ? [] : [run.reason]));
}

async function waitForRunnerEvents(
  root: Pick<CompositionRoot, 'journal'>,
  priorPosition: Promise<number>,
  signal: AbortSignal,
  resident: { readonly pollBackoffMs: number; readonly maxPollBackoffMs?: number } | undefined,
  consecutiveIdleTicks: number,
  initializing: boolean,
): Promise<number> {
  let currentPosition = 0;
  try {
    const afterPosition = await priorPosition;
    currentPosition = initializing
      ? await sampleRunnerPosition(root)
      : await root.journal.latestGlobalPosition();
    await root.journal.waitForEventsAfter(afterPosition, signal, JOURNAL_CHANGE_FALLBACK_MS);
  } catch (error) {
    reportRunnerWaitError(error);
    await sleepUntilAbort(signal, nextPollBackoffMs(resident, consecutiveIdleTicks));
  }
  return currentPosition;
}

function sampleRunnerPosition(root: Pick<CompositionRoot, 'journal'>): Promise<number> {
  try {
    return root.journal.latestGlobalPosition().catch((error: unknown) => {
      reportRunnerWaitError(error);
      return 0;
    });
  } catch (error) {
    reportRunnerWaitError(error);
    return Promise.resolve(0);
  }
}

function reportRunnerWaitError(error: unknown): void {
  process.stderr.write(
    `Wake runner event wait failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}

function nextPollBackoffMs(
  resident: { readonly pollBackoffMs: number; readonly maxPollBackoffMs?: number } | undefined,
  consecutiveIdleTicks: number,
): number {
  const baseMs = resident?.pollBackoffMs ?? 1000;
  const maxMs = resident?.maxPollBackoffMs ?? baseMs * 16;
  return Math.min(baseMs * 2 ** Math.min(consecutiveIdleTicks, 20), maxMs);
}

function sleepUntilAbort(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function createHttpStarter(
  root: CompositionRoot,
  api: ApiApplications,
  servers: Set<FastifyInstance>,
) {
  return async (options: HostOptions = {}, web = false): Promise<void> => {
    const assets = web ? createPackagedAssetSource() : undefined;
    if (web && (await assets!.get('/index.html')) === undefined)
      throw new Error('Packaged Wake web assets are missing');
    const server = createSurfaceHttpServer({
      dispatcher: createApiDispatcher(api),
      credentials: await loadOrCreateCredentials(root.paths.wakeRoot),
      auth: {
        disabled: root.config.surfaces.web.auth.disabled,
        redeemGrant: (grant) =>
          redeemPairingGrant(root.paths.wakeRoot, grant, undefined, serialiseCredentialMutation),
      },
      ...(assets === undefined ? {} : { assets }),
    });
    servers.add(server);
    try {
      await server.listen({
        port: options.port ?? root.config.surfaces.api.port,
        host: options.host ?? root.config.surfaces.api.host,
      });
    } catch (error) {
      servers.delete(server);
      throw error;
    }
  };
}

function serialiseCredentialMutation<Value>(
  lockPath: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  return withFileLock(lockPath, operation, { waitMs: 5_000, retryIntervalMs: 10 });
}

function createDockerCliForRoot(root: CompositionRoot): DockerCli {
  return createLoggedDockerCli(
    {
      execute: (arguments_, onChunk, options) =>
        spawnDocker(arguments_, onChunk, root.paths.wakeRoot, options),
    },
    createProcessLogSink(
      join(root.paths.wakeRoot, 'logs', 'sandbox.log'),
      { write: (value) => process.stdout.write(value) },
      { maxBytes: 10 * 1024 * 1024 },
    ),
  );
}

function sandboxDockerOptions(
  root: CompositionRoot,
  overrides?: {
    readonly image?: string;
    readonly development?: SandboxDockerOptions['development'];
    readonly buildVersion?: string;
  },
): SandboxDockerOptions {
  return {
    wakeRoot: root.paths.wakeRoot,
    containerHomeRoot: root.paths.containerHomeRoot,
    image: overrides?.image ?? root.config.host.sandbox.image,
    development: overrides?.development ?? root.config.host.development,
    containerName: root.config.host.sandbox.containerName,
    ...(root.config.surfaces.api.enabled ? { publishedPort: root.config.surfaces.api.port } : {}),
    wakeMountPath: root.config.host.sandbox.wakeMountPath,
    containerHomeMountPath: root.config.host.sandbox.containerHomeMountPath,
    extraMounts: root.config.host.sandbox.extraMounts,
    startEnabled: root.config.host.sandbox.start.enabled,
    ...(process.env.WAKE_MEMORY_PROFILE === 'runner' ? { memoryProfile: 'runner' as const } : {}),
    inspect: createDockerInspection(root.paths.wakeRoot),
    resolveBuildVersion: async () =>
      overrides?.buildVersion === undefined
        ? resolveSandboxBuildVersion(root)
        : overrides.buildVersion,
  };
}

function createSandboxDocker(
  root: CompositionRoot,
  overrides?: {
    readonly image?: string;
    readonly development?: SandboxDockerOptions['development'];
    readonly buildVersion?: string;
  },
) {
  return createSandboxDockerPort(
    createDockerCliForRoot(root),
    sandboxDockerOptions(root, overrides),
  );
}

async function createSandboxDockerForCommand(root: CompositionRoot, arguments_: readonly string[]) {
  if (arguments_[0] !== 'build' || root.config.host.development.mode === 'source')
    return createSandboxDocker(root);
  const buildVersion = await createNpmUpdatePort({
    packageName: root.config.host.selfUpdate.npm.package,
    distTag: root.config.host.selfUpdate.npm.distTag,
    ...(root.config.host.selfUpdate.npm.registry === undefined
      ? {}
      : { registry: root.config.host.selfUpdate.npm.registry }),
  }).latestTag();
  return createSandboxDocker(root, { buildVersion });
}

async function resolveSandboxBuildVersion(root: CompositionRoot): Promise<string> {
  const development = root.config.host.development;
  return development.mode === 'source' && development.repoRoot !== undefined
    ? resolveWakeVersion({ repoRoot: development.repoRoot })
    : wakePackageVersion;
}

function sandboxWakeInvocation(root: CompositionRoot): readonly string[] {
  return root.config.host.development.mode === 'source'
    ? ['node', '/app/dist/src/main.js']
    : ['wake'];
}

async function activeExecutionRuns(root: CompositionRoot) {
  // advanceOnce skips recoverActive entirely while dispatch is paused, so a
  // Run whose lease already expired would otherwise never be recovered during
  // a maintenance quiesce wait. Recover it here so an owner that is truly gone
  // (no heartbeat, no lease renewal) reaches a terminal or ambiguous status
  // instead of sitting as active and blocking the update forever.
  await root.recovery.recoverActive('self-update', root.execution.isLocallyActive);
  // Ambiguous Runs are always terminal (finishedAt is set the moment escalation
  // occurs) and require an operator's `run-resolve`, not a maintenance drain or
  // cancellation. Treating them as active would deadlock every future update.
  return (await root.execution.list())
    .filter((run) => isActiveRunStatus(run.status))
    .map((run) => ({
      runId: run.runId,
      maintenanceCancellable: run.cancellation === undefined,
    }));
}

async function activeExecutionRunIds(root: CompositionRoot): Promise<readonly string[]> {
  return (await root.execution.list())
    .filter((run) => isActiveRunStatus(run.status))
    .map((run) => run.runId);
}

/** The production maintenance boundary shared by the CLI update application. */
export function createSelfUpdateQuiescePort(root: CompositionRoot): SelfUpdateQuiescePort {
  return {
    acquire: (tag, retryFailed) => root.maintenance.acquire(tag, retryFailed),
    exclusive: (tag, retryFailed, operation) =>
      root.maintenance.runExclusive(tag, retryFailed, operation),
    activeRuns: () => activeExecutionRuns(root),
    sleep: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
    fail: async (error, attemptId) => {
      await root.maintenance.fail(error, attemptId);
    },
    transition: async (phase, attemptId) => {
      await root.maintenance.transition(phase, attemptId);
    },
    clear: (attemptId) => root.maintenance.clear(attemptId),
  };
}

function createSandboxRuntimeApplications(root: CompositionRoot) {
  const docker = createSandboxDocker(root);
  const wakeInvocation = sandboxWakeInvocation(root);
  return {
    async hasDockerfile(): Promise<boolean> {
      try {
        await access(join(root.paths.wakeRoot, 'docker', 'Dockerfile'));
        return true;
      } catch {
        return false;
      }
    },
    async exec(arguments_: readonly string[]): Promise<void> {
      await docker.exec([...wakeInvocation, ...arguments_]);
    },
  };
}

/**
 * Builds a running self-update on the sandbox container onto a specific
 * image tag: rebuild the image, swap the container onto it, and confirm the
 * resident `wake start` process actually came back up. Reused for both the
 * forward deploy and a same-shaped rollback to a previously-built tag.
 */
async function deploySandboxTag(
  root: CompositionRoot,
  docker: DockerCli,
  tag: string,
  image: string,
  overrides?: {
    readonly development?: SandboxDockerOptions['development'];
    readonly buildVersion?: string;
  },
) {
  const port = createSandboxDockerPort(docker, sandboxDockerOptions(root, { image, ...overrides }));
  const wakeInvocation =
    overrides?.development?.mode === 'source'
      ? ['node', '/app/dist/src/main.js']
      : sandboxWakeInvocation(root);
  const healthcheckRoot = `/tmp/wake-self-update-healthcheck-${tag}`;
  await port.build();
  await port.update();
  await verifyResidentStart(
    docker,
    root.config.host.sandbox.containerName,
    [...wakeInvocation, 'start', '--wake-root', '/wake'].join(' '),
  );
  await port.exec([...wakeInvocation, 'init', healthcheckRoot]);
  await port.exec([...wakeInvocation, 'tick', '--wake-root', healthcheckRoot, '--no-sandbox']);
  await promoteSandboxImage(docker, image, root.config.host.sandbox.image);
}

async function rollbackSandboxTag(
  root: CompositionRoot,
  docker: DockerCli,
  image: string,
  development?: SandboxDockerOptions['development'],
) {
  const port = createSandboxDockerPort(docker, sandboxDockerOptions(root, { image }));
  await port.update();
  const wakeInvocation =
    development?.mode === 'source'
      ? ['node', '/app/dist/src/main.js']
      : sandboxWakeInvocation(root);
  await verifyResidentStart(
    docker,
    root.config.host.sandbox.containerName,
    [...wakeInvocation, 'start', '--wake-root', '/wake'].join(' '),
  );
  await promoteSandboxImage(docker, image, root.config.host.sandbox.image);
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
              await root.projectionSubscriptions.rebuild(definition);
          },
        },
      }),
    sandboxSetup: async (arguments_: readonly string[]) => {
      if (arguments_.length > 0) throw new Error('wake sandbox-setup accepts no arguments');
      await runSandboxSetup(
        createSandboxSetupDependencies(root.config.host.sandbox.containerHomeMountPath),
      );
    },
    sandbox: async (arguments_: readonly string[]) => {
      await runSandbox(arguments_, await createSandboxDockerForCommand(root, arguments_));
      // A manual sandbox replacement can recover a previously failed update,
      // but never clear an in-progress self-update owned by another process.
      if (
        arguments_[0] === 'update' &&
        (await root.maintenance.read())?.phase === UpdateMaintenancePhase.Failed
      )
        await root.maintenance.clear();
    },
    sandboxEntrypoint: async () => {
      await runSandboxEntrypoint(createSandboxEntrypointDependencies(root));
    },
    // eslint-disable-next-line complexity -- update source and loop options are validated at this CLI boundary.
    selfUpdate: async (arguments_: readonly string[]) => {
      const sourceRoot = optionalOperationalOption(arguments_, '--source');
      const configuredSource = root.config.host.development.mode === 'source';
      const repoRoot = sourceRoot ?? root.config.host.development.repoRoot;
      if (sourceRoot !== undefined && root.config.host.development.mode === 'source')
        throw new Error('wake self-update --source cannot override source-mode configuration');
      if (configuredSource && repoRoot === undefined)
        throw new Error('wake self-update requires host.development.repoRoot');
      const tag = optionalOperationalOption(arguments_, '--tag');
      const version = optionalOperationalOption(arguments_, '--version');
      if (tag !== undefined && version !== undefined)
        throw new Error('wake self-update accepts only one of --tag or --version');
      if (version !== undefined && (configuredSource || sourceRoot !== undefined))
        throw new Error('wake self-update --version is only valid for npm updates');
      const useSource = configuredSource || sourceRoot !== undefined;
      const updatePort = useSource
        ? createSourceUpdatePort({ repoRoot: repoRoot! })
        : createNpmUpdatePort({
            packageName: root.config.host.selfUpdate.npm.package,
            distTag: root.config.host.selfUpdate.npm.distTag,
            ...(root.config.host.selfUpdate.npm.registry === undefined
              ? {}
              : { registry: root.config.host.selfUpdate.npm.registry }),
          });
      const updateTag = tag ?? version;
      const updateDevelopment = useSource
        ? { mode: 'source' as const, repoRoot: repoRoot! }
        : { mode: 'packaged' as const };
      const dockerCli = createDockerCliForRoot(root);
      const imageRepository = root.config.host.sandbox.imageRepository;
      const failureLog = createSelfUpdateFailureLog(root.paths.wakeRoot);
      const application = createSelfUpdateApplication({
        ledger: createUpdateLedger(root.paths.wakeRoot),
        source: updatePort,
        rollout: {
          async deploy(deployTag) {
            await waitForActiveRuns({
              activeRunIds: () => activeExecutionRunIds(root),
              sleep: async (milliseconds) =>
                new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
            });
            await deploySandboxTag(root, dockerCli, deployTag, `${imageRepository}:${deployTag}`, {
              development: updateDevelopment,
              buildVersion: deployTag,
            });
            // A later deploy succeeding after a prior rollback clears the stale warning.
            await failureLog.clear();
          },
          async rollback(rollbackTag) {
            await rollbackSandboxTag(
              root,
              dockerCli,
              `${imageRepository}:${rollbackTag}`,
              updateDevelopment,
            );
          },
          recordFailure: (failedTag, error) => failureLog.record(failedTag, error),
        },
        quiesce: createSelfUpdateQuiescePort(root),
      });
      const force = arguments_.includes('--force');
      if (arguments_.includes('--loop')) {
        const intervalMs = selfUpdateLoopInterval(arguments_);
        if (updateTag !== undefined)
          return runSelfUpdateLatestLoop(
            async () => application.update(updateTag, force),
            () => delay(intervalMs),
            (message) => process.stderr.write(`${message}\n`),
          );
        return runSelfUpdateLatestLoop(
          async () => application.updateLatest(force),
          () => delay(intervalMs),
          (message) => process.stderr.write(`${message}\n`),
        );
      }
      if (updateTag !== undefined)
        return { tag: updateTag, updated: await application.update(updateTag, force) };
      return application.updateLatest(force);
    },
    smoke: async () =>
      runTargetSmoke(
        createRunnerRegistry(root.config.execution, root.fakeScenarios),
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
  options?: DockerInvokeOptions,
): Promise<DockerInvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [...arguments_],
      options?.interactive ? { cwd, stdio: 'inherit' } : { cwd },
    );
    if (options?.interactive) {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout: '', stderr: '' });
        else
          reject(
            new DockerProcessError(
              'docker ' + arguments_.join(' ') + ' exited with code ' + String(code),
              { stdout: '', stderr: '' },
            ),
          );
      });
      return;
    }
    let chain = Promise.resolve();
    let stdout = '';
    let stderr = '';
    const enqueue = (stream: DockerProcessChunk['stream'], text: string) => {
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      chain = chain.then(() => onChunk({ stream, text }));
    };
    child.stdout!.on('data', (buffer: Buffer) => enqueue('stdout', buffer.toString('utf8')));
    child.stderr!.on('data', (buffer: Buffer) => enqueue('stderr', buffer.toString('utf8')));
    child.on('error', (error) => {
      void chain.then(() =>
        reject(new DockerProcessError(error.message, { stdout, stderr }, error)),
      );
    });
    child.on('close', (code) => {
      void chain.then(() => {
        if (code === 0) resolve({ stdout, stderr });
        else {
          const detail = stderr.trim();
          reject(
            new DockerProcessError(
              `docker ${arguments_.join(' ')} exited with code ${String(code)}` +
                (detail.length > 0 ? `: ${detail}` : ''),
              { stdout, stderr },
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
    createRunnerRegistry(root.config.execution, root.fakeScenarios).resolve(
      root.config.execution.defaultRunnerPool,
    );
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
  await checkMaintenanceLease(root, failures);
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

// A retained maintenance lease pauses every resident loop (intake and
// dispatch) regardless of phase -- including Failed, since it's the
// operator's decision whether a failed attempt is safe to retry or clear.
// Without this check the pause is invisible: the process ticks normally and
// logs nothing, so a stuck lease from an update that couldn't quiesce active
// Runs looks identical to a healthy idle system.
async function checkMaintenanceLease(root: CompositionRoot, failures: string[]): Promise<void> {
  const lease = await root.maintenance.read();
  if (lease === null) return;
  const detail = lease.failure === undefined ? '' : ` (${lease.failure})`;
  failures.push(
    `update maintenance lease is held in phase "${lease.phase}" since ${lease.startedAt}${detail} -- ` +
      'every resident loop stays paused until it is cleared or resumes; run `wake self-update` ' +
      'to retry, or clear the lease manually if the attempt is abandoned',
  );
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
  for (const failure of root.providerFailures)
    failures.push(`provider "${failure.adapter}" failed to initialize: ${failure.error}`);
  if (
    root.providers.length === 0 &&
    root.providerFailures.length === 0 &&
    Object.keys(root.config.integrations).length > 0
  )
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
      `Docker sandbox image "${image}" was not found (or Docker is unavailable) — run \`wake sandbox build\` if this deployment uses the Docker sandbox`,
    ];
  const state = await inspect.containerState(containerName);
  if (state === 'halted')
    return [
      `Docker sandbox container "${containerName}" is stopped — run \`wake sandbox up\` to resume it`,
    ];
  if (state === null)
    return [
      `Docker sandbox container "${containerName}" was not found — run \`wake sandbox up\` if this deployment uses the Docker sandbox`,
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
        await root.projectionSubscriptions.rebuild(definition);
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

async function closeAll(servers: Set<FastifyInstance>): Promise<void> {
  await Promise.all(
    [...servers].map(async (server) => {
      if (!server.server.listening) return;
      await server.close();
      servers.delete(server);
    }),
  );
}

const DEFAULT_START_RESTART_DELAY_SECONDS = 10;

function createSandboxEntrypointDependencies(root: CompositionRoot): SandboxEntrypointDependencies {
  const logDirectory = join(root.paths.dataRoot, 'logs');
  const pidFile = join(logDirectory, 'start.pid');
  const startLogFile = join(logDirectory, 'start.log');
  const children = new Map<number, Promise<number>>();
  return {
    startEnabled: process.env.WAKE_START_ENABLED === 'true',
    restartDelaySeconds: resolveRestartDelaySeconds(process.env),
    wakeInvocation: sandboxWakeInvocation(root),
    pidFile,
    startLogFile,
    ensureLogDirectory: async () => {
      await mkdir(logDirectory, { recursive: true });
    },
    spawnDetached: (command, arguments_, options) => {
      const sink = createProcessLogSink(
        options.logFile,
        { write: () => {} },
        { maxBytes: 10 * 1024 * 1024 },
      );
      const child = spawn(command, [...arguments_], {
        cwd: root.paths.wakeRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      if (typeof child.pid !== 'number')
        throw new Error('failed to spawn detached wake start process');
      let closeStatus = 1;
      const closed = new Promise<void>((resolve) => {
        child.once('close', (code) => {
          closeStatus = code ?? 1;
          resolve();
        });
      });
      const drained = drainProcessOutput(
        child,
        sink,
        (value) => process.stderr.write(value),
        (error) => {
          process.stderr.write(
            `Wake detached start log failure: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        },
      );
      const completion = closed.then(() => drained).then(() => closeStatus);
      children.set(child.pid, completion);
      void completion.then(() => children.delete(child.pid!));
      child.unref();
      return { pid: child.pid };
    },
    waitForExit: async (pid) => children.get(pid) ?? 1,
    writeFile: (path, content) => writeFileContent(path, content, 'utf8'),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    waitForever,
    log: (message) => process.stdout.write(`${message}\n`),
  };
}

function resolveRestartDelaySeconds(env: NodeJS.ProcessEnv): number {
  const value = env.WAKE_START_RESTART_DELAY_SECONDS;
  if (value === undefined) return DEFAULT_START_RESTART_DELAY_SECONDS;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_START_RESTART_DELAY_SECONDS;
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
