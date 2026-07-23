#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  createDockerCli,
  type DockerCli,
  type DockerExecProcess,
} from './adapters/docker/docker-cli.js';
import { createFileBackedFakeTicketingSystem } from './adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from './adapters/fake/fake-workspace-manager.js';
import { createGitWorkspaceManager } from './adapters/git/git-workspace-manager.js';
import { createRunnerCliAdapter } from './adapters/runner/runner-cli-adapter.js';
import { createRegistryRunner, runnerKindForOverride } from './adapters/runner/runner-registry.js';
import { createResourceIndex } from './adapters/fs/resource-index.js';
import { createStateStore } from './adapters/fs/state-store.js';
import {
  readSelfUpdateLedger,
  writeSelfUpdateLedger,
  type SelfUpdateLedger,
} from './adapters/fs/self-update-ledger.js';
import { resolveGitHubToken } from './adapters/github/github-auth.js';
import { createGitHubArtifactVerifier } from './adapters/github/github-artifact-verifier.js';
import { createGitHubClient } from './adapters/github/github-client.js';
import { createGitHubIssuesWorkSource } from './adapters/github/github-issues-work-source.js';
import { createGitHubPullRequestActivitySource } from './adapters/github/github-pull-request-activity-source.js';
import { runCorrelateCommand } from './cli/correlate-command.js';
import { runDoctorCommand, type DoctorDeps } from './cli/doctor-command.js';
import { runInitCommand } from './cli/init-command.js';
import { runSandboxCommand } from './cli/sandbox-command.js';
import { runSandboxEntrypointCommand } from './cli/sandbox-entrypoint-command.js';
import { runSandboxSetupCommand } from './cli/sandbox-setup-command.js';
import { collectStartupPreflightFailures, runStartupPreflight } from './cli/startup-preflight.js';
import { runUiCommand } from './cli/ui-command.js';
import { loadWakeConfig } from './config/load-config.js';
import { createControlPlane } from './core/control-plane.js';
import { createOutboundSinkRouter, createWorkSourceFanIn } from './core/sink-router.js';
import { createTickRunner } from './core/tick-runner.js';
import { systemClock } from './lib/clock.js';
import { readJsonFile } from './lib/json-file.js';
import { configuredTicketSource } from './domain/sources.js';
import { wakeVersion } from './version.js';
import type { RunRecord, WakeConfig } from './domain/types.js';

function commandArgsBeforeTerminator(args: string[]): string[] {
  const terminatorIndex = args.indexOf('--');
  if (terminatorIndex === -1) {
    return args;
  }

  return args.slice(0, terminatorIndex);
}

export function readFlagBeforeCommandTerminator(name: string, args: string[]): string | undefined {
  const scopedArgs = commandArgsBeforeTerminator(args);
  const index = scopedArgs.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return scopedArgs[index + 1];
}

// Walks up from this file's own directory until it finds a package.json,
// rather than assuming a fixed number of directory levels — the file
// running is `dist/src/main.js` for a built/packaged install (two levels
// below the package root) but `src/main.ts` for a `tsx` dev invocation
// (only one level below), so a fixed `resolve(..., '..', '..')` overshoots
// the root by one directory in the latter case.
function resolvePackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate package root (no package.json found above ${dir})`);
    }

    dir = parent;
  }
}

export async function hasDockerfile(wakeRoot: string): Promise<boolean> {
  try {
    await access(resolve(wakeRoot, 'docker', 'Dockerfile'));
    return true;
  } catch {
    return false;
  }
}

function routesOnlyToFake(config: WakeConfig): boolean {
  return Object.values(config.tiers).every((candidates) => {
    const first = candidates[0];
    return first !== undefined && config.runners[first]?.kind === 'fake';
  });
}

async function resolveSelfLogin(
  githubClient: ReturnType<typeof createGitHubClient> | undefined,
): Promise<string | undefined> {
  if (githubClient === undefined) {
    return undefined;
  }

  try {
    return await githubClient.getAuthenticatedLogin();
  } catch (error) {
    console.error(
      `wake: failed to resolve authenticated GitHub login; continuing without self-login bot detection: ${String(error)}`,
    );
    return undefined;
  }
}

export function formatTickFailureDetails(runRecord: RunRecord | null): string | null {
  if (runRecord === null) {
    return null;
  }

  const summary = runRecord.summary?.trim();
  const exitCode =
    runRecord.metadata !== undefined && typeof runRecord.metadata.exitCode === 'number'
      ? runRecord.metadata.exitCode
      : undefined;
  const stderr =
    runRecord.metadata !== undefined && typeof runRecord.metadata.stderr === 'string'
      ? runRecord.metadata.stderr.trim()
      : '';

  if (summary === undefined && exitCode === undefined && stderr.length === 0) {
    return null;
  }

  const lines = ['Tick failure details:', `runId: ${runRecord.runId}`];

  if (exitCode !== undefined) {
    lines.push(`exitCode: ${exitCode}`);
  }

  if (summary !== undefined) {
    lines.push('', 'Summary:', summary);
  }

  if (stderr.length > 0) {
    lines.push('', 'stderr:', stderr);
  }

  return lines.join('\n');
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolveRun();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode ?? 1}`));
    });
  });
}

