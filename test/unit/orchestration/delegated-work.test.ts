import {
  correlationId,
  createEventData,
  EventProcessorHost,
  WrongExpectedSequenceError,
  type CommandContext,
  type EventJournal,
} from '@atolis-hq/eventing';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
} from '@atolis-hq/eventing/memory';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  activationId,
  activityName,
  ActivityRegistry,
  pullRequestMergeInputSchema,
} from '../../../src/activities/index.js';
import {
  conversationIdForWorkItem,
  createConversationService,
} from '../../../src/conversations/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  compileWorkflow,
  createConversationCommandReactor,
  createOrchestrationEventData,
  createOrchestrationService,
  DelegationPendingError,
  OrchestrationEventType,
  signalName,
  TransitionTargetKind,
  workflowInstanceStream,
  type DelegationArtifacts,
  type DelegationMessages,
  type DelegationRepositories,
  type DelegationResources,
  type WorkflowInstanceView,
  type WorkflowOrchestrationEventData,
} from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { FaultInjectingJournal } from '../../support/fault-injecting-journal.js';
import { workId } from '../../support/identities.js';

afterEach(() => vi.restoreAllMocks());

const context = (commandId: string, occurredAt = '2026-07-30T12:00:00.000Z'): CommandContext => ({
  commandId,
  correlationId: correlationId('delegation-1'),
  occurredAt,
  actor: { kind: 'system', id: 'test' },
});

/** Permanent fake of the Bootstrap adapter: grants are immutable per id and outputs are opt-in. */
class FakeDelegationArtifacts implements DelegationArtifacts {
  registrationUnavailable = false;
  prerequisiteGrantsUnavailable = false;
  failureMessage = 'Grant store unavailable';
  readonly unavailableChildren = new Set<string>();
  readonly grants = new Map<string, string>();
  readonly published = new Set<string>();
  readonly revisions = new Map<string, string>();
  readonly merged = new Set<string>();
  readonly changes = new Map<string, DelegationResult['outputs'][number]>();

  async prerequisiteOutput(
    child: WorkflowInstanceView,
    output: DelegatedAssignment['outputs'][number],
    condition?: string,
  ): Promise<DelegationResult['outputs'][number] | null> {
    if ('kind' in output) {
      if (condition === 'merged-change' && !this.merged.has(child.workItemId)) return null;
      return this.changes.get(child.workItemId) ?? null;
    }
    return (await this.qualifyingOutputs(child, [output]))?.[0] ?? null;
  }

  onValidate: (() => Promise<void>) | undefined;

  async validateInputs(): Promise<void> {
    await this.onValidate?.();
  }

  async registerChild(grant: Parameters<DelegationArtifacts['registerChild']>[0]): Promise<void> {
    if (this.prerequisiteGrantsUnavailable && grant.delegationId.endsWith(':prerequisites'))
      throw new Error('Prerequisite grants unavailable');
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
    if (outputs.some((output) => 'kind' in output)) {
      const changes = outputs.map(() => this.changes.get(child.workItemId));
      return changes.every((change) => change !== undefined) ? changes : null;
    }
    return outputs.map((output) => ({
      name: output.name,
      reference: {
        workItemId: child.workItemId,
        revisionId: this.revisions.get(child.workItemId) ?? `revision-${output.name}`,
      },
    }));
  }
}

function build(
  journal = new FaultInjectingJournal(new FakeClock()),
  artifacts = new FakeDelegationArtifacts(),
  activeRuns = new Set<string>(),
  repositories?: DelegationRepositories,
  merging = false,
  /** When present, children are agent stages that block on clarification. */
  agent?: {
    readonly isAgent?: (activity: ReturnType<typeof activityName>) => boolean;
    /** Leaves `failed` unrouted so a failing child parks as blocked, like exhausted retries. */
    readonly unroutedFailure?: boolean;
  },
) {
  const agentChild = agent !== undefined;
  const isAgent = agent?.isAgent;
  const work = createWorkService(journal);
  const activities = new ActivityRegistry();
  for (const name of ['plan', 'child-work', 'pr.merge', 'agent']) {
    const inputSchema: z.ZodType<unknown> =
      name === 'pr.merge' ? pullRequestMergeInputSchema : z.object({}).strict();
    activities.register({
      name: activityName(name),
      inputSchema,
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
        with:
          activity === 'pr.merge'
            ? { target: 'primary', method: 'squash', requireChecks: true }
            : {},
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
    child: compileWorkflow(
      'child',
      // An agent stage without a blocked route blocks the workflow when it asks for clarification.
      agentChild
        ? {
            stages: {
              work: {
                activity: 'agent',
                with: {},
                on:
                  agent?.unroutedFailure === true
                    ? { done: { then: 'done' } }
                    : { done: { then: 'done' }, failed: { then: 'done' } },
                requiresApproval: false,
              },
            },
          }
        : stage(merging ? 'pr.merge' : 'child-work'),
      activities,
      names,
    ),
  };
  const opened: Parameters<DelegationMessages['post']>[0][] = [];
  const related: Parameters<DelegationResources['relateChild']>[0][] = [];
  const service = createOrchestrationService(
    journal,
    work,
    definitions,
    undefined,
    isAgent,
    () => ({
      artifacts,
      authority: { assertCaller: async () => undefined, repositories: async () => [] },
      ...(repositories === undefined ? {} : { repositories }),
      messages: { post: async (input) => void opened.push(input) },
      resources: { relateChild: async (input) => void related.push(input) },
      runHasEnded: async (id) => !activeRuns.has(id),
    }),
  );
  return {
    journal,
    work,
    service,
    artifacts,
    definitions,
    activeRuns,
    activities,
    opened,
    related,
  };
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
  const reservation = await fixture.service['delegatedWork'].reserve(
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
  const replay = await fixture.service['delegatedWork'].reserve(
    { ...caller, runId: 'recovered-run' },
    'cohort-1',
    [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
    context('reserve-replay'),
  );
  expect(replay).toEqual(reservation);
  expect((await fixture.journal.readAll(0)).length).toBe(before);
  await expect(
    fixture.service['delegatedWork'].reserve(
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
  const reservation = await fixture.service['delegatedWork'].reserve(
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
    await fixture.service['delegatedWork'].results(caller.workflowInstanceId, 'cohort-1'),
  ).toMatchObject([{ childWorkItemId: child.workItemId }]);
});

it('does not join when a required child fails', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
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
  await first.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  expect(await count(first, OrchestrationEventType.DelegationReconciliationFailed)).toBe(1);
  expect(await first.service['delegationGate'].fenced(caller.workflowInstanceId)).toBe(true);
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
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
    limits,
  );
  const child = top.children[0]!;
  const childView = (await fixture.service.get(child.workflowInstanceId))!;
  const nested = await fixture.service['delegatedWork'].reserve(
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
    fixture.service['delegatedWork'].reserve(
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
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  const child = top.children[0]!;
  await expect(
    fixture.service['delegatedWork'].reserve(
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
    const reservation = await fixture.service['delegatedWork'].reserve(
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
  await fixture.service['delegatedWork'].reserve(
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
  await expect(
    restarted.service.acceptOutcome(
      {
        workflowInstanceId: caller.workflowInstanceId,
        activationId: activationId('parent-1:activity:2'),
        outcome: { kind: 'done' },
      },
      context('retry-outcome'),
    ),
  ).rejects.toBeInstanceOf(DelegationPendingError);
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
  ).resolves.toMatchObject({ status: 'waiting' });
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
  ).resolves.toMatchObject({ status: 'waiting' });
  await restarted.service.expireTimedOutWaits({
    ...context('timeout'),
    occurredAt: '2026-07-31T12:00:00.000Z',
  });
  expect((await fixture.journal.readAll(0)).length).toBe(before + 2);
  expect(await count(fixture, OrchestrationEventType.SignalDeferred)).toBe(2);
});

it('isolates a broken cohort while unrelated outcomes, later cohorts and watch children reconcile', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  fixture.artifacts.registrationUnavailable = true;
  const broken = await fixture.service['delegatedWork'].reserve(
    caller,
    'broken',
    [assignment(fingerprint)],
    context('broken'),
  );
  fixture.artifacts.registrationUnavailable = false;
  fixture.artifacts.unavailableChildren.add(broken.children[0]!.workItemId);
  const probe = (await fixture.service.get(workflowInstanceId('probe')))!;
  const good = await fixture.service['delegatedWork'].reserve(
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

it('opens each child with its assignment and keeps the work item title a short summary', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'brief',
    [
      {
        ...assignment(fingerprint, 'a'),
        objective: 'Add a.txt',
        criteria: ['a.txt contains alpha', 'No other file changes'],
        context: [{ workItemId: workId('1'), revisionId: 'brief-1' }],
      },
    ],
    context('brief'),
  );
  const child = reservation.children[0]!;

  // The work item carries only the summary; the substance is delivered as the opening message.
  expect((await fixture.work.get(child.workItemId))?.objective).toBe('Add a.txt');
  expect(fixture.opened).toHaveLength(1);
  expect(fixture.opened[0]).toMatchObject({
    workItemId: child.workItemId,
    entryId: `delegation:${child.grantId}`,
    authorId: `delegation:${reservation.parentWorkItemId}`,
  });
  expect(fixture.opened[0]!.body).toContain('Add a.txt');
  expect(fixture.opened[0]!.body).toContain('- a.txt contains alpha');
  expect(fixture.opened[0]!.body).toContain('brief-1');
  // Each child is also related to its parent's resource, so its runs can publish there.
  expect(fixture.related).toEqual([
    { childWorkItemId: child.workItemId, parentWorkItemId: reservation.parentWorkItemId },
  ]);
});

it('keeps a completed child pending while its output may still become visible, then blocks it', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'a')],
    context('reserve'),
  );
  const child = reservation.children[0]!;
  await complete(fixture, child.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('first'));
  expect(await count(fixture, OrchestrationEventType.DelegationReconciliationFailed)).toBe(1);
  // Back-to-back passes (provider evidence typically lands within seconds) must not block it.
  await fixture.service.reconcileChildCompletions(context('second', '2026-07-30T12:00:02.000Z'));
  expect(await count(fixture, OrchestrationEventType.DelegationChildBlocked)).toBe(0);
  // The output becoming visible inside the window selects the result.
  fixture.artifacts.published.add(child.workItemId);
  await fixture.service.reconcileChildCompletions(context('visible', '2026-07-30T12:00:03.000Z'));
  expect(await count(fixture, OrchestrationEventType.DelegationResultSelected)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationChildBlocked)).toBe(0);
});

it('blocks a completed child whose output stays invisible past the grace window', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'a')],
    context('reserve'),
  );
  await complete(fixture, reservation.children[0]!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('first'));
  await fixture.service.reconcileChildCompletions(context('late', '2026-07-30T12:05:00.000Z'));
  expect(await count(fixture, OrchestrationEventType.DelegationChildBlocked)).toBe(1);
});

