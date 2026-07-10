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

  it('logs status on change but suppresses repeated identical statuses', async () => {
    const tickRunner = {
      runTick: vi.fn().mockResolvedValue({ status: 'idle' }),
    };
    const logged: string[] = [];

    const controlPlane = createControlPlane({
      tickRunner,
      intervalMs: 0,
      isPaused: () => false,
      logger: { info(msg) { logged.push(msg); }, error() {} },
      sleep: async () => {},
    });

    await controlPlane.runOnce();
    await controlPlane.runOnce();
    await controlPlane.runOnce();

    expect(logged.filter((m) => m.includes('status=idle'))).toHaveLength(1);
  });

  it('logs each distinct status transition', async () => {
    const statuses = ['idle', 'processed', 'idle'];
    let call = 0;
    const tickRunner = {
      runTick: vi.fn().mockImplementation(() => Promise.resolve({ status: statuses[call++] })),
    };
    const logged: string[] = [];

    const controlPlane = createControlPlane({
      tickRunner,
      intervalMs: 0,
      isPaused: () => false,
      logger: { info(msg) { logged.push(msg); }, error() {} },
      sleep: async () => {},
    });

    await controlPlane.runOnce();
    await controlPlane.runOnce();
    await controlPlane.runOnce();

    expect(logged).toEqual(['[wake] status=idle', '[wake] status=processed', '[wake] status=idle']);
  });

  it('does not sleep after a processed tick', async () => {
    let calls = 0;
    const tickRunner = {
      runTick: vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.resolve({ status: 'processed' });
        // Stop the loop on the second call
        controlPlane.stop();
        return Promise.resolve({ status: 'idle' });
      }),
    };
    const sleepCalls: number[] = [];

    const controlPlane = createControlPlane({
      tickRunner,
      intervalMs: 30000,
      isPaused: () => false,
      logger: { info() {}, error() {} },
      sleep: async (ms) => { sleepCalls.push(ms); },
    });

    await controlPlane.start();

    // The first tick returned 'processed', so no sleep before the second tick.
    // The second tick called stop(), so no sleep after it either.
    expect(sleepCalls).toHaveLength(0);
  });

  it('sleeps after an idle tick', async () => {
    let calls = 0;
    const tickRunner = {
      runTick: vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.resolve({ status: 'idle' });
        controlPlane.stop();
        return Promise.resolve({ status: 'idle' });
      }),
    };
    const sleepCalls: number[] = [];

    const controlPlane = createControlPlane({
      tickRunner,
      intervalMs: 5000,
      isPaused: () => false,
      logger: { info() {}, error() {} },
      sleep: async (ms) => { sleepCalls.push(ms); },
    });

    await controlPlane.start();

    expect(sleepCalls).toEqual([5000]);
  });
});