function parseGithubRepoSlug(remoteUrl: string): string {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl.trim());
  if (match === null) {
    throw new Error(`Could not parse a GitHub owner/repo from origin remote: ${remoteUrl}`);
  }

  return match[1] as string;
}

async function runCommandCapture(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolveRun(stdout);
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode ?? 1}`));
    });
  });
}

const codexBootstrapHome = '/home/wake/.codex';
const codexRuntimeHome = '/home/wake/.codex-runtime';
const sshHome = '/home/wake/.ssh';
const sshKeyPath = join(sshHome, 'id_ed25519');

async function prepareCodexHome(): Promise<void> {
  await mkdir(codexRuntimeHome, { recursive: true });

  const bootstrapConfig = join(codexBootstrapHome, 'config.toml');
  if (existsSync(bootstrapConfig)) {
    await copyFile(bootstrapConfig, join(codexRuntimeHome, 'config.toml'));
  }

  const bootstrapAuth = join(codexBootstrapHome, 'auth.json');
  const runtimeAuth = join(codexRuntimeHome, 'auth.json');
  if (existsSync(bootstrapAuth) && !existsSync(runtimeAuth)) {
    await copyFile(bootstrapAuth, runtimeAuth);
  }

  process.env.CODEX_HOME = codexRuntimeHome;
}

async function ensureSshKey(): Promise<void> {
  if (!existsSync(sshKeyPath)) {
    await mkdir(sshHome, { recursive: true, mode: 0o700 });
    await chmod(sshHome, 0o700);
    await runCommand('ssh-keygen', ['-t', 'ed25519', '-f', sshKeyPath, '-N', '']);
  }

  // Display the public key to the user
  const publicKeyPath = join(sshHome, 'id_ed25519.pub');
  const publicKey = await readFile(publicKeyPath, 'utf-8');
  console.log(publicKey);
}

async function promptYesNo(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function runSandboxSetup(): Promise<void> {
  await runSandboxSetupCommand({
    prompt: promptYesNo,
    runInteractive: (command, args) => runCommand(command, args),
    ensureSshKey,
    prepareCodexHome,
    log: (message) => console.log(message),
  });
}

const NGROK_TUNNELS_URL = 'http://127.0.0.1:4040/api/tunnels';
const NGROK_DISCOVERY_ATTEMPTS = 30;
const NGROK_DISCOVERY_INTERVAL_MS = 1000;

async function discoverNgrokUrl(): Promise<string | undefined> {
  for (let attempt = 0; attempt < NGROK_DISCOVERY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(NGROK_TUNNELS_URL, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const body = (await response.json()) as { tunnels?: Array<{ public_url?: unknown }> };
        const tunnels = body.tunnels ?? [];
        const httpsTunnel = tunnels.find(
          (tunnel) =>
            typeof tunnel.public_url === 'string' && tunnel.public_url.startsWith('https://'),
        );
        const anyTunnel =
          httpsTunnel ?? tunnels.find((tunnel) => typeof tunnel.public_url === 'string');
        if (typeof anyTunnel?.public_url === 'string') {
          return anyTunnel.public_url;
        }
      }
    } catch {
      // ignore and retry
    }

    await new Promise((resolveSleep) => setTimeout(resolveSleep, NGROK_DISCOVERY_INTERVAL_MS));
  }

  return undefined;
}

function createSandboxEntrypointDeps(): Parameters<typeof runSandboxEntrypointCommand>[0] {
  const children = new Map<number, ChildProcess>();

  return {
    env: process.env,
    spawnDetached: (command, args, options) => {
      const logFd = options?.logFile !== undefined ? openSync(options.logFile, 'a') : 'ignore';
      const child = spawn(command, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', logFd, logFd],
        detached: true,
      });

      if (typeof child.pid === 'number') {
        children.set(child.pid, child);
      }

      // Registered here (at spawn time) so it runs before any exit listener
      // waitForExit attaches later — though it wouldn't matter either way:
      // waitForExit captures the ChildProcess reference synchronously from
      // `children` when it's called (before the child can possibly have
      // exited) and attaches its own listener directly to that reference,
      // so it never re-reads `children` inside the exit callback. Deleting
      // the map entry here is therefore safe regardless of ordering.
      child.on('exit', () => {
        if (typeof child.pid === 'number') {
          children.delete(child.pid);
        }
        if (logFd !== 'ignore') {
          closeSync(logFd);
        }
      });

      return { pid: child.pid ?? -1 };
    },
    waitForExit: (pid) =>
      new Promise((resolveExit) => {
        const child = children.get(pid);
        if (child === undefined) {
          resolveExit(1);
          return;
        }

        child.on('exit', (code) => resolveExit(code ?? 1));
      }),
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    discoverNgrokUrl,
    log: (message) => console.log(message),
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    removeFile: (path) => rm(path, { force: true }),
  };
}

async function runSandboxEntrypoint(): Promise<void> {
  await runSandboxEntrypointCommand(createSandboxEntrypointDeps());
}

async function readTickRequestId(path: string): Promise<string | null> {
  try {
    const request = await readJsonFile<{ requestId?: unknown }>(path);
    return typeof request.requestId === 'string' && request.requestId.length > 0
      ? request.requestId
      : null;
  } catch {
    return null;
  }
}

async function inspectDockerImage(image: string): Promise<boolean> {
  return await new Promise<boolean>((resolveInspect, reject) => {
    const child = spawn('docker', ['image', 'inspect', image], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'ignore',
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolveInspect(exitCode === 0);
    });
  });
}

async function inspectDockerContainer(
  containerName: string,
): Promise<'running' | 'stopped' | null> {
  return await new Promise<'running' | 'stopped' | null>((resolveInspect, reject) => {
    const child = spawn(
      'docker',
      ['container', 'inspect', '-f', '{{.State.Running}}', containerName],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        resolveInspect(null);
        return;
      }

      resolveInspect(stdout.trim() === 'true' ? 'running' : 'stopped');
    });
  });
}

async function dockerDaemonReachable(): Promise<boolean> {
  return await new Promise<boolean>((resolveReachable) => {
    const child = spawn('docker', ['info'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'ignore',
    });

    child.on('error', () => resolveReachable(false));
    child.on('close', (exitCode) => resolveReachable(exitCode === 0));
  });
}

/**
 * Builds the same `DockerCli` client the `sandbox` command path uses, so
 * `wake doctor`'s Docker/sandbox reachability checks reuse one Docker CLI
 * invocation implementation instead of duplicating it.
 */
function createHostDockerCli(): DockerCli {
  return createDockerCli({
    // BuildKit is required for the Dockerfile's cache-mount syntax
    // (`RUN --mount=type=cache`), which keeps `npm`/`apt` package
    // caches warm across builds even when a layer above them changes.
    run: (dockerArgs) => runCommand('docker', dockerArgs, { ...process.env, DOCKER_BUILDKIT: '1' }),
    inspectImage: inspectDockerImage,
    inspectContainer: inspectDockerContainer,
    spawnExec: (dockerArgs) => {
      const child = spawn('docker', dockerArgs, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      // stdio: ['inherit', 'pipe', 'pipe'] guarantees stdout/stderr are
      // non-null pipes; child_process's types don't encode that.
      return child as unknown as DockerExecProcess;
    },
  });
}

/**
 * Runs `wake version` inside the sandbox container via `docker exec` and
 * returns the trimmed stdout, so `wake doctor` can compare it against the
 * installed host CLI version. Stderr is discarded (surfaced only as an
 * empty/mismatched version, which the caller already treats as a notice).
 */
async function execVersionInContainer(
  docker: DockerCli,
  containerName: string,
  devMode: 'source' | 'packaged' | undefined,
): Promise<string> {
  let stdout = '';
  const command =
    devMode === 'source' ? ['node', '/app/dist/src/main.js', 'version'] : ['wake', 'version'];
  await docker.execCaptured(containerName, command, {
    onStdout: (line) => {
      stdout += line;
    },
    onStderr: () => {},
  });
  return stdout.trim();
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Compares the wake-home's `prompts/*.md` and `docker/Dockerfile` (both
 * user-owned files, never auto-overwritten after scaffolding — see
 * `scaffold-assets.ts`/`sandbox-command.ts`'s `ensureDockerfile`) against the
 * currently-shipped defaults under `resolvePackageRoot()`, byte-for-byte.
 * Only files present in *both* locations are compared: a prompt file the
 * user hasn't customized locally, or one only shipped in a newer/older CLI
 * version, is not drift.
 */