it.each(['failed', 'missing-output'])(
  'settles and blocks on a %s child across restart without stranding siblings',
  async (failure) => {
    const fixture = build();
    const { caller, fingerprint } = await startParent(fixture);
    const reservation = await fixture.service['delegatedWork'].reserve(
      caller,
      'cohort-1',
      [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
      context('reserve'),
    );
    const child = reservation.children[0]!;
    await complete(fixture, child.workflowInstanceId, failure === 'failed' ? 'failed' : 'done');
    const restarted = build(fixture.journal, fixture.artifacts);
    await restarted.service.reconcileChildCompletions(context('restart'));
    // A missing output is only blocked once the visibility grace has elapsed.
    await restarted.service.reconcileChildCompletions(
      context('duplicate', failure === 'missing-output' ? '2026-07-30T12:05:00.000Z' : undefined),
    );
    // Raised once for the failed member; the running sibling keeps its pending work.
    expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
    expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
    expect(
      await restarted.service.listPendingActivations(reservation.children[1]!.workItemId),
    ).toHaveLength(1);
    restarted.artifacts.published.add(reservation.children[1]!.workItemId);
    await complete(restarted, reservation.children[1]!.workflowInstanceId);
    await finishAttention(restarted, 'assessed');
    expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
    expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
    expect(await restarted.service['delegationGate'].fenced(caller.workflowInstanceId)).toBe(false);
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
  const top = await fixture.service['delegatedWork'].reserve(
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

it('releases failed child capacity only once the cohort settles, retaining running siblings meanwhile', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'first',
    [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
    context('reserve'),
    { maxDepth: 1, maxDescendants: 2 },
  );
  await complete(fixture, top.children[0]!.workflowInstanceId, 'failed');
  const attending = await attentionCaller(fixture, caller);
  // No second cohort can start while the first is unresolved, and the sibling keeps running.
  await expect(
    fixture.service['delegatedWork'].reserve(
      attending,
      'early',
      [assignment(fingerprint, 'c')],
      context('early'),
    ),
  ).rejects.toMatchObject({ code: 'attention-open' });
  expect(await fixture.service.listPendingActivations(top.children[1]!.workItemId)).toHaveLength(1);
  fixture.artifacts.published.add(top.children[1]!.workItemId);
  await complete(fixture, top.children[1]!.workflowInstanceId);
  await finishAttention(fixture, 'assessed');
  const next = (await parentOf(fixture)).pendingActivation!.activationId;
  const retry = { ...caller, activationId: next, runId: 'new-run' };
  await expect(
    fixture.service['delegatedWork'].reserve(
      retry,
      'too-many',
      [assignment(fingerprint, 'c'), assignment(fingerprint, 'd'), assignment(fingerprint, 'e')],
      context('too-many'),
    ),
  ).rejects.toThrow('reservation limit exceeded');
  const later = await fixture.service['delegatedWork'].reserve(
    retry,
    'later',
    [assignment(fingerprint, 'c')],
    context('later'),
  );
  expect(later.maxDescendants).toBe(2);
});

it.each(['Grant store unavailable', ''])(
  'deduplicates valid persistent diagnostics across restart: %s',
  async (message) => {
    const fixture = build();
    fixture.artifacts.failureMessage = message;
    const { caller, fingerprint } = await startParent(fixture);
    fixture.artifacts.registrationUnavailable = true;
    await fixture.service['delegatedWork'].reserve(
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
  const broken = await fixture.service['delegatedWork'].reserve(
    caller,
    'broken',
    [assignment(fingerprint)],
    context('reserve'),
  );
  fixture.artifacts.registrationUnavailable = false;
  fixture.artifacts.unavailableChildren.add(broken.children[0]!.workItemId);
  const probe = (await fixture.service.get(workflowInstanceId('probe')))!;
  const good = await fixture.service['delegatedWork'].reserve(
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
  const first = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('first'),
  );
  const probe = (await fixture.service.get(workflowInstanceId('probe')))!;
  const second = await fixture.service['delegatedWork'].reserve(
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
    const results = await fixture.service['delegatedWork'].results(
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
  const top = await fixture.service['delegatedWork'].reserve(
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
  // The parked child is put to the parent once; the cohort is neither failed nor joined.
  expect((await fixture.service.get(caller.workflowInstanceId))!.delegationAttention).toBeDefined();
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  const restarted = build(fixture.journal, fixture.artifacts);
  await restarted.service.retryBlockedFailedStage(child.workflowInstanceId, context('retry'));
  restarted.artifacts.published.add(child.workItemId);
  await complete(restarted, child.workflowInstanceId);
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  await finishAttention(restarted, 'assessed');
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
});

it('keeps a definition-unavailable child blocked without failing the cohort', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service['delegatedWork'].reserve(
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
  expect(
    (await restarted.service.get(caller.workflowInstanceId))!.delegationAttention,
  ).toBeDefined();
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  await finishAttention(restarted, 'assessed');
  expect((await restarted.service.get(caller.workflowInstanceId))!.status).toBe('waiting');
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
});

it('qualifies a configured custom terminal success outcome with its exact outputs', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service['delegatedWork'].reserve(
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

it('isolates unavailable adapters while recording durable diagnostics', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const unwired = createOrchestrationService(fixture.journal, fixture.work, fixture.definitions);
  await unwired.reconcileChildCompletions(context('ordinary'));
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  await expect(unwired.reconcileChildCompletions(context('unwired'))).resolves.toBeUndefined();
  expect(await count(fixture, OrchestrationEventType.DelegationReconciliationFailed)).toBe(1);
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
  const top = await fixture.service['delegatedWork'].reserve(
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

it('waits for the delegating Run to end before requesting continuation, including after restart', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  fixture.activeRuns.add(caller.runId);
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  fixture.artifacts.published.add(top.children[0]!.workItemId);
  await complete(fixture, top.children[0]!.workflowInstanceId);
  const restarted = build(fixture.journal, fixture.artifacts, fixture.activeRuns);
  await restarted.service.reconcileChildCompletions(context('restart'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  expect(await restarted.service.listPendingActivations(workId('1'))).toHaveLength(0);
  restarted.activeRuns.delete(caller.runId);
  await restarted.service.reconcileChildCompletions(context('ended'));
  await restarted.service.reconcileChildCompletions(context('duplicate'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
});

it('keeps starting independent siblings after a member fails', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  fixture.journal.failBefore = OrchestrationEventType.InstanceStarted;
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
    context('reserve'),
  );
  const child = top.children[0]!;
  await fixture.service.start(
    {
      workflowInstanceId: child.workflowInstanceId,
      workItemId: child.workItemId,
      workflowName: child.workflowName,
      workflowDefinitionFingerprint: child.workflowFingerprint,
      orchestrationGroupId: orchestrationGroupId('primary:' + child.workItemId),
    },
    context('first-child'),
  );
  await complete(fixture, child.workflowInstanceId, 'failed');
  // An independent, not-yet-started sibling still starts: the failure is put to the parent.
  expect((await fixture.service.get(caller.workflowInstanceId))!.delegationAttention).toBeDefined();
  expect(await fixture.service.get(top.children[1]!.workflowInstanceId)).not.toBeNull();
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
});

it('does not silently acknowledge a stale or different outcome while an exact delegating activation is held', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  await expect(
    fixture.service.acceptOutcome(
      {
        workflowInstanceId: caller.workflowInstanceId,
        activationId: activationId('stale'),
        outcome: { kind: 'done' },
      },
      context('stale'),
    ),
  ).rejects.toBeInstanceOf(DelegationPendingError);
  await expect(
    fixture.service.acceptOutcome(
      {
        workflowInstanceId: caller.workflowInstanceId,
        activationId: caller.activationId,
        outcome: { kind: 'done' },
      },
      context('held'),
    ),
  ).resolves.toMatchObject({ status: 'waiting' });
  expect(await count(fixture, OrchestrationEventType.ActivityOutcomeAccepted)).toBe(0);
});

it('reserves with a fresh root stream even when it contains a fact the orchestration selector drops', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const stream = workflowInstanceStream(caller.workflowInstanceId);
  const prior = await fixture.journal.readStream(stream);
  await fixture.journal.appendToStream(stream, prior.length, [
    createEventData({
      ...context('foreign'),
      eventId: 'foreign-observation',
      causationId: 'test',
      source: { kind: 'adapter', id: 'test' },
      eventType: 'foreign.observed',
      payload: {},
    }),
  ]);
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  expect(await fixture.service.get(top.children[0]!.workflowInstanceId)).not.toBeNull();
});

it('bounds reservation retries under persistent root contention', async () => {
  class ContendedJournal extends FaultInjectingJournal {
    conflicts = 0;
    override async appendToStream(...args: Parameters<EventJournal['appendToStream']>) {
      if (args[2].some((entry) => entry.eventType === OrchestrationEventType.DelegationReserved)) {
        this.conflicts++;
        throw new WrongExpectedSequenceError('Concurrent root append');
      }
      return super.appendToStream(...args);
    }
  }

  const journal = new ContendedJournal(new FakeClock());
  const fixture = build(journal);
  const { caller, fingerprint } = await startParent(fixture);
  await expect(
    fixture.service['delegatedWork'].reserve(
      caller,
      'cohort-1',
      [assignment(fingerprint)],
      context('reserve'),
    ),
  ).rejects.toThrow('contention exceeded retry limit');
  expect(journal.conflicts).toBe(8);
  expect(await count(fixture, OrchestrationEventType.DelegationReserved)).toBe(0);
});

it('rejects historical assignment fingerprints while recovering an already committed pinned definition', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  fixture.artifacts.registrationUnavailable = true;
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
  );
  const child = compileWorkflow(
    'child',
    {
      stages: {
        revised: {
          activity: 'child-work',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    },
    fixture.activities,
    ['parent', 'child'],
  );
  const restarted = createOrchestrationService(
    fixture.journal,
    fixture.work,
    {
      ...fixture.definitions,
      child,
    },
    undefined,
    undefined,
    () => ({ artifacts: fixture.artifacts, runHasEnded: async () => true }),
  );

  const probe = (await restarted.get(workflowInstanceId('probe')))!;
  await expect(
    restarted['delegatedWork'].reserve(
      {
        workflowInstanceId: probe.workflowInstanceId,
        activationId: probe.pendingActivation!.activationId,
        runId: 'probe-run',
      },
      'new-cohort',
      [assignment(fingerprint)],
      context('old-assignment'),
    ),
  ).rejects.toThrow('fingerprint must match current');
  fixture.artifacts.registrationUnavailable = false;
  await restarted['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('replay'),
  );
  expect(
    (await restarted.get(top.children[0]!.workflowInstanceId))!.workflowDefinitionFingerprint,
  ).toBe(fingerprint);
});

import type {
  DelegatedAssignment,
  DelegationCaller,
  DelegationResult,
} from '../../../src/orchestration/contracts/delegation.js';

it.each(['cancel', 'close', 'delete'] as const)(
  'settles a cohort when its registered child is %s before startup',
  async (action) => {
    const fixture = build();
    const { caller, fingerprint } = await startParent(fixture);
    fixture.artifacts.registrationUnavailable = true;
    const reservation = await fixture.service['delegatedWork'].reserve(
      caller,
      'terminal-before-start',
      [assignment(fingerprint)],
      context('reserve'),
    );
    const child = reservation.children[0]!;
    expect(await fixture.service.get(child.workflowInstanceId)).toBeNull();
    if (action === 'delete') await fixture.work.delete(child.workItemId, context(action));
    else await fixture.work[action](child.workItemId, 'Operator stopped work', context(action));
    fixture.artifacts.registrationUnavailable = false;
    const restarted = build(fixture.journal, fixture.artifacts);
    await restarted.service.reconcileChildCompletions(context('recover'));
    expect(await fixture.service.get(child.workflowInstanceId)).toBeNull();
    // The only member is terminal, so the cohort settles unsuccessfully and requests assessment.
    expect((await fixture.service.get(caller.workflowInstanceId))!.status).toBe('active');
    expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
    expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
    expect(await restarted.service['delegationGate'].fenced(caller.workflowInstanceId)).toBe(false);
  },
);

it('deduplicates a changing storage error by stable cohort reason', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  fixture.artifacts.registrationUnavailable = true;
  await fixture.service['delegatedWork'].reserve(
    caller,
    'changing-error',
    [assignment(fingerprint)],
    context('reserve'),
  );
  for (let pass = 0; pass < 4; pass++) {
    fixture.artifacts.failureMessage = `Missing /tmp/run-${pass}/artifact at ${Date.now()}`;
    await fixture.service.reconcileChildCompletions(context('pass-' + pass));
  }
  expect(await count(fixture, OrchestrationEventType.DelegationReconciliationFailed)).toBe(1);
});

it('retries missing outputs once across restart before deciding terminal failure', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'late-outputs',
    [assignment(fingerprint)],
    context('reserve'),
  );
  const child = reservation.children[0]!;
  await complete(fixture, child.workflowInstanceId);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  fixture.artifacts.published.add(child.workItemId);
  const restarted = build(fixture.journal, fixture.artifacts);
  await restarted.service.reconcileChildCompletions(context('visible-now'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
});

it('folds a nested reservation fence before wait registration and rebuilds it after restart', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'top-fence',
    [assignment(fingerprint)],
    context('top'),
    { maxDepth: 2, maxDescendants: 3 },
  );
  const child = (await fixture.service.get(top.children[0]!.workflowInstanceId))!;
  fixture.journal.failBefore = OrchestrationEventType.DelegationWaitStarted;
  await fixture.service['delegatedWork'].reserve(
    {
      workflowInstanceId: child.workflowInstanceId,
      activationId: child.pendingActivation!.activationId,
      runId: 'nested',
    },
    'nested-fence',
    [assignment(fingerprint)],
    context('nested'),
  );
  const restarted = build(fixture.journal, fixture.artifacts);
  const view = (await restarted.service.get(child.workflowInstanceId))!;
  expect(view.delegationWait).toBeUndefined();
  expect(view.delegationFence).toEqual({
    cohortId: 'nested-fence',
    activationId: child.pendingActivation!.activationId,
  });
  expect(await restarted.service.listPendingActivations(child.workItemId)).toEqual([]);
  await expect(
    restarted.service.waitForSignal(
      child.workflowInstanceId,
      { signalKind: signalName('approval') },
      context('wait'),
    ),
  ).rejects.toBeInstanceOf(DelegationPendingError);
  await restarted.service.reconcileChildCompletions(context('recover'));
  expect((await restarted.service.get(child.workflowInstanceId))!.delegationWait?.cohortId).toBe(
    'nested-fence',
  );
});

it('keeps the root descendant bound across joined cohorts', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const first = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
    { maxDepth: 1, maxDescendants: 1 },
  );
  fixture.artifacts.published.add(first.children[0]!.workItemId);
  await complete(fixture, first.children[0]!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('join'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
  const resumed = (await fixture.service.get(caller.workflowInstanceId))!;
  await expect(
    fixture.service['delegatedWork'].reserve(
      { ...caller, activationId: resumed.pendingActivation!.activationId, runId: 'run-2' },
      'cohort-2',
      [assignment(fingerprint, 'again')],
      context('reserve-2'),
    ),
  ).rejects.toThrow('reservation limit exceeded');
});

it('still counts a blocked child of a failed cohort against the root bound', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
    context('reserve'),
    { maxDepth: 1, maxDescendants: 2 },
  );
  await fixture.service.block(
    top.children[1]!.workflowInstanceId,
    'workflow-definition-unavailable',
    context('block'),
  );
  await complete(fixture, top.children[0]!.workflowInstanceId, 'failed');
  await fixture.service.reconcileChildCompletions(context('fail'));
  // The blocked member keeps the cohort unsettled, so every reservation still counts and the
  // open assessment cannot start a second cohort.
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
  await expect(
    fixture.service['delegatedWork'].reserve(
      { ...(await attentionCaller(fixture, caller)), runId: 'run-2' },
      'cohort-2',
      [assignment(fingerprint, 'c'), assignment(fingerprint, 'd')],
      context('reserve-2'),
    ),
  ).rejects.toMatchObject({ code: 'attention-open' });
  expect(await count(fixture, OrchestrationEventType.DelegationReserved)).toBe(1);
});

it('fails a reservation whose parent activation changed before the commit, starting no child', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint)],
    context('reserve'),
    { maxDepth: 2, maxDescendants: 4 },
  );
  const midId = top.children[0]!.workflowInstanceId;
  const mid = (await fixture.service.get(midId))!;
  const { status: _status, ...original } = mid.pendingActivation!;
  // The non-root parent changes after validation but before the root-stream commit.
  fixture.artifacts.onValidate = async () => {
    fixture.artifacts.onValidate = undefined;
    await appendFact(fixture, midId, {
      eventType: OrchestrationEventType.ActivityRequested,
      payload: { ...original, activationId: activationId(`${midId}:activity:2`), ordinal: 2 },
    });
  };
  const grants = fixture.artifacts.grants.size;
  const nested = await fixture.service['delegatedWork'].reserve(
    {
      workflowInstanceId: midId,
      activationId: mid.pendingActivation!.activationId,
      runId: 'run-2',
    },
    'cohort-2',
    [assignment(fingerprint, 'nested')],
    context('reserve-nested'),
  );
  expect(await count(fixture, OrchestrationEventType.DelegationWaitStarted)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
  expect(await fixture.service.listPendingActivations(nested.children[0]!.workItemId)).toEqual([]);
  expect(fixture.artifacts.grants.size).toBe(grants);
});

it('replays the recorded source after branch movement and rejects an explicit conflicting revision (DC-11, DC-21)', async () => {
  const resolve = vi.fn(async (_parent, request) => ({
    ...request,
    sourceRevision: 'a'.repeat(40),
  }));
  const fixture = build(undefined, undefined, undefined, { resolve });
  const { caller, fingerprint } = await startParent(fixture);
  const input = [
    {
      ...assignment(fingerprint),
      repository: { resourceId: 'repository', sourceRef: 'main', pullRequestBase: 'integration' },
    },
  ];
  const reserved = await fixture.service['delegatedWork'].reserve(
    caller,
    'pinned',
    input,
    context('pin'),
  );
  resolve.mockImplementation(async (_parent, request) => ({
    ...request,
    sourceRevision: 'b'.repeat(40),
  }));
  const restarted = build(fixture.journal, fixture.artifacts, fixture.activeRuns, { resolve });
  expect(
    await restarted.service['delegatedWork'].reserve(caller, 'pinned', input, context('replay')),
  ).toEqual(reserved);
  expect(resolve).toHaveBeenCalledTimes(1);
  await expect(
    restarted.service['delegatedWork'].reserve(
      caller,
      'pinned',
      [{ ...input[0]!, repository: { ...input[0]!.repository, sourceRevision: 'b'.repeat(40) } }],
      context('conflict'),
    ),
  ).rejects.toThrow('replay conflict');
});

it('queues upfront prerequisites, preserves independent progress, pins exact context and recovers grants after restart (DC-02, DC-17)', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const assignments = [
    assignment(fingerprint, 'a'),
    {
      ...assignment(fingerprint, 'b'),
      prerequisites: [
        { assignmentId: 'a', output: 'findings', condition: 'accepted-output' as const },
      ],
    },
    assignment(fingerprint, 'independent'),
  ];
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'queued',
    assignments,
    context('reserve'),
  );
  const [a, b, independent] = reservation.children;
  expect(b!.prerequisiteWorkItemIds).toEqual([a!.workItemId]);
  expect(await fixture.service.get(b!.workflowInstanceId)).toBeNull();
  expect(await fixture.service.listPendingActivations(independent!.workItemId)).toHaveLength(1);
  expect(
    (await fixture.service.deliveryTree(workId('1')))[0]!.children[1]!.prerequisiteBlocker,
  ).toContain('Waiting for');
  fixture.artifacts.published.add(a!.workItemId);
  const restarted = build(fixture.journal, fixture.artifacts);
  await restarted.service.reconcileChildCompletions(context('ready'));
  expect(await restarted.service.get(b!.workflowInstanceId)).not.toBeNull();
  expect(await restarted.service.repositoryAssignment(b!.workItemId)).toBeUndefined();
  const tree = (await restarted.service.deliveryTree(workId('1')))[0]!;
  expect(tree.children[1]!.consumedInputs!.consumed[0]!.reference).toEqual({
    workItemId: a!.workItemId,
    revisionId: 'revision-findings',
  });
  expect(
    [...fixture.artifacts.grants.values()].some(
      (grant) => grant.includes(a!.workItemId) && grant.includes(b!.workItemId),
    ),
  ).toBe(true);
  const before = await count(fixture, OrchestrationEventType.DelegationInputsResolved);
  await restarted.service.reconcileChildCompletions(context('duplicate'));
  expect(await count(fixture, OrchestrationEventType.DelegationInputsResolved)).toBe(before);
  fixture.artifacts.revisions.set(a!.workItemId, 'changed');
  expect(await restarted.service.listPendingActivations(b!.workItemId)).toHaveLength(0);
  await expect(complete(restarted, b!.workflowInstanceId)).rejects.toThrow(DelegationPendingError);
  expect(await restarted.service.listPendingActivations(independent!.workItemId)).toHaveLength(1);
  await restarted.service.reconcileChildCompletions(context('stale'));
  expect(
    (await restarted.service.deliveryTree(workId('1')))[0]!.children[1]!.prerequisiteBlocker,
  ).toContain('changed');
});

