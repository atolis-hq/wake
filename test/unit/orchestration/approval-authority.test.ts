import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActivityRegistry, activityName } from '../../../src/activities/index.js';
import {
  ApprovalAuthorityKind,
  OrchestrationEventType,
  TransitionTargetKind,
  WorkflowStatus,
  compileWorkflow,
  createOrchestrationService,
  orchestrationGroupId,
  signalName,
  stageName,
  watchId,
  workflowInstanceId,
  workflowName,
  type ApprovalAuthority,
} from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const reviewWatch = {
  id: 'pr-review',
  while: { stages: ['implement'], statuses: [WorkflowStatus.Waiting] },
  on: { events: ['orchestration.signal-wait-started'] },
  workflow: 'default',
  maxPerGroup: 3,
};

function registry(): ActivityRegistry {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
  return activities;
}

function workflowConfig(from: readonly unknown[], watches: readonly unknown[] = [reviewWatch]) {
  return {
    watches,
    stages: {
      implement: {
        activity: 'implement',
        with: {},
        on: { done: { then: 'done', await: { signal: 'approval', from } } },
      },
    },
  };
}

async function gatedGate(from: readonly unknown[], consent = false) {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  const baseContext = {
    correlationId: correlationId('corr-1'),
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'operator' as const, id: 'owner' },
  };
  await work.create(
    { workItemId: workId('1'), objective: 'ship' },
    { ...baseContext, commandId: 'create-work' },
  );
  if (consent)
    await work.grantAutoApproval(workId('1'), { ...baseContext, commandId: 'grant-consent' });
  const definition = compileWorkflow('default', workflowConfig(from), registry());
  const service = createOrchestrationService(journal, work, { default: definition });
  const started = await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-1'),
      workItemId: workId('1'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    { ...baseContext, commandId: 'start' },
  );
  const waiting = await service.acceptOutcome(
    {
      workflowInstanceId: started.workflowInstanceId,
      activationId: started.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    { ...baseContext, commandId: 'run-1' },
  );
  return { service, waiting, baseContext, journal };
}

function approval(authority?: ApprovalAuthority) {
  return {
    kind: signalName('approval'),
    actorId: 'owner',
    actorDecision: { authorized: true, evidenceId: 'approval-evidence-1' },
    providerEventId: 'provider-approval-1',
    ...(authority === undefined ? {} : { authority }),
  };
}

describe('approval authority compilation', () => {
  it('compiles the friendly from list into a discriminated authority union', () => {
    const compiled = compileWorkflow(
      'default',
      workflowConfig([
        ApprovalAuthorityKind.Human,
        ApprovalAuthorityKind.Auto,
        { kind: ApprovalAuthorityKind.Watch, id: 'pr-review' },
      ]),
      registry(),
    );

    expect(compiled.stages[stageName('implement')]?.on.done?.await).toEqual({
      signal: signalName('approval'),
      from: [
        { kind: ApprovalAuthorityKind.Human },
        { kind: ApprovalAuthorityKind.Auto },
        { kind: ApprovalAuthorityKind.Watch, watch: watchId('pr-review') },
      ],
      resume: { kind: TransitionTargetKind.Complete },
    });
  });

  it('brands a compiled watch id', () => {
    const compiled = compileWorkflow(
      'default',
      workflowConfig([ApprovalAuthorityKind.Human]),
      registry(),
    );

    expect(compiled.watches[0]?.id).toBe(watchId('pr-review'));
  });

  it('fails compilation naming the workflow, stage and unknown watch reference', () => {
    expect(() =>
      compileWorkflow(
        'default',
        workflowConfig([{ kind: ApprovalAuthorityKind.Watch, id: 'missing-review' }]),
        registry(),
      ),
    ).toThrow(/default.*implement.*missing-review/);
  });

  it('fails compilation when the workflow declares no watches at all', () => {
    expect(() =>
      compileWorkflow(
        'default',
        workflowConfig([{ kind: ApprovalAuthorityKind.Watch, id: 'pr-review' }], []),
        registry(),
      ),
    ).toThrow(/pr-review/);
  });
});

