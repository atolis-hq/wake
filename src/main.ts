import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { createDockerCli } from './adapters/docker/docker-cli.js';
import { createFileBackedFakeTicketingSystem } from './adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from './adapters/fake/fake-workspace-manager.js';
import { createGitWorkspaceManager } from './adapters/git/git-workspace-manager.js';
import { createRunnerCliAdapter } from './adapters/runner/runner-cli-adapter.js';
import {
  createRegistryRunner,
  runnerKindForOverride,
} from './adapters/runner/runner-registry.js';
import { createStateStore } from './adapters/fs/state-store.js';
import {
  readSelfUpdateLedger,
  writeSelfUpdateLedger,
  type SelfUpdateLedger,
} from './adapters/fs/self-update-ledger.js';
import { resolveGitHubToken } from './adapters/github/github-auth.js';
import { createGitHubClient } from './adapters/github/github-client.js';
import { createGitHubIssuesWorkSource } from './adapters/github/github-issues-work-source.js';
import { runInitCommand } from './cli/init-command.js';
import { runSandboxCommand } from './cli/sandbox-command.js';
import { runUiCommand } from './cli/ui-command.js';
import { loadWakeConfig } from './config/load-config.js';
import { createControlPlane } from './core/control-plane.js';
import { createTickRunner } from './core/tick-runner.js';
import { systemClock } from './lib/clock.js';
import type { RunRecord, WakeConfig } from './domain/types.js';

function commandArgsBeforeTerminator(args: string[]): string[] {
  const terminatorIndex = args.indexOf('--');
  if (terminatorIndex === -1) {
    return args;
  }

  return args.slice(0, terminatorIndex);
}

export function readFlagBeforeCommandTerminator(
  name: string,
  args: string[],
): string | undefined {
  const scopedArgs = commandArgsBeforeTerminator(args);
  const index = scopedArgs.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return scopedArgs[index + 1];
}

function hasFlag(name: string, args: string[]): boolean {
  return commandArgsBeforeTerminator(args).includes(name);
}

function routesOnlyToFake(config: WakeConfig): boolean {
  return Object.values(config.tiers).every((candidates) => {
    const first = candidates[0];
    return first !== undefined && config.runners[first]?.kind === 'fake';
  });
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

async function inspectDockerContainer(containerName: string): Promise<'running' | 'stopped' | null> {
  return await new Promise<'running' | 'stopped' | null>((resolveInspect, reject) => {
    const child = spawn('docker', ['container', 'inspect', '-f', '{{.State.Running}}', containerName], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

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

async function buildRuntime(args: string[]) {
  const wakeRoot = resolve(
    readFlagBeforeCommandTerminator('--wake-root', args) ?? resolve(process.cwd(), '.wake'),
  );
  const stateStore = createStateStore({ wakeRoot });
  await stateStore.ensureWakeRoot();

  const config = await loadWakeConfig({
    wakeRoot,
    configFile: stateStore.paths.configFile,
  });
  await stateStore.writeConfig(config);

  const ticketingSystem = config.sources.github.enabled
    ? createGitHubIssuesWorkSource({
        client: createGitHubClient(await resolveGitHubToken()),
        stateStore,
        config,
        now: () => systemClock.now(),
      })
    : await createFileBackedFakeTicketingSystem({
        fixturePath: stateStore.paths.issueFixtureFile,
        now: () => systemClock.now(),
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

  const workspaceManager =
    (runnerOverride !== undefined
      ? runnerKindForOverride(config, runnerOverride) === 'fake'
      : routesOnlyToFake(config))
      ? createFakeWorkspaceManager(stateStore.paths.workspaceRoot)
      : createGitWorkspaceManager({ wakeRoot });
  const tickRunner = createTickRunner({
    clock: systemClock,
    config,
    stateStore,
    workSource: ticketingSystem,
    outboundSink: ticketingSystem,
    runner,
    workspaceManager,
  });

  return {
    config,
    runnerAdapter: null,
    runner,
    stateStore,
    tickRunner,
  };
}

async function runTick(args: string[]) {
  const runtime = await buildRuntime(args);
  const outcome = await runtime.tickRunner.runTick();
  console.log(JSON.stringify(outcome, null, 2));

  if (outcome.status !== 'processed' || outcome.sentinel !== 'FAILED') {
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
  const wakeRoot = resolve(
    readFlagBeforeCommandTerminator('--wake-root', args) ?? resolve(process.cwd(), '.wake'),
  );
  const stateStore = createStateStore({ wakeRoot });
  await stateStore.ensureWakeRoot();
  const config = await loadWakeConfig({
    wakeRoot,
    configFile: stateStore.paths.configFile,
  });

  const server = await runUiCommand({
    args,
    stateStore,
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

async function runSmoke(args: string[]) {
  const runtime = await buildRuntime(args);
  const explicitKind =
    args[0] === 'claude' || args[0] === 'codex' || args[0] === 'cursor' ? args[0] : undefined;
  const smokeArgs = explicitKind === undefined ? args : args.slice(1);

  const entry = resolveSmokEntry(runtime.config, explicitKind);
  if (entry === null) {
    throw new Error('Smoke tests require a real runner entry (`claude`, `codex`, or `cursor`) in config.runners.');
  }

  const runnerAdapter = createRunnerCliAdapter({
    entry,
    cwd: process.cwd(),
  });
  const result = await runnerAdapter.smoke(smokeArgs);
  console.log(JSON.stringify(result, null, 2));
}

export async function dispatchMainCommand(input: {
  args: string[];
  runInit: (args: string[]) => Promise<unknown>;
  runSandbox: (args: string[]) => Promise<unknown>;
  runTick: (args: string[]) => Promise<unknown>;
  runStart: (args: string[]) => Promise<unknown>;
  runSmoke: (args: string[]) => Promise<unknown>;
  runUi: (args: string[]) => Promise<unknown>;
}) {
  const command = input.args[0] ?? 'tick';
  if (command === 'tick') {
    await input.runTick(input.args.slice(1));
    return;
  }

  if (command === 'start') {
    await input.runStart(input.args.slice(1));
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

  if (command === 'stop') {
    await input.runSandbox(['stop', ...input.args.slice(1)]);
    return;
  }

  if (command === 'smoke') {
    await input.runSmoke(input.args.slice(1));
    return;
  }

  if (command === 'ui') {
    await input.runUi(input.args.slice(1));
    return;
  }

  throw new Error(`Unknown command: ${input.args.join(' ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  await dispatchMainCommand({
    args,
    runInit: async (commandArgs) => {
      await runInitCommand({
        cwd: process.cwd(),
        args: commandArgs,
        repoRoot: process.cwd(),
      });
    },
    runSandbox: async (commandArgs) => {
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
      });

      const repoRoot = config.dev?.repoRoot;
      const selfUpdate =
        commandArgs[0] === 'self-update' && repoRoot !== undefined && repoRoot.length > 0
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
    },
    runTick,
    runStart,
    runSmoke,
    runUi,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
