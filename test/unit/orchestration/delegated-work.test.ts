import { correlationId, type CommandContext } from '@atolis-hq/eventing';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activationId, activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  compileWorkflow,
  createOrchestrationEventData,
  createOrchestrationService,
  DelegationPendingError,
  OrchestrationEventType,
  signalName,
  TransitionTargetKind,
  workflowInstanceStream,
  type DelegatedAssignment,
  type DelegationArtifacts,
  type DelegationCaller,
  type WorkflowInstanceView,
  type WorkflowOrchestrationEventData,
} from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { FaultInjectingJournal } from '../../support/fault-injecting-journal.js';
import { workId } from '../../support/identities.js';

afterEach(() => vi.restoreAllMocks());

const context = (commandId: string): CommandContext => ({
  commandId,
  correlationId: correlationId('delegation-1'),
  occurredAt: '2026-07-30T12:00:00.000Z',
  actor: { kind: 'system', id: 'test' },
});

/** Permanent fake of the Bootstrap adapter: grants are immutable per id and outputs are opt-in. */
class FakeDelegationArtifacts implements DelegationArtifacts {
  registrationUnavailable = false;
  failureMessage = 'Grant store unavailable';
  readonly unavailableChildren = new Set<string>();
  readonly grants = new Map<string, string>();
  readonly published = new Set<string>();

  async validateInputs(): Promise<void> {}

  async registerChild(grant: Parameters<DelegationArtifacts['registerChild']>[0]): Promise<void> {
    if (this.registrationUnavailable || this.unavailableChildren.has(grant.childWorkItemId))
      throw new Error(this.failureMessage);
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
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'blocked', 'failed', 'found']) }).strict(),
      outcomeKinds: ['done', 'blocked', 'failed', 'found'],
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
        on: {
          done: { then: 'done' },
          found: { then: 'done' },
          blocked: { then: 'done' },
          failed: { then: 'done' },
        },
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