async function diffPromptsAndDockerfile(input: {
  wakeRoot: string;
  packageRoot: string;
  devMode: 'source' | 'packaged' | undefined;
}): Promise<string[]> {
  const drifted: string[] = [];

  let promptFileNames: string[];
  try {
    promptFileNames = (await readdir(resolve(input.wakeRoot, 'prompts'))).filter((name) =>
      name.endsWith('.md'),
    );
  } catch {
    promptFileNames = [];
  }

  for (const fileName of promptFileNames) {
    const local = await readFileIfExists(resolve(input.wakeRoot, 'prompts', fileName));
    const shipped = await readFileIfExists(resolve(input.packageRoot, 'prompts', fileName));
    if (local !== null && shipped !== null && local !== shipped) {
      drifted.push(`prompts/${fileName}`);
    }
  }

  // Mirrors ensureDockerfile's template selection in sandbox-command.ts: a
  // "source" dev mode wake-home was seeded from docker/Dockerfile, a
  // "packaged" one from docker/Dockerfile.packaged.
  const dockerfileTemplateName =
    (input.devMode ?? 'packaged') === 'source' ? 'Dockerfile' : 'Dockerfile.packaged';
  const localDockerfile = await readFileIfExists(resolve(input.wakeRoot, 'docker', 'Dockerfile'));
  const shippedDockerfile = await readFileIfExists(
    resolve(input.packageRoot, 'docker', dockerfileTemplateName),
  );
  if (
    localDockerfile !== null &&
    shippedDockerfile !== null &&
    localDockerfile !== shippedDockerfile
  ) {
    drifted.push('docker/Dockerfile');
  }

  return drifted;
}