describe('approval authority acceptance', () => {
  it('opens a gate declaring human authority and then takes the route target', async () => {
    const { service, waiting, baseContext } = await gatedGate([ApprovalAuthorityKind.Human]);
    expect(waiting.status).toBe(WorkflowStatus.Waiting);

    const resumed = await service.acceptSignal(
      waiting.workflowInstanceId,
      approval({ kind: ApprovalAuthorityKind.Human }),
      { ...baseContext, commandId: 'signal-1' },
    );

    expect(resumed.status).toBe(WorkflowStatus.Completed);
  });

  it('treats a signal that claims no authority as human', async () => {
    const { service, waiting, baseContext } = await gatedGate([ApprovalAuthorityKind.Human]);

    const resumed = await service.acceptSignal(waiting.workflowInstanceId, approval(), {
      ...baseContext,
      commandId: 'signal-1',
    });

    expect(resumed.status).toBe(WorkflowStatus.Completed);
  });

  it('refuses auto when the route does not declare it, even with operator consent', async () => {
    const { service, waiting, baseContext } = await gatedGate([ApprovalAuthorityKind.Human], true);

    const unchanged = await service.acceptSignal(
      waiting.workflowInstanceId,
      approval({ kind: ApprovalAuthorityKind.Auto }),
      { ...baseContext, commandId: 'signal-1' },
    );

    expect(unchanged.status).toBe(WorkflowStatus.Waiting);
    expect(unchanged.acceptedSignalIds).toEqual([]);
  });

  it('refuses auto when the route declares it but the work item withholds consent', async () => {
    const { service, waiting, baseContext } = await gatedGate([
      ApprovalAuthorityKind.Human,
      ApprovalAuthorityKind.Auto,
    ]);

    const unchanged = await service.acceptSignal(
      waiting.workflowInstanceId,
      approval({ kind: ApprovalAuthorityKind.Auto }),
      { ...baseContext, commandId: 'signal-1' },
    );

    expect(unchanged.status).toBe(WorkflowStatus.Waiting);
    expect(unchanged.acceptedSignalIds).toEqual([]);
  });

  it('accepts auto only when capability and consent are both present', async () => {
    const { service, waiting, baseContext } = await gatedGate(
      [ApprovalAuthorityKind.Human, ApprovalAuthorityKind.Auto],
      true,
    );

    const resumed = await service.acceptSignal(
      waiting.workflowInstanceId,
      approval({ kind: ApprovalAuthorityKind.Auto }),
      { ...baseContext, commandId: 'signal-1' },
    );

    expect(resumed.status).toBe(WorkflowStatus.Completed);
  });

  it('accepts only the watch the route names', async () => {
    const declared = { kind: ApprovalAuthorityKind.Watch, id: 'pr-review' };
    const other = await gatedGate([declared]);
    const unchanged = await other.service.acceptSignal(
      other.waiting.workflowInstanceId,
      approval({ kind: ApprovalAuthorityKind.Watch, watch: watchId('other-review') }),
      { ...other.baseContext, commandId: 'signal-1' },
    );
    expect(unchanged.status).toBe(WorkflowStatus.Waiting);

    const named = await gatedGate([declared]);
    const resumed = await named.service.acceptSignal(
      named.waiting.workflowInstanceId,
      approval({ kind: ApprovalAuthorityKind.Watch, watch: watchId('pr-review') }),
      { ...named.baseContext, commandId: 'signal-2' },
    );
    expect(resumed.status).toBe(WorkflowStatus.Completed);
  });

  it('records the opening authority separately from the actor provenance', async () => {
    const { service, waiting, baseContext, journal } = await gatedGate(
      [ApprovalAuthorityKind.Human, ApprovalAuthorityKind.Auto],
      true,
    );
    await service.acceptSignal(
      waiting.workflowInstanceId,
      approval({ kind: ApprovalAuthorityKind.Auto }),
      { ...baseContext, commandId: 'signal-1' },
    );

    const accepted = (await journal.readAll(0)).find(
      (event) => event.event.eventType === OrchestrationEventType.SignalAccepted,
    );

    expect(accepted?.event.payload).toMatchObject({
      authority: { kind: ApprovalAuthorityKind.Auto },
      actorId: 'owner',
      actorDecision: { authorized: true, evidenceId: 'approval-evidence-1' },
    });
  });
});