it.each([
  ['self-dependency', 'a', 'findings'],
  ['missing-target', 'missing', 'findings'],
  ['missing-output', 'b', 'missing'],
])('rejects %s without committing any reservation (DC-07)', async (code, target, output) => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  await expect(
    fixture.service['delegatedWork'].reserve(
      caller,
      'invalid',
      [
        {
          ...assignment(fingerprint, 'a'),
          prerequisites: [{ assignmentId: target, output, condition: 'accepted-output' }],
        },
        assignment(fingerprint, 'b'),
      ],
      context('invalid'),
    ),
  ).rejects.toMatchObject({ name: 'DelegationConflictError', code });
  expect(await count(fixture, OrchestrationEventType.DelegationReserved)).toBe(0);
});

it('rejects explicit cycles and stale expected plan revisions (DC-07)', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  await expect(
    fixture.service['delegatedWork'].reserve(
      caller,
      'cycle',
      ['a', 'b'].map((id, index) => ({
        ...assignment(fingerprint, id),
        prerequisites: [
          {
            assignmentId: index === 0 ? 'b' : 'a',
            output: 'findings',
            condition: 'accepted-output' as const,
          },
        ],
      })),
      context('cycle'),
    ),
  ).rejects.toMatchObject({ code: 'wait-cycle' });
  await expect(
    fixture.service['delegatedWork'].reserve(
      caller,
      'stale',
      [assignment(fingerprint)],
      context('stale'),
      undefined,
      1,
    ),
  ).rejects.toMatchObject({ code: 'stale-plan' });
  expect(await count(fixture, OrchestrationEventType.DelegationReserved)).toBe(0);
});

