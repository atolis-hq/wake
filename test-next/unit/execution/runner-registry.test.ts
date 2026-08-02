import { describe, expect, it } from 'vitest';

import { RunnerRegistry, type Runner } from '../../../src-next/execution/index.js';

describe('RunnerRegistry', () => {
  it('resolves the first configured runner in an execution runner pool', () => {
    const runner: Runner = fakeRunner();
    const registry = new RunnerRegistry({ standard: ['fake'] }, { fake: runner });

    expect(registry.resolve('standard')).toEqual({ name: 'fake', runner });
  });

  it('selects the first candidate when all candidates are eligible', () => {
    const sonnet = fakeRunner();
    const codexMini = fakeRunner();
    const registry = new RunnerRegistry(
      { standard: ['sonnet', 'codex-mini'] },
      { sonnet, 'codex-mini': codexMini },
    );

    expect(registry.resolve('standard', new Set())).toEqual({ name: 'sonnet', runner: sonnet });
  });

  it('falls sideways to the second candidate when the first is ineligible', () => {
    const sonnet = fakeRunner();
    const codexMini = fakeRunner();
    const registry = new RunnerRegistry(
      { standard: ['sonnet', 'codex-mini'] },
      { sonnet, 'codex-mini': codexMini },
    );

    expect(registry.resolve('standard', new Set(['sonnet']))).toEqual({
      name: 'codex-mini',
      runner: codexMini,
    });
  });

  it('throws a distinct error when every candidate in the runner pool is ineligible', () => {
    const sonnet = fakeRunner();
    const codexMini = fakeRunner();
    const registry = new RunnerRegistry(
      { standard: ['sonnet', 'codex-mini'] },
      { sonnet, 'codex-mini': codexMini },
    );

    expect(() => registry.resolve('standard', new Set(['sonnet', 'codex-mini']))).toThrow(
      /no eligible runner/i,
    );
  });

  it('does not fall back to an ineligible runner or a different runner pool when exhausted', () => {
    const sonnet = fakeRunner();
    const registry = new RunnerRegistry({ standard: ['sonnet'], fallback: ['sonnet'] }, { sonnet });

    expect(() => registry.resolve('standard', new Set(['sonnet']))).toThrow();
  });

  it('throws when a runner pool names a runner that is not registered', () => {
    const registry = new RunnerRegistry({ standard: ['missing'] }, {});

    expect(() => registry.resolve('standard')).toThrow(/not registered/i);
  });

  it('throws when the runner pool itself is unknown', () => {
    const registry = new RunnerRegistry({ standard: ['fake'] }, { fake: fakeRunner() });

    expect(() => registry.resolve('unknown-runner-pool')).toThrow(/has no runner/i);
  });
});

function fakeRunner(): Runner {
  return {
    start: async () => ({ result: Promise.resolve(success()), cancel: async () => {} }),
  };
}

function success() {
  return { transport: 'succeeded' as const, output: 'DONE', runner: 'fake' };
}