async function complete(fixture: Fixture, id: string, kind: 'done' | 'failed' | 'found' = 'done') {
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
    { ...caller, runId: 'recovered-run' },
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

  // An exact output alone does not qualify until the workflow succeeds.
  fixture.artifacts.published.add(child.workItemId);
  await fixture.service.reconcileChildCompletions(context('reconcile-1'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  await complete(fixture, child.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('reconcile-2'));
  await fixture.service.reconcileChildCompletions(context('reconcile-3'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationResultSelected)).toBe(1);
  const resumed = (await fixture.service.get(workflowInstanceId('parent-1')))!;
  expect(resumed.delegationWait).toBeUndefined();
  expect(resumed.pendingActivation?.input).toEqual({});
  expect(
    await fixture.service.delegatedWork.results(caller.workflowInstanceId, 'cohort-1'),
  ).toMatchObject([{ childWorkItemId: child.workItemId }]);
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
  await first.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  expect(await count(first, OrchestrationEventType.DelegationReconciliationFailed)).toBe(1);
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

type Fact = {
  [T in WorkflowOrchestrationEventData['eventType']]: Pick<
    Extract<WorkflowOrchestrationEventData, { eventType: T }>,
    'eventType' | 'payload'
  >;
}[WorkflowOrchestrationEventData['eventType']];

async function appendFact(fixture: Fixture, id: string, fact: Fact) {
  const stream = workflowInstanceStream(workflowInstanceId(id));
  const events = await fixture.journal.readStream(stream);
  const input = {
    ...context('fact-' + events.length),
    eventId: 'fact-' + id + events.length,
    causationId: 'test',
    source: { kind: 'internal' as const, id: 'test' },
    ...fact,
  };
  await fixture.journal.appendToStream(stream, events.length, [
    createOrchestrationEventData(input),
  ]);
}

it.each(['blocked', 'superseded', 'completed', 'definition-unavailable'])(
  'does not resurrect a %s parent after child completion',
  async (state) => {
    const fixture = build();
    const { caller, fingerprint } = await startParent(fixture);
    const reservation = await fixture.service.delegatedWork.reserve(
      caller,
      'cohort-1',
      [assignment(fingerprint)],
      context('reserve'),
    );
    const child = reservation.children[0]!;
    if (state === 'superseded')
      await appendFact(fixture, 'parent-1', {
        eventType: OrchestrationEventType.InstanceSuperseded,
        payload: {},
      });
    else if (state === 'completed')
      await appendFact(fixture, 'parent-1', {
        eventType: OrchestrationEventType.InstanceCompleted,
        payload: {},
      });
    else await fixture.service.block(caller.workflowInstanceId, state, context('block'));
    fixture.artifacts.published.add(child.workItemId);
    await complete(fixture, child.workflowInstanceId);
    const restarted = build(fixture.journal, fixture.artifacts);
    await restarted.service.reconcileChildCompletions(context('restart'));
    const parent = (await restarted.service.get(caller.workflowInstanceId))!;
    expect(parent.status).toBe(state === 'definition-unavailable' ? 'blocked' : state);
    expect(parent.delegationWait).toBeUndefined();
    expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  },
);

it('fences new retry activations, quota/execution retries, signals and timeout expiry', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const { status: _status, ...original } = (await fixture.service.get(caller.workflowInstanceId))!
    .pendingActivation!;
  await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  await expect(
    fixture.service.retryRunnerQuotaFailure(
      caller.workflowInstanceId,
      {
        activationId: caller.activationId,
        runId: caller.runId,
        runnerName: 'fake',
        message: 'quota',
      },
      context('quota'),
    ),
  ).rejects.toBeInstanceOf(DelegationPendingError);
  await expect(
    fixture.service.resolveExecutionFailure(
      caller.workflowInstanceId,
      { activationId: caller.activationId, runId: caller.runId, reason: 'interrupted' },
      context('execution-failure'),
    ),
  ).rejects.toBeInstanceOf(DelegationPendingError);
  expect(
    (await fixture.service.get(caller.workflowInstanceId))!.pendingActivation!.activationId,
  ).toBe(caller.activationId);
  // A retry persisted by an earlier host must also be fenced after restart.
  await appendFact(fixture, 'parent-1', {
    eventType: OrchestrationEventType.ActivityRequested,
    payload: { ...original, activationId: activationId('parent-1:activity:2'), ordinal: 2 },
  });
  await appendFact(fixture, 'parent-1', {
    eventType: OrchestrationEventType.SignalWaitStarted,
    payload: {
      signalKind: signalName('test'),
      timeoutMs: 1,
      waitStartedAt: context('x').occurredAt,
    },
  });
  const restarted = build(fixture.journal, fixture.artifacts);
  expect(await restarted.service.listPendingActivations(workId('1'))).toHaveLength(0);
  const before = (await fixture.journal.readAll(0)).length;
  await restarted.service.acceptOutcome(
    {
      workflowInstanceId: caller.workflowInstanceId,
      activationId: activationId('parent-1:activity:2'),
      outcome: { kind: 'done' },
    },
    context('retry-outcome'),
  );
  await expect(
    restarted.service.acceptSignal(
      caller.workflowInstanceId,
      {
        kind: signalName('test'),
        actorId: 'test',
        actorDecision: { authorized: true, evidenceId: 'test' },
        providerEventId: 'signal-1',
      },
      context('signal'),
    ),
  ).rejects.toBeInstanceOf(DelegationPendingError);
  await expect(
    restarted.service.waitForSignal(
      caller.workflowInstanceId,
      { signalKind: signalName('approval') },
      context('wait'),
    ),
  ).rejects.toBeInstanceOf(DelegationPendingError);
  await expect(
    restarted.service.applyResourceTransition(
      caller.workflowInstanceId,
      { kind: TransitionTargetKind.Complete },
      'merged-pr',
      context('merged'),
    ),
  ).rejects.toBeInstanceOf(DelegationPendingError);
  await restarted.service.expireTimedOutWaits({
    ...context('timeout'),
    occurredAt: '2026-07-31T12:00:00.000Z',
  });
  expect((await fixture.journal.readAll(0)).length).toBe(before);
});

it('isolates a broken cohort while unrelated outcomes, later cohorts and watch children reconcile', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  fixture.artifacts.registrationUnavailable = true;
  const broken = await fixture.service.delegatedWork.reserve(
    caller,
    'broken',
    [assignment(fingerprint)],
    context('broken'),
  );
  fixture.artifacts.registrationUnavailable = false;
  fixture.artifacts.unavailableChildren.add(broken.children[0]!.workItemId);
  const probe = (await fixture.service.get(workflowInstanceId('probe')))!;
  const good = await fixture.service.delegatedWork.reserve(
    {
      workflowInstanceId: probe.workflowInstanceId,
      activationId: probe.pendingActivation!.activationId,
      runId: 'probe-run',
    },
    'good',
    [assignment(fingerprint)],
    context('good'),
  );
  fixture.artifacts.published.add(good.children[0]!.workItemId);
  await complete(fixture, good.children[0]!.workflowInstanceId);
  expect((await fixture.service.get(probe.workflowInstanceId))!.delegationWait).toBeUndefined();
  const watch = await fixture.service.requestChild(
    {
      parentWorkflowInstanceId: probe.workflowInstanceId,
      watchId: 'watch',
      triggerId: 'trigger',
      workflowName: workflowName('child'),
      causalCycleId: 'cycle',
      requestId: workflowInstanceId('probe:watch:watch:trigger:trigger'),
      maxPerGroup: 3,
    },
    context('watch'),
  );
  if (!('workflowInstanceId' in watch)) throw new Error('Unexpected exhausted watch budget');
  await complete(fixture, watch.workflowInstanceId);
  expect((await fixture.service.get(watch.workflowInstanceId))!.childCompletionRecorded).toBe(true);
  await complete(fixture, probe.workflowInstanceId);
  expect((await fixture.service.get(probe.workflowInstanceId))!.status).toBe('completed');
  expect((await fixture.service.get(caller.workflowInstanceId))!.status).toBe('waiting');
  expect(
    await count(fixture, OrchestrationEventType.DelegationReconciliationFailed),
  ).toBeGreaterThan(0);
});

it.each(['failed', 'missing-output'])(
  'settles and blocks on a %s child across restart without stranding siblings',
  async (failure) => {
    const fixture = build();
    const { caller, fingerprint } = await startParent(fixture);
    const reservation = await fixture.service.delegatedWork.reserve(
      caller,
      'cohort-1',
      [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
      context('reserve'),
    );
    const child = reservation.children[0]!;
    await complete(fixture, child.workflowInstanceId, failure === 'failed' ? 'failed' : 'done');
    const restarted = build(fixture.journal, fixture.artifacts);
    await restarted.service.reconcileChildCompletions(context('restart'));
    await restarted.service.reconcileChildCompletions(context('duplicate'));
    expect((await restarted.service.get(caller.workflowInstanceId))!.status).toBe('blocked');
    expect(await restarted.service.delegatedWork.fences(caller.workflowInstanceId)).toBe(false);
    expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
    expect(
      await restarted.service.listPendingActivations(reservation.children[1]!.workItemId),
    ).toHaveLength(1);
  },
);

it('preserves supplemental, follow-on and watch-driven activation identity with strict input schemas', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const { status: _status, ...original } = (await fixture.service.get(caller.workflowInstanceId))!
    .pendingActivation!;
  await appendFact(fixture, 'parent-1', {
    eventType: OrchestrationEventType.ActivityRequested,
    payload: {
      ...original,
      activationId: activationId('parent-1:activity:2'),
      ordinal: 2,
      activity: activityName('child-work'),
      supplemental: true,
      followOnIndex: 2,
      watchDriven: true,
    },
  });
  const top = await fixture.service.delegatedWork.reserve(
    { ...caller, activationId: activationId('parent-1:activity:2') },
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  fixture.artifacts.published.add(top.children[0]!.workItemId);
  await complete(fixture, top.children[0]!.workflowInstanceId);
  const resumed = (await fixture.service.get(caller.workflowInstanceId))!.pendingActivation!;
  expect(resumed).toMatchObject({
    activity: 'child-work',
    supplemental: true,
    followOnIndex: 2,
    watchDriven: true,
    input: {},
  });
  expect(resumed.activationId).not.toBe(caller.activationId);
});

it('releases failed child capacity while retaining reservations for running siblings', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const { status: _status, ...original } = (await fixture.service.get(caller.workflowInstanceId))!
    .pendingActivation!;
  const top = await fixture.service.delegatedWork.reserve(
    caller,
    'first',
    [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
    context('reserve'),
    { maxDepth: 1, maxDescendants: 2 },
  );
  await complete(fixture, top.children[0]!.workflowInstanceId, 'failed');
  await appendFact(fixture, 'parent-1', {
    eventType: OrchestrationEventType.ActivityRequested,
    payload: { ...original, activationId: activationId('parent-1:activity:2'), ordinal: 2 },
  });
  const retry = { ...caller, activationId: activationId('parent-1:activity:2'), runId: 'new-run' };
  await expect(
    fixture.service.delegatedWork.reserve(
      retry,
      'too-many',
      [assignment(fingerprint, 'c'), assignment(fingerprint, 'd')],
      context('too-many'),
    ),
  ).rejects.toThrow('reservation limit exceeded');
  const later = await fixture.service.delegatedWork.reserve(
    retry,
    'later',
    [assignment(fingerprint, 'c')],
    context('later'),
  );
  expect(later.maxDescendants).toBe(2);
  expect(await fixture.service.listPendingActivations(top.children[1]!.workItemId)).toHaveLength(1);
});

it.each(['Grant store unavailable', ''])(
  'deduplicates valid persistent diagnostics across restart: %s',
  async (message) => {
    const fixture = build();
    fixture.artifacts.failureMessage = message;
    const { caller, fingerprint } = await startParent(fixture);
    fixture.artifacts.registrationUnavailable = true;
    await fixture.service.delegatedWork.reserve(
      caller,
      'cohort-1',
      [assignment(fingerprint)],
      context('reserve'),
    );
    const restarted = build(fixture.journal, fixture.artifacts);
    for (let pass = 0; pass < 4; pass++)
      await restarted.service.reconcileChildCompletions(context('pass-' + pass));
    expect(await count(fixture, OrchestrationEventType.DelegationReconciliationFailed)).toBe(1);
  },
);

it('isolates a failing diagnostic append from later cohorts, watch reconciliation and unrelated outcomes', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  fixture.artifacts.registrationUnavailable = true;
  fixture.journal.failAlwaysBefore.add(OrchestrationEventType.DelegationReconciliationFailed);
  const broken = await fixture.service.delegatedWork.reserve(
    caller,
    'broken',
    [assignment(fingerprint)],
    context('reserve'),
  );
  fixture.artifacts.registrationUnavailable = false;
  fixture.artifacts.unavailableChildren.add(broken.children[0]!.workItemId);
  const probe = (await fixture.service.get(workflowInstanceId('probe')))!;
  const good = await fixture.service.delegatedWork.reserve(
    {
      workflowInstanceId: probe.workflowInstanceId,
      activationId: probe.pendingActivation!.activationId,
      runId: 'probe',
    },
    'good',
    [assignment(fingerprint)],
    context('good'),
  );
  fixture.artifacts.published.add(good.children[0]!.workItemId);
  await complete(fixture, good.children[0]!.workflowInstanceId);
  const watch = await fixture.service.requestChild(
    {
      parentWorkflowInstanceId: probe.workflowInstanceId,
      watchId: 'watch',
      triggerId: 'trigger',
      workflowName: workflowName('child'),
      causalCycleId: 'cycle',
      requestId: workflowInstanceId('probe:watch:watch:trigger:trigger'),
      maxPerGroup: 3,
    },
    context('watch'),
  );
  if (!('workflowInstanceId' in watch)) throw new Error('Unexpected exhausted watch budget');
  await complete(fixture, watch.workflowInstanceId);
  expect((await fixture.service.get(watch.workflowInstanceId))!.childCompletionRecorded).toBe(true);
  await complete(fixture, probe.workflowInstanceId);
  expect((await fixture.service.get(probe.workflowInstanceId))!.status).toBe('completed');
  expect(warning).toHaveBeenCalled();
  expect(await count(fixture, OrchestrationEventType.DelegationReconciliationFailed)).toBe(0);
});

it('keeps selected results isolated when independent roots reuse a cohort name', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const first = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('first'),
  );
  const probe = (await fixture.service.get(workflowInstanceId('probe')))!;
  const second = await fixture.service.delegatedWork.reserve(
    {
      workflowInstanceId: probe.workflowInstanceId,
      activationId: probe.pendingActivation!.activationId,
      runId: 'probe',
    },
    'cohort-1',
    [assignment(fingerprint)],
    context('second'),
  );
  for (const reservation of [first, second]) {
    fixture.artifacts.published.add(reservation.children[0]!.workItemId);
    await complete(fixture, reservation.children[0]!.workflowInstanceId);
  }
  for (const reservation of [first, second]) {
    const results = await fixture.service.delegatedWork.results(
      reservation.parentWorkflowInstanceId,
      'cohort-1',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.childWorkItemId).toBe(reservation.children[0]!.workItemId);
  }
});