it('rejects implicit ancestor joins even though explicit dependencies are acyclic (DC-35)', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const top = await fixture.service['delegatedWork'].reserve(
    caller,
    'top-join',
    [assignment(fingerprint, 'ancestor')],
    context('top'),
    { maxDepth: 3, maxDescendants: 8 },
  );
  const ancestor = top.children[0]!;
  const view = (await fixture.service.get(ancestor.workflowInstanceId))!;
  await expect(
    fixture.service['delegatedWork'].reserve(
      {
        workflowInstanceId: view.workflowInstanceId,
        activationId: view.pendingActivation!.activationId,
        runId: 'nested-run',
      },
      'nested',
      [
        {
          ...assignment(fingerprint, 'nested'),
          prerequisites: [
            {
              cohortId: 'top-join',
              assignmentId: 'ancestor',
              output: 'findings',
              condition: 'accepted-output',
            },
          ],
        },
      ],
      context('nested'),
      { maxDepth: 3, maxDescendants: 8 },
    ),
  ).rejects.toMatchObject({ code: 'wait-cycle' });
});

it('keeps accepted ancestor context usable without creating a future join prerequisite (DC-35)', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'accepted-context',
    [
      {
        ...assignment(fingerprint),
        context: [{ workItemId: workId('1'), revisionId: 'accepted-plan' }],
      },
    ],
    context('context'),
  );
  expect(await fixture.service.get(reservation.children[0]!.workflowInstanceId)).not.toBeNull();
});

it('rejects merge-before-same-join for a delivery-ready child workflow (DC-35)', async () => {
  const fixture = build(undefined, undefined, undefined, {
    resolve: async (_parent, request) => ({ ...request, sourceRevision: 'a'.repeat(40) }),
  });
  const { caller, fingerprint } = await startParent(fixture);
  const code = (id: string): DelegatedAssignment => ({
    ...assignment(fingerprint, id),
    repository: { resourceId: 'repo', sourceRef: 'main', pullRequestBase: 'main' },
    outputs: [{ name: 'change', kind: 'change' }],
  });
  await expect(
    fixture.service['delegatedWork'].reserve(
      caller,
      'merge-deadlock',
      [
        code('a'),
        {
          ...code('b'),
          prerequisites: [{ assignmentId: 'a', output: 'change', condition: 'merged-change' }],
        },
      ],
      context('merge-deadlock'),
    ),
  ).rejects.toMatchObject({ code: 'wait-cycle' });
  expect(await count(fixture, OrchestrationEventType.DelegationReserved)).toBe(0);
});

it('queues actual-merge prerequisites when the upstream has its own configured merge lane (DC-12)', async () => {
  const fixture = build(
    undefined,
    undefined,
    undefined,
    { resolve: async (_parent, request) => ({ ...request, sourceRevision: 'a'.repeat(40) }) },
    true,
  );
  const { caller, fingerprint } = await startParent(fixture);
  const code = (id: string): DelegatedAssignment => ({
    ...assignment(fingerprint, id),
    repository: { resourceId: 'repo', sourceRef: 'main', pullRequestBase: 'main' },
    outputs: [{ name: 'change', kind: 'change' }],
  });
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'own-merge',
    [
      code('a'),
      {
        ...code('b'),
        prerequisites: [{ assignmentId: 'a', output: 'change', condition: 'merged-change' }],
      },
    ],
    context('own-merge'),
  );
  const [a, b] = reservation.children;
  fixture.artifacts.changes.set(a!.workItemId, {
    name: 'change',
    reference: {
      workItemId: a!.workItemId,
      resourceId: 'pr',
      repositoryResourceId: 'repo',
      revision: 'a'.repeat(40),
      branch: a!.workItemId,
      pullRequestBase: 'main',
      runId: 'upstream-run',
    },
  });
  await fixture.service.reconcileChildCompletions(context('not-yet-merged'));
  expect(await fixture.service.get(b!.workflowInstanceId)).toBeNull();
  fixture.artifacts.merged.add(a!.workItemId);
  await fixture.service.reconcileChildCompletions(context('actual-merge'));
  expect(await fixture.service.get(b!.workflowInstanceId)).not.toBeNull();
});

it('supports incremental delivery-ready artifact prerequisites without changing earlier reservations', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const first = await fixture.service['delegatedWork'].reserve(
    caller,
    'first',
    [assignment(fingerprint, 'contract')],
    context('first'),
  );
  const upstream = first.children[0]!;
  fixture.artifacts.published.add(upstream.workItemId);
  await complete(fixture, upstream.workflowInstanceId);
  await fixture.work.close(upstream.workItemId, 'Delivered', context('closed-completed-upstream'));
  const parent = (await fixture.service.get(caller.workflowInstanceId))!;
  const second = await fixture.service['delegatedWork'].reserve(
    { ...caller, activationId: parent.pendingActivation!.activationId },
    'second',
    [
      {
        ...assignment(fingerprint, 'consume'),
        prerequisites: [
          {
            cohortId: 'first',
            assignmentId: 'contract',
            output: 'findings',
            condition: 'delivery-ready',
          },
        ],
      },
    ],
    context('second'),
    undefined,
    1,
  );
  expect(second.planRevision).toBe(2);
  expect(second.children[0]!.prerequisiteWorkItemIds).toEqual([upstream.workItemId]);
  expect(await fixture.service.get(second.children[0]!.workflowInstanceId)).not.toBeNull();
  expect(
    (await fixture.service.deliveryTree(workId('1')))[0]!.children[0]!.prerequisites,
  ).toBeUndefined();
});

it('recovers the exact pinned receipt when the prerequisite grant fails after commitment', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'grant-fault',
    [
      assignment(fingerprint, 'a'),
      {
        ...assignment(fingerprint, 'b'),
        prerequisites: [{ assignmentId: 'a', output: 'findings', condition: 'accepted-output' }],
      },
    ],
    context('reserve'),
  );
  const [a, b] = reservation.children;
  fixture.artifacts.published.add(a!.workItemId);
  fixture.artifacts.prerequisiteGrantsUnavailable = true;
  await fixture.service.reconcileChildCompletions(context('grant-fault'));
  expect(await count(fixture, OrchestrationEventType.DelegationInputsResolved)).toBe(1);
  expect(await fixture.service.get(b!.workflowInstanceId)).toBeNull();
  fixture.artifacts.prerequisiteGrantsUnavailable = false;
  const restarted = build(fixture.journal, fixture.artifacts);
  await restarted.service.reconcileChildCompletions(context('grant-recover'));
  expect(await restarted.service.get(b!.workflowInstanceId)).not.toBeNull();
  expect(await count(fixture, OrchestrationEventType.DelegationInputsResolved)).toBe(1);
  expect(fixture.artifacts.grants.get(b!.grantId + ':prerequisites')).toContain(
    'revision-findings',
  );
});

it('rejects cross-repository Git bases before committing children', async () => {
  const fixture = build(undefined, undefined, undefined, {
    resolve: async (_parent, request) => ({ ...request, sourceRevision: 'a'.repeat(40) }),
  });
  const { caller, fingerprint } = await startParent(fixture);
  const code = (id: string): DelegatedAssignment => ({
    ...assignment(fingerprint, id),
    repository: { resourceId: 'repo-' + id, sourceRef: 'main', pullRequestBase: 'main' },
    outputs: [{ name: 'change', kind: 'change' }],
  });
  await expect(
    fixture.service['delegatedWork'].reserve(
      caller,
      'foreign-base',
      [
        code('a'),
        {
          ...code('b'),
          prerequisites: [
            { assignmentId: 'a', output: 'change', condition: 'pushed-change', useAsBase: true },
          ],
        },
      ],
      context('foreign-base'),
    ),
  ).rejects.toMatchObject({ code: 'cross-repository-base' });
  expect(await count(fixture, OrchestrationEventType.DelegationReserved)).toBe(0);
});

