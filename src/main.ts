import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { createClaudeRunner } from './adapters/claude/claude-runner.js';
import { createDockerCli } from './adapters/docker/docker-cli.js';
import { createFileBackedFakeTicketingSystem } from './adapters/fake/fake-ticketing-system.js';
import { createFakeRunner } from './adapters/fake/fake-runner.js';
import { createFakeWorkspaceManager } from './adapters/fake/fake-workspace-manager.js';
import { createGitWorkspaceManager } from './adapters/git/git-workspace-manager.js';
import { createStateStore } from './adapters/fs/state-store.js';
import { resolveGitHubToken } from './adapters/github/github-auth.js';
import { createGitHubClient } from './adapters/github/github-client.js';
import { createGitHubIssuesWorkSource } from './adapters/github/github-issues-work-source.js';
import { runInitCommand } from './cli/init-command.js';
import { runSandboxCommand } from './cli/sandbox-command.js';
import { loadWakeConfig } from './config/load-config.js';
import { createControlPlane } from './core/control-plane.js';
import { createTickRunner } from './core/tick-runner.js';
import { systemClock } from './lib/clock.js';

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

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
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

  const runnerMode = readFlagBeforeCommandTerminator('--runner', args) ?? config.runner.mode;
  const runner =
    runnerMode === 'claude'
      ? createClaudeRunner({
          command: config.runner.claude.command,
          cwd: process.cwd(),
        })
      : createFakeRunner();

  const workspaceManager =
    runnerMode === 'claude'
      ? createGitWorkspaceManager({ wakeRoot })
      : createFakeWorkspaceManager(stateStore.paths.workspaceRoot);
  const tickRunner = createTickRunner({
    clock: systemClock,
    config: {
      ...config,
      runner: {
        ...config.runner,
        mode: runnerMode === 'claude' ? 'claude' : 'fake',
      },
    },
    stateStore,
    workSource: ticketingSystem,
    outboundSink: ticketingSystem,
    runner,
    workspaceManager,
  });

  return {
    config,
    runner,
    stateStore,
    tickRunner,
  };
}

async function runTick(args: string[]) {
  const runtime = await buildRuntime(args);
  const outcome = await runtime.tickRunner.runTick();
  console.log(JSON.stringify(outcome, null, 2));
}

async function runStart(args: string[]) {
  const runtime = await buildRuntime(args);
  const controlPlane = createControlPlane({
    tickRunner: runtime.tickRunner,
    intervalMs: runtime.config.scheduler.intervalMs,
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

async function runClaudeSmoke(args: string[]) {
  const runtime = await buildRuntime(args);
  const claudeRunner = createClaudeRunner({
    command: runtime.config.runner.claude.command,
    cwd: process.cwd(),
  });

  if (hasFlag('--remote-control', args)) {
    const result = await claudeRunner.startRemoteControlSmoke(runtime.config);
    console.log(
      JSON.stringify(
        {
          mode: 'remote-control',
          exitCode: result.exitCode,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          command: result.command,
          args: result.args,
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await claudeRunner.smoke(runtime.config);
  console.log(
    JSON.stringify(
      {
        mode: 'print-json',
        exitCode: result.exitCode,
        text: result.text,
        sessionId: result.sessionId,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      },
      null,
      2,
    ),
  );
}

export async function dispatchMainCommand(input: {
  args: string[];
  runInit: (args: string[]) => Promise<unknown>;
  runSandbox: (args: string[]) => Promise<unknown>;
  runTick: (args: string[]) => Promise<unknown>;
  runStart: (args: string[]) => Promise<unknown>;
  runClaudeSmoke: (args: string[]) => Promise<unknown>;
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

  if (command === 'smoke' && input.args[1] === 'claude') {
    await input.runClaudeSmoke(input.args.slice(2));
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
        run: (dockerArgs) => runCommand('docker', dockerArgs),
        inspectImage: inspectDockerImage,
        inspectContainer: inspectDockerContainer,
      });

      await runSandboxCommand({
        args: commandArgs,
        config,
        wakeRoot,
        containerHomeRoot: stateStore.paths.containerHomeRoot,
        docker,
      });
    },
    runTick,
    runStart,
    runClaudeSmoke,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
