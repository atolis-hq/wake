import { describe, expect, it, vi } from 'vitest';
import { createIntakePipeline } from '../../../src/control-plane/application/intake-pipeline.js';

describe('IntakePipeline', () => {
  it('stops an in-flight intake cycle at the next stage boundary when maintenance acquires', async () => {
    const paused = true;
    let polls = 0;
    const pipeline = createIntakePipeline({
      isPaused: async () => paused,
      poll: async () => {
        polls += 1;
        return 1;
      },
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({ processed: false });
    expect(polls).toBe(0);
  });

  it('reports no progress when maintenance acquires during a poll', async () => {
    let paused = false;
    const pipeline = createIntakePipeline({
      isPaused: async () => paused,
      poll: async () => {
        paused = true;
        return 1;
      },
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({ processed: false });
  });

  it('reports processed when poll finds new events', async () => {
    const pipeline = createIntakePipeline({
      poll: async () => 2,
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: true,
    });
  });

  it('does not treat an independently processed backlog as intake progress', async () => {
    const pipeline = createIntakePipeline({
      poll: async () => 0,
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: false,
    });
  });

  it('reports no progress when nothing new arrived', async () => {
    const pipeline = createIntakePipeline({
      poll: async () => 0,
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: false,
    });
  });

  it('skips poll and reports no progress while paused', async () => {
    const poll = vi.fn(async () => 1);
    const pipeline = createIntakePipeline({
      isPaused: async () => true,
      poll,
    });

    await expect(pipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: false,
    });
    expect(poll).not.toHaveBeenCalled();
  });

  it('propagates a poll failure', async () => {
    const pipeline = createIntakePipeline({
      poll: async () => {
        throw new Error('GitHub API unavailable');
      },
    });

    await expect(pipeline.run(new AbortController().signal)).rejects.toThrow(
      'GitHub API unavailable',
    );
  });
});