it('keeps unrelated queued-batch children progressing after an upstream fails', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'partial-failure',
    [
      assignment(fingerprint, 'a'),
      {
        ...assignment(fingerprint, 'dependent'),
        prerequisites: [{ assignmentId: 'a', output: 'findings', condition: 'accepted-output' }],
      },
      assignment(fingerprint, 'independent'),
    ],
    context('partial-failure'),
  );
  const [a, dependent, independent] = reservation.children;
  await complete(fixture, a!.workflowInstanceId, 'failed');
  const restarted = build(fixture.journal, fixture.artifacts);
  await restarted.service.reconcileChildCompletions(context('recover-failure'));
  expect(await restarted.service.get(dependent!.workflowInstanceId)).toBeNull();
  expect(await restarted.service.listPendingActivations(independent!.workItemId)).toHaveLength(1);
  const tree = (await restarted.service.deliveryTree(workId('1')))[0]!;
  expect(tree.children[0]!.prerequisiteBlocker).toContain('without success');
  expect(tree.children[1]!.prerequisiteBlocker).toMatch(/failed|without success/);
  fixture.artifacts.published.add(independent!.workItemId);
  await complete(restarted, independent!.workflowInstanceId);
  await restarted.service.reconcileChildCompletions(context('settle-failed'));
  // The failure was put to the parent while the independent child ran; the cohort stays open.
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  const attending = (await restarted.service.get(caller.workflowInstanceId))!;
  await restarted.service.acceptOutcome(
    {
      workflowInstanceId: caller.workflowInstanceId,
      activationId: attending.delegationAttention!.activationId,
      outcome: { kind: 'done' },
    },
    context('attention-done'),
  );
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  expect((await restarted.service.get(caller.workflowInstanceId))!.status).toBe('active');
  expect(await restarted.service.listPendingActivations(workId('1'))).toHaveLength(1);
  await restarted.service.reconcileChildCompletions(context('duplicate-failure'));
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
});

// A new batch is an agent decision, with fresh identities and evidence, never an implicit rebase.
it('returns stale consumed inputs for agent assessment and accepts a forward revision in a replacement batch', async () => {
  const fixture = build(undefined, undefined, new Set(['run-1']));
  const { caller, fingerprint } = await startParent(fixture);
  const batch = await fixture.service['delegatedWork'].reserve(
    caller,
    'original',
    [
      assignment(fingerprint, 'upstream'),
      {
        ...assignment(fingerprint, 'consumer'),
        prerequisites: [
          { assignmentId: 'upstream', output: 'findings', condition: 'accepted-output' },
        ],
      },
    ],
    context('original'),
  );
  const [upstream, consumer] = batch.children;
  fixture.artifacts.published.add(upstream!.workItemId);
  await complete(fixture, upstream!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('pin'));
  fixture.artifacts.published.add(consumer!.workItemId);
  await complete(fixture, consumer!.workflowInstanceId);
  const original = (await fixture.service.deliveryTree(workId('1')))[0]!.children[1]!
    .consumedInputs;
  fixture.artifacts.revisions.set(upstream!.workItemId, 'revision-v2');
  await fixture.service.reconcileChildCompletions(context('moved-forward'));
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  // The original parent Run must end before an assessment Run may be requested.
  await complete(fixture, caller.workflowInstanceId);
  fixture.activeRuns.clear();
  const restarted = build(fixture.journal, fixture.artifacts);
  await restarted.service.reconcileChildCompletions(context('assessment'));
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
  expect(
    await restarted.service.joinedDelegationResults(caller.workflowInstanceId, 'original'),
  ).toEqual([]);
  const parent = (await restarted.service.get(caller.workflowInstanceId))!;
  expect(parent.pendingActivation!.activationId).not.toBe(caller.activationId);
  await expect(
    restarted.service['delegatedWork'].reserve(
      caller,
      'unauthorized-replay',
      [assignment(fingerprint, 'wrong-activation')],
      context('old-caller'),
    ),
  ).rejects.toThrow('current active activation');
  expect((await restarted.service.deliveryTree(workId('1')))[0]!.failureReason).toContain(
    'inspect blockers',
  );
  const replacement = await restarted.service['delegatedWork'].reserve(
    { ...caller, activationId: parent.pendingActivation!.activationId, runId: 'assessment-run' },
    'replacement',
    [
      {
        ...assignment(fingerprint, 'consumer-v2'),
        prerequisites: [
          {
            cohortId: 'original',
            assignmentId: 'upstream',
            output: 'findings',
            condition: 'accepted-output',
          },
        ],
      },
    ],
    context('replacement'),
    undefined,
    1,
  );
  const child = replacement.children[0]!;
  const tree = await restarted.service.deliveryTree(workId('1'));
  expect(tree[0]!.children[1]!.consumedInputs).toEqual(original);
  expect(tree[1]!.children[0]!.consumedInputs!.consumed[0]!.reference).toMatchObject({
    revisionId: 'revision-v2',
  });
  expect(child.workItemId).not.toBe(consumer!.workItemId);
  fixture.artifacts.published.add(child.workItemId);
  await complete(restarted, child.workflowInstanceId);
  expect(
    await restarted.service.joinedDelegationResults(caller.workflowInstanceId, 'replacement'),
  ).toHaveLength(1);
  expect(await count(fixture, OrchestrationEventType.DelegationInputsResolved)).toBe(2);
});

it('deduplicates shared prerequisite verification within a gate pass and skips settled reconciliation', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const batch = await fixture.service['delegatedWork'].reserve(
    caller,
    'fanout',
    [
      assignment(fingerprint, 'source'),
      ...Array.from({ length: 6 }, (_, i) => ({
        ...assignment(fingerprint, 'consumer-' + i),
        prerequisites: [
          { assignmentId: 'source', output: 'findings', condition: 'accepted-output' as const },
        ],
      })),
    ],
    context('fanout'),
  );
  fixture.artifacts.published.add(batch.children[0]!.workItemId);
  await fixture.service.reconcileChildCompletions(context('start-consumers'));
  const verification = vi.spyOn(fixture.artifacts, 'prerequisiteOutput');
  const snapshots = vi.spyOn(fixture.service['repository'], 'snapshot');
  await fixture.service.listPendingActivations();
  expect(verification).toHaveBeenCalledTimes(1);
  expect(snapshots).toHaveBeenCalledTimes(1);
  for (const child of batch.children) {
    fixture.artifacts.published.add(child.workItemId);
    await complete(fixture, child.workflowInstanceId);
  }
  verification.mockClear();
  await fixture.service.reconcileChildCompletions(context('settled-history'));
  expect(verification).not.toHaveBeenCalled();
});

it('inspects blockers from recorded facts without verifying outputs with the provider', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const batch = await fixture.service['delegatedWork'].reserve(
    caller,
    'inspect',
    [
      assignment(fingerprint, 'source'),
      {
        ...assignment(fingerprint, 'consumer'),
        prerequisites: [
          { assignmentId: 'source', output: 'findings', condition: 'accepted-output' as const },
        ],
      },
    ],
    context('inspect'),
  );
  const consumer = batch.children[1]!.workItemId;
  const verification = vi.spyOn(fixture.artifacts, 'prerequisiteOutput');
  const waiting = (tree: Awaited<ReturnType<typeof fixture.service.deliveryTree>>) =>
    tree[0]!.children.find((child) => child.workItemId === consumer)!.prerequisiteBlocker;

  expect(waiting(await fixture.service.deliveryTree(batch.parentWorkItemId))).toBe(
    'Waiting for accepted-output output source/findings',
  );
  expect(verification).not.toHaveBeenCalled();

  // Explicit verification still evaluates against the provider.
  await fixture.service.deliveryTree(batch.parentWorkItemId, { verify: true });
  expect(verification).toHaveBeenCalled();
});

