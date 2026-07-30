import { describe, expect, it } from 'vitest';

import { RunnerRegistry, type Runner } from '../../src-next/execution/index.js';

describe('RunnerRegistry', () => {
  it('resolves the first configured runner in an execution tier', () => {
    const runner: Runner = {
      start: async () => ({ result: Promise.resolve(success()), cancel: async () => {} }),
    };
    const registry = new RunnerRegistry({ standard: ['fake'] }, { fake: runner });

    expect(registry.resolve('standard')).toBe(runner);
  });
});

function success() {
  return { transport: 'succeeded' as const, output: 'DONE', runner: 'fake' };
}
