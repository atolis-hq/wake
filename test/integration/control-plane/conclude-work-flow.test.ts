import { correlationId } from '@atolis-hq/eventing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { createGitHubWakeLabelReconciler } from '../../../src/integrations/github/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
  WorkflowStatus,
} from '../../../src/orchestration/index.js';
import { resourceCapability, resourceKind } from '../../../src/resources/index.js';
import { WorkStatus } from '../../../src/work/index.js';
import { TestWorld } from '../../e2e/support/world.js';
import { resId } from '../../support/identities.js';

const CLOSED = 'work.item-closed';

function registerStep(world: TestWorld) {
  world.registerActivity({
    name: activityName('step'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' as const };
      },
    },
  });
}

const stage = (on: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  activity: 'step',
  with: {},
  execution: { workspace: 'none' },
  requiresApproval: false,
  on,
  ...extra,
});

async function setup(stages: Record<string, unknown>, siblingStages?: Record<string, unknown>) {
  const world = new TestWorld();
  registerStep(world);
  world.configureWorkflow('main', { stages } as never);
  if (siblingStages !== undefined)
    world.configureWorkflow('sibling', { stages: siblingStages } as never);
  const work = await world.createWork({ objective: 'conclude' });
  return { world, workItemId: work.workItemId };
}

