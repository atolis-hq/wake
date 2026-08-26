import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityRegistry,
  ExternalExecutionKind,
  activityName,
} from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import { correlationId } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src/persistence/index.js';
import {
  ResourceCorrelationRole,
  resourceCapability,
  resourceKind,
} from '../../../src/resources/index.js';
import { createApiDispatcher, createSurfaceHttpServer } from '../../../src/surfaces/index.js';
import {} from '../../../src/work/index.js';
import { resId, workId } from '../../support/identities.js';

const scenario = { id: 'E2E-SURFACE-001' } as const;

describe(`${scenario.id} API metadata provenance`, () => {
  it('attributes a retracted resource correlation to Work detail absence', async () => {
    const { root, context } = await createWorld();
    await root.work.create(
      { workItemId: workId('retracted'), objective: 'Track absence provenance' },
      context,
    );
    const discovered = await root.resources.discover(
      {
        resourceId: resId('retracted'),
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'github', key: 'atolis/wake#retracted' },
        capabilities: [resourceCapability('review')],
      },
      context,
    );
    const correlatedAt = '2026-07-31T10:05:00.000Z';
    await root.resources.correlate(
      discovered.resourceId,
      workId('retracted'),
      ResourceCorrelationRole.Primary,
      { ...context, commandId: 'surface-correlate', occurredAt: correlatedAt },
    );
    const retractedAt = '2026-07-31T10:10:00.000Z';
    await root.resources.retract(discovered.resourceId, workId('retracted'), {
      ...context,
      commandId: 'surface-retract',
      occurredAt: retractedAt,
    });
    await root.projectionRunner.runRegisteredOnce();
    const work = (
      await createSurfaceApplications(root, {
        now: () => '2026-07-31T11:00:00.000Z',
      })
    ).api.work;
    const page = await work.list({ limit: 1 });
    const detail = await work.detail(page.items[0]!.workItemKey);

    expect(detail?.data.resources).toEqual([]);
    expect(detail?.meta).toEqual({ asOf: retractedAt, position: 4 });
  });

  it('pages events from the highest global position', async () => {
    const { root, context } = await createWorld();
    await root.work.create(
      { workItemId: workId('earlier-event'), objective: 'Earlier event' },
      context,
    );
    await root.work.create(
      { workItemId: workId('later-event'), objective: 'Later event' },
      {
        ...context,
        commandId: 'surface-event-later',
        correlationId: correlationId('surface-event-later'),
      },
    );
    const events = (
      await createSurfaceApplications(root, {
        now: () => '2026-07-31T11:00:00.000Z',
      })
    ).api.events;

    const first = await events.list({ limit: 1 });
    const second = await events.list({ limit: 1, cursor: { position: first.nextPosition! } });

    expect(first.items.map((event) => event.position)).toEqual([2]);
    expect(first.nextPosition).toBe(2);
    expect(second.items.map((event) => event.position)).toEqual([1]);
  });
  it('timestamps collection totals and empty filters from the newest contributing fact', async () => {
    const { root, context } = await createWorld();
    await root.work.create({ workItemId: workId('earlier'), objective: 'Earlier work' }, context);
    const laterAt = '2026-07-31T10:05:00.000Z';
    await root.work.create(
      { workItemId: workId('later'), objective: 'Later work' },
      { ...context, commandId: 'surface-flow-later', occurredAt: laterAt },
    );
    await root.projectionRunner.runRegisteredOnce();
    const work = (
      await createSurfaceApplications(root, {
        now: () => '2026-07-31T11:00:00.000Z',
      })
    ).api.work;

    const firstPage = await work.list({ limit: 1 });
    const emptyFilter = await work.list({ limit: 1, search: 'no-match' });

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.total).toBe(2);
    expect(firstPage.meta).toEqual({ asOf: laterAt, position: 2 });
    expect(emptyFilter.items).toEqual([]);
    expect(emptyFilter.meta).toEqual({ asOf: laterAt, position: 2 });
  });
});

