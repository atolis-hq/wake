import { describe, expect, it, vi } from 'vitest';
import { createIntakePipeline } from '../../../src/control-plane/application/intake-pipeline.js';

describe('IntakePipeline', () => {
  it('stops an in-flight intake cycle at the next stage boundary when maintenance acquires', async () => {
    let paused = false;
    let projectionCatchUps = 0;
    let polls = 0;
    let translations = 0;
    const pipeline = createIntakePipeline({
      isPaused: async () => paused,
      catchUpProjections: async () => {
        projectionCatchUps += 1;
        paused = true;
      },
      poll: async () => {
        polls += 1;
        return 1;
      },
      translateInbound: async () => {
        translations += 1;
        return 1;
      },
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({ processed: false });
    expect({ projectionCatchUps, polls, translations }).toEqual({
      projectionCatchUps: 2,
      polls: 0,
      translations: 0,
    });
  });

  it('does not translate inbound work after maintenance acquires during a poll', async () => {
    let paused = false;
    let projectionCatchUps = 0;
    let translations = 0;
    const pipeline = createIntakePipeline({
      isPaused: async () => paused,
      catchUpProjections: async () => {
        projectionCatchUps += 1;
      },
      poll: async () => {
        paused = true;
        return 1;
      },
      translateInbound: async () => {
        translations += 1;
        return 1;
      },
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({ processed: false });
    expect(projectionCatchUps).toBe(2);
    expect(translations).toBe(0);
  });

  it('reports processed when poll finds new events', async () => {
    const pipeline = createIntakePipeline({
      catchUpProjections: async () => undefined,
      poll: async () => 2,
      translateInbound: async () => 0,
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: true,
    });
  });

  it('reports processed when translateInbound drains a backlog even without a fresh poll', async () => {
    const pipeline = createIntakePipeline({
      catchUpProjections: async () => undefined,
      poll: async () => 0,
      translateInbound: async () => 3,
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: true,
    });
  });

  it('reports no progress when nothing new arrived', async () => {
    const pipeline = createIntakePipeline({
      catchUpProjections: async () => undefined,
      poll: async () => 0,
      translateInbound: async () => 0,
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: false,
    });
  });

  it('skips poll and reports no progress while paused', async () => {
    const catchUpProjections = vi.fn(async () => undefined);
    const poll = vi.fn(async () => 1);
    const translateInbound = vi.fn(async () => 0);
    const pipeline = createIntakePipeline({
      isPaused: async () => true,
      catchUpProjections,
      poll,
      translateInbound,
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: false,
    });
    expect(catchUpProjections).toHaveBeenCalledOnce();
    expect(poll).not.toHaveBeenCalled();
    expect(translateInbound).not.toHaveBeenCalled();
  });

  it('catches projections up even when poll fails', async () => {
    let projectionCatchUps = 0;
    const pipeline = createIntakePipeline({
      catchUpProjections: async () => {
        projectionCatchUps += 1;
      },
      poll: async () => {
        throw new Error('GitHub API unavailable');
      },
      translateInbound: async () => 0,
    });

    await expect(pipeline.run(new AbortController().signal)).rejects.toThrow(
      'GitHub API unavailable',
    );
    expect(projectionCatchUps).toBe(2);
  });
});
