import { describe, expect, it } from 'vitest';
import {
  runResidentSupervisor,
  runSandboxEntrypoint,
  type ResidentSupervisorDependencies,
  type SandboxEntrypointDependencies,
} from '../../../src/surfaces/cli/commands/sandbox-entrypoint.js';

describe('resident supervisor', () => {
  it('spawns wake start detached, records its pid, and restarts it after it exits', async () => {
    const events: string[] = [];
    let cycle = 0;
    const deps: ResidentSupervisorDependencies = {
      restartDelaySeconds: 5,
      wakeInvocation: ['node', '/app/dist/src/main.js'],
      pidFile: '/wake/.wake/logs/start.pid',
      startLogFile: '/wake/.wake/logs/start.log',
      spawnDetached: (command, arguments_, options) => {
        cycle += 1;
        events.push(`spawn:${command} ${arguments_.join(' ')} log=${options.logFile}`);
        return { pid: 1000 + cycle };
      },
      waitForExit: async (pid) => {
        events.push(`exit-wait:${pid}`);
        return 1;
      },
      writeFile: async (path, content) => {
        events.push(`write:${path}=${content}`);
      },
      sleep: async (milliseconds) => {
        events.push(`sleep:${milliseconds}`);
        if (cycle >= 2) throw new Error('test-stop');
      },
      log: (message) => events.push(`log:${message}`),
    };

    await expect(runResidentSupervisor(deps)).rejects.toThrow('test-stop');

    expect(events).toEqual([
      'log:wake start: starting resident loop',
      'spawn:node /app/dist/src/main.js start --wake-root /wake --no-sandbox log=/wake/.wake/logs/start.log',
      'write:/wake/.wake/logs/start.pid=1001',
      'exit-wait:1001',
      'log:wake start: resident loop exited with status 1; restarting in 5s',
      'sleep:5000',
      'log:wake start: starting resident loop',
      'spawn:node /app/dist/src/main.js start --wake-root /wake --no-sandbox log=/wake/.wake/logs/start.log',
      'write:/wake/.wake/logs/start.pid=1002',
      'exit-wait:1002',
      'log:wake start: resident loop exited with status 1; restarting in 5s',
      'sleep:5000',
    ]);
  });
});

describe('sandbox entrypoint', () => {
  function baseDeps(
    overrides: Partial<SandboxEntrypointDependencies>,
  ): SandboxEntrypointDependencies {
    return {
      startEnabled: false,
      restartDelaySeconds: 10,
      wakeInvocation: ['wake'],
      pidFile: '/wake/.wake/logs/start.pid',
      startLogFile: '/wake/.wake/logs/start.log',
      ensureLogDirectory: async () => {},
      spawnDetached: () => {
        throw new Error('spawnDetached must not be called when start is disabled');
      },
      waitForExit: async () => 0,
      writeFile: async () => {},
      sleep: async () => {},
      waitForever: async () => undefined as never,
      log: () => {},
      ...overrides,
    };
  }

  it('never starts wake start and still waits forever when start is disabled', async () => {
    const events: string[] = [];
    await runSandboxEntrypoint(
      baseDeps({
        ensureLogDirectory: async () => {
          events.push('ensure-dir');
        },
        waitForever: async () => {
          events.push('wait-forever');
          return undefined as never;
        },
      }),
    );
    expect(events).toEqual(['ensure-dir', 'wait-forever']);
  });

  it('starts supervising wake start before waiting forever when start is enabled', async () => {
    const events: string[] = [];
    await runSandboxEntrypoint(
      baseDeps({
        startEnabled: true,
        wakeInvocation: ['wake'],
        ensureLogDirectory: async () => {
          events.push('ensure-dir');
        },
        spawnDetached: (command, arguments_) => {
          events.push(`spawn:${command} ${arguments_.join(' ')}`);
          return { pid: 999 };
        },
        waitForExit: () => new Promise(() => {}),
        waitForever: async () => {
          events.push('wait-forever');
          return undefined as never;
        },
      }),
    );
    expect(events).toEqual([
      'ensure-dir',
      'spawn:wake start --wake-root /wake --no-sandbox',
      'wait-forever',
    ]);
  });

  it('resolves instead of crashing if the resident supervisor throws unexpectedly', async () => {
    await expect(
      runSandboxEntrypoint(
        baseDeps({
          startEnabled: true,
          spawnDetached: () => {
            throw new Error('spawn failed');
          },
          waitForever: async () => undefined as never,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
