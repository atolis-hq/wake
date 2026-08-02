import { describe, expect, it, vi } from 'vitest';
import { runWakeCommand, type WakeCliApplications } from '../../../src-next/surfaces/cli/main.js';

describe('Wake target CLI runtime commands', () => {
  it.each(['tick', 'start', 'stop', 'api', 'ui'] as const)(
    'dispatches %s to its injected application facade',
    async (kind) => {
      const calls: string[] = [];
      const applications = fixtureApplications(calls);

      await runWakeCommand(
        { kind },
        applications,
        { write: vi.fn() },
        new AbortController().signal,
      );

      expect(calls).toContain(kind);
    },
  );

  it('formats canonical audit facts and causal links without depending on projections', async () => {
    const write = vi.fn();
    const applications = fixtureApplications([]);

    await runWakeCommand(
      { kind: 'audit', workItemId: 'work-demo' },
      applications,
      { write },
      new AbortController().signal,
    );

    expect(write).toHaveBeenCalledWith(expect.stringContaining('work.created'));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('cause-1'));
  });

  it('runs explicit projection rebuilding only when requested', async () => {
    const rebuild = vi.fn(async () => undefined);
    const applications = fixtureApplications([]);
    applications.validateState.rebuildProjections = rebuild;

    await runWakeCommand(
      { kind: 'validate-state', rebuildProjections: true },
      applications,
      { write: vi.fn() },
      new AbortController().signal,
    );

    expect(rebuild).toHaveBeenCalledOnce();
  });
});

function fixtureApplications(calls: string[]): WakeCliApplications {
  return {
    tick: {
      run: async () => {
        calls.push('tick');
        return { advances: 0, runs: 0, stoppedBecause: 'idle' };
      },
    },
    start: {
      run: async () => {
        calls.push('start');
        return { advances: 0, runs: 0, stoppedBecause: 'shutdown' };
      },
    },
    stop: {
      stop: async () => {
        calls.push('stop');
      },
    },
    api: {
      start: async () => {
        calls.push('api');
      },
    },
    ui: {
      start: async () => {
        calls.push('ui');
      },
    },
    audit: {
      read: async () => [
        {
          eventId: 'event-1',
          eventType: 'work.created',
          occurredAt: '2026-07-31T10:00:00.000Z',
          stream: 'work-demo',
          causationId: 'cause-1',
          correlationId: 'correlation-1',
        },
      ],
    },
    correlate: { correlate: async () => ({ resourceId: 'resource-1', workItemId: 'work-demo' }) },
    validateState: {
      health: async () => ({ journal: 'ok', projections: 'ok', checkpoints: 'ok' }),
      rebuildProjections: async () => undefined,
    },
  };
}
