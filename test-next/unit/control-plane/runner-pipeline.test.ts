import { describe, expect, it } from 'vitest';
import { createRunnerPipeline } from '../../../src-next/control-plane/application/runner-pipeline.js';

describe('RunnerPipeline', () => {
  it('catches projections up after a later stage fails', async () => {
    let projectionCatchUps = 0;
    const pipeline = createRunnerPipeline({
      catchUpProjections: async () => {
        projectionCatchUps += 1;
      },
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