// A sibling is a child instance: a second primary cannot be claimed while one is active.
async function startChild(world: TestWorld, workItemId: string, parent: string, name: string) {
  const id = `${parent}:child`;
  return world.orchestration.start(
    {
      workItemId,
      workflowInstanceId: workflowInstanceId(id),
      workflowName: workflowName(name),
      orchestrationGroupId: orchestrationGroupId(parent),
      parentWorkflowInstanceId: workflowInstanceId(parent),
      watchId: 'watch',
      triggerId: 'trigger',
      causalCycleId: 'cycle',
      requestId: workflowInstanceId(id),
    } as never,
    {
      commandId: 'start-child',
      correlationId: correlationId('child'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );
}

describe('workflow routes that conclude work (real services)', () => {
  it('leaves work open when the route makes no declaration', async () => {
    const { world, workItemId } = await setup({ only: stage({ done: { then: 'done' } }) });
    const instance = await world.startWorkflow({ workItemId, workflowName: 'main' });
    await world.advanceUntilSettled(workItemId);
    await world.advance(workItemId);
    expect(await world.viewWorkflow(instance.workflowInstanceId)).toMatchObject({
      status: WorkflowStatus.Completed,
    });
    expect(await world.viewWork(workItemId)).toMatchObject({ state: WorkStatus.Open });
    expect(await world.events(CLOSED)).toHaveLength(0);
  });

  it('closes the work item exactly once and keeps the instance completed', async () => {
    const { world, workItemId } = await setup({
      only: stage({ done: { then: 'done', concludesWork: true } }),
    });
    const instance = await world.startWorkflow({ workItemId, workflowName: 'main' });
    await world.advanceUntilSettled(workItemId);
    for (let pass = 0; pass < 3; pass += 1) await world.advance(workItemId);
    expect(await world.viewWorkflow(instance.workflowInstanceId)).toMatchObject({
      status: WorkflowStatus.Completed,
      concludesWork: true,
    });
    expect(await world.viewWork(workItemId)).toMatchObject({ state: WorkStatus.Closed });
    expect(await world.events(CLOSED)).toHaveLength(1);
  });

  it('closes only after the final done, not after earlier stages', async () => {
    const { world, workItemId } = await setup({
      first: stage({ done: { then: 'second' } }),
      second: stage({ done: { then: 'third' } }),
      third: stage({ done: { then: 'done', concludesWork: true } }),
    });
    const instance = await world.startWorkflow({ workItemId, workflowName: 'main' });
    let sawIntermediateOpen = false;
    for (let tick = 0; tick < 12; tick += 1) {
      await world.advance(workItemId);
      const view = await world.viewWorkflow(instance.workflowInstanceId);
      const item = await world.viewWork(workItemId);
      if (view?.status !== WorkflowStatus.Completed) {
        expect(item?.state).toBe(WorkStatus.Open);
        sawIntermediateOpen = true;
      }
    }
    expect(sawIntermediateOpen).toBe(true);
    expect(await world.viewWork(workItemId)).toMatchObject({ state: WorkStatus.Closed });
    expect(await world.events(CLOSED)).toHaveLength(1);
  });

  it('keeps a completed instance completed when the work is closed externally', async () => {
    const { world, workItemId } = await setup({ only: stage({ done: { then: 'done' } }) });
    const instance = await world.startWorkflow({ workItemId, workflowName: 'main' });
    await world.advanceUntilSettled(workItemId);
    await world.closeWork(workItemId, 'issue closed as completed');
    expect(await world.viewWorkflow(instance.workflowInstanceId)).toMatchObject({
      status: WorkflowStatus.Completed,
    });
    expect(await world.viewWork(workItemId)).toMatchObject({ state: WorkStatus.Closed });
  });

  it('is a no-op when the work was already closed before the instance completed', async () => {
    const { world, workItemId } = await setup({
      only: stage({ done: { then: 'done', concludesWork: true } }),
    });
    const instance = await world.startWorkflow({ workItemId, workflowName: 'main' });
    await world.closeWork(workItemId, 'issue closed');
    await world.advance(workItemId);
    await world.advance(workItemId);
    expect(await world.events(CLOSED)).toHaveLength(1);
    expect((await world.viewWorkflow(instance.workflowInstanceId))?.status).not.toBe(
      WorkflowStatus.Active,
    );
  });

  it('blocks a still-waiting sibling when the primary concludes the work', async () => {
    const { world, workItemId } = await setup(
      { only: stage({ done: { then: 'done', concludesWork: true } }) },
      { gated: stage({ done: { then: 'done' } }, { requiresApproval: true }) },
    );
    const primary = await world.startWorkflow({ workItemId, workflowName: 'main' });
    const sibling = await startChild(world, workItemId, primary.workflowInstanceId, 'sibling');
    await world.advanceUntilSettled(workItemId);
    for (let pass = 0; pass < 3; pass += 1) await world.advance(workItemId);
    expect(await world.viewWorkflow(primary.workflowInstanceId)).toMatchObject({
      status: WorkflowStatus.Completed,
    });
    expect(await world.viewWorkflow(sibling.workflowInstanceId)).toMatchObject({
      status: WorkflowStatus.Blocked,
    });
    expect(await world.events(CLOSED)).toHaveLength(1);
  });

  it('does not close the work when only a non-primary instance declares it', async () => {
    const { world, workItemId } = await setup(
      { gated: stage({ done: { then: 'done' } }, { requiresApproval: true }) },
      { only: stage({ done: { then: 'done', concludesWork: true } }) },
    );
    const primary = await world.startWorkflow({ workItemId, workflowName: 'main' });
    const sibling = await startChild(world, workItemId, primary.workflowInstanceId, 'sibling');
    await world.advanceUntilSettled(workItemId);
    for (let pass = 0; pass < 3; pass += 1) await world.advance(workItemId);
    // The child policy supersedes this child before it can finish; either way the
    // declaration on a non-primary instance must never close the work item.
    expect((await world.viewWorkflow(sibling.workflowInstanceId))?.status).not.toBe(
      WorkflowStatus.Active,
    );
    expect(await world.viewWork(workItemId)).toMatchObject({ state: WorkStatus.Open });
    expect(await world.events(CLOSED)).toHaveLength(0);
    // block() must not flip a superseded instance either.
    expect((await world.viewWorkflow(sibling.workflowInstanceId))?.status).toBe(
      WorkflowStatus.Superseded,
    );
    await world.blockWorkflow(sibling.workflowInstanceId, 'work closed');
    expect((await world.viewWorkflow(sibling.workflowInstanceId))?.status).toBe(
      WorkflowStatus.Superseded,
    );
  });

  // The poll consuming Wake's own issue-close echo never closes the work itself, so the
  // close must come from the instance completing, in either order.
  it.each(['before', 'after'] as const)(
    'closes the work once when the poll consumes the completion %s the instance completes',
    async (order) => {
      const { world, workItemId } = await setup({
        first: stage({ done: { then: 'final' } }),
        final: stage({ done: { then: 'done', concludesWork: true } }),
      });
      const resourceId = resId('issue');
      await world.discoverResource({
        resourceId,
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: 'issues/1' },
        capabilities: [],
      });
      await world.correlateResource(resourceId, workItemId, 'primary');
      const instance = await world.startWorkflow({ workItemId, workflowName: 'main' });
      const consume = () =>
        world.resources.consumeIssueCompletion(resourceId, 'intent-1', {
          commandId: `consume-${order}`,
          correlationId: correlationId('poll'),
          occurredAt: world.clock.now().toISOString(),
          actor: { kind: 'integration', id: 'poll' },
        });
      if (order === 'before') await consume();
      await world.advanceUntilSettled(workItemId);
      if (order === 'after') await consume();
      for (let pass = 0; pass < 3; pass += 1) await world.advance(workItemId);
      expect(await world.viewWorkflow(instance.workflowInstanceId)).toMatchObject({
        status: WorkflowStatus.Completed,
      });
      expect(await world.viewWork(workItemId)).toMatchObject({ state: WorkStatus.Closed });
      expect(await world.events(CLOSED)).toHaveLength(1);
    },
  );

  it('still syncs the completed status label once the concluded work item is closed', async () => {
    const { world, workItemId } = await setup({
      only: stage({ done: { then: 'done', concludesWork: true } }),
    });
    const resourceId = resId('gh-issue');
    await world.discoverResource({
      resourceId,
      kind: resourceKind('issue'),
      externalKey: { adapter: 'github', key: 'org/repo#7' },
      capabilities: [],
    });
    await world.correlateResource(resourceId, workItemId, 'primary');
    await world.startWorkflow({ workItemId, workflowName: 'main' });
    await world.advanceUntilSettled(workItemId);
    for (let pass = 0; pass < 3; pass += 1) await world.advance(workItemId);
    expect(await world.viewWork(workItemId)).toMatchObject({ state: WorkStatus.Closed });
    let labels: readonly string[] = ['bug', 'wake:status.working', 'wake:stage.only'];
    let sets = 0;
    const reconciler = createGitHubWakeLabelReconciler({
      orchestration: world.orchestration,
      resources: world.resources,
      work: world.work,
      getLabels: async () => labels,
      setLabels: async (_owner, _repo, _number, next) => {
        sets += 1;
        labels = next;
      },
    });
    await reconciler.runOnce();
    await reconciler.runOnce();
    expect(labels).toContain('wake:status.completed');
    expect(labels).not.toContain('wake:status.working');
    expect(labels).toContain('bug');
    expect(sets).toBe(1);
  });

  it('concludes the work when a merged-PR resource transition completes the instance', async () => {
    const { world, workItemId } = await setup({
      only: stage({
        done: {
          then: 'wait',
          resourceTransitions: [
            {
              events: ['pr.state-changed'],
              where: { state: 'merged' },
              then: 'done',
              concludesWork: true,
            },
          ],
        },
      }),
    });
    const resourceId = resId('1');
    await world.discoverResource({
      resourceId,
      kind: resourceKind('pull-request'),
      externalKey: { adapter: 'github', key: 'owner/repo#1' },
      capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
    });
    await world.correlateResource(resourceId, workItemId, 'primary');
    const observe = (state: 'open' | 'merged') =>
      world.observePullRequest({
        resourceId,
        workItemId,
        state,
        headRevision: 'a',
        baseRevision: 'base',
        checks: 'passing',
      });
    await observe('open');
    const instance = await world.startWorkflow({ workItemId, workflowName: 'main' });
    await world.advanceUntilSettled(workItemId);
    expect(await world.viewWork(workItemId)).toMatchObject({ state: WorkStatus.Open });
    await observe('merged');
    for (let pass = 0; pass < 3; pass += 1) await world.advance(workItemId);
    expect(await world.viewWorkflow(instance.workflowInstanceId)).toMatchObject({
      status: WorkflowStatus.Completed,
      concludesWork: true,
    });
    expect(await world.viewWork(workItemId)).toMatchObject({ state: WorkStatus.Closed });
    expect(await world.events(CLOSED)).toHaveLength(1);
  });
});
