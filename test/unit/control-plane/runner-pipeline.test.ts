import { describe, expect, it, vi } from 'vitest';
import { createRunnerPipeline } from '../../../src/control-plane/application/runner-pipeline.js';

describe('RunnerPipeline', () => {
  it('runs schedules and reactors without accepting a scheduler stage', async () => {
    const react = vi.fn(async () => undefined);
    const pipeline = createRunnerPipeline({
      catchUpProjections: async () => undefined,
      runSchedules: async () => undefined,
      react,
      deliver: async () => undefined,
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });

    expect(react).toHaveBeenCalledTimes(2);
  });

  it('catches projections up once without running operational stages while paused', async () => {
    const catchUpProjections = vi.fn(async () => undefined);
    const runSchedules = vi.fn(async () => undefined);
    const react = vi.fn(async () => undefined);
    const publishAgentRuns = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => undefined);
    const pipeline = createRunnerPipeline({
      isPaused: async () => true,
      catchUpProjections,
      runSchedules,
      react,
      publishAgentRuns,
      deliver,
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect(catchUpProjections).toHaveBeenCalledOnce();
    expect(runSchedules).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
    expect(publishAgentRuns).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

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
      deliver: async () => {
        deliveries += 1;
      },
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect({ projections, reactions, deliveries }).toEqual({
      projections: 2,
      reactions: 0,
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
      deliver: async () => undefined,
    });

    await expect(pipeline.run({ maxProgress: 1 })).rejects.toThrow('label delivery denied');
    expect(projectionCatchUps).toBe(2);
  });

  it('never reports scheduler progress after producing schedule and reactor facts', async () => {
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
      deliver: async () => {
        stages.push('deliver');
      },
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
    expect(stages).toEqual([
      'projections',
      'schedules',
      'react',
      'projections',
      'deliver',
      'projections',
      'react',
      'projections',
    ]);
  });

  it('publishes agent-run reports after reactors and before delivery', async () => {
    const stages: string[] = [];
    const pipeline = createRunnerPipeline({
      catchUpProjections: async () => undefined,
      runSchedules: async () => undefined,
      react: async () => {
        stages.push('react');
      },
      publishAgentRuns: async () => {
        stages.push('publish-agent-runs');
      },
      deliver: async () => {
        stages.push('deliver');
      },
    });

    await pipeline.run({ maxProgress: 1 });

    expect(stages.indexOf('publish-agent-runs')).toBeGreaterThan(stages.indexOf('react'));
    expect(stages.indexOf('publish-agent-runs')).toBeLessThan(stages.indexOf('deliver'));
  });
});
