import { describe, expect, it } from 'vitest';
import { runSandbox } from '../../src-next/surfaces/cli/commands/sandbox.js';
import { scrubProcessLog } from '../../src-next/surfaces/cli/infrastructure/process-log.js';

// eslint-disable-next-line max-lines-per-function -- scenario coverage shares one injected Docker port.
describe('sandbox', () => {
  it('forwards an explicit subcommand only through the Docker port', async () => {
    const calls: string[] = [];
    await runSandbox(['up'], {
      build: async () => calls.push('build'),
      up: async () => calls.push('up'),
      down: async () => calls.push('down'),
    });
    expect(calls).toEqual(['up']);
  });

  it('rejects unknown commands before invoking Docker', async () => {
    await expect(
      runSandbox(['destroy'], { build: async () => {}, up: async () => {}, down: async () => {} }),
    ).rejects.toThrow('Unknown sandbox command');
  });

  it('scrubs assignment and GitHub-token-shaped values before process logs are shown', () => {
    expect(scrubProcessLog('GITHUB_TOKEN=abc ghp_abcdefghijklmnop github_pat_123')).toBe(
      'GITHUB_TOKEN=[REDACTED] [REDACTED] [REDACTED]',
    );
  });

  it('forwards sandbox exec and bounded logs through the Docker port', async () => {
    const calls: string[] = [];
    await runSandbox(['exec', '--', 'pwd'], {
      build: async () => {},
      up: async () => {},
      down: async () => {},
      exec: async (command) => calls.push(`exec:${command.join(' ')}`),
      logs: async (tail) => calls.push(`logs:${tail}`),
    });
    await runSandbox(['logs', '--tail', '25'], {
      build: async () => {},
      up: async () => {},
      down: async () => {},
      exec: async () => {},
      logs: async (tail) => calls.push(`logs:${tail}`),
    });
    expect(calls).toEqual(['exec:pwd', 'logs:25']);
  });

  it('opens the target sandbox shell when exec has no forwarded command', async () => {
    const calls: string[][] = [];
    await runSandbox(['exec'], {
      build: async () => {},
      up: async () => {},
      down: async () => {},
      exec: async (command) => calls.push([...command]),
    });
    expect(calls).toEqual([[]]);
  });
  it('forwards sandbox update through the Docker port', async () => {
    const calls: string[] = [];
    await runSandbox(['update'], {
      build: async () => {},
      up: async () => {},
      down: async () => {},
      update: async () => calls.push('update'),
    });
    expect(calls).toEqual(['update']);
  });

  it('forwards sandbox setup through the Docker port', async () => {
    const calls: string[] = [];
    await runSandbox(['setup'], {
      build: async () => {},
      up: async () => {},
      down: async () => {},
      setup: async () => calls.push('setup'),
    });
    expect(calls).toEqual(['setup']);
  });

  it('rejects sandbox setup when the Docker port has not configured it', async () => {
    await expect(
      runSandbox(['setup'], { build: async () => {}, up: async () => {}, down: async () => {} }),
    ).rejects.toThrow('sandbox setup is not configured');
  });

  it('forwards an explicit sandbox resume target through the Docker port', async () => {
    const calls: { sessionId: string; cwd: string; cli: string }[] = [];
    await runSandbox(
      ['resume', 'session-1', '--cwd', '/wake/workspaces/repo/12', '--cli', 'codex'],
      {
        build: async () => {},
        up: async () => {},
        down: async () => {},
        resume: async (target) => {
          calls.push(target);
        },
      },
    );
    expect(calls).toEqual([
      { sessionId: 'session-1', cwd: '/wake/workspaces/repo/12', cli: 'codex' },
    ]);
  });

  it('rejects sandbox resume when the Docker port has not configured it', async () => {
    await expect(
      runSandbox(['resume', 'session-1', '--cwd', '/wake/workspaces/repo/12', '--cli', 'codex'], {
        build: async () => {},
        up: async () => {},
        down: async () => {},
      }),
    ).rejects.toThrow('sandbox resume is not configured');
  });

  it('rejects sandbox resume without a session id', async () => {
    await expect(
      runSandbox(['resume'], {
        build: async () => {},
        up: async () => {},
        down: async () => {},
        resume: async () => {},
      }),
    ).rejects.toThrow('sandbox resume requires a session id');
  });

  it('rejects sandbox resume missing --cwd', async () => {
    await expect(
      runSandbox(['resume', 'session-1'], {
        build: async () => {},
        up: async () => {},
        down: async () => {},
        resume: async () => {},
      }),
    ).rejects.toThrow('sandbox resume requires --cwd');
  });

  it('rejects sandbox resume missing --cli', async () => {
    await expect(
      runSandbox(['resume', 'session-1', '--cwd', '/workspace'], {
        build: async () => {},
        up: async () => {},
        down: async () => {},
        resume: async () => {},
      }),
    ).rejects.toThrow('sandbox resume requires --cli');
  });
});
