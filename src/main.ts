import { resolve } from 'node:path';

import { createClaudeRunner } from './adapters/claude/claude-runner.js';
import { createFileBackedFakeTicketingSystem } from './adapters/fake/fake-ticketing-system.js';
import { createFakeRunner } from './adapters/fake/fake-runner.js';
import { createFakeWorkspaceManager } from './adapters/fake/fake-workspace-manager.js';
import { createStateStore } from './adapters/fs/state-store.js';
import { loadWakeConfig } from './config/load-config.js';
import { createControlPlane } from './core/control-plane.js';
import { createTickRunner } from './core/tick-runner.js';
import { systemClock } from './lib/clock.js';

function readFlag(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function hasFlag(name: string, args: string[]): boolean {
  return args.includes(name);
}

async function buildRuntime(args: string[]) {
  const wakeRoot = resolve(
    readFlag('--wake-root', args) ?? resolve(process.cwd(), '.wake'),
  );
  const stateStore = createStateStore({ wakeRoot });
  await stateStore.ensureWakeRoot();

  const config = await loadWakeConfig({
    wakeRoot,
    configFile: stateStore.paths.configFile,
  });
  await stateStore.writeConfig(config);

  const workSource = await createFileBackedFakeTicketingSystem({
    fixturePath: stateStore.paths.issueFixtureFile,
    now: () => systemClock.now(),
  });

  const runnerMode = readFlag('--runner', args) ?? config.runner.mode;
  const runner =
    runnerMode === 'claude'
      ? createClaudeRunner({
          command: config.runner.claude.command,
          cwd: process.cwd(),
        })
      : createFakeRunner();

  const workspaceManager = createFakeWorkspaceManager(stateStore.paths.workspaceRoot);
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
    workSource,
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

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'tick';

  if (command === 'tick') {
    await runTick(args.slice(1));
    return;
  }

  if (command === 'start') {
    await runStart(args.slice(1));
    return;
  }

  if (command === 'smoke' && args[1] === 'claude') {
    await runClaudeSmoke(args.slice(2));
    return;
  }

  console.error(`Unknown command: ${args.join(' ')}`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