it('keeps a blocked child joinable after an operator retry and restart', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  const child = (await fixture.service.get(top.children[0]!.workflowInstanceId))!;
  await fixture.service.resolveExecutionFailure(
    child.workflowInstanceId,
    {
      activationId: child.pendingActivation!.activationId,
      runId: 'child-run',
      reason: 'Runner unavailable',
    },
    context('failure'),
  );
  await fixture.service.reconcileChildCompletions(context('blocked'));
  expect((await fixture.service.get(caller.workflowInstanceId))!.status).toBe('waiting');
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  const restarted = build(fixture.journal, fixture.artifacts);
  await restarted.service.retryBlockedFailedStage(child.workflowInstanceId, context('retry'));
  restarted.artifacts.published.add(child.workItemId);
  await complete(restarted, child.workflowInstanceId);
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
});

it('keeps a definition-unavailable child blocked without failing the cohort', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  await fixture.service.block(
    top.children[0]!.workflowInstanceId,
    'workflow-definition-unavailable',
    context('unavailable'),
  );
  const restarted = build(fixture.journal, fixture.artifacts);
  await restarted.service.reconcileChildCompletions(context('restart'));
  expect((await restarted.service.get(caller.workflowInstanceId))!.status).toBe('waiting');
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
});

it('qualifies a configured custom terminal success outcome with its exact outputs', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  fixture.artifacts.published.add(top.children[0]!.workItemId);
  await complete(fixture, top.children[0]!.workflowInstanceId, 'found');
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
});

