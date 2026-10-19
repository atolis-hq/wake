import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityOutcomeKind } from '../../../src/activities/index.js';
import {
  canDispatchWorkItem,
  controlPlaneConfigSchema,
  createAdvanceOnce,
  deriveOpenWorkItemIds,
  readOpenWorkItemIds,
} from '../../../src/control-plane/index.js';
import { createExecutionService } from '../../../src/execution/index.js';
import {
  ActivityActivationStatus,
  createOrchestrationService,
  orchestrationProjection,
  signalName,
  workflowInstanceStream,
  WorkflowStatus,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { TestWorld } from '../../e2e/support/world.js';
import { snapshotOf } from '../../support/delivery-snapshot.js';

function view(
  id: string,
  status: WorkflowInstanceView['status'],
  started = true,
): WorkflowInstanceView {
  return {
    workItemId: id,
    status,
    hasStartedActivation: started,
    acceptedOutcomes: [],
  } as unknown as WorkflowInstanceView;
}

describe('open work policy', () => {
  it('counts distinct started items with unfinished workflows and excludes unavailable items', () => {
    const views = [
      view('waiting', WorkflowStatus.Waiting),
      view('waiting', WorkflowStatus.Active),
      view('blocked', WorkflowStatus.Blocked),
      view('new', WorkflowStatus.Active, false),
      view('done', WorkflowStatus.Completed),
      view('superseded', WorkflowStatus.Superseded),
      view('frozen', WorkflowStatus.Waiting),
      view('deleted', WorkflowStatus.Active),
      view('parent', WorkflowStatus.Completed),
      view('parent', WorkflowStatus.Active, false),
    ];
    expect([...deriveOpenWorkItemIds(views, new Set(['frozen', 'deleted']))]).toEqual([
      'waiting',
      'blocked',
      'parent',
    ]);
  });

  it('only checks work availability for started unfinished items', async () => {
    const lookedUp: string[] = [];
    const open = readOpenWorkItemIds(
      [
        view('done', WorkflowStatus.Completed),
        view('new', WorkflowStatus.Active, false),
        view('open', WorkflowStatus.Waiting),
        view('open', WorkflowStatus.Active),
        view('frozen', WorkflowStatus.Waiting),
        view('deleted', WorkflowStatus.Active),
      ],
      snapshotOf((id) => {
        lookedUp.push(id);
        return { frozen: id === 'frozen', deleted: id === 'deleted' };
      }),
    );
    expect(lookedUp).toEqual(['open', 'frozen', 'deleted']);
    expect([...open]).toEqual(['open']);
  });

  it('allows unlimited dispatch and existing open items at or above capacity', () => {
    const open = new Set(['a', 'b']);
    expect(canDispatchWorkItem('c', open, null)).toBe(true);
    expect(canDispatchWorkItem('c', open, 1)).toBe(false);
    expect(canDispatchWorkItem('a', open, 1)).toBe(true);
    expect(canDispatchWorkItem('c', new Set(), 1)).toBe(true);
  });

  it('defaults to unlimited and rejects nonpositive, fractional and nonnumeric limits', () => {
    expect(controlPlaneConfigSchema.parse({}).maxOpenWorkItems).toBeNull();
    expect(controlPlaneConfigSchema.parse({ maxOpenWorkItems: 1 }).maxOpenWorkItems).toBe(1);
    expect(controlPlaneConfigSchema.parse({ maxOpenWorkItems: null }).maxOpenWorkItems).toBeNull();
    for (const maxOpenWorkItems of [0, -1, 1.5, '1'])
      expect(() => controlPlaneConfigSchema.parse({ maxOpenWorkItems })).toThrow();
  });

  it('holds new work during a first-activity review wait and preserves capacity across signal resumption', async () => {
    const world = new TestWorld();
    let calls = 0;
    world.registerActivity({
      name: activityName('review'),
      inputSchema: z.object({}),
      outcomeSchema: z.union([
        z.object({ kind: z.literal('done') }),
        z.object({
          kind: z.literal('waiting'),
          data: z.object({ intentEventId: z.string(), signalKind: z.string() }),
        }),
      ]),
      outcomeKinds: ['done', 'waiting'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          calls++;
          return calls === 1
            ? {
                kind: ActivityOutcomeKind.Waiting,
                data: { intentEventId: 'review-intent', signalKind: 'reviewed' },
              }
            : { kind: 'done' };
        },
      },
    });
    const definition = world.configureWorkflow('review', {
      stages: {
        review: {
          activity: 'review',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    });
    const a = await world.createWork({ objective: 'a' });
    const b = await world.createWork({ objective: 'b' });
    const first = await world.startWorkflow({ workItemId: a.workItemId, workflowName: 'review' });
    const second = await world.startWorkflow({ workItemId: b.workItemId, workflowName: 'review' });
    const execution = createExecutionService(
      world.journal,
      world.activities,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      { clock: world.clock, ids: world.ids },
    );
    const scheduler = (orchestration: typeof world.orchestration) =>
      createAdvanceOnce(orchestration, execution, world.resources, world.clock, {
        ids: world.ids,
        work: world.work,
        maxOpenWorkItems: 1,
        maxConcurrentRuns: 3,
        maxDispatches: 3,
      });
    const advance = scheduler(world.orchestration);
    const initial = await advance({ maxProgress: 3 });
    expect(initial.kind).toBe('progressed');
    expect(calls).toBe(1);
    expect([...deriveOpenWorkItemIds(await world.orchestration.listAll())]).toEqual([a.workItemId]);
    await advance({ maxProgress: 3 });
    expect(calls).toBe(1);
    const waiting = (await world.orchestration.get(first.workflowInstanceId))!;
    const { hasStartedActivation: _started, ...legacyWaiting } = waiting;
    const beforeSignal = await world.journal.readStream(
      workflowInstanceStream(first.workflowInstanceId),
    );
    await world.projections.write({
      namespace: orchestrationProjection.name,
      key: first.workflowInstanceId,
      lastGlobalPosition: beforeSignal.at(-1)!.globalPosition,
      value: legacyWaiting,
    });
    await world.acceptSignal(first.workflowInstanceId, {
      kind: signalName('reviewed'),
      actorId: 'owner',
      actorDecision: { authorized: true, evidenceId: 'review-evidence' },
      providerEventId: 'review-accepted',
      outcome: ActivityOutcomeKind.Done,
    });
    const signalEvents = (
      await world.journal.readStream(workflowInstanceStream(first.workflowInstanceId))
    ).slice(beforeSignal.length);
    const continued = signalEvents.reduce<WorkflowInstanceView | null>(
      orchestrationProjection.project,
      legacyWaiting,
    );
    expect(continued?.hasStartedActivation).toBe(true);
    expect(continued?.pendingActivation?.status).toBe(ActivityActivationStatus.Pending);
    // Even a legacy projection already resumed before upgrade has no remaining start evidence.
    const resumed = await world.orchestration.get(first.workflowInstanceId);
    expect(resumed?.acceptedOutcomes).toEqual([]);
    expect(resumed?.pendingActivation?.status).toBe(ActivityActivationStatus.Pending);
    expect([...deriveOpenWorkItemIds(await world.orchestration.listAll())]).toEqual([a.workItemId]);
    const { hasStartedActivation: _resumedStarted, ...legacyResumed } = resumed!;
    await world.projections.write({
      namespace: orchestrationProjection.name,
      key: first.workflowInstanceId,
      lastGlobalPosition: signalEvents.at(-1)!.globalPosition,
      value: legacyResumed,
    });
    const upgraded = createOrchestrationService(
      world.journal,
      world.work,
      { review: definition },
      world.projections,
    );
    expect(
      (await upgraded.listAll()).find(
        (item) => item.workflowInstanceId === first.workflowInstanceId,
      )?.hasStartedActivation,
    ).toBe(true);
    await scheduler(upgraded)({ maxProgress: 3 });
    expect(calls).toBe(3);
    expect((await upgraded.get(second.workflowInstanceId))?.status).toBe(WorkflowStatus.Completed);
    expect((await world.orchestration.get(first.workflowInstanceId))?.status).toBe(
      WorkflowStatus.Completed,
    );
  });
});

it('counts validated delivery roots once while any descendant remains live (DC-26)', async () => {
  const root = 'work-root';
  const child = 'work-child';
  const work = snapshotOf((id: string) => {
    return {
      state: 'open',
      ...(id === child
        ? {
            delegation: {
              parentWorkItemId: root,
              rootWorkItemId: root,
              ancestors: [root],
            } as never,
          }
        : {}),
    };
  });
  const open = readOpenWorkItemIds(
    [view(root, WorkflowStatus.Completed), view(child, WorkflowStatus.Waiting)],
    work,
  );
  expect([...open]).toEqual([root]);
  expect(canDispatchWorkItem(root, open, 1)).toBe(true);
  expect(canDispatchWorkItem('unrelated', open, 1)).toBe(false);
});
