import { correlationId, type CommandContext } from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  compileWorkflow,
  createOrchestrationService,
  OrchestrationEventType,
  type DelegatedAssignment,
  type DelegationArtifacts,
  type DelegationCaller,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { FaultInjectingJournal } from '../../support/fault-injecting-journal.js';
import { workId } from '../../support/identities.js';

const context = (commandId: string): CommandContext => ({
  commandId,
  correlationId: correlationId('delegation-1'),
  occurredAt: '2026-07-30T12:00:00.000Z',
  actor: { kind: 'system', id: 'test' },
});

/** Permanent fake of the Bootstrap adapter: grants are immutable per id and outputs are opt-in. */
class FakeDelegationArtifacts implements DelegationArtifacts {
  readonly grants = new Map<string, string>();
  readonly published = new Set<string>();

  async validateInputs(): Promise<void> {}

  async registerChild(grant: Parameters<DelegationArtifacts['registerChild']>[0]): Promise<void> {
    const serialised = JSON.stringify(grant);
    const prior = this.grants.get(grant.delegationId);
    if (prior !== undefined && prior !== serialised)
      throw new Error('Artifact delegation conflict');
    this.grants.set(grant.delegationId, serialised);
  }

  async qualifyingOutputs(child: WorkflowInstanceView, outputs: DelegatedAssignment['outputs']) {
    if (!this.published.has(child.workItemId)) return null;
    return outputs.map((output) => ({
      name: output.name,
      reference: { workItemId: child.workItemId, revisionId: `revision-${output.name}` },
    }));
  }
}

function build(
  journal = new FaultInjectingJournal(new FakeClock()),
  artifacts = new FakeDelegationArtifacts(),
) {
  const work = createWorkService(journal);
  const activities = new ActivityRegistry();
  for (const name of ['plan', 'child-work']) {
    activities.register({
      name: activityName(name),
      inputSchema: z.object({}).passthrough(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'blocked', 'failed']) }).strict(),
      outcomeKinds: ['done', 'blocked', 'failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' } as const;
        },
      },
    });
  }
  const stage = (activity: string) => ({
    stages: {
      work: {
        activity,
        with: {},
        on: { done: { then: 'done' }, blocked: { then: 'done' }, failed: { then: 'done' } },
        requiresApproval: false,
      },
    },
  });
  const names = ['parent', 'child'];
  const definitions = {
    parent: compileWorkflow('parent', stage('plan'), activities, names),
    child: compileWorkflow('child', stage('child-work'), activities, names),
  };
  const service = createOrchestrationService(journal, work, definitions);
  service.delegatedWork.setArtifacts(artifacts);
  return { journal, work, service, artifacts, definitions };
}

type Fixture = ReturnType<typeof build>;

async function startParent(fixture: Fixture) {
  await fixture.work.create({ workItemId: workId('1'), objective: 'parent' }, context('work-1'));
  await fixture.work.create({ workItemId: workId('9'), objective: 'probe' }, context('work-9'));
  const probe = await fixture.service.start(
    {
      workflowInstanceId: workflowInstanceId('probe'),
      workItemId: workId('9'),
      workflowName: workflowName('child'),
      orchestrationGroupId: orchestrationGroupId('probe-group'),
    },
    context('start-probe'),
  );
  const parent = await fixture.service.start(
    {
      workflowInstanceId: workflowInstanceId('parent-1'),
      workItemId: workId('1'),
      workflowName: workflowName('parent'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    context('start-parent'),
  );
  const caller: DelegationCaller = {
    workflowInstanceId: parent.workflowInstanceId,
    activationId: parent.pendingActivation!.activationId,
    runId: 'run-1',
  };
  return { caller, fingerprint: probe.workflowDefinitionFingerprint! };
}

const assignment = (fingerprint: string, id = 'investigate'): DelegatedAssignment => ({
  assignmentId: id,
  objective: `Do ${id}`,
  criteria: ['Findings published'],
  workflowName: workflowName('child'),
  workflowFingerprint: fingerprint,
  context: [],
  outputs: [{ name: 'findings', path: 'findings.md' }],
});

async function complete(fixture: Fixture, id: string, kind: 'done' | 'failed' = 'done') {
  const view = (await fixture.service.get(workflowInstanceId(id)))!;
  await fixture.service.acceptOutcome(
    {
      workflowInstanceId: view.workflowInstanceId,
      activationId: view.pendingActivation!.activationId,
      outcome: { kind },
    },
    context(`outcome-${id}-${kind}`),
  );
}

async function count(fixture: Fixture, type: string) {
  return (await fixture.journal.readAll(0)).filter((event) => event.event.eventType === type)
    .length;
}

it('registers distinct children, fences the parent and replays identically (DC-03, DC-06, DC-31)', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
    context('reserve'),
  );
  const [a, b] = reservation.children;
  expect(a!.workItemId).not.toBe(b!.workItemId);
  expect(a!.grantId).not.toBe(b!.grantId);
  expect(fixture.artifacts.grants.size).toBe(2);
  expect(
    (await fixture.service.get(workflowInstanceId('parent-1')))!.delegationWait?.cohortId,
  ).toBe('cohort-1');
  expect((await fixture.work.get(a!.workItemId))!.delegation?.rootWorkItemId).toBe(workId('1'));
  expect(await fixture.service.getPrimaryWorkflowInstanceId(a!.workItemId)).toBe(
    a!.workflowInstanceId,
  );
  expect(await fixture.service.listPendingActivations(a!.workItemId)).toHaveLength(1);

  const before = (await fixture.journal.readAll(0)).length;
  const replay = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
    context('reserve-replay'),
  );
  expect(replay).toEqual(reservation);
  expect((await fixture.journal.readAll(0)).length).toBe(before);
  await expect(
    fixture.service.delegatedWork.reserve(
      caller,
      'cohort-1',
      [assignment(fingerprint, 'c')],
      context('x'),
    ),
  ).rejects.toThrow('Delegation replay conflict');
});

