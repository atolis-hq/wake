import { describe, expect, it, vi } from 'vitest';
import { createRunnerPipeline } from '../../../src/control-plane/application/runner-pipeline.js';

describe('RunnerPipeline', () => {
  it('can omit inline activation scheduling while keeping legacy reactors running', async () => {
    const advance = vi.fn(async () => ({ kind: 'no-work' as const }));
    const react = vi.fn(async () => undefined);
    const pipeline = createRunnerPipeline({
      catchUpProjections: async () => undefined,
      runSchedules: async () => undefined,
      react,
      advance,
      deliver: async () => undefined,
      inlineActivationScheduling: false,
    });

    await pipeline.run({ maxProgress: 1 });

    expect(advance).not.toHaveBeenCalled();
    expect(react).toHaveBeenCalledTimes(2);
  });

  it('catches projections up once without running operational stages while paused', async () => {
    const catchUpProjections = vi.fn(async () => undefined);
    const runSchedules = vi.fn(async () => undefined);
    const react = vi.fn(async () => undefined);
    const advance = vi.fn(async () => ({ kind: 'no-work' as const }));
    const publishAgentRuns = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => undefined);
    const pipeline = createRunnerPipeline({
      isPaused: async () => true,
      catchUpProjections,
      runSchedules,
      react,
      advance,
      publishAgentRuns,
      deliver,
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect(catchUpProjections).toHaveBeenCalledOnce();
    expect(runSchedules).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
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
      projections: 2,
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

  it('reacts after a progressed dispatch so watches see the resulting wait state', async () => {
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
        return {
          kind: 'progressed',
          dispatched: [{ activationId: 'activation-1', runId: 'run-1' }],
        };
      },
      deliver: async () => {
        stages.push('deliver');
      },
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toMatchObject({ kind: 'progressed' });
    expect(stages.indexOf('react')).toBeGreaterThan(stages.indexOf('advance'));
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
        return {
          kind: 'progressed',
          dispatched: [{ activationId: 'activation-1', runId: 'run-1' }],
        };
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
