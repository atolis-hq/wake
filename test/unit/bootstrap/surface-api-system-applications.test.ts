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
  const runnerPipeline = {
    run: vi.fn(async (_options, _signal, beforeDelivery: (() => Promise<void>) | undefined) => {
      await beforeDelivery?.();
      return { kind: 'no-work' as const };
    }),
  };
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [],
      activationSchedulerSubscriber: {
        ...scheduler,
        processor: {} as never,
        lastResult: () => undefined,
      },
      processorRuntime: { processors: [], catchUp: async () => 0 },
      projectionSubscriptions: { catchUpOnce: async () => 0 },
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
      activationSchedulerSubscriber: { health: () => undefined },
      processorRuntime: {
        processors: [{ consumer: 'subscriber:control-plane.activation-scheduler' }],
        health: async () => [
          {
            consumer: 'subscriber:control-plane.activation-scheduler',
            status: 'healthy',
            checkpoint: 9,
            head: 12,
            lag: 3,
            consecutiveFailures: 0,
          },
        ],
      },
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
      activationSchedulerSubscriber: {
        health: () => ({
          consumer: 'activation-scheduler',
          status: 'healthy',
          checkpoint: 0,
          consecutiveFailures: 0,
        }),
      },
      processorRuntime: { processors: [], health: async () => [] },
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
      processorRuntime: {
        processors: [{ consumer: 'subscriber:control-plane.activation-scheduler' }],
        health: async () => [
          {
            consumer: 'subscriber:control-plane.activation-scheduler',
            status: 'healthy',
            checkpoint: 9,
            head: 12,
            lag: 3,
            consecutiveFailures: 0,
          },
        ],
      },
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  const response = await applications.system.health();

  expect(response.data.status).toBe('degraded');
  expect(response.data.checks).toContainEqual({
    name: 'activation-scheduler',
    status: 'degraded',
    detail: 'degraded at checkpoint 9 after 2 failures; last error Error: scheduler failed',
  });
});

it('bounds and sanitizes processor errors in health diagnostics', async () => {
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [],
      activationSchedulerSubscriber: { health: () => undefined },
      processorRuntime: {
        processors: [{ consumer: 'projection:work' }],
        health: async () => [
          {
            consumer: 'projection:work',
            status: 'degraded',
            checkpoint: 12,
            consecutiveFailures: 3,
            lastError: {
              name: `Processor${'n'.repeat(300)}`,
              message: `failed\n${'m'.repeat(1_000)}`,
            },
          },
        ],
      },
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  const response = await applications.system.health();
  const check = response.data.checks?.find(({ name }) => name === 'projection:work');

  expect(check?.detail).toBe(
    `degraded at checkpoint 12 after 3 failures; last error Processor${'n'.repeat(111)}: failed ${'m'.repeat(493)}`,
  );
  expect(check?.detail).not.toContain('\n');
});

it('redacts credentials from processor health errors', async () => {
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [],
      activationSchedulerSubscriber: { health: () => undefined },
      processorRuntime: {
        processors: [{ consumer: 'projection:work' }],
        health: async () => [
          {
            consumer: 'projection:work',
            status: 'degraded',
            checkpoint: 12,
            consecutiveFailures: 1,
            lastError: new Error(
              'Authorization: Bearer ghp_supersecret token=query-secret&signature=signed-secret',
            ),
          },
        ],
      },
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  const response = await applications.system.health();
  const detail = response.data.checks?.find(({ name }) => name === 'projection:work')?.detail;

  expect(detail).toContain('[REDACTED]');
  expect(detail).not.toMatch(/ghp_supersecret|query-secret|signed-secret/);
});

it('keeps health available when a custom Error has malformed fields', async () => {
  const malformed = new Error('failed');
  Object.defineProperty(malformed, 'message', { value: Symbol('message') });
  Object.defineProperty(malformed, 'name', { value: 42 });
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [],
      activationSchedulerSubscriber: { health: () => undefined },
      processorRuntime: {
        processors: [{ consumer: 'projection:work' }],
        health: async () => [
          {
            consumer: 'projection:work',
            status: 'degraded',
            checkpoint: 12,
            consecutiveFailures: 1,
            lastError: malformed,
          },
        ],
      },
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  await expect(applications.system.health()).resolves.toMatchObject({
    data: {
      checks: expect.arrayContaining([
        expect.objectContaining({
          detail: expect.stringContaining('last error 42: Symbol(message)'),
        }),
      ]),
    },
  });
});

it('surfaces every registered projection consumer and represents absent snapshots as starting', async () => {
  const applications = createSurfaceApiApplications(
    {
      paths: { wakeRoot: tmpdir() },
      config: {},
      providers: [],
      activationSchedulerSubscriber: { health: () => undefined },
      processorRuntime: {
        processors: [{ consumer: 'projection:work' }, { consumer: 'projection:board' }],
        health: async () => [
          {
            consumer: 'projection:work',
            status: 'healthy',
            checkpoint: 12,
            consecutiveFailures: 0,
          },
        ],
      },
    } as unknown as CompositionRoot,
    () => '2026-08-17T00:00:00.000Z',
  );

  const response = await applications.system.health();

  expect(response.data.status).toBe('degraded');
  expect(response.data.checks).toContainEqual({
    name: 'projection:work',
    status: 'ok',
    detail: 'healthy at checkpoint 12 after 0 failures',
  });
  expect(response.data.checks).toContainEqual({
    name: 'projection:board',
    status: 'degraded',
    detail: 'starting at checkpoint 0 after 0 failures',
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