it('ignores the parent ordinary success while delegated and joins once on exact results (DC-09, DC-28)', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  const child = reservation.children[0]!;
  await complete(fixture, 'parent-1');
  const parent = (await fixture.service.get(workflowInstanceId('parent-1')))!;
  expect(parent.status).toBe('waiting');

  // Accepted activation alone does not qualify: no exact output is published yet.
  await complete(fixture, child.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('reconcile-1'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);

  fixture.artifacts.published.add(child.workItemId);
  await fixture.service.reconcileChildCompletions(context('reconcile-2'));
  await fixture.service.reconcileChildCompletions(context('reconcile-3'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationResultSelected)).toBe(1);
  const resumed = (await fixture.service.get(workflowInstanceId('parent-1')))!;
  expect(resumed.delegationWait).toBeUndefined();
  expect(resumed.pendingActivation?.input).toMatchObject({
    delegation: { results: [{ childWorkItemId: child.workItemId }] },
  });
});

it('does not join when a required child fails', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
    context('reserve'),
  );
  fixture.artifacts.published.add(reservation.children[0]!.workItemId);
  fixture.artifacts.published.add(reservation.children[1]!.workItemId);
  await complete(fixture, reservation.children[0]!.workflowInstanceId);
  await complete(fixture, reservation.children[1]!.workflowInstanceId, 'failed');
  await fixture.service.reconcileChildCompletions(context('reconcile'));
  expect(await count(fixture, OrchestrationEventType.DelegationResultSelected)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
});

it('recovers partial registration without starting any child (DC-22)', async () => {
  const journal = new FaultInjectingJournal(new FakeClock());
  const first = build(journal);
  const { caller, fingerprint } = await startParent(first);
  journal.failBefore = OrchestrationEventType.DelegationRegistered;
  await expect(
    first.service.delegatedWork.reserve(
      caller,
      'cohort-1',
      [assignment(fingerprint)],
      context('reserve'),
    ),
  ).rejects.toThrow('Injected storage failure');
  expect(await first.service.delegatedWork.fences(caller.workflowInstanceId)).toBe(true);
  expect(await count(first, OrchestrationEventType.InstanceStarted)).toBe(2);

  const restarted = build(journal, first.artifacts);
  await restarted.service.reconcileChildCompletions(context('restart'));
  expect(await count(restarted, OrchestrationEventType.DelegationRegistered)).toBe(1);
  expect(await count(restarted, OrchestrationEventType.InstanceStarted)).toBe(3);
  expect(restarted.artifacts.grants.size).toBe(1);
});

it('keeps root identity for nested delegation and enforces durable limits (DC-08, DC-35)', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const limits = { maxDepth: 2, maxDescendants: 2 };
  const top = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
    limits,
  );
  const child = top.children[0]!;
  const childView = (await fixture.service.get(child.workflowInstanceId))!;
  const nested = await fixture.service.delegatedWork.reserve(
    {
      workflowInstanceId: child.workflowInstanceId,
      activationId: childView.pendingActivation!.activationId,
      runId: 'run-2',
    },
    'cohort-2',
    [assignment(fingerprint, 'nested')],
    context('reserve-nested'),
    limits,
  );
  const grandchild = await fixture.work.get(nested.children[0]!.workItemId);
  expect(grandchild!.delegation).toMatchObject({
    parentWorkItemId: child.workItemId,
    rootWorkItemId: workId('1'),
    ancestors: [workId('1'), child.workItemId],
  });
  // The shared root budget survives: a third descendant cannot be reserved through any ancestor.
  await expect(
    fixture.service.delegatedWork.reserve(
      {
        workflowInstanceId: nested.children[0]!.workflowInstanceId,
        activationId: (await fixture.service.get(nested.children[0]!.workflowInstanceId))!
          .pendingActivation!.activationId,
        runId: 'run-3',
      },
      'cohort-3',
      [assignment(fingerprint, 'too-deep')],
      context('reserve-deep'),
      limits,
    ),
  ).rejects.toThrow();
});

it('defaults to depth one so a child cannot delegate further', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  const child = top.children[0]!;
  await expect(
    fixture.service.delegatedWork.reserve(
      {
        workflowInstanceId: child.workflowInstanceId,
        activationId: (await fixture.service.get(child.workflowInstanceId))!.pendingActivation!
          .activationId,
        runId: 'run-2',
      },
      'cohort-2',
      [assignment(fingerprint, 'nested')],
      context('reserve-nested'),
    ),
  ).rejects.toThrow('Delegation root reservation limit exceeded');
});
