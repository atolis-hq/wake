import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { workId, resId } from '../../support/identities.js';
import { z } from 'zod';
import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityRegistry,
  activityName,
} from '../../../src-next/activities/index.js';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src-next/bootstrap/index.js';
import { correlationId } from '../../../src-next/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src-next/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src-next/persistence/index.js';
import {
  resourceCapability,
  resourceKind,
  ResourceCorrelationRole,
} from '../../../src-next/resources/index.js';
import { createApiDispatcher, createApiHttpServer } from '../../../src-next/surfaces/index.js';
import {} from '../../../src-next/work/index.js';

describe('E2E-SURFACE-001 API metadata provenance', () => {
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
    const work = createSurfaceApplications(root, {
      now: () => '2026-07-31T11:00:00.000Z',
    }).api.work;
    const page = await work.list({ limit: 1 });
    const detail = await work.detail(page.items[0]!.workItemKey);

    expect(detail?.data.resources).toEqual([]);
    expect(detail?.meta).toEqual({ asOf: retractedAt, position: 4 });
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
    const work = createSurfaceApplications(root, {
      now: () => '2026-07-31T11:00:00.000Z',
    }).api.work;

    const firstPage = await work.list({ limit: 1 });
    const emptyFilter = await work.list({ limit: 1, search: 'no-match' });

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.total).toBe(2);
    expect(firstPage.meta).toEqual({ asOf: laterAt, position: 2 });
    expect(emptyFilter.items).toEqual([]);
    expect(emptyFilter.meta).toEqual({ asOf: laterAt, position: 2 });
  });
});

describe('E2E-SURFACE-001 API domain shape', () => {
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

    // When the real Node HTTP Surface queries the injected production facade.
    const surface = createSurfaceApplications(root, { now: () => '2026-07-31T11:00:00.000Z' });
    const server = createApiHttpServer(createApiDispatcher(surface.api));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const list = (await (
        await fetch(`http://127.0.0.1:${address.port}/api/v1/work-items`)
      ).json()) as { items: readonly { workItemKey: string }[] };
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/work-items/${encodeURIComponent(list.items[0]!.workItemKey)}`,
      );
      const body = (await response.json()) as {
        data: Record<string, unknown>;
        meta: { asOf: string; position?: number };
      };

      // Then identity is Wake-owned and cross-domain data stays nested and redacted.
      expect(response.status).toBe(200);
      expect(list.items[0]!.workItemKey).toMatch(/^wk_/);
      expect(body.data).toHaveProperty('work');
      expect(body.data).toHaveProperty('resources');
      expect(body.data).toHaveProperty('orchestration');
      expect(body.data).toHaveProperty('execution');
      expect(body.data).toHaveProperty('activities');
      expect(body.meta.asOf).toBe(clock.now().toISOString());
      expect(body.meta.position).toBeTypeOf('number');
      expect(JSON.stringify(body)).not.toContain('github');
      expect(JSON.stringify(body)).not.toContain('atolis/wake');
      expect(JSON.stringify(body)).not.toContain('workspace');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

describe('E2E-SURFACE-001 command idempotency', () => {
  it('deduplicates a production advance command by idempotency key', async () => {
    const { root, clock, context } = await createWorld();
    const surface = createSurfaceApplications(root, { now: () => clock.now().toISOString() });
    const advance = surface.api.controlPlane.advance;
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
  });
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
        tiers: { standard: ['fake'] },
        defaultTier: 'standard',
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
