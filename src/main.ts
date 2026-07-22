#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { createDockerCli, type DockerExecProcess } from './adapters/docker/docker-cli.js';
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
import { runInitCommand } from './cli/init-command.js';
import { runSandboxCommand } from './cli/sandbox-command.js';
import { runSandboxSetupCommand } from './cli/sandbox-setup-command.js';
import { runStartupPreflight } from './cli/startup-preflight.js';
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

function resolvePackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
      '  wake version               Print the installed Wake version',
      '  wake --help                Show this message',
      '',
      'Getting started:',
      '  1. wake init ./wake-home',
      '  2. cd wake-home && ./wake.sh start   (or ./wake.ps1 start on Windows)',
      '',
      'Runtime commands (tick/start/ui/smoke/correlate) auto-delegate into the sandbox',
      'when docker/Dockerfile exists at --wake-root (i.e. after `wake sandbox build`),',
      'the same way the generated wake.sh/wake.ps1 launcher does. Pass --host to run',
      'directly on the host instead.',
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
  runTick: (args: string[]) => Promise<unknown>;
  runStart: (args: string[]) => Promise<unknown>;
  runSmoke: (args: string[]) => Promise<unknown>;
  runUi: (args: string[]) => Promise<unknown>;
  runCorrelate: (args: string[]) => Promise<unknown>;
  execIntoSandbox: (args: string[]) => Promise<unknown>;
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

  if (command === 'stop') {
    await input.runSandbox(['stop', ...input.args.slice(1)]);
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
    const docker = createDockerCli({
      // BuildKit is required for the Dockerfile's cache-mount syntax
      // (`RUN --mount=type=cache`), which keeps `npm`/`apt` package
      // caches warm across builds even when a layer above them changes.
      run: (dockerArgs) =>
        runCommand('docker', dockerArgs, { ...process.env, DOCKER_BUILDKIT: '1' }),
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

      await runSandbox(['exec', '--', 'node', '/app/dist/src/main.js', ...rewritten]);
    },
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
