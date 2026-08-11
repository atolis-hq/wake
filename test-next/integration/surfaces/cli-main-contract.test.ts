import { describe, expect, it, vi } from 'vitest';
import { wakeVersion } from '../../../src-next/bootstrap/version.js';
import { main } from '../../../src-next/main.js';

describe('target CLI main contract', () => {
  it.each([
    ['--help', 'wake <tick|start|stop'],
    ['-h', 'wake <tick|start|stop'],
    ['help', 'wake <tick|start|stop'],
  ])('prints usage for %s without composing applications', async (argument, expected) => {
    const output: string[] = [];
    const compose = vi.fn(async () => applications());

    await main([argument], dependencies(compose, output));

    expect(output.join('')).toContain(expected);
    expect(compose).not.toHaveBeenCalled();
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

    expect(output.join('')).toContain('wake <tick|start|stop');
    expect(compose).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

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
    audit: { read: async () => [] },
    correlate: { correlate: async () => ({}) },
    validateState: {
      health: async () => ({ journal: 'ok', projections: 'ok', checkpoints: 'ok' }),
      rebuildProjections: async () => undefined,
    },
  };
}
