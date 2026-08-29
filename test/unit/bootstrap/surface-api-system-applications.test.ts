import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { createSurfaceApiApplications } from '../../../src/bootstrap/surface-api-applications.js';

it('uses the subscriber one-shot scheduler pass without duplicating dispatch through the API tick', async () => {
  const scheduler = {
    poke: vi.fn(async () => ({
      kind: 'progressed' as const,
      dispatched: [{ activationId: 'activation-one', runId: 'run-one' }],
    })),
  };
  const runnerPipeline = { run: vi.fn(async () => ({ kind: 'no-work' as const })) };
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [],
      activationSchedulerSubscriber: scheduler,
      runnerPipeline,
      projections: { read: async () => null },
      journal: { readAll: async () => [] },
      maintenance: { read: async () => null },
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  await expect(
    applications.controlPlane.tick?.({ idempotencyKey: 'api-tick-one' }),
  ).resolves.toMatchObject({
    status: 'completed',
  });

  expect(scheduler.poke).toHaveBeenCalledOnce();
  expect(runnerPipeline.run).toHaveBeenCalledOnce();
});

it('surfaces adapter health checks from provider instances alongside system checks', async () => {
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [
        {
          adapter: 'github-issues',
          provider: 'github',
          health: () => [
            {
              scope: 'atolis-hq/wake',
              channel: 'read',
              status: 'ok',
              successCount: 12,
              failureCount: 0,
            },
          ],
        },
        {
          adapter: 'github-pull-requests',
          provider: 'github',
          health: () => [
            {
              scope: 'atolis-hq/wake',
              channel: 'write',
              status: 'degraded',
              detail: '3 consecutive failures',
              successCount: 4,
              failureCount: 3,
            },
          ],
        },
        // A provider without a health() accessor must be skipped, not throw.
        { adapter: 'no-health-provider', provider: 'fake' },
      ],
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  const response = await applications.system.health();

  expect(response.data.adapters).toEqual([
    {
      adapter: 'github-issues',
      provider: 'github',
      scope: 'atolis-hq/wake',
      channel: 'read',
      status: 'ok',
      successCount: 12,
      failureCount: 0,
    },
    {
      adapter: 'github-pull-requests',
      provider: 'github',
      scope: 'atolis-hq/wake',
      channel: 'write',
      status: 'degraded',
      detail: '3 consecutive failures',
      successCount: 4,
      failureCount: 3,
    },
  ]);
  expect(response.data.status).toBe('degraded');
});

it('stays ok when every adapter health check is ok', async () => {
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [
        {
          adapter: 'github-issues',
          provider: 'github',
          health: () => [
            {
              scope: 'atolis-hq/wake',
              channel: 'read',
              status: 'ok',
              successCount: 1,
              failureCount: 0,
            },
          ],
        },
      ],
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  const response = await applications.system.health();

  expect(response.data.status).toBe('ok');
});

it('surfaces durable activation scheduler subscription health', async () => {
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [],
      activationSchedulerSubscriber: {
        health: () => ({
          consumer: 'activation-scheduler',
          status: 'degraded',
          checkpoint: 4,
          consecutiveFailures: 2,
          lastError: new Error('scheduler failed'),
        }),
      },
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  const response = await applications.system.health();

  expect(response.data.status).toBe('degraded');
  expect(response.data.checks).toContainEqual({
    name: 'activation-scheduler',
    status: 'degraded',
    detail: 'degraded at checkpoint 4 after 2 failures',
  });
});

it('surfaces commands from provider instances that expose them, skipping those that do not', async () => {
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [
        {
          adapter: 'github-issues',
          provider: 'github',
          commands: () => [
            { syntax: '/approved' },
            { syntax: '/accepted' },
            { syntax: '/changes' },
            { syntax: '/retry' },
          ],
        },
        // A provider without a commands() accessor must be skipped, not throw.
        { adapter: 'no-commands-provider', provider: 'fake' },
      ],
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  const response = await applications.system.commands();

  expect(response.data.adapters).toEqual([
    {
      adapter: 'github-issues',
      provider: 'github',
      commands: [
        { syntax: '/approved' },
        { syntax: '/accepted' },
        { syntax: '/changes' },
        { syntax: '/retry' },
      ],
    },
  ]);
});
