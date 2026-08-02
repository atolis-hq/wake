import { describe, expect, it } from 'vitest';
import { runSandbox } from '../../src-next/surfaces/cli/commands/sandbox.js';
import { scrubProcessLog } from '../../src-next/surfaces/cli/infrastructure/process-log.js';

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
});
