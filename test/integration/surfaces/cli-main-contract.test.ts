import { describe, expect, it, vi } from 'vitest';
import { wakeVersion } from '../../../src/bootstrap/version.js';
import { main } from '../../../src/main.js';

const expectedUsage = [
  'Wake - an autonomous agent control plane for software development.',
  '',
  'Usage:',
  '  wake init <path>           Scaffold a new Wake home directory',
  '  wake sandbox <subcommand>  Build/run/manage the Docker sandbox (build, up, update, down, stop, self-update, setup, exec, logs, resume)',
  '  wake tick                  Run one control-plane tick',
  '  wake start                 Run the resident loop',
  '  wake validate-state        Validate .wake/ control-plane state health',
  '  wake stop                  Drain active runs and stop the sandbox',
  '  wake smoke                 Smoke-test the configured runner',
  '  wake ui                    Run the control-plane UI server',
  '  wake ui token              Print the UI login access key',
  '  wake ui token set <key>    Replace the UI login access key',
  '  wake audit                 Show autonomous decision audit history',
  '  wake correlate             Manually correlate a resource to a work item',
  '  wake run resolve           Resolve an escalated ambiguous run',
  '  wake doctor                Diagnose config/GitHub/Docker/sandbox setup problems',
  '  wake --version             Print the installed Wake version',
  '  wake --help                Show this message',
  '',
  'Additional target commands:',
  '  wake run resolve <run-id> --succeeded (--outcome <json> | --outcome-file <path>)',
  '  wake run resolve <run-id> --failed --reason <message>',
  '  wake api                   Run the target API surface',
  '  wake sandbox-entrypoint    Run the sandbox resident entrypoint',
  '  wake self-update           Safely update a source installation',
  '',
  'Getting started:',
  '  1. wake init ./wake-home',
  '  2. cd wake-home && wake start',
  '  https://github.com/atolis-hq/wake#readme',
  '',
  'Runtime commands (tick/start/ui/smoke/audit/correlate/validate-state) auto-delegate into the sandbox',
  'when docker/Dockerfile exists at --wake-root (i.e. after `wake sandbox build`),',
  'defaulting --wake-root to the current directory. Pass --no-sandbox to run',
  'directly on the host instead.',
].join('\n');

const expectedSandboxUsage = [
  'Sandbox usage:',
  '  wake sandbox build',
  '  wake sandbox up | down | update',
  '  wake sandbox exec [-- <command...>]',
  '  wake sandbox logs [--tail <positive integer>]',
  '  wake sandbox setup',
  '  wake sandbox resume <sessionId> --cwd <path> --cli <claude|codex|cursor>',
].join('\n');

