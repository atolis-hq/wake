import { describe, expect, it } from 'vitest';
import {
  GitHubRequestCooldownError,
  createGitHubRequestCoordinator,
} from '../../../../src/integrations/github/infrastructure/request-coordinator.js';

describe('createGitHubRequestCoordinator', () => {
  it('caps concurrent provider requests from independent consumers', async () => {
    const coordinator = createGitHubRequestCoordinator({ maxConcurrent: 2 });
    let active = 0;
    let maximum = 0;
    const gates = Array.from({ length: 5 }, deferred<void>);

    const requests = gates.map((gate) =>
      coordinator.run(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate.promise;
        active -= 1;
      }),
    );

    await eventually(() => expect(maximum).toBe(2));
    gates[0]!.resolve();
    gates[1]!.resolve();
    await eventually(() => expect(active).toBe(2));
    gates.slice(2).forEach((gate) => gate.resolve());
    await expect(Promise.all(requests)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(maximum).toBe(2);
  });

  it('honors Retry-After and rejects queued provider requests without fan-out', async () => {
    let now = 1_000;
    const coordinator = createGitHubRequestCoordinator({ maxConcurrent: 1, now: () => now });
    let calls = 0;
    const rateLimited = Object.assign(new Error('rate limited'), {
      status: 429,
      response: { headers: { 'retry-after': '10' } },
    });

    const requests = [1, 2, 3].map(() =>
      coordinator.run(async () => {
        calls += 1;
        throw rateLimited;
      }),
    );

    const outcomes = await Promise.allSettled(requests);
    expect(calls).toBe(1);
    expect(outcomes).toHaveLength(3);
    expect(
      outcomes
        .slice(1)
        .every(
          (outcome) =>
            outcome.status === 'rejected' && outcome.reason instanceof GitHubRequestCooldownError,
        ),
    ).toBe(true);

    await expect(coordinator.run(async () => 'too-early')).rejects.toBeInstanceOf(
      GitHubRequestCooldownError,
    );
    now += 10_000;
    await expect(coordinator.run(async () => 'resumed')).resolves.toBe('resumed');

    await expect(
      coordinator.run(async () => {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }),
    ).rejects.toThrow('rate limited');
    await expect(coordinator.run(async () => 'too-early')).rejects.toMatchObject({
      retryAt: now + 60_000,
    });
  });

  it('applies exponential provider cooldown to 5xx and network failures', async () => {
    let now = 0;
    const coordinator = createGitHubRequestCoordinator({ maxConcurrent: 1, now: () => now });

    await expect(
      coordinator.run(async () => {
        throw Object.assign(new Error('upstream unavailable'), { status: 503 });
      }),
    ).rejects.toThrow('upstream unavailable');
    await expect(coordinator.run(async () => 'too-early')).rejects.toMatchObject({
      retryAt: 5_000,
    });

    now = 5_000;
    await expect(
      coordinator.run(async () => {
        throw new TypeError('network unavailable');
      }),
    ).rejects.toThrow('network unavailable');
    await expect(coordinator.run(async () => 'too-early')).rejects.toMatchObject({
      retryAt: 15_000,
    });
  });

  it('caps exponential cooldown at sixty seconds', async () => {
    let now = 0;
    const coordinator = createGitHubRequestCoordinator({ maxConcurrent: 1, now: () => now });

    for (const expectedDelay of [5_000, 10_000, 20_000, 40_000, 60_000]) {
      await expect(
        coordinator.run(async () => {
          throw Object.assign(new Error('upstream unavailable'), { status: 503 });
        }),
      ).rejects.toThrow('upstream unavailable');
      await expect(coordinator.run(async () => 'too-early')).rejects.toMatchObject({
        retryAt: now + expectedDelay,
      });
      now += expectedDelay;
    }
  });
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  assertion();
}