export async function buildRuntime(args: string[]) {
  const wakeRoot = resolve(readFlagBeforeCommandTerminator('--wake-root', args) ?? process.cwd());
  const stateStore = createStateStore({ wakeRoot });
  await stateStore.ensureWakeRoot();

  const config = await loadWakeConfig({
    wakeRoot,
    configFile: stateStore.paths.configFile,
  });
  await stateStore.writeConfig(config);

  const resourceIndex = createResourceIndex({ paths: stateStore.paths });

  const prTrackingEnabled =
    config.sources.github.enabled && config.sources.github.pullRequests.enabled;

  // Resolved once and shared: resolveGitHubToken shells out to `gh auth
  // token`, so building a separate client per consumer would triple that
  // subprocess spawn on every startup for no benefit — all three consumers
  // talk to the same GitHub account under the same config.
  const githubClient = config.sources.github.enabled
    ? createGitHubClient(await resolveGitHubToken())
    : undefined;

  // Resolved once alongside the client: the login Wake itself posts as, so
  // both GitHub work sources can recognize a comment Wake's own agent posted
  // by direct API/CLI call (not through formatWakeComment, so it never
  // carries the wake:agent marker) as bot-authored instead of a fresh human
  // reply that would re-trigger another run against itself.
  const selfLogin = await resolveSelfLogin(githubClient);

  const artifactVerifier =
    prTrackingEnabled && githubClient !== undefined
      ? createGitHubArtifactVerifier({ client: githubClient })
      : undefined;

  const ticketingSystem =
    githubClient !== undefined
      ? createGitHubIssuesWorkSource({
          client: githubClient,
          stateStore,
          config,
          resourceIndex,
          now: () => systemClock.now(),
          ...(selfLogin === undefined ? {} : { selfLogin }),
        })
      : await createFileBackedFakeTicketingSystem({
          fixturePath: stateStore.paths.issueFixtureFile,
          now: () => systemClock.now(),
        });
  const sourceName = configuredTicketSource(config);
  const sinkName = sourceName;

  const pullRequestActivitySource =
    prTrackingEnabled && githubClient !== undefined
      ? createGitHubPullRequestActivitySource({
          client: githubClient,
          stateStore,
          config,
          resourceIndex,
          now: () => systemClock.now(),
          ...(selfLogin === undefined ? {} : { selfLogin }),
        })
      : null;

  const workSource = createWorkSourceFanIn([
    {
      source: sourceName,
      pollEvents: ticketingSystem.pollEvents,
    },
    ...(pullRequestActivitySource === null
      ? []
      : [{ source: 'github-pr', pollEvents: pullRequestActivitySource.pollEvents }]),
  ]);
  const outboundSink = createOutboundSinkRouter({
    sinks: [
      {
        sink: sinkName,
        deliverIntent: ticketingSystem.deliverIntent,
      },
      ...(pullRequestActivitySource === null
        ? []
        : [{ sink: 'github-pr', deliverIntent: pullRequestActivitySource.deliverIntent }]),
    ],
    config,
  });

  const runnerOverride = readFlagBeforeCommandTerminator('--runner', args);
  if (
    runnerOverride !== undefined &&
    runnerOverride !== 'fake' &&
    config.runners[runnerOverride] === undefined
  ) {
    throw new Error(`Unsupported runner override: ${runnerOverride}`);
  }

  const runner = createRegistryRunner({
    config,
    cwd: process.cwd(),
    ...(runnerOverride === undefined ? {} : { override: runnerOverride }),
  });

  const workspaceManager = (
    runnerOverride !== undefined
      ? runnerKindForOverride(config, runnerOverride) === 'fake'
      : routesOnlyToFake(config)
  )
    ? createFakeWorkspaceManager(stateStore.paths.workspaceRoot)
    : createGitWorkspaceManager({ wakeRoot });
  const tickRunner = createTickRunner({
    clock: systemClock,
    config,
    stateStore,
    workSource,
    outboundSink,
    runner,
    workspaceManager,
    resourceIndex,
    ...(artifactVerifier === undefined ? {} : { artifactVerifier }),
  });

  return {
    config,
    runnerAdapter: null,
    runner,
    stateStore,
    tickRunner,
    workspaceManager,
  };
}