describe('target CLI main contract', () => {
  it.each([
    ['--help', 'Usage:'],
    ['-h', 'Usage:'],
    ['help', 'Usage:'],
  ])('prints usage for %s without composing applications', async (argument, expected) => {
    const output: string[] = [];
    const compose = vi.fn(async () => applications());

    await main([argument], dependencies(compose, output));

    expect(output.join('')).toContain(expected);
    expect(compose).not.toHaveBeenCalled();
  });

  it('renders identical complete pre-composition help for every public form', async () => {
    const helpOutputs: string[] = [];
    for (const arguments_ of [['--help'], ['-h'], ['help'], []] as const) {
      const output: string[] = [];
      const compose = vi.fn(async () => applications());

      await main(arguments_, dependencies(compose, output));

      expect(compose).not.toHaveBeenCalled();
      helpOutputs.push(output.join(''));
    }

    expect(helpOutputs).toEqual([
      `${expectedUsage}\n`,
      `${expectedUsage}\n`,
      `${expectedUsage}\n`,
      `${expectedUsage}\n`,
    ]);
  });

  it.each(['--version', '-v'])(
    'prints the embedded version for %s without composing',
    async (argument) => {
      const output: string[] = [];
      const compose = vi.fn(async () => applications());

      await main([argument], dependencies(compose, output));

      expect(output).toEqual([`${wakeVersion}\n`]);
      expect(compose).not.toHaveBeenCalled();
    },
  );

  it.each([[['--help']], [['--version']], [[]]] as const)(
    'does not construct production signal handling for meta arguments %j',
    async (arguments_) => {
      const before = {
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
      };
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await main(arguments_);

      expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
      expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
      expect(write).toHaveBeenCalledOnce();
      write.mockRestore();
    },
  );

  it.each([
    ['--help', 'ignored'],
    ['-h', 'ignored'],
    ['help', 'ignored'],
    ['--version', 'ignored'],
    ['-v', 'ignored'],
  ])('recognises %s from the first token despite trailing arguments', async (command, trailing) => {
    const output: string[] = [];
    const compose = vi.fn(async () => applications());

    await main([command, trailing], dependencies(compose, output));

    expect(output).toHaveLength(1);
    expect(compose).not.toHaveBeenCalled();
  });

  it('prints usage for bare arguments without starting a tick', async () => {
    const output: string[] = [];
    const calls: string[] = [];
    const compose = vi.fn(async () => applications(calls));

    await main([], dependencies(compose, output));

    expect(output.join('')).toContain('Usage:');
    expect(compose).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each([
    ['dev', 'sandbox'],
    ['dev', 'sandbox', '--help'],
  ] as const)(
    'prints sandbox usage for wake %s without composing applications',
    async (...arguments_) => {
      const output: string[] = [];
      const compose = vi.fn(async () => applications());

      await main(arguments_, dependencies(compose, output));

      expect(output).toEqual([`${expectedSandboxUsage}\n`]);
      expect(compose).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown commands before composing applications', async () => {
    const compose = vi.fn(async () => applications());
    const output: string[] = [];

    await expect(main(['not-a-command'], dependencies(compose, output))).rejects.toThrow(
      'Unknown wake command: not-a-command',
    );

    expect(compose).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });

  it('rejects missing required command arguments before composing applications', async () => {
    const compose = vi.fn(async () => applications());
    const output: string[] = [];

    await expect(main(['audit'], dependencies(compose, output))).rejects.toThrow(
      'Missing audit work item',
    );

    expect(compose).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });

  it('dispatches an operational command once and writes only its result', async () => {
    const output: string[] = [];
    const calls: string[] = [];

    await main(
      ['doctor', '--wake-root', '/wake'],
      dependencies(async () => applications(calls), output),
    );

    expect(calls).toEqual(['doctor:--wake-root /wake']);
    expect(output).toEqual(['{"failures":[],"notices":[]}\n']);
  });

  it('prints and replaces the UI access key through the CLI auth facade', async () => {
    const output: string[] = [];
    const token = vi.fn(async (accessKey?: string) => accessKey ?? 'generated-access-key');
    const compose = vi.fn(async () => ({ ...applications(), auth: { token } }));

    await main(['ui', 'token'], dependencies(compose, output));
    await main(['ui', 'token', 'set', 'replacement-key'], dependencies(compose, output));

    expect(token).toHaveBeenNthCalledWith(1, undefined);
    expect(token).toHaveBeenNthCalledWith(2, 'replacement-key');
    expect(output).toEqual(['generated-access-key\n', 'replacement-key\n']);
  });

  it('renders a QR code only for the configured public pairing URL', async () => {
    const output: string[] = [];
    const compose = vi.fn(async () => ({
      ...applications(),
      auth: {
        token: async () =>
          'Wake login link:\n  Local:  http://localhost:4317/?grant=local\n  Public: https://wake.example.test/?grant=public',
      },
    }));

    await main(['ui', 'token'], dependencies(compose, output));

    expect(output.join('')).toContain('Local:  http://localhost:4317/?grant=local');
    expect(output.join('').match(/QR code:/g)).toHaveLength(1);
  });

  it('initialises the positional wake root without composing applications', async () => {
    const output: string[] = [];
    const compose = vi.fn(async () => applications());
    const initialise = vi.fn(async (wakeRoot: string) => ({ wakeRoot }));

    await main(['init', '/tmp/new-wake'], { ...dependencies(compose, output), initialise });

    expect(initialise).toHaveBeenCalledWith('/tmp/new-wake');
    expect(compose).not.toHaveBeenCalled();
    expect(output).toEqual(['{"wakeRoot":"/tmp/new-wake"}\n']);
  });

  it('keeps explicit init --wake-root behavior', async () => {
    const output: string[] = [];
    const compose = vi.fn(async () => applications());
    const initialise = vi.fn(async (wakeRoot: string) => ({ wakeRoot }));

    await main(['init', '--wake-root', '/tmp/explicit-wake'], {
      ...dependencies(compose, output),
      initialise,
    });

    expect(initialise).toHaveBeenCalledWith('/tmp/explicit-wake');
    expect(compose).not.toHaveBeenCalled();
  });

  it('gives init --wake-root precedence over a positional root', async () => {
    const output: string[] = [];
    const compose = vi.fn(async () => applications());
    const initialise = vi.fn(async (wakeRoot: string) => ({ wakeRoot }));

    await main(['init', '/tmp/ignored-wake', '--wake-root', '/tmp/explicit-wake'], {
      ...dependencies(compose, output),
      initialise,
    });

    expect(initialise).toHaveBeenCalledWith('/tmp/explicit-wake');
    expect(compose).not.toHaveBeenCalled();
  });
});

function dependencies(
  compose: (wakeRoot: string) => Promise<ReturnType<typeof applications>>,
  output: string[],
) {
  return {
    compose,
    output: { write: (value: string) => output.push(value) },
    signal: new AbortController().signal,
  };
}

function applications(calls: string[] = []) {
  return {
    operational: {
      init: async () => ({}),
      doctor: async (arguments_: readonly string[]) => {
        calls.push(`doctor:${arguments_.join(' ')}`);
        return { failures: [], notices: [] };
      },
      sandbox: async () => ({}),
      sandboxSetup: async () => ({}),
      sandboxEntrypoint: async () => undefined,
      selfUpdate: async () => ({}),
      smoke: async () => ({}),
    },
    tick: { run: async () => ({ advances: 0, runs: 0, stoppedBecause: 'idle' as const }) },
    start: { run: async () => ({ advances: 0, runs: 0, stoppedBecause: 'idle' as const }) },
    stop: { stop: async () => undefined },
    api: { start: async () => undefined },
    ui: { start: async () => undefined },
    auth: { token: async () => 'test-access-key' },
    audit: { read: async () => [] },
    correlate: { correlate: async () => ({}) },
    validateState: {
      health: async () => ({ journal: 'ok', projections: 'ok', checkpoints: 'ok' }),
      rebuildProjections: async () => undefined,
    },
  };
}