it('bounds prerequisite diagnostics when provider error messages keep changing', async () => {
  const fixture = build();
  const { caller, fingerprint } = await startParent(fixture);
  const batch = await fixture.service['delegatedWork'].reserve(
    caller,
    'unavailable',
    [
      assignment(fingerprint, 'source'),
      {
        ...assignment(fingerprint, 'consumer'),
        prerequisites: [
          { assignmentId: 'source', output: 'findings', condition: 'accepted-output' },
        ],
      },
    ],
    context('unavailable'),
  );
  fixture.artifacts.published.add(batch.children[0]!.workItemId);
  await fixture.service.reconcileChildCompletions(context('pin'));
  let n = 0;
  vi.spyOn(fixture.artifacts, 'prerequisiteOutput').mockImplementation(async () => {
    throw new Error('Remote request ' + n++ + ' failed');
  });
  for (let i = 0; i < 8; i++)
    await fixture.service.reconcileChildCompletions(context('provider-' + i));
  expect(await count(fixture, OrchestrationEventType.DelegationPrerequisiteBlocked)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
});

it('accepts a newer pushed head through an explicit replacement assignment without restoring the old branch', async () => {
  let head = 'a'.repeat(40);
  const resolve = vi.fn<DelegationRepositories['resolve']>(async (_parent, request) => ({
    ...request,
    sourceRevision:
      request.sourceRevision ?? (request.sourceRef === 'main' ? '0'.repeat(40) : head),
  }));
  const fixture = build(undefined, undefined, new Set(['run-1']), { resolve });
  const { caller, fingerprint } = await startParent(fixture);
  const source = {
    ...assignment(fingerprint, 'source'),
    outputs: [{ name: 'change', kind: 'change' as const }],
    repository: { resourceId: 'repo', sourceRef: 'main', pullRequestBase: 'main' },
  };
  const consumer = {
    ...assignment(fingerprint, 'consumer'),
    repository: source.repository,
    prerequisites: [
      {
        assignmentId: 'source',
        output: 'change',
        condition: 'pushed-change' as const,
        useAsBase: true,
      },
    ],
  };
  const batch = await fixture.service['delegatedWork'].reserve(
    caller,
    'stack',
    [source, consumer],
    context('stack'),
  );
  const [a, b] = batch.children;
  const change = {
    name: 'change',
    reference: {
      workItemId: a!.workItemId,
      resourceId: 'pr',
      repositoryResourceId: 'repo',
      revision: head,
      branch: a!.workItemId,
      pullRequestBase: 'main',
      baseRevision: '0'.repeat(40),
      runId: 'push-v1',
    },
  };
  fixture.artifacts.changes.set(a!.workItemId, change);
  fixture.artifacts.published.add(a!.workItemId);
  await complete(fixture, a!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('pin-v1'));
  const oldReceipt = (await fixture.service.deliveryTree(workId('1')))[0]!.children[1]!
    .consumedInputs;
  expect((await fixture.service.repositoryAssignment(b!.workItemId))!.sourceRevision).toBe(head);
  resolve.mockClear();
  await fixture.service.listPendingActivations();
  expect(resolve).toHaveBeenCalledTimes(1);
  fixture.artifacts.changes.set(a!.workItemId, {
    ...change,
    reference: { ...change.reference, baseRevision: 'unrelated-main-merge' },
  });
  expect(await fixture.service.listPendingActivations(b!.workItemId)).toHaveLength(1);
  fixture.artifacts.changes.set(a!.workItemId, {
    ...change,
    reference: { ...change.reference, merged: true },
  });
  const liveResolver = resolve.getMockImplementation()!;
  resolve.mockImplementation(async () => {
    throw new Error('Source branch deleted after merge');
  });
  resolve.mockClear();
  expect(await fixture.service.listPendingActivations(b!.workItemId)).toHaveLength(1);
  expect(resolve).not.toHaveBeenCalled();
  resolve.mockImplementation(liveResolver);
  head = 'b'.repeat(40);
  fixture.artifacts.changes.set(a!.workItemId, {
    ...change,
    reference: { ...change.reference, revision: head, runId: 'push-v2' },
  });
  expect(await fixture.service.listPendingActivations(b!.workItemId)).toHaveLength(0);
  await complete(fixture, caller.workflowInstanceId);
  fixture.activeRuns.clear();
  await fixture.service.reconcileChildCompletions(context('stale-stack'));
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
  // Late outcomes drain existing Runs without accepting stale results; Work fences still apply.
  fixture.artifacts.published.add(b!.workItemId);
  await fixture.work.freeze(workId('1'), context('freeze-history'));
  await expect(complete(fixture, b!.workflowInstanceId)).rejects.toThrow(DelegationPendingError);
  await fixture.work.unfreeze(workId('1'), context('unfreeze-history'));
  await complete(fixture, b!.workflowInstanceId);
  expect((await fixture.service.get(b!.workflowInstanceId))!.status).toBe('superseded');
  expect(await fixture.service.joinedDelegationResults(caller.workflowInstanceId, 'stack')).toEqual(
    [],
  );
  const parent = (await fixture.service.get(caller.workflowInstanceId))!;
  const next = await fixture.service['delegatedWork'].reserve(
    { ...caller, activationId: parent.pendingActivation!.activationId, runId: 'repair' },
    'repair',
    [
      {
        ...consumer,
        assignmentId: 'consumer-v2',
        prerequisites: [{ ...consumer.prerequisites[0]!, cohortId: 'stack' }],
      },
    ],
    context('repair'),
    undefined,
    1,
  );
  const replacement = next.children[0]!;
  expect((await fixture.service.repositoryAssignment(replacement.workItemId))!.sourceRevision).toBe(
    head,
  );
  expect((await fixture.service.deliveryTree(workId('1')))[0]!.children[1]!.consumedInputs).toEqual(
    oldReceipt,
  );
  fixture.artifacts.published.add(replacement.workItemId);
  await complete(fixture, replacement.workflowInstanceId);
  expect(
    await fixture.service.joinedDelegationResults(caller.workflowInstanceId, 'repair'),
  ).toHaveLength(1);
});

// Parent attention (DC-10, DC-17, DC-19, DC-32): one coalesced assessment per unresolved set.
const attentionBuild = (journal?: FaultInjectingJournal, artifacts?: FakeDelegationArtifacts) =>
  build(journal, artifacts, undefined, undefined, false, {});

async function clarify(fixture: Fixture, id: string) {
  const view = (await fixture.service.get(workflowInstanceId(id)))!;
  await fixture.service.acceptOutcome(
    {
      workflowInstanceId: view.workflowInstanceId,
      activationId: view.pendingActivation!.activationId,
      outcome: { kind: 'blocked', data: { status: 'NEEDS_CLARIFICATION' } },
    },
    context(`clarify-${id}-${view.pendingActivation!.ordinal}`),
  );
}

async function parentOf(fixture: Fixture) {
  return (await fixture.service.get(workflowInstanceId('parent-1')))!;
}

async function finishAttention(fixture: Fixture, commandId: string) {
  const parent = await parentOf(fixture);
  await fixture.service.acceptOutcome(
    {
      workflowInstanceId: parent.workflowInstanceId,
      activationId: parent.delegationAttention!.activationId,
      outcome: { kind: 'done' },
    },
    context(commandId),
  );
}

const attentionCaller = async (fixture: Fixture, base: DelegationCaller) => ({
  ...base,
  activationId: (await parentOf(fixture)).delegationAttention!.activationId,
});

const failingPair = (fingerprint: string, id: string) => [
  assignment(fingerprint, id),
  {
    ...assignment(fingerprint, `${id}-dependent`),
    prerequisites: [
      { assignmentId: id, output: 'findings', condition: 'accepted-output' as const },
    ],
  },
];

it('coalesces failures into one attention, retains a finishing sibling and never joins successfully (DC-10, DC-32)', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [...failingPair(fingerprint, 'a'), assignment(fingerprint, 'independent')],
    context('reserve'),
  );
  const [a, , independent] = reservation.children;
  await complete(fixture, a!.workflowInstanceId, 'failed');
  await fixture.service.reconcileChildCompletions(context('r1'));
  await fixture.service.reconcileChildCompletions(context('r2'));
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
  const attending = await parentOf(fixture);
  expect(attending.status).toBe('active');
  expect(attending.pendingActivation!.activationId).toBe(
    attending.delegationAttention!.activationId,
  );
  // Exactly one parent activation is dispatchable, and the independent child keeps running.
  expect(await fixture.service.listPendingActivations(workId('1'))).toHaveLength(1);
  expect(await fixture.service.listPendingActivations(independent!.workItemId)).toHaveLength(1);

  fixture.artifacts.published.add(independent!.workItemId);
  await complete(fixture, independent!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('r3'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);

  await finishAttention(fixture, 'attention-done');
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
  // No new assignment or budget was created by assessing the failure.
  expect(await count(fixture, OrchestrationEventType.DelegationReserved)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
});

it('coalesces a late blocker into a subsequent assessment instead of a concurrent one', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [
      ...failingPair(fingerprint, 'a'),
      ...failingPair(fingerprint, 'b'),
      assignment(fingerprint, 'independent'),
    ],
    context('reserve'),
  );
  await complete(fixture, reservation.children[0]!.workflowInstanceId, 'failed');
  await fixture.service.reconcileChildCompletions(context('r1'));
  const first = (await parentOf(fixture)).delegationAttention!.attentionKey;
  await complete(fixture, reservation.children[2]!.workflowInstanceId, 'failed');
  await fixture.service.reconcileChildCompletions(context('r2'));
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
  expect((await parentOf(fixture)).delegationAttention!.attentionKey).toBe(first);

  await finishAttention(fixture, 'attention-1');
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(2);
  const second = await parentOf(fixture);
  expect(second.delegationAttention!.attentionKey).not.toBe(first);
  expect(second.delegationAttention!.attentionKey.length).toBeGreaterThan(first.length);
  await finishAttention(fixture, 'attention-2');
  // Both reasons were assessed; the unresolved independent child is not polled again.
  await fixture.service.reconcileChildCompletions(context('r3'));
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(2);
  expect((await parentOf(fixture)).status).toBe('waiting');
});

