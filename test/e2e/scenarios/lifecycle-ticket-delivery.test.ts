import { afterEach, expect, it } from 'vitest';
import { signalName } from '../../../src/orchestration/index.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

const scenario = { id: 'E2E-SIGNAL-001' } as const;

it(
  `${scenario.id} mints a work item from a ticket and delivers a comment per stage, ` +
    'pausing for approval by default at each stage',
  async () => {
    const world = await ProcessWorld.create('wake-root-lifecycle');
    worlds.push(world);

    await world.runTicksUntilIdle();
    const workflowInstanceId = await approveWaitingStage(world, 'approve-refine');
    await world.runTicksUntilIdle();
    await approveWaitingStage(world, 'approve-implement');
    await world.runTicksUntilIdle();

    const workItems = await world.readProjection<{ readonly state: string }>('work');
    expect(workItems).toHaveLength(1);

    const publishIntents = (await world.events()).filter(
      (event) => event.event.eventType === 'agent-run.publish-requested',
    );
    expect(publishIntents.length).toBeGreaterThanOrEqual(2);

    const orchestrationViews = await world.readProjection<{
      readonly view: { readonly status: string; readonly workflowInstanceId: string } | null;
    }>('orchestration');
    expect(orchestrationViews).toHaveLength(1);
    expect(orchestrationViews[0]?.value.view?.status).toBe('completed');
    expect(orchestrationViews[0]?.value.view?.workflowInstanceId).toBe(workflowInstanceId);
  },
  15000,
);

async function approveWaitingStage(world: ProcessWorld, evidenceId: string): Promise<string> {
  const orchestrationViews = await world.readProjection<{
    readonly view: { readonly status: string; readonly workflowInstanceId: string } | null;
  }>('orchestration');
  const view = orchestrationViews[0]?.value.view;
  if (view === null || view === undefined || view.status !== 'waiting')
    throw new Error(`Expected exactly one waiting workflow instance, got ${JSON.stringify(view)}`);
  await world.acceptSignal(view.workflowInstanceId, {
    kind: signalName('approved'),
    actorId: 'operator',
    actorDecision: { authorized: true, evidenceId },
    providerEventId: evidenceId,
  });
  return view.workflowInstanceId;
}