async function runTick(args: string[]) {
  const runtime = await buildRuntime(args);
  const outcome = await runtime.tickRunner.runTick();
  console.log(JSON.stringify(outcome, null, 2));

  if (
    outcome.status !== 'processed' ||
    outcome.sentinel !== 'FAILED' ||
    outcome.runId === undefined
  ) {
    return;
  }

  const runRecord = await runtime.stateStore.readRunRecord(outcome.runId);
  const details = formatTickFailureDetails(runRecord);
  if (details !== null) {
    console.error(details);
  }
}

async function runStart(args: string[]) {
  const runtime = await buildRuntime(args);
  const runnerOverride = readFlagBeforeCommandTerminator('--runner', args);
  await runStartupPreflight(runtime.config, {
    ...(runnerOverride === undefined ? {} : { runnerOverride }),
    workspaceManager: runtime.workspaceManager,
  });
  const controlPlane = createControlPlane({
    tickRunner: runtime.tickRunner,
    intervalMs: runtime.config.scheduler.intervalMs,
    maxIntervalMs: runtime.config.scheduler.maxIntervalMs,
    isPaused: () => runtime.stateStore.isPaused(),
    logger: {
      info(message) {
        console.log(message);
      },
      error(message) {
        console.error(message);
      },
    },
    sleep(ms) {
      return new Promise((resolveSleep) => {
        setTimeout(resolveSleep, ms);
      });
    },
    readTickRequest() {
      return readTickRequestId(runtime.stateStore.paths.tickRequestFile);
    },
  });

  const stop = () => controlPlane.stop();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await controlPlane.start();
}