it('answers only an assignment-context blocker with exact references and resumes only that child (DC-32)', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'x'), assignment(fingerprint, 'y')],
    context('reserve'),
  );
  const [x, y] = reservation.children;
  await clarify(fixture, x!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('r1'));
  const attention = (await parentOf(fixture)).delegationAttention!;
  const attending = await attentionCaller(fixture, caller);
  const request = (await fixture.service.inspectDelegation(attending, context('inspect'))) as {
    attention: { revision: number; blockers: { blockerId: string; kind: string }[] };
  };
  expect(request.attention.blockers).toMatchObject([{ kind: 'assignment-context' }]);
  const reply = {
    childWorkItemId: x!.workItemId,
    blockerId: request.attention.blockers[0]!.blockerId,
    expectedRevision: request.attention.revision,
    references: [{ workItemId: workId('1'), revisionId: 'answer-1' }],
  };
  const reject = async (changed: object, code: string) =>
    expect(
      fixture.service.respondToDelegationAttention(
        attending,
        { ...reply, ...changed } as never,
        context(`reject-${code}`),
      ),
    ).rejects.toMatchObject({ code });
  await reject({ expectedRevision: reply.expectedRevision + 1 }, 'stale-revision');
  await reject({ blockerId: 'unknown' }, 'unknown-blocker');
  await reject({ childWorkItemId: y!.workItemId }, 'unknown-blocker');
  await expect(
    fixture.service.respondToDelegationAttention(
      { ...attending, activationId: caller.activationId },
      reply as never,
      context('stale-activation'),
    ),
  ).rejects.toMatchObject({ code: 'no-attention' });
  await expect(
    fixture.service.respondToDelegationAttention(
      attending,
      { ...reply, references: [{ workItemId: workId('9'), revisionId: 'outside' }] } as never,
      context('outside'),
    ),
  ).rejects.toThrow('outside the parent hierarchy');
  expect(fixture.artifacts.grants.size).toBe(2);

  await fixture.service.respondToDelegationAttention(attending, reply as never, context('reply'));
  await fixture.service.respondToDelegationAttention(attending, reply as never, context('replay'));
  expect(fixture.artifacts.grants.size).toBe(3);
  expect([...fixture.artifacts.grants.values()].at(-1)).toContain('answer-1');
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionResponded)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.OperatorRetryRequested)).toBe(1);
  await reject({ references: [] }, 'duplicate');
  expect((await fixture.service.get(x!.workflowInstanceId))!.status).toBe('active');
  expect((await fixture.service.get(y!.workflowInstanceId))!.status).toBe('active');

  // Both children finish during the assessment: the join is retained, not lost or duplicated.
  fixture.artifacts.published.add(x!.workItemId);
  fixture.artifacts.published.add(y!.workItemId);
  await complete(fixture, x!.workflowInstanceId);
  await complete(fixture, y!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('r2'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  expect((await parentOf(fixture)).delegationAttention?.attentionKey).toBe(attention.attentionKey);

  const restarted = attentionBuild(fixture.journal, fixture.artifacts);
  await restarted.service.reconcileChildCompletions(context('restart'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  await finishAttention(restarted, 'attention-done');
  await restarted.service.reconcileChildCompletions(context('r3'));
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
  expect(
    await restarted.service.joinedDelegationResults(caller.workflowInstanceId, 'cohort-1'),
  ).toHaveLength(2);
});

it('answers a clarification with a free-text message posted to the child, and refuses an empty reply', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'x')],
    context('reserve'),
  );
  const child = reservation.children[0]!;
  await clarify(fixture, child.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('r1'));
  const attending = await attentionCaller(fixture, caller);
  const request = (await fixture.service.inspectDelegation(attending, context('inspect'))) as {
    attention: { revision: number; blockers: { blockerId: string }[] };
  };
  const base = {
    childWorkItemId: child.workItemId,
    blockerId: request.attention.blockers[0]!.blockerId,
    expectedRevision: request.attention.revision,
  };
  const respond = (reply: object, commandId: string) =>
    fixture.service.respondToDelegationAttention(
      attending,
      { references: [], ...base, ...reply } as never,
      context(commandId),
    );
  fixture.opened.length = 0;

  await expect(respond({}, 'empty')).rejects.toMatchObject({ code: 'empty-reply' });
  expect(fixture.opened).toEqual([]);

  await respond({ message: 'The codeword is FALCON.' }, 'reply');
  await respond({ message: 'The codeword is FALCON.' }, 'replay');

  // The answer is posted to the child's conversation under a stable id (replays dedupe there),
  // names the parent as its author, and creates no artifact grant of its own.
  expect(new Set(fixture.opened.map((entry) => entry.entryId)).size).toBe(1);
  expect(fixture.opened[0]).toMatchObject({
    workItemId: child.workItemId,
    authorId: `delegation:${reservation.parentWorkItemId}`,
    body: 'The codeword is FALCON.',
  });
  expect(fixture.artifacts.grants.size).toBe(1);
  expect(await count(fixture, OrchestrationEventType.OperatorRetryRequested)).toBe(1);
  expect((await fixture.service.get(child.workflowInstanceId))!.status).toBe('active');
  await expect(respond({ message: 'Something else.' }, 'other')).rejects.toMatchObject({
    code: 'duplicate',
  });
});

it('wakes the parent once per human reply while a child waits on a clarification, and passes it on', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'x'), assignment(fingerprint, 'y')],
    context('reserve'),
  );
  const [x] = reservation.children;
  const reply = (entryId: string, commandId = entryId) =>
    fixture.service.requestReplyAssessment(
      reservation.parentWorkItemId,
      entryId,
      context(commandId),
    );

  // Nothing is waiting on a human yet: a comment is only recorded, it wakes nothing.
  await reply('comment-0');
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(0);

  await clarify(fixture, x!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('r1'));
  await finishAttention(fixture, 'assess-question');
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
  // The assessed question is not raised again by reconciliation.
  await fixture.service.reconcileChildCompletions(context('r2'));
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);

  // A human reply is new information: the parent is woken, once, however often it is replayed.
  await reply('comment-1');
  await reply('comment-1', 'replay');
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(2);
  const attending = await attentionCaller(fixture, caller);
  const request = (await fixture.service.inspectDelegation(attending, context('inspect'))) as {
    attention: { revision: number; blockers: { blockerId: string; kind: string }[] };
  };
  expect(request.attention.blockers).toMatchObject([{ kind: 'assignment-context' }]);

  // The parent decides what the child hears, and the child resumes.
  fixture.opened.length = 0;
  await fixture.service.respondToDelegationAttention(
    attending,
    {
      childWorkItemId: x!.workItemId,
      blockerId: request.attention.blockers[0]!.blockerId,
      expectedRevision: request.attention.revision,
      references: [],
      message: 'Use FALCON.',
    } as never,
    context('relay'),
  );
  expect(fixture.opened.map((entry) => entry.body)).toEqual(['Use FALCON.']);
  expect((await fixture.service.get(x!.workflowInstanceId))!.status).toBe('active');

  // The child is no longer waiting, so a later comment wakes nothing further.
  await finishAttention(fixture, 'assess-reply');
  await reply('comment-2');
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(2);
});

it('does not accept a reply for a terminal failure or a human-only gate (DC-32)', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [...failingPair(fingerprint, 'a'), assignment(fingerprint, 'independent')],
    context('reserve'),
  );
  await complete(fixture, reservation.children[0]!.workflowInstanceId, 'failed');
  await fixture.service.reconcileChildCompletions(context('r1'));
  const attending = await attentionCaller(fixture, caller);
  const request = (await fixture.service.inspectDelegation(attending, context('inspect'))) as {
    attention: { blockers: { blockerId: string }[] };
  };
  await expect(
    fixture.service.respondToDelegationAttention(
      attending,
      {
        childWorkItemId: reservation.children[0]!.workItemId,
        blockerId: request.attention.blockers[0]!.blockerId,
        expectedRevision: 1,
        references: [],
      },
      context('terminal'),
    ),
  ).rejects.toMatchObject({ code: 'not-answerable' });
  // A child waiting at an approval gate raises no blocker, so there is nothing to answer.
  await expect(
    fixture.service.respondToDelegationAttention(
      attending,
      {
        childWorkItemId: reservation.children[2]!.workItemId,
        blockerId: `${reservation.children[2]!.grantId}:context:gate`,
        expectedRevision: 1,
        references: [],
      },
      context('gate'),
    ),
  ).rejects.toMatchObject({ code: 'unknown-blocker' });
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionResponded)).toBe(0);
});

it('raises no attention for a frozen parent and refuses a late attention outcome (DC-19)', async () => {
  // The delegating Run is still active, so nothing may be requested until it ends.
  const fixture = build(undefined, undefined, new Set(['run-1']), undefined, false, {});
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'x'), assignment(fingerprint, 'y')],
    context('reserve'),
  );
  await clarify(fixture, reservation.children[0]!.workflowInstanceId);
  await fixture.work.freeze(workId('1'), context('freeze'));
  fixture.activeRuns.clear();
  await fixture.service.reconcileChildCompletions(context('r1'));
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(0);
  expect((await parentOf(fixture)).status).toBe('waiting');
  await fixture.work.unfreeze(workId('1'), context('unfreeze'));
  await fixture.service.reconcileChildCompletions(context('r2'));
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
  // Freezing during the assessment refuses its outcome instead of restoring the wait.
  await fixture.work.freeze(workId('1'), context('freeze-again'));
  const parent = await parentOf(fixture);
  await expect(
    fixture.service.acceptOutcome(
      {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.delegationAttention!.activationId,
        outcome: { kind: 'done' },
      },
      context('late'),
    ),
  ).rejects.toBeInstanceOf(DelegationPendingError);
  expect((await parentOf(fixture)).delegationAttention).toBeDefined();
});

it('escalates once when the delegating activity cannot assess attention', async () => {
  const fixture = build(undefined, undefined, undefined, undefined, false, {
    isAgent: () => false,
  });
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'x'), assignment(fingerprint, 'y')],
    context('reserve'),
  );
  await clarify(fixture, reservation.children[0]!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('r1'));
  await fixture.service.reconcileChildCompletions(context('r2'));
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(0);
  const escalations = (await fixture.journal.readAll(0)).filter(
    (entry) =>
      entry.event.eventType === OrchestrationEventType.DelegationReconciliationFailed &&
      JSON.stringify(entry.event.payload).includes('cannot assess'),
  );
  expect(escalations).toHaveLength(1);
  expect((await parentOf(fixture)).status).toBe('waiting');
});

it('keeps the cohort tracked when the parent escalates a human question, then relays the human answer to the child', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'x'), assignment(fingerprint, 'y')],
    context('reserve'),
  );
  const [x, y] = reservation.children;
  await clarify(fixture, x!.workflowInstanceId);
  const parent = await parentOf(fixture);
  const attentionId = parent.delegationAttention!.activationId;
  await fixture.service.acceptOutcome(
    {
      workflowInstanceId: parent.workflowInstanceId,
      activationId: attentionId,
      outcome: {
        kind: 'blocked',
        data: { status: 'NEEDS_CLARIFICATION', question: 'Which API version is intended?' },
      },
    },
    context('escalate'),
  );
  // The question is an ordinary accepted outcome (published to a human by the existing route).
  const accepted = (await fixture.journal.readAll(0)).filter(
    (entry) =>
      entry.event.eventType === OrchestrationEventType.ActivityOutcomeAccepted &&
      (entry.event.payload as { activationId?: string }).activationId === attentionId,
  );
  expect(accepted).toHaveLength(1);
  const resolved = (await fixture.journal.readAll(0)).filter(
    (entry) => entry.event.eventType === OrchestrationEventType.DelegationAttentionResolved,
  );
  expect(resolved[0]!.event.payload).toMatchObject({
    escalation: 'Which API version is intended?',
  });
  // Nothing is settled, cancelled or joined: the parent waits and the independent child runs on.
  const waiting = await parentOf(fixture);
  expect(waiting.status).toBe('waiting');
  expect(waiting.delegationWait?.cohortId).toBe('cohort-1');
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  expect((await fixture.service.get(y!.workflowInstanceId))!.status).toBe('active');
  expect((await fixture.service.get(x!.workflowInstanceId))!.status).toBe('blocked');
  // A sibling finishing after the escalation keeps its result; the human answer then resumes
  // the asking child and the whole cohort joins once, with both results.
  fixture.artifacts.published.add(y!.workItemId);
  await complete(fixture, y!.workflowInstanceId);
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  // The human answers on the parent issue (the route the question was published on). The reply is
  // recorded on the parent, which is woken to decide how to pass it on; the child is not resumed
  // behind its back.
  await humanReply(fixture, workId('1'), 'Use API version 2.');
  expect((await fixture.service.get(x!.workflowInstanceId))!.status).toBe('blocked');
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(2);
  const attending = await attentionCaller(fixture, caller);
  const request = (await fixture.service.inspectDelegation(attending, context('inspect'))) as {
    attention: { revision: number; blockers: { blockerId: string }[] };
  };
  await fixture.service.respondToDelegationAttention(
    attending,
    {
      childWorkItemId: x!.workItemId,
      blockerId: request.attention.blockers[0]!.blockerId,
      expectedRevision: request.attention.revision,
      references: [],
      message: 'Use API version 2.',
    } as never,
    context('relay'),
  );
  expect((await fixture.service.get(x!.workflowInstanceId))!.status).toBe('active');
  expect((await fixture.service.get(y!.workflowInstanceId))!.status).toBe('completed');
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  await finishAttention(fixture, 'assess-reply');
  // A second comment wakes nothing: the child is no longer blocked on the question.
  const resumes = await count(fixture, OrchestrationEventType.OperatorRetryRequested);
  await humanReply(fixture, workId('1'), 'Thanks!', 'second');
  expect(await count(fixture, OrchestrationEventType.OperatorRetryRequested)).toBe(resumes);
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(2);
  fixture.artifacts.published.add(x!.workItemId);
  await complete(fixture, x!.workflowInstanceId);
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
  expect(
    await fixture.service.joinedDelegationResults(caller.workflowInstanceId, 'cohort-1'),
  ).toHaveLength(2);
  expect(await count(fixture, OrchestrationEventType.DelegationReserved)).toBe(1);
});