it('fails loudly on missing adapters only when durable delegation needs reconciliation', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const unwired = createOrchestrationService(fixture.journal, fixture.work, fixture.definitions);
  await unwired.reconcileChildCompletions(context('ordinary'));
  const top = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  await expect(unwired.reconcileChildCompletions(context('unwired'))).rejects.toThrow(
    'Delegation adapters unavailable',
  );
  fixture.artifacts.published.add(top.children[0]!.workItemId);
  await complete(fixture, top.children[0]!.workflowInstanceId);
  await unwired.reconcileChildCompletions(context('settled'));
});

it.each(['closed', 'deleted', 'unknown-workflow'])(
  'preserves ordinary start validation on an existing instance: %s',
  async (invalid) => {
    const fixture = build();
    const { caller } = await startParent(fixture);
    const parent = (await fixture.service.get(caller.workflowInstanceId))!;
    if (invalid === 'closed')
      await fixture.work.close(parent.workItemId, 'Finished', context('close'));
    if (invalid === 'deleted') await fixture.work.delete(parent.workItemId, context('delete'));
    await expect(
      fixture.service.start(
        {
          workflowInstanceId: parent.workflowInstanceId,
          workItemId: parent.workItemId,
          workflowName: workflowName(invalid === 'unknown-workflow' ? 'unknown' : 'parent'),
          orchestrationGroupId: parent.orchestrationGroupId,
        },
        context('replay'),
      ),
    ).rejects.toThrow(
      invalid === 'unknown-workflow' ? 'Unknown workflow' : 'WorkItem must exist and be open',
    );
  },
);

it('reconciles an existing delegated child after its WorkItem closes without weakening public start validation', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service.delegatedWork.reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  const child = top.children[0]!;
  fixture.artifacts.published.add(child.workItemId);
  fixture.journal.failBefore = OrchestrationEventType.DelegationJoined;
  await complete(fixture, child.workflowInstanceId);
  await fixture.work.close(child.workItemId, 'Finished', context('close'));
  const restarted = build(fixture.journal, fixture.artifacts);
  await restarted.service.reconcileChildCompletions(context('restart'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
});
