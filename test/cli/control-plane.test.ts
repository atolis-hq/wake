import { describe, expect, it, vi } from 'vitest';

import { createControlPlane } from '../../src/core/control-plane.js';

describe('control plane', () => {
  it('skips execution when the pause gate is active', async () => {
    const tickRunner = {
      runTick: vi.fn(),
    };

    const controlPlane = createControlPlane({
      tickRunner,
      intervalMs: 10,
      isPaused: () => true,
      logger: { info() {}, error() {} },
      sleep: async () => {},
    });

    await controlPlane.runOnce();

    expect(tickRunner.runTick).not.toHaveBeenCalled();
  });
});