/** A human comment on a work item, applied through the real conversation reactor. */
async function humanReply(
  fixture: Fixture,
  workItemId: ReturnType<typeof workId>,
  body: string,
  id = 'first',
) {
  const conversations = createConversationService(fixture.journal);
  const reactor = createConversationCommandReactor(fixture.service, {
    conversations,
    publish: async () => undefined,
  });
  const entryContext = context(`comment-${id}`);
  await conversations.createForWorkItem(workItemId, entryContext);
  await conversations.record(
    {
      conversationId: conversationIdForWorkItem(workItemId),
      entryId: `comment-${id}`,
      body,
      origin: {
        kind: 'external',
        adapter: 'github',
        actorId: 'contributor',
        resourceId: 'resource-1',
        threadId: 'org/repo#1',
        messageId: id,
        authorized: false,
      },
    },
    entryContext,
  );
  const host = new EventProcessorHost(
    fixture.journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );
  // The routed copy lands on the child's conversation and is picked up by a second pass.
  await host.runOnce(reactor.processor);
  await host.runOnce(reactor.processor);
}

it('treats a failed assessment run as retryable without settling or cancelling the cohort', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'x'), assignment(fingerprint, 'y')],
    context('reserve'),
  );
  const [x, y] = reservation.children;
  await clarify(fixture, x!.workflowInstanceId);
  const failures = [
    { kind: 'failed', data: { reason: 'runner-failed' } },
    { kind: 'blocked', data: { reason: 'runner-authentication-required' } },
    { kind: 'failed', data: { reason: 'invalid-agent-result' } },
  ];
  for (const [index, outcome] of failures.entries()) {
    const parent = await parentOf(fixture);
    expect(parent.delegationAttention).toBeDefined();
    await fixture.service.acceptOutcome(
      {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.delegationAttention!.activationId,
        outcome: outcome as never,
      },
      context(`assessment-${index}`),
    );
    // Siblings keep running and the cohort is neither failed nor joined.
    expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
    expect((await fixture.service.get(y!.workflowInstanceId))!.status).toBe('active');
  }
  // Failures are bounded and visible: no fourth assessment is requested for the same blockers.
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(3);
  expect((await parentOf(fixture)).status).toBe('waiting');
  const diagnostics = (await fixture.journal.readAll(0)).filter(
    (entry) =>
      entry.event.eventType === OrchestrationEventType.DelegationReconciliationFailed &&
      JSON.stringify(entry.event.payload).includes('assessment failed'),
  );
  // Three per-attempt diagnostics, the last of which is also the operator escalation.
  expect(diagnostics).toHaveLength(4);
  expect(
    diagnostics.filter((entry) =>
      JSON.stringify(entry.event.payload).includes('an operator must inspect the blockers'),
    ),
  ).toHaveLength(1);
  // The cohort is still joinable once the child is answered by other means.
  await fixture.service.resumeNeedsClarificationStage(x!.workflowInstanceId, context('answer'));
  fixture.artifacts.published.add(x!.workItemId);
  fixture.artifacts.published.add(y!.workItemId);
  await complete(fixture, x!.workflowInstanceId);
  await complete(fixture, y!.workflowInstanceId);
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(1);
});

it('puts a child parked by exhausted retries to the parent in an ordinary cohort (DC-32)', async () => {
  const fixture = build(undefined, undefined, undefined, undefined, false, {
    unroutedFailure: true,
  });
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'a'), assignment(fingerprint, 'b')],
    context('reserve'),
  );
  await complete(fixture, reservation.children[0]!.workflowInstanceId, 'failed');
  expect((await fixture.service.get(reservation.children[0]!.workflowInstanceId))!.status).toBe(
    'blocked',
  );
  await fixture.service.reconcileChildCompletions(context('r1'));
  const open = await fixture.service.openDelegationAttention(
    caller.workflowInstanceId,
    (await parentOf(fixture)).delegationAttention!.activationId,
  );
  expect(open!.blockers).toMatchObject([
    { kind: 'failed', blockerId: expect.stringContaining(':parked:') },
  ]);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  expect(
    await fixture.service.listPendingActivations(reservation.children[1]!.workItemId),
  ).toHaveLength(1);
  // The parked child is not a reply target and is never polled again after assessment.
  await expect(
    fixture.service.respondToDelegationAttention(
      await attentionCaller(fixture, caller),
      {
        childWorkItemId: reservation.children[0]!.workItemId,
        blockerId: open!.blockers[0]!.blockerId,
        expectedRevision: 1,
        references: [],
      },
      context('reply'),
    ),
  ).rejects.toMatchObject({ code: 'not-answerable' });
  await finishAttention(fixture, 'assessed');
  await fixture.service.reconcileChildCompletions(context('r2'));
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionRequested)).toBe(1);
});

it('puts a changed consumed input to the parent without staling unrelated work (DC-17)', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const batch = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [
      assignment(fingerprint, 'upstream'),
      {
        ...assignment(fingerprint, 'consumer'),
        prerequisites: [
          { assignmentId: 'upstream', output: 'findings', condition: 'accepted-output' },
        ],
      },
      assignment(fingerprint, 'unrelated'),
    ],
    context('reserve'),
  );
  const [upstream, consumer, unrelated] = batch.children;
  fixture.artifacts.published.add(upstream!.workItemId);
  await complete(fixture, upstream!.workflowInstanceId);
  await fixture.service.reconcileChildCompletions(context('pin'));
  const original = (await fixture.service.deliveryTree(workId('1')))[0]!.children[1]!
    .consumedInputs;
  fixture.artifacts.published.add(consumer!.workItemId);
  await complete(fixture, consumer!.workflowInstanceId);
  fixture.artifacts.revisions.set(upstream!.workItemId, 'revision-v2');
  await fixture.service.reconcileChildCompletions(context('moved-forward'));
  const open = await fixture.service.openDelegationAttention(
    caller.workflowInstanceId,
    (await parentOf(fixture)).delegationAttention!.activationId,
  );
  expect(open!.blockers).toMatchObject([{ kind: 'failed' }]);
  expect(open!.blockers[0]!.childWorkItemId).toBe(consumer!.workItemId);
  // Only the affected consumer is stale: the other members and the old receipt are untouched.
  expect(await fixture.service.listPendingActivations(unrelated!.workItemId)).toHaveLength(1);
  expect((await fixture.service.deliveryTree(workId('1')))[0]!.children[1]!.consumedInputs).toEqual(
    original,
  );
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
  // Assessment alone neither accepts the new revision nor settles the cohort.
  await finishAttention(fixture, 'reassessed');
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(0);
  fixture.artifacts.published.add(unrelated!.workItemId);
  await complete(fixture, unrelated!.workflowInstanceId);
  expect(await count(fixture, OrchestrationEventType.DelegationFailed)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.DelegationJoined)).toBe(0);
});

it('completes an accepted reply after a crash between the recorded reply and the child resume', async () => {
  const fixture = attentionBuild();
  const { caller, fingerprint } = await startParent(fixture);
  const reservation = await fixture.service['delegatedWork'].reserve(
    caller,
    'cohort-1',
    [assignment(fingerprint, 'x'), assignment(fingerprint, 'y')],
    context('reserve'),
  );
  const x = reservation.children[0]!;
  await clarify(fixture, x.workflowInstanceId);
  const attending = await attentionCaller(fixture, caller);
  const open = await fixture.service.openDelegationAttention(
    caller.workflowInstanceId,
    attending.activationId,
  );
  const reply = {
    childWorkItemId: x.workItemId,
    blockerId: open!.blockers[0]!.blockerId,
    expectedRevision: open!.revision,
    references: [{ workItemId: workId('1'), revisionId: 'answer-1' }],
  };
  fixture.artifacts.registrationUnavailable = true;
  await expect(
    fixture.service.respondToDelegationAttention(attending, reply, context('reply')),
  ).rejects.toThrow('Grant store unavailable');
  // The reply is durable but the child is still blocked and no grant exists yet.
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionResponded)).toBe(1);
  expect((await fixture.service.get(x.workflowInstanceId))!.status).toBe('blocked');
  fixture.artifacts.registrationUnavailable = false;
  const restarted = attentionBuild(fixture.journal, fixture.artifacts);
  await restarted.service.respondToDelegationAttention(attending, reply, context('replay'));
  await restarted.service.respondToDelegationAttention(attending, reply, context('replay-2'));
  expect(await count(fixture, OrchestrationEventType.DelegationAttentionResponded)).toBe(1);
  expect(await count(fixture, OrchestrationEventType.OperatorRetryRequested)).toBe(1);
  expect((await restarted.service.get(x.workflowInstanceId))!.status).toBe('active');
  expect(
    [...fixture.artifacts.grants.values()].filter((grant) => grant.includes('answer-1')),
  ).toHaveLength(1);
});
