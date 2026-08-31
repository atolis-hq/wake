import {
  EventActorKind,
  EventSourceKind,
  causationId,
  correlationId,
  eventId,
} from '@atolis-hq/eventing';
import { describe, expect, it, vi } from 'vitest';
import { createSurfaceApplications, type CompositionRoot } from '../../../src/bootstrap/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { runWakeCommand, type WakeCliApplications } from '../../../src/surfaces/cli/main.js';

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

  it('reads audit facts from the composed canonical journal and formats target records', async () => {
    const clock = { now: () => new Date('2026-08-11T12:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    await journal.appendToStream({ kind: 'work-item', id: 'work-demo' }, 0, [
      {
        eventId: eventId('audit-event'),
        eventType: 'work.created',
        schemaVersion: 1,
        occurredAt: clock.now().toISOString(),
        correlationId: correlationId('audit-correlation'),
        causationId: causationId('audit-causation'),
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        payload: { objective: 'Audit the canonical journal' },
      },
    ]);
    await journal.appendToStream({ kind: 'resource', id: 'work-demo' }, 0, [
      {
        eventId: eventId('same-id-non-work-event'),
        eventType: 'resource.registered',
        schemaVersion: 1,
        occurredAt: clock.now().toISOString(),
        correlationId: correlationId('non-work-correlation'),
        causationId: causationId('non-work-causation'),
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        payload: { provider: 'test' },
      },
    ]);
    const root = {
      journal,
      paths: { wakeRoot: 'C:/wake' },
      config: {
        host: {
          development: { mode: 'packaged' },
          sandbox: {
            image: 'wake:test',
            containerName: 'wake-test',
            wakeMountPath: '/wake',
            containerHomeMountPath: '/home/wake',
            extraMounts: [],
            start: { enabled: false },
          },
        },
        surfaces: { api: { enabled: false } },
      },
      projections: new Proxy(
        {},
        {
          get() {
            throw new Error('audit must not read projections');
          },
        },
      ),
      processorRuntime: {
        processors: [],
        catchUp: async () => 0,
      },
    } as unknown as CompositionRoot;
    const applications = (
      await createSurfaceApplications(root, {
        now: () => clock.now().toISOString(),
      })
    ).cli;
    const output: string[] = [];

    await runWakeCommand(
      { kind: 'audit', workItemId: 'work-demo' },
      applications,
      { write: (value) => output.push(value) },
      new AbortController().signal,
    );

    expect(output).toEqual([
      `${JSON.stringify({
        eventId: 'audit-event',
        eventType: 'work.created',
        occurredAt: '2026-08-11T12:00:00.000Z',
        stream: 'work-item:work-demo',
        causationId: 'audit-causation',
        correlationId: 'audit-correlation',
      })}\n`,
    ]);
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
