import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  compileWorkflow,
  createOrchestrationService,
  orchestrationGroupId,
  stageName,
  workflowInstanceId,
  workflowName,
  WorkflowStatus,
} from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const context = (commandId: string) => ({
  commandId,
  correlationId: correlationId('concludes'),
  occurredAt: '2026-11-21T18:00:00Z',
  actor: { kind: 'system' as const, id: 'test' },
});

function registry() {
  const result = new ActivityRegistry();
  result.register({
    name: activityName('step'),
    inputSchema: z.object({}),
    outcomeSchema: z.object({ kind: z.literal('done') }),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' as const };
      },
    },
  });
  return result;
}

const stage = (on: Record<string, unknown>) => ({
  activity: 'step',
  with: {},
  requiresApproval: false,
  on,
});

describe('route concludesWork', () => {
  it('compiles on a done route into the complete target', () => {
    const compiled = compileWorkflow(
      'w',
      { stages: { only: stage({ done: { then: 'done', concludesWork: true } }) } },
      registry(),
    );
    expect(compiled.stages[stageName('only')]?.on.done?.target).toEqual({
      kind: 'complete',
      concludesWork: true,
    });
  });

  it('omits the declaration when absent or false', () => {
    for (const route of [{ then: 'done' }, { then: 'done', concludesWork: false }]) {
      const compiled = compileWorkflow(
        'w',
        { stages: { only: stage({ done: route }) } },
        registry(),
      );
      expect(compiled.stages[stageName('only')]?.on.done?.target).toEqual({ kind: 'complete' });
    }
  });

  it('rejects the declaration on a route that does not end the workflow', () => {
    expect(() =>
      compileWorkflow(
        'w',
        {
          stages: {
            first: stage({ done: { then: 'second', concludesWork: true } }),
            second: stage({ done: { then: 'done' } }),
          },
        },
        registry(),
      ),
    ).toThrow(/w:first:done concludesWork is only valid with then: done/);
  });

  async function completed(concludesWork: boolean) {
    const journal = new InMemoryEventJournal(new FakeClock());
    const work = createWorkService(journal);
    const id = workId('concludes');
    await work.create({ workItemId: id, objective: 'conclude' }, context('create'));
    const definition = compileWorkflow(
      'w',
      {
        stages: {
          only: stage({ done: { then: 'done', ...(concludesWork ? { concludesWork } : {}) } }),
        },
      },
      registry(),
    );
    const service = createOrchestrationService(journal, work, { w: definition });
    const instance = await service.start(
      {
        workItemId: id,
        workflowInstanceId: workflowInstanceId('concludes'),
        workflowName: workflowName('w'),
        orchestrationGroupId: orchestrationGroupId('concludes'),
      },
      context('start'),
    );
    await service.acceptOutcome(
      {
        workflowInstanceId: instance.workflowInstanceId,
        activationId: instance.pendingActivation!.activationId,
        outcome: { kind: 'done' },
      },
      context('accept'),
    );
    return { service, id: instance.workflowInstanceId };
  }

  it('records the declaration on the completed instance', async () => {
    const { service, id } = await completed(true);
    expect(await service.get(id)).toMatchObject({
      status: WorkflowStatus.Completed,
      concludesWork: true,
    });
  });

  it('does not record a declaration when the route has none', async () => {
    const { service, id } = await completed(false);
    const view = await service.get(id);
    expect(view?.status).toBe(WorkflowStatus.Completed);
    expect(view?.concludesWork).toBeUndefined();
  });

  it.each([true, false])('block() leaves a completed instance completed (%s)', async (declared) => {
    const { service, id } = await completed(declared);
    await service.block(id, 'work closed: done', context('block'));
    expect((await service.get(id))?.status).toBe(WorkflowStatus.Completed);
  });
});
