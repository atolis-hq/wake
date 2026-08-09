import { describe, expect, it } from 'vitest';
import { IntakeHost } from '../../../src-next/control-plane/infrastructure/intake-host.js';

const budget = { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1000 };

describe('IntakeHost', () => {
  it('reports one advance when the cycle processed something', async () => {
    const host = new IntakeHost(async () => ({ processed: true }));

    await expect(host.run(budget)).resolves.toEqual({
      advances: 1,
      runs: 0,
      stoppedBecause: 'budget',
    });
  });

  it('reports idle when the cycle found nothing', async () => {
    const host = new IntakeHost(async () => ({ processed: false }));

    await expect(host.run(budget)).resolves.toEqual({
      advances: 0,
      runs: 0,
      stoppedBecause: 'idle',
    });
  });
});