function resolveSmokEntry(
  config: WakeConfig,
  kind?: 'claude' | 'codex' | 'cursor',
): Exclude<WakeConfig['runners'][string], { kind: 'fake' }> | null {
  for (const entry of Object.values(config.runners)) {
    if (entry.kind === 'fake') {
      continue;
    }
    if (kind === undefined || entry.kind === kind) {
      return entry;
    }
  }
  return null;
}

async function runUi(args: string[]) {
  const wakeRoot = resolve(readFlagBeforeCommandTerminator('--wake-root', args) ?? process.cwd());
  const stateStore = createStateStore({ wakeRoot });
  await stateStore.ensureWakeRoot();
  const config = await loadWakeConfig({
    wakeRoot,
    configFile: stateStore.paths.configFile,
  });

  const server = await runUiCommand({
    args,
    stateStore,
    resourceIndex: createResourceIndex({ paths: stateStore.paths }),
    config,
    readFlag: readFlagBeforeCommandTerminator,
  });

  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await new Promise(() => {});
}

async function runCorrelate(args: string[]) {
  const wakeRoot = resolve(readFlagBeforeCommandTerminator('--wake-root', args) ?? process.cwd());
  const stateStore = createStateStore({ wakeRoot });
  await stateStore.ensureWakeRoot();

  await runCorrelateCommand({
    args,
    stateStore,
    resourceIndex: createResourceIndex({ paths: stateStore.paths }),
    clock: systemClock,
    readFlag: readFlagBeforeCommandTerminator,
  });
}

async function runSmoke(args: string[]) {
  const runtime = await buildRuntime(args);
  const explicitKind =
    args[0] === 'claude' || args[0] === 'codex' || args[0] === 'cursor' ? args[0] : undefined;
  const smokeArgs = explicitKind === undefined ? args : args.slice(1);

  const entry = resolveSmokEntry(runtime.config, explicitKind);
  if (entry === null) {
    throw new Error(
      'Smoke tests require a real runner entry (`claude`, `codex`, or `cursor`) in config.runners.',
    );
  }

  const runnerAdapter = createRunnerCliAdapter({
    entry,
    cwd: process.cwd(),
  });
  const result = await runnerAdapter.smoke(smokeArgs);
  console.log(JSON.stringify(result, null, 2));
}

async function runDoctor(args: string[]) {
  const wakeRoot = resolve(readFlagBeforeCommandTerminator('--wake-root', args) ?? process.cwd());
  const stateStore = createStateStore({ wakeRoot });
  await stateStore.ensureWakeRoot();
  const config = await loadWakeConfig({
    wakeRoot,
    configFile: stateStore.paths.configFile,
  });

  const docker = createHostDockerCli();
  const packageRoot = resolvePackageRoot();
  const containerName = config.sandbox.containerName;
  const image = config.sandbox.image;

  const deps: DoctorDeps = {
    collectPreflightFailures: (doctorConfig) => collectStartupPreflightFailures(doctorConfig),
    resolveGitHubToken,
    hasDockerfile,
    dockerReachable: dockerDaemonReachable,
    inspectImage: async (imageToInspect) => {
      try {
        return await inspectDockerImage(imageToInspect);
      } catch {
        return false;
      }
    },
    wakeRoot,
    image,
    containerRunning: async () => (await inspectDockerContainer(containerName)) === 'running',
    execVersionInContainer: () => execVersionInContainer(docker, containerName, config.dev?.mode),
    installedVersion: wakeVersion,
    diffPromptsAndDockerfile: () =>
      diffPromptsAndDockerfile({ wakeRoot, packageRoot, devMode: config.dev?.mode }),
  };

  const report = await runDoctorCommand(config, deps);

  if (report.failures.length > 0) {
    console.log('Failures:');
    for (const failure of report.failures) {
      console.log(`  - ${failure}`);
    }
  }

  if (report.notices.length > 0) {
    console.log('Notices:');
    for (const notice of report.notices) {
      console.log(`  - ${notice}`);
    }
  }

  if (report.failures.length === 0 && report.notices.length === 0) {
    console.log('wake doctor: no issues found');
  }

  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}

export class CliUsageError extends Error {}

