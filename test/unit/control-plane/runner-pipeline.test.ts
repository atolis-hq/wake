import { describe, expect, it, vi } from 'vitest';
import { createRunnerPipeline } from '../../../src/control-plane/application/runner-pipeline.js';

describe('RunnerPipeline', () => {
  it('runs schedules and maintenance without accepting a scheduler stage', async () => {
    const maintain = vi.fn(async () => undefined);
    const pipeline = createRunnerPipeline({
      runSchedules: async () => undefined,
      maintain,
      deliver: async () => undefined,
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });

    expect(maintain).toHaveBeenCalledOnce();
  });

  it('runs no operational stages while paused', async () => {
    const runSchedules = vi.fn(async () => undefined);
    const maintain = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => undefined);
    const pipeline = createRunnerPipeline({
      isPaused: async () => true,
      runSchedules,
      maintain,
      deliver,
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect(runSchedules).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
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
      maintain: async () => undefined,
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
      maintain: async () => {
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
      maintain: async () => {
        throw new Error('label delivery denied');
      },
      deliver: async () => undefined,
    });

    await expect(pipeline.run({ maxProgress: 1 })).rejects.toThrow('label delivery denied');
  });

  it('never reports scheduler progress after producing schedule and maintenance facts', async () => {
    const stages: string[] = [];
    const pipeline = createRunnerPipeline({
      runSchedules: async () => {
        stages.push('schedules');
      },
      maintain: async () => {
        stages.push('maintain');
      },
      deliver: async () => {
        stages.push('deliver');
      },
    });

    await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
    expect(stages).toEqual(['schedules', 'maintain', 'deliver']);
  });

  it('runs delivery after maintenance without invoking processor stages', async () => {
    const stages: string[] = [];
    const pipeline = createRunnerPipeline({
      runSchedules: async () => undefined,
      maintain: async () => {
        stages.push('maintain');
      },
      deliver: async () => {
        stages.push('deliver');
      },
    });

    await pipeline.run({ maxProgress: 1 });

    expect(stages).toEqual(['maintain', 'deliver']);
  });
});
