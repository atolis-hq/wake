import { describe, expect, it, vi } from 'vitest';
import { createRunnerPipeline } from '../../../src/control-plane/application/runner-pipeline.js';

describe('RunnerPipeline', () => {
  it('serializes overlapping ticks', async () => {
    let releaseFirstCatchUp: (() => void) | undefined;
    const firstCatchUpStarted = new Promise<void>((resolve) => {
      releaseFirstCatchUp = resolve;
    });
    let allowFirstCatchUp: (() => void) | undefined;
    const firstCatchUpMayFinish = new Promise<void>((resolve) => {
      allowFirstCatchUp = resolve;
    });
    const catchUpProjections = vi.fn(async () => {
      if (catchUpProjections.mock.calls.length === 1) {
        releaseFirstCatchUp?.();
        await firstCatchUpMayFinish;
      }
    });
    const pipeline = createRunnerPipeline({
      catchUpProjections,
      runSchedules: async () => undefined,
      react: async () => undefined,
      advance: async () => ({ kind: 'no-work' as const }),
      deliver: async () => undefined,
    });

    const first = pipeline.run({ maxProgress: 1 });
    await firstCatchUpStarted;
    const second = pipeline.run({ maxProgress: 1 });

    await new Promise((resolve) => setImmediate(resolve));
    expect(catchUpProjections).toHaveBeenCalledOnce();

    allowFirstCatchUp?.();
    await Promise.all([first, second]);
  });

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

  it('reacts again after a progressed dispatch', async () => {
    const stages: string[] = [];
    const pipeline = createRunnerPipeline({
      catchUpProjections: async () => {
        stages.push('projections');
      },
      runSchedules: async () => {
        stages.push('schedules');
      },
      react: async () => {
        stages.push('react');
      },
      advance: async () => {
        stages.push('advance');
        return { kind: 'progressed', activationId: 'activation-1', runId: 'run-1' };
      },
      deliver: async () => {
        stages.push('deliver');
      },
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toMatchObject({ kind: 'progressed' });
    expect(stages.lastIndexOf('react')).toBeGreaterThan(stages.indexOf('advance'));
  });

  it('publishes agent-run reports after advancement and before delivery', async () => {
    const stages: string[] = [];
    const pipeline = createRunnerPipeline({
      catchUpProjections: async () => undefined,
      runSchedules: async () => undefined,
      react: async () => {
        stages.push('react');
      },
      advance: async () => {
        stages.push('advance');
        return { kind: 'progressed', activationId: 'activation-1', runId: 'run-1' };
      },
      publishAgentRuns: async () => {
        stages.push('publish-agent-runs');
      },
      deliver: async () => {
        stages.push('deliver');
      },
    });

    await pipeline.run({ maxProgress: 1 });

    expect(stages.indexOf('publish-agent-runs')).toBeGreaterThan(stages.indexOf('advance'));
    expect(stages.indexOf('publish-agent-runs')).toBeLessThan(stages.indexOf('deliver'));
  });
});
