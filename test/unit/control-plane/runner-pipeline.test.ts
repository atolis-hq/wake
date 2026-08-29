import { describe, expect, it, vi } from 'vitest';
import { createRunnerPipeline } from '../../../src/control-plane/application/runner-pipeline.js';

describe('RunnerPipeline', () => {
  it('runs schedules and reactors without accepting a scheduler stage', async () => {
    const react = vi.fn(async () => undefined);
    const pipeline = createRunnerPipeline({
      runSchedules: async () => undefined,
      react,
      deliver: async () => undefined,
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });

    expect(react).toHaveBeenCalledTimes(2);
  });

  it('runs no operational stages while paused', async () => {
    const runSchedules = vi.fn(async () => undefined);
    const react = vi.fn(async () => undefined);
    const publishAgentRuns = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => undefined);
    const pipeline = createRunnerPipeline({
      isPaused: async () => true,
      runSchedules,
      react,
      publishAgentRuns,
      deliver,
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect(runSchedules).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
    expect(publishAgentRuns).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('serializes overlapping ticks', async () => {
    let releaseFirstSchedule: (() => void) | undefined;
    const firstScheduleStarted = new Promise<void>((resolve) => {
      releaseFirstSchedule = resolve;
    });
    let allowFirstSchedule: (() => void) | undefined;
    const firstScheduleMayFinish = new Promise<void>((resolve) => {
      allowFirstSchedule = resolve;
    });
    const runSchedules = vi.fn(async () => {
      if (runSchedules.mock.calls.length === 1) {
        releaseFirstSchedule?.();
        await firstScheduleMayFinish;
      }
    });
    const pipeline = createRunnerPipeline({
      runSchedules,
      react: async () => undefined,
      deliver: async () => undefined,
    });

    const first = pipeline.run({ maxProgress: 1 });
    await firstScheduleStarted;
    const second = pipeline.run({ maxProgress: 1 });

    await new Promise((resolve) => setImmediate(resolve));
    expect(runSchedules).toHaveBeenCalledOnce();

    allowFirstSchedule?.();
    await Promise.all([first, second]);
  });

  it('stops an in-flight tick at the next stage boundary when maintenance acquires', async () => {
    let paused = false;
    let reactions = 0;
    let deliveries = 0;
    const pipeline = createRunnerPipeline({
      isPaused: async () => paused,
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
    expect({ reactions, deliveries }).toEqual({ reactions: 0, deliveries: 0 });
  });

  it('propagates a later stage failure', async () => {
    const pipeline = createRunnerPipeline({
      runSchedules: async () => undefined,
      react: async () => {
        throw new Error('label delivery denied');
      },
      deliver: async () => undefined,
    });

    await expect(pipeline.run({ maxProgress: 1 })).rejects.toThrow('label delivery denied');
  });

  it('never reports scheduler progress after producing schedule and reactor facts', async () => {
    const stages: string[] = [];
    const pipeline = createRunnerPipeline({
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
    expect(stages).toEqual(['schedules', 'react', 'deliver', 'react']);
  });

  it('publishes agent-run reports after reactors and before delivery', async () => {
    const stages: string[] = [];
    const pipeline = createRunnerPipeline({
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
