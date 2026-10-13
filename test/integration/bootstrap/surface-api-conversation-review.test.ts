import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityOutcomeKind } from '../../../src/activities/index.js';
import type { CompositionRoot } from '../../../src/bootstrap/index.js';
import { createSurfaceWorkApplications } from '../../../src/bootstrap/surface-api-work-applications.js';
import { createConversationService } from '../../../src/conversations/index.js';
import {
  ApprovalAuthorityKind,
  signalName,
  stageName,
  TransitionTargetKind,
  watchId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { toWorkItemKey } from '../../../src/surfaces/index.js';
import { TestWorld } from '../../e2e/support/world.js';

async function fixture() {
  const world = new TestWorld();
  world.registerActivity({
    name: activityName('agent'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'blocked']) }).strict(),
    outcomeKinds: ['done', 'blocked'],
    resources: [],
    executionKind: 'deterministic',
    handler: { execute: async () => ({ kind: ActivityOutcomeKind.Done }) },
  });
  world.configureWorkflow('ui-review', {
    stages: {
      review: {
        activity: 'agent',
        with: {},
        on: {
          done: { then: 'done', await: { signal: 'approved', from: ['human'] } },
          blocked: { then: 'revise' },
        },
      },
      revise: { activity: 'agent', with: {}, on: { done: { then: 'done' } } },
    },
  });
  const work = await world.createWork({
    objective: 'Review through the authenticated operator composer',
  });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('ui-review'),
  });
  await world.acceptOutcome(workflow.workflowInstanceId, workflow.pendingActivation!.activationId, {
    kind: ActivityOutcomeKind.Done,
  });
  const context = {
    commandId: 'configured-review-wait',
    correlationId: 'ui-review' as never,
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'operator' as const, id: 'operator' },
  };
  await world.orchestration.waitForSignal(
    workflow.workflowInstanceId,
    {
      signalKind: signalName('approved'),
      from: [{ kind: ApprovalAuthorityKind.Human }],
      resume: { kind: TransitionTargetKind.Complete },
      onRejectResume: { kind: TransitionTargetKind.Stage, stage: stageName('revise') },
    },
    context,
  );
  const applications = createSurfaceWorkApplications(
    {
      config: { surfaces: { api: { conversationMessages: { enabled: true } } } },
      work: world.work,
      orchestration: world.orchestration,
      conversations: createConversationService(world.journal),
    } as unknown as CompositionRoot,
    () => world.clock.now().toISOString(),
  );
  return {
    world,
    workflow,
    context,
    message: applications.message!,
    key: toWorkItemKey(work.workItemId),
  };
}

it.each(['/approved', '/accepted'])(
  'retains authenticated operator %s approval of a human workflow wait',
  async (body) => {
    const { world, workflow, message, key } = await fixture();
    expect(await message(key, { idempotencyKey: 'ui-approval', body })).toMatchObject({
      status: 'accepted',
    });
    expect(await world.orchestration.get(workflow.workflowInstanceId)).toMatchObject({
      status: 'completed',
      acceptedSignalIds: ['work:ui-approval'],
      operatorRetryCommandIds: [],
    });
  },
);

it('routes ordinary operator /changes through the durable rejection target', async () => {
  const { world, workflow, message, key } = await fixture();
  expect(
    await message(key, { idempotencyKey: 'ui-reject', body: '/changes Fix the diagnostic.' }),
  ).toMatchObject({ status: 'accepted' });
  expect(await world.orchestration.get(workflow.workflowInstanceId)).toMatchObject({
    currentStage: 'revise',
    acceptedSignalIds: ['work:ui-reject'],
    operatorRetryCommandIds: [],
  });
});

it('keeps explicit continuation separate from an operator review decision', async () => {
  const { world, workflow, message, key } = await fixture();
  expect(
    await message(key, {
      idempotencyKey: 'ui-continue',
      body: '/changes Clarify the diagnostic.',
      continuation: true,
    }),
  ).toMatchObject({ status: 'accepted' });
  expect(await world.orchestration.get(workflow.workflowInstanceId)).toMatchObject({
    currentStage: 'review',
    acceptedSignalIds: [],
    operatorRetryCommandIds: ['work:ui-continue'],
  });
});

it('keeps a casual operator message from re-running a successful human-review wait', async () => {
  const { world, workflow, message, key } = await fixture();
  const before = await world.orchestration.get(workflow.workflowInstanceId);
  expect(
    await message(key, { idempotencyKey: 'ui-casual', body: 'Thanks for the update.' }),
  ).toMatchObject({ status: 'accepted' });
  expect(await world.orchestration.get(workflow.workflowInstanceId)).toEqual(before);
});

it.each(['revision', 'watch'] as const)(
  'does not let operator approval bypass %s evidence',
  async (kind) => {
    const { world, workflow, message, key, context } = await fixture();
    await world.orchestration.waitForSignal(
      workflow.workflowInstanceId,
      {
        signalKind: signalName('approved'),
        ...(kind === 'revision'
          ? { resourceId: 'review-resource', revision: 'exact-head' }
          : {
              from: [{ kind: ApprovalAuthorityKind.Watch, watch: watchId('independent-review') }],
            }),
      },
      { ...context, commandId: 'bind-review-evidence' },
    );
    const before = await world.orchestration.get(workflow.workflowInstanceId);
    expect(
      await message(key, { idempotencyKey: 'ui-bound-approval', body: '/approved' }),
    ).toMatchObject({
      conflict: true,
      detail: expect.stringContaining('configured authority and current revision'),
    });
    expect(await world.orchestration.get(workflow.workflowInstanceId)).toEqual(before);
  },
);

it('rejects explicit continuation without instructions or with another command', async () => {
  const { message, key } = await fixture();
  expect(
    await message(key, {
      idempotencyKey: 'ui-empty-continuation',
      body: '/changes',
      continuation: true,
    }),
  ).toMatchObject({ conflict: true, detail: expect.stringContaining('Supply instructions') });
  expect(
    await message(key, {
      idempotencyKey: 'ui-wrong-continuation',
      body: '/approved',
      continuation: true,
    }),
  ).toMatchObject({
    conflict: true,
    detail: expect.stringContaining('Continuation must use /changes'),
  });
});