export function printUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    [
      'Wake — an autonomous agent control plane for software development.',
      '',
      'Usage:',
      '  wake init <path>           Scaffold a new Wake home directory',
      '  wake sandbox <subcommand>  Build/run/manage the Docker sandbox (build, up, update, down, stop, self-update, setup, exec, logs, resume)',
      '  wake tick                  Run one control-plane tick',
      '  wake start                 Run the resident loop',
      '  wake stop                  Stop the sandbox container gracefully',
      '  wake smoke                 Smoke-test the configured runner',
      '  wake ui                    Run the control-plane UI server',
      '  wake correlate             Manually correlate a resource to a work item',
      '  wake doctor                Diagnose config/GitHub/Docker/sandbox setup problems',
      '  wake version               Print the installed Wake version',
      '  wake --help                Show this message',
      '',
      'Getting started:',
      '  1. wake init ./wake-home',
      '  2. cd wake-home && wake start',
      '',
      'Runtime commands (tick/start/ui/smoke/correlate) auto-delegate into the sandbox',
      'when docker/Dockerfile exists at --wake-root (i.e. after `wake sandbox build`),',
      'defaulting --wake-root to the current directory. Pass --host to run directly',
      'on the host instead.',
      '',
    ].join('\n'),
  );
}

const runtimeCommands = new Set(['tick', 'start', 'ui', 'smoke', 'correlate']);

export async function dispatchMainCommand(input: {
  args: string[];
  runInit: (args: string[]) => Promise<unknown>;
  runSandbox: (args: string[]) => Promise<unknown>;
  runSandboxSetup: (args: string[]) => Promise<unknown>;
  runSandboxEntrypoint: (args: string[]) => Promise<unknown>;
  runTick: (args: string[]) => Promise<unknown>;
  runStart: (args: string[]) => Promise<unknown>;
  runSmoke: (args: string[]) => Promise<unknown>;
  runUi: (args: string[]) => Promise<unknown>;
  runCorrelate: (args: string[]) => Promise<unknown>;
  execIntoSandbox: (args: string[]) => Promise<unknown>;
  runDoctor: (args: string[]) => Promise<unknown>;
}) {
  const command = input.args[0] ?? 'help';
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(wakeVersion);
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage(process.stdout);
    return;
  }

  if (command === 'init') {
    await input.runInit(input.args.slice(1));
    return;
  }

  if (command === 'sandbox') {
    await input.runSandbox(input.args.slice(1));
    return;
  }

  if (command === 'sandbox-setup') {
    await input.runSandboxSetup(input.args.slice(1));
    return;
  }

  if (command === 'sandbox-entrypoint') {
    await input.runSandboxEntrypoint(input.args.slice(1));
    return;
  }

  if (command === 'stop') {
    await input.runSandbox(['stop', ...input.args.slice(1)]);
    return;
  }

  if (command === 'doctor') {
    // Host-only, like init/sandbox/stop above: doctor's job is to report on
    // sandbox reachability from the outside, so it must never auto-delegate
    // into the sandbox the way runtimeCommands below does.
    await input.runDoctor(input.args.slice(1));
    return;
  }

  if (runtimeCommands.has(command)) {
    const commandArgs = input.args.slice(1);
    const wakeRoot = resolve(
      readFlagBeforeCommandTerminator('--wake-root', commandArgs) ?? process.cwd(),
    );
    const host = commandArgs.includes('--host');

    if (!host && (await hasDockerfile(wakeRoot))) {
      await input.execIntoSandbox(input.args);
      return;
    }

    const hostArgs = commandArgs.filter((arg) => arg !== '--host');
    if (command === 'tick') {
      await input.runTick(hostArgs);
    } else if (command === 'start') {
      await input.runStart(hostArgs);
    } else if (command === 'ui') {
      await input.runUi(hostArgs);
    } else if (command === 'smoke') {
      await input.runSmoke(hostArgs);
    } else {
      await input.runCorrelate(hostArgs);
    }
    return;
  }

  printUsage(process.stderr);
  throw new CliUsageError(`Unknown command: ${input.args.join(' ')}`);
}

