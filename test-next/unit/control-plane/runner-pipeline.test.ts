import { describe, expect, it } from 'vitest';
import { createRunnerPipeline } from '../../../src-next/control-plane/application/runner-pipeline.js';

describe('RunnerPipeline', () => {
  it('stops an in-flight tick at the next stage boundary when maintenance acquires', async () => {
    let paused = false;
    let projections = 0;
    let reactions = 0;
    let advances = 0;
    let deliveries = 0;
    const pipeline = createRunnerPipeline({
      isPaused: async () => paused,
      catchUpProjections: async () => {
        projections += 1;
      },
      runSchedules: async () => {
        paused = true;
      },
      react: async () => {
        reactions += 1;
      },
      advance: async () => {
        advances += 1;
        return { kind: 'no-work' };
      },
      deliver: async () => {
        deliveries += 1;
      },
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect({ projections, reactions, advances, deliveries }).toEqual({
      projections: 1,
      reactions: 0,
      advances: 0,
      deliveries: 0,
    });
  });

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
