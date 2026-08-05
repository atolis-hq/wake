import { describe, expect, it } from 'vitest';
import { createTickPipeline } from '../../../src-next/control-plane/application/tick-pipeline.js';

describe('TickPipeline', () => {
  it('catches projections up after a later stage fails', async () => {
    let projectionCatchUps = 0;
    const pipeline = createTickPipeline({
      catchUpProjections: async () => {
        projectionCatchUps += 1;
      },
      poll: async () => undefined,
      translateInbound: async () => undefined,
      runSchedules: async () => undefined,
      react: async () => {
        throw new Error('label delivery denied');
      },
      advance: async () => ({ kind: 'no-work' }),
      deliver: async () => undefined,
    });

    await expect(pipeline.run({ maxProgress: 1 })).rejects.toThrow('label delivery denied');
    expect(projectionCatchUps).toBe(2);
  });
});