async function main() {
  const args = process.argv.slice(2);

  const runSandbox = async (commandArgs: string[]) => {
    const wakeRoot = resolve(
      readFlagBeforeCommandTerminator('--wake-root', commandArgs) ?? process.cwd(),
    );
    const stateStore = createStateStore({ wakeRoot });
    await stateStore.ensureWakeRoot();
    const config = await loadWakeConfig({
      wakeRoot,
      configFile: stateStore.paths.configFile,
    });
    const docker = createHostDockerCli();

    const repoRoot = config.dev?.repoRoot;
    const selfUpdate =
      commandArgs[0] === 'self-update' &&
      config.dev?.mode === 'source' &&
      repoRoot !== undefined &&
      repoRoot.length > 0
        ? {
            git: {
              latestTag: async () => {
                await runCommand('git', ['-C', repoRoot, 'fetch', '--tags']);
                const output = await runCommandCapture('git', [
                  '-C',
                  repoRoot,
                  'tag',
                  '--list',
                  'v*',
                  '--sort=-v:refname',
                ]);
                const [latest] = output.split('\n').filter((line) => line.trim().length > 0);
                if (latest === undefined) {
                  throw new Error('No version tags found in repo');
                }
                return latest.trim();
              },
              isWorkingTreeClean: async () => {
                const output = await runCommandCapture('git', [
                  '-C',
                  repoRoot,
                  'status',
                  '--porcelain',
                ]);
                return output.trim().length === 0;
              },
              checkoutTag: async (tag: string) => {
                await runCommand('git', ['-C', repoRoot, 'checkout', tag]);
              },
            },
            issueReporter: {
              createIssue: async (issue: { title: string; body: string }) => {
                const remoteUrl = await runCommandCapture('git', [
                  '-C',
                  repoRoot,
                  'remote',
                  'get-url',
                  'origin',
                ]);
                const repoSlug = parseGithubRepoSlug(remoteUrl);
                await runCommand('gh', [
                  'issue',
                  'create',
                  '--repo',
                  repoSlug,
                  '--title',
                  issue.title,
                  '--body',
                  issue.body,
                ]);
              },
            },
            readLedger: () => readSelfUpdateLedger(resolve(wakeRoot, 'self-update-ledger.json')),
            writeLedger: (ledger: SelfUpdateLedger) =>
              writeSelfUpdateLedger(resolve(wakeRoot, 'self-update-ledger.json'), ledger),
          }
        : undefined;

    await runSandboxCommand({
      args: commandArgs,
      config,
      wakeRoot,
      containerHomeRoot: stateStore.paths.containerHomeRoot,
      docker,
      packagedTemplatesRoot: resolve(resolvePackageRoot(), 'docker'),
      stateStore,
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      logger: {
        info(message) {
          console.log(message);
        },
        error(message) {
          console.error(message);
        },
      },
      selfUpdate,
    });
  };

  await dispatchMainCommand({
    args,
    runInit: async (commandArgs) => {
      await runInitCommand({
        cwd: process.cwd(),
        args: commandArgs,
        repoRoot: resolvePackageRoot(),
      });
    },
    runSandbox,
    runSandboxSetup: async () => {
      await runSandboxSetup();
    },
    runSandboxEntrypoint: async () => {
      await runSandboxEntrypoint();
    },
    runTick,
    runStart,
    runSmoke,
    runUi,
    runCorrelate,
    execIntoSandbox: async (commandArgs) => {
      const withoutHostFlag = commandArgs.filter((arg) => arg !== '--host');
      const wakeRootIndex = withoutHostFlag.indexOf('--wake-root');
      const rewritten =
        wakeRootIndex === -1
          ? [...withoutHostFlag, '--wake-root', '/wake']
          : withoutHostFlag.map((arg, index) => (index === wakeRootIndex + 1 ? '/wake' : arg));

      const wakeRoot = resolve(
        readFlagBeforeCommandTerminator('--wake-root', commandArgs) ?? process.cwd(),
      );
      const stateStore = createStateStore({ wakeRoot });
      await stateStore.ensureWakeRoot();
      const config = await loadWakeConfig({
        wakeRoot,
        configFile: stateStore.paths.configFile,
      });
      const wakeInvocation =
        config.dev?.mode === 'source' ? ['node', '/app/dist/src/main.js'] : ['wake'];

      await runSandbox(['exec', '--', ...wakeInvocation, ...rewritten]);
    },
    runDoctor,
  });
}

main().catch((error) => {
  if (error instanceof CliUsageError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