describe(`${scenario.id} API domain shape`, () => {
  it('enriches work-detail runs with workflow context', async () => {
    const { root, context } = await createWorld();
    const work = await root.work.create(
      { workItemId: workId('run-context'), objective: 'Show run context' },
      context,
    );
    await root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-run-context'),
        workItemId: work.workItemId,
        workflowName: workflowName('default'),
        orchestrationGroupId: orchestrationGroupId('group-run-context'),
      },
      context,
    );
    await root.advanceOnce({ maxProgress: 1 });
    await root.projectionRunner.runRegisteredOnce();

    const surface = await createSurfaceApplications(root, {
      now: () => '2026-07-31T11:00:00.000Z',
    });
    const page = await surface.api.work.list({ limit: 1 });
    const detail = await surface.api.work.detail(page.items[0]!.workItemKey);

    expect(detail?.data.execution.runs).toEqual([
      expect.objectContaining({ workflowName: 'default', stage: 'implement' }),
    ]);
  });

  it('reads detail state through work-scoped projections', async () => {
    const { root, context } = await createWorld();
    const work = await root.work.create(
      { workItemId: workId('scoped-detail'), objective: 'Read only this work item' },
      context,
    );
    await root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-scoped-detail'),
        workItemId: work.workItemId,
        workflowName: workflowName('default'),
        orchestrationGroupId: orchestrationGroupId('group-scoped-detail'),
      },
      context,
    );
    await root.advanceOnce({ maxProgress: 1 });
    await root.projectionRunner.runRegisteredOnce();

    const page = await (
      await createSurfaceApplications(root, {
        now: () => '2026-07-31T11:00:00.000Z',
      })
    ).api.work.list({ limit: 1 });
    const list = vi.spyOn(root.projections, 'list').mockRejectedValue(new Error('global list'));
    const journalReads = vi.spyOn(root.journal, 'readAll');

    const detail = await (
      await createSurfaceApplications(root, {
        now: () => '2026-07-31T11:00:00.000Z',
      })
    ).api.work.detail(page.items[0]!.workItemKey);

    expect(detail?.data.execution.runs).toHaveLength(1);
    expect(list).not.toHaveBeenCalled();
    expect(journalReads).not.toHaveBeenCalledWith(0);
  });

  it('queries composed production services over real HTTP without provider or workspace leakage', async () => {
    // Given composed production applications create canonical Work, Resource, workflow, and Run facts.
    const { root, clock, context } = await createWorld();
    const work = await root.work.create(
      { workItemId: workId('surface'), objective: 'Expose target surface' },
      context,
    );
    const resource = await root.resources.discover(
      {
        resourceId: resId('surface'),
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'github', key: 'atolis/wake#25' },
        capabilities: [resourceCapability('review')],
      },
      context,
    );
    await root.resources.correlate(
      resource.resourceId,
      work.workItemId,
      ResourceCorrelationRole.Primary,
      context,
    );
    await root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-surface'),
        workItemId: work.workItemId,
        workflowName: workflowName('default'),
        orchestrationGroupId: orchestrationGroupId('group-surface'),
      },
      context,
    );
    await root.advanceOnce({ maxProgress: 1 });
    await root.projectionRunner.runRegisteredOnce();

    // When the real Fastify HTTP Surface queries the injected production facade.
    const surface = await createSurfaceApplications(root, {
      now: () => '2026-07-31T11:00:00.000Z',
    });
    const server = createSurfaceHttpServer({
      dispatcher: createApiDispatcher(surface.api),
      credentials: {
        accessKey: 'e2e-access-key',
        sessionPassword: Buffer.alloc(32, 4).toString('base64url'),
        createdAt: clock.now().toISOString(),
      },
    });
    try {
      const login = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { accessKey: 'e2e-access-key' },
      });
      const setCookie = login.headers['set-cookie'];
      if (typeof setCookie !== 'string') throw new Error('Expected login session cookie');
      const headers = { cookie: setCookie.split(';', 1)[0]! };
      const list = (
        await server.inject({ method: 'GET', url: '/api/v1/work-items', headers })
      ).json() as {
        items: readonly { workItemKey: string }[];
      };
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/work-items/${encodeURIComponent(list.items[0]!.workItemKey)}`,
        headers,
      });
      const body = response.json() as {
        data: Record<string, unknown>;
        meta: { asOf: string; position?: number };
      };

      // Then identity is Wake-owned and cross-domain data stays nested and redacted.
      expect(response.statusCode).toBe(200);
      expect(list.items[0]!.workItemKey).toMatch(/^wk_/);
      expect(body.data).toHaveProperty('work');
      expect(body.data).toHaveProperty('resources');
      expect(body.data).toHaveProperty('orchestration');
      expect(body.data).toHaveProperty('execution');
      expect(body.data).toHaveProperty('activities');
      expect(body.meta.asOf).toBe(clock.now().toISOString());
      expect(body.meta.position).toBeTypeOf('number');
      expect(JSON.stringify(body)).toContain('https://github.com/atolis/wake/issues/25');
      expect(JSON.stringify(body)).not.toContain('workspace');
    } finally {
      await server.close();
    }
  });
});

describe(`${scenario.id} command idempotency`, () => {
  it('resolves an ambiguous run durably over the composed API before retrying only failed work', async () => {
    const failed = await createAmbiguousRunWorld('failed');
    const failedWork = await startAmbiguousRun(failed, 'failed');
    const failedSurface = await createSurfaceApplications(failed.root, {
      now: () => failed.clock.now().toISOString(),
    });
    const failedDispatcher = createApiDispatcher(failedSurface.api);
    const failedPage = await failedSurface.api.work.list({ limit: 1 });

    expect(
      await failedDispatcher.dispatch(
        'POST',
        `/api/v1/runs/${encodeURIComponent(failedWork.runId)}/commands/resolve`,
        {
          idempotencyKey: 'operator-resolve-failed',
          status: 'failed',
          reason: 'Operator confirmed no work completed',
        },
      ),
    ).toMatchObject({ status: 202 });
    expect((await failed.root.execution.list()).at(0)).toMatchObject({ status: 'failed' });
    expect(await failed.root.orchestration.get(failedWork.workflowInstanceId)).toMatchObject({
      status: 'blocked',
    });

    expect(
      await failedDispatcher.dispatch(
        'POST',
        `/api/v1/work-items/${encodeURIComponent(failedPage.items[0]!.workItemKey)}/commands/retry`,
        { idempotencyKey: 'operator-retry-after-failed-resolution' },
      ),
    ).toMatchObject({ status: 202 });
    await failed.root.advanceOnce({ maxProgress: 1 });
    expect(await failed.root.execution.list()).toHaveLength(2);

    const succeeded = await createAmbiguousRunWorld('succeeded');
    const succeededWork = await startAmbiguousRun(succeeded, 'succeeded');
    const succeededSurface = await createSurfaceApplications(succeeded.root, {
      now: () => succeeded.clock.now().toISOString(),
    });
    const succeededDispatcher = createApiDispatcher(succeededSurface.api);
    const succeededPage = await succeededSurface.api.work.list({ limit: 1 });

    expect(
      await succeededDispatcher.dispatch(
        'POST',
        `/api/v1/runs/${encodeURIComponent(succeededWork.runId)}/commands/resolve`,
        {
          idempotencyKey: 'operator-resolve-succeeded',
          status: 'succeeded',
          outcome: { kind: 'done' },
        },
      ),
    ).toMatchObject({ status: 202 });
    expect((await succeeded.root.execution.list()).at(0)).toMatchObject({ status: 'succeeded' });
    const resolvedWorkflow = await succeeded.root.orchestration.get(
      succeededWork.workflowInstanceId,
    );
    expect(resolvedWorkflow?.status).not.toBe('blocked');
    expect(resolvedWorkflow?.acceptedOutcomes).toHaveLength(1);
    expect(
      await succeededDispatcher.dispatch(
        'POST',
        `/api/v1/work-items/${encodeURIComponent(succeededPage.items[0]!.workItemKey)}/commands/retry`,
        { idempotencyKey: 'retry-after-succeeded-resolution' },
      ),
    ).toMatchObject({ status: 409, body: { code: 'retry-ineligible' } });
  }, 15_000);

  it('accepts an eligible blocked-work retry over the composed HTTP API', async () => {
    const { root, clock, context } = await createRetryWorld();
    const work = await root.work.create(
      { workItemId: workId('surface-retry'), objective: 'Retry blocked work' },
      context,
    );
    await root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-surface-retry'),
        workItemId: work.workItemId,
        workflowName: workflowName('default'),
        orchestrationGroupId: orchestrationGroupId('group-surface-retry'),
      },
      context,
    );
    await root.advanceOnce({ maxProgress: 1 });
    await vi.waitFor(async () => {
      expect((await root.execution.list()).at(0)?.status).toBe('succeeded');
    });
    await root.advanceOnce({ maxProgress: 1 });
    await root.projectionRunner.runRegisteredOnce();

    const surface = await createSurfaceApplications(root, { now: () => clock.now().toISOString() });
    const page = await surface.api.work.list({ limit: 1 });
    const detail = await surface.api.work.detail(page.items[0]!.workItemKey);
    expect(detail?.data.orchestration.primary?.retryEligible).toBe(true);

    const response = await createApiDispatcher(surface.api).dispatch(
      'POST',
      `/api/v1/work-items/${encodeURIComponent(page.items[0]!.workItemKey)}/commands/retry`,
      { idempotencyKey: 'operator-retry-1' },
    );

    expect(response?.status).toBe(202);
    expect(response?.body).toMatchObject({
      data: { idempotencyKey: 'operator-retry-1', status: 'accepted' },
    });
  });

  it('rejects an ineligible retry over the composed HTTP API', async () => {
    const { root, clock, context } = await createRetryWorld();
    await root.work.create(
      {
        workItemId: workId('surface-retry-ineligible'),
        objective: 'Cannot retry without workflow',
      },
      context,
    );
    await root.projectionRunner.runRegisteredOnce();

    const surface = await createSurfaceApplications(root, { now: () => clock.now().toISOString() });
    const page = await surface.api.work.list({ limit: 1 });
    const response = await createApiDispatcher(surface.api).dispatch(
      'POST',
      `/api/v1/work-items/${encodeURIComponent(page.items[0]!.workItemKey)}/commands/retry`,
      { idempotencyKey: 'operator-retry-ineligible' },
    );

    expect(response?.status).toBe(409);
    expect(response?.body).toMatchObject({
      code: 'retry-ineligible',
      detail: 'Work item has no primary workflow',
    });
  });

  it('deduplicates a production advance command by idempotency key', async () => {
    const { root, clock, context } = await createWorld();
    const surface = await createSurfaceApplications(root, { now: () => clock.now().toISOString() });
    const advance = surface.api.controlPlane.tick;
    if (advance === undefined) throw new Error('Expected the production advance command');

    const first = await advance({ idempotencyKey: 'operator-action-1' });
    expect(first).toMatchObject({
      result: {
        data: { paused: false, updatedAt: clock.now().toISOString() },
        meta: { asOf: clock.now().toISOString() },
      },
    });
    const work = await root.work.create(
      { workItemId: workId('after-command'), objective: 'Wait for a new command' },
      context,
    );
    await root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-after-command'),
        workItemId: work.workItemId,
        workflowName: workflowName('default'),
        orchestrationGroupId: orchestrationGroupId('group-after-command'),
      },
      context,
    );

    expect(await advance({ idempotencyKey: 'operator-action-1' })).toEqual(first);
    expect(await root.execution.list()).toEqual([]);
    await advance({ idempotencyKey: 'operator-action-2' });
    expect(await root.execution.list()).toHaveLength(1);

    for (let index = 0; index <= 100; index += 1)
      await advance({ idempotencyKey: `recent-action-${index}` });
    const laterContext = {
      ...context,
      commandId: 'surface-flow-later',
      correlationId: correlationId('surface-flow-later'),
    };
    const laterWork = await root.work.create(
      { workItemId: workId('after-eviction'), objective: 'Bound completed commands' },
      laterContext,
    );
    await root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-after-eviction'),
        workItemId: laterWork.workItemId,
        workflowName: workflowName('default'),
        orchestrationGroupId: orchestrationGroupId('group-after-eviction'),
      },
      laterContext,
    );
    await advance({ idempotencyKey: 'operator-action-1' });
    expect(await root.execution.list()).toHaveLength(2);
  }, 30_000);
});

const boardScenario = { id: 'E2E-SURFACE-BOARD-001' } as const;

it(`${boardScenario.id} projects composed Work and Run state into bounded operator board cards`, async () => {
  const { root, context } = await createWorld();
  const work = await root.work.create(
    { workItemId: workId('board-card'), objective: 'Show operator board state' },
    context,
  );
  await root.orchestration.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-board-card'),
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-board-card'),
    },
    context,
  );
  await root.advanceOnce({ maxProgress: 1 });
  await root.projectionRunner.runRegisteredOnce();

  const page = await (
    await createSurfaceApplications(root, {
      now: () => '2026-07-31T11:00:00.000Z',
    })
  ).api.board!.list({ limit: 10 });

  expect(page.total).toBe(1);
  expect(page.items[0]).toMatchObject({ workItemKey: expect.stringMatching(/^wk_/) });
  expect(page.conditionCounts).toEqual(expect.any(Object));
});

const analyticsScenario = { id: 'E2E-SURFACE-ANALYTICS-001' } as const;

it(`${analyticsScenario.id} returns an incremental composed analytics window with projection provenance`, async () => {
  const { root, context } = await createWorld();
  await root.work.create(
    { workItemId: workId('analytics'), objective: 'Count analytics facts' },
    context,
  );
  await root.projectionRunner.runRegisteredOnce();

  const result = await (
    await createSurfaceApplications(root, {
      now: () => '2026-07-31T11:00:00.000Z',
    })
  ).api.observability!.metrics({ days: 1 });

  expect(result.data.window).toEqual({ days: 1, from: '2026-07-31', to: '2026-07-31' });
  expect(result.data.values).toMatchObject({ events: expect.any(Number), workItems: 1 });
  expect(result.meta.position).toBeTypeOf('number');
});

async function createWorld() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: { execute: async () => ({ kind: ActivityOutcomeKind.Done }) },
  });
  const clock = { now: () => new Date('2026-07-31T10:00:00.000Z') };
  const root = await createCompositionRoot('C:/wake-home', {
    config: parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      activities: {},
      orchestration: {
        workflows: {
          default: {
            stages: {
              implement: { activity: 'implement', with: {}, on: { done: { then: 'done' } } },
            },
          },
        },
      },
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    }),
    activities,
    clock,
    journal: new InMemoryEventJournal(clock),
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
  });
  return {
    root,
    clock,
    context: {
      commandId: 'surface-flow',
      correlationId: correlationId('surface-flow'),
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'system' as const, id: 'test' },
    },
  };
}

async function createRetryWorld() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z
      .object({ kind: z.enum([ActivityOutcomeKind.Done, ActivityOutcomeKind.Failed]) })
      .strict(),
    outcomeKinds: [ActivityOutcomeKind.Done, ActivityOutcomeKind.Failed],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: { execute: async () => ({ kind: ActivityOutcomeKind.Failed }) },
  });
  const clock = { now: () => new Date('2026-07-31T10:00:00.000Z') };
  const root = await createCompositionRoot('C:/wake-home', {
    config: parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      activities: {},
      orchestration: {
        workflows: {
          default: {
            stages: {
              implement: { activity: 'implement', with: {}, on: { done: { then: 'done' } } },
            },
          },
        },
      },
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    }),
    activities,
    clock,
    journal: new InMemoryEventJournal(clock),
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
  });
  return {
    root,
    clock,
    context: {
      commandId: 'surface-retry-flow',
      correlationId: correlationId('surface-retry-flow'),
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'system' as const, id: 'test' },
    },
  };
}

async function createAmbiguousRunWorld(suffix: string) {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('external-run'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Agent,
    handler: {
      async execute(_invocation, context) {
        context.reportRunnerStarted?.();
        const execution = await context.runner!.start(
          { runId: context.runId!, prompt: 'recover this run', allowedTools: [] },
          context.signal,
        );
        if (execution.identity !== undefined)
          await context.reportExternalExecution(execution.identity);
        return new Promise<never>(() => {});
      },
    },
  });
  let now = new Date('2026-07-31T10:00:00.000Z');
  const clock = { now: () => new Date(now) };
  const root = await createCompositionRoot(`C:/wake-home-${suffix}`, {
    config: parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      activities: {},
      orchestration: {
        workflows: {
          default: {
            stages: {
              implement: { activity: 'external-run', with: {}, on: { done: { then: 'done' } } },
            },
          },
        },
      },
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    }),
    activities,
    clock,
    journal: new InMemoryEventJournal(clock),
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
    decorateRunner: () => ({
      async start(_request, _signal) {
        return {
          identity: {
            kind: ExternalExecutionKind.Process,
            id: `process-${suffix}`,
            startedAt: clock.now().toISOString(),
          },
          result: new Promise(() => {}),
          async cancel() {},
        };
      },
    }),
  });
  return {
    root,
    clock,
    advanceClock(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    context: {
      commandId: `surface-ambiguous-${suffix}`,
      correlationId: correlationId(`surface-ambiguous-${suffix}`),
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'system' as const, id: 'test' },
    },
  };
}

async function startAmbiguousRun(
  world: Awaited<ReturnType<typeof createAmbiguousRunWorld>>,
  suffix: string,
) {
  const work = await world.root.work.create(
    {
      workItemId: workId(`surface-ambiguous-${suffix}`),
      objective: 'Resolve unknown external work',
    },
    world.context,
  );
  const instanceId = workflowInstanceId(`workflow-surface-ambiguous-${suffix}`);
  await world.root.orchestration.start(
    {
      workflowInstanceId: instanceId,
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId(`group-surface-ambiguous-${suffix}`),
    },
    world.context,
  );
  await world.root.advanceOnce({ maxProgress: 1 });
  await vi.waitFor(async () => {
    expect((await world.root.execution.list()).at(0)).toMatchObject({
      status: 'started',
      externalExecution: expect.any(Object),
    });
  });
  const run = (await world.root.execution.list())[0]!;
  world.advanceClock(60_001);
  await world.root.recovery.recover(run.runId, 'recovery');
  await world.root.recovery.recover(run.runId, 'recovery');
  await world.root.recovery.recover(run.runId, 'recovery');
  expect((await world.root.execution.list())[0]).toMatchObject({
    status: 'ambiguous',
    escalated: true,
  });
  await world.root.projectionRunner.runRegisteredOnce();
  return { runId: run.runId, workflowInstanceId: instanceId };
}
