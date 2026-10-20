import { correlationId, type CommandContext } from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import type {
  DelegatedAssignment,
  DelegationResult,
} from '../../../src/orchestration/contracts/delegation.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  compileWorkflow,
  createOrchestrationEventData,
  createOrchestrationService,
  DeliveryRejectionError,
  OrchestrationEventType,
  workflowInstanceStream,
  type DelegationArtifacts,
  type DelegationCaller,
  type DelegationRepositories,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { createWorkService, type WorkItemId } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { FaultInjectingJournal } from '../../support/fault-injecting-journal.js';
import { workId } from '../../support/identities.js';

const context = (commandId: string): CommandContext => ({
  commandId,
  correlationId: correlationId('delivery-1'),
  occurredAt: '2026-07-30T12:00:00.000Z',
  actor: { kind: 'system', id: 'test' },
});

const sha = (char: string) => char.repeat(40);

type Output = DelegationResult['outputs'][number];

/** Permanent fake of the Bootstrap artifact adapter: change outputs are opt-in per child. */
class FakeArtifacts implements DelegationArtifacts {
  readonly published = new Set<string>();
  readonly changes = new Map<string, Output>();
  async validateInputs(): Promise<void> {}
  async registerChild(): Promise<void> {}
  async prerequisiteOutput(child: WorkflowInstanceView): Promise<Output | null> {
    return this.changes.get(child.workItemId) ?? null;
  }

  async qualifyingOutputs(child: WorkflowInstanceView) {
    if (!this.published.has(child.workItemId)) return null;
    const change = this.changes.get(child.workItemId);
    return change === undefined ? null : [change];
  }
}

/** Remote repository fake: refs and fetchable commits per repository. */
class FakeRemote {
  readonly refs = new Map<string, string>();
  readonly commits = new Set<string>();
  readonly resolve: DelegationRepositories['resolve'] = async (_parent, request) => {
    const revision =
      request.sourceRevision === undefined
        ? this.refs.get(`${request.resourceId}:${request.sourceRef}`)
        : this.commits.has(`${request.resourceId}:${request.sourceRevision}`)
          ? request.sourceRevision
          : undefined;
    if (revision === undefined) throw new Error('Source did not resolve to the requested commit');
    return { ...request, sourceRevision: revision };
  };
}

function build(
  options: { completion?: 'qa-approved' | 'merge-required'; descendants?: number } = {},
) {
  const journal = new FaultInjectingJournal(new FakeClock());
  const work = createWorkService(journal);
  const artifacts = new FakeArtifacts();
  const remote = new FakeRemote();
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('plan'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
    outcomeKinds: ['done', 'failed'],
    resources: [],
    executionKind: 'deterministic',
    handler: { execute: async () => ({ kind: 'done' }) as const },
  });
  const stage = {
    stages: {
      work: {
        activity: 'plan',
        with: {},
        on: { done: { then: 'done' }, failed: { then: 'done' } },
        requiresApproval: false,
      },
    },
  };
  const names = ['parent', 'child'];
  const definitions = {
    parent: compileWorkflow(
      'parent',
      {
        ...stage,
        delegation: {
          workflows: ['child'],
          maxDepth: 1,
          maxDescendants: options.descendants ?? 8,
          maxConcurrentRuns: 4,
          ...(options.completion === undefined ? {} : { completion: options.completion }),
        },
      },
      activities,
      names,
    ),
    child: compileWorkflow('child', stage, activities, names),
  };
  const service = createOrchestrationService(
    journal,
    work,
    definitions,
    undefined,
    undefined,
    () => ({
      artifacts,
      authority: {
        assertCaller: async () => undefined,
        repositories: async () => ['repo-a', 'repo-b'],
      },
      repositories: { resolve: remote.resolve },
      runHasEnded: async () => true,
    }),
  );
  const limits = { maxDepth: 1, maxDescendants: options.descendants ?? 8 };
  return { journal, work, service, artifacts, remote, definitions, limits };
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
  await fixture.service.start(
    {
      workflowInstanceId: workflowInstanceId('parent-1'),
      workItemId: workId('1'),
      workflowName: workflowName('parent'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    context('start-parent'),
  );
  return probe.workflowDefinitionFingerprint!;
}

async function callerOf(fixture: Fixture): Promise<DelegationCaller> {
  const view = (await fixture.service.get(workflowInstanceId('parent-1')))!;
  return {
    workflowInstanceId: view.workflowInstanceId,
    activationId: view.pendingActivation!.activationId,
    runId: 'run-1',
  };
}

const change = (repo: string, name = 'change') => ({ name, kind: 'change' as const });

function assignmentFor(
  fingerprint: string,
  id: string,
  repo: string,
  extra: Record<string, unknown> = {},
) {
  return {
    assignmentId: id,
    objective: `Do ${id}`,
    criteria: ['Works with the other repository'],
    workflowName: workflowName('child'),
    workflowFingerprint: fingerprint,
    context: [],
    outputs: [change(repo)],
    repository: { resourceId: repo, sourceRef: 'main', pullRequestBase: 'main' },
    ...extra,
  };
}

/** Submissions never carry the fingerprint; Wake pins it from the current definition. */
const submitted = (assignment: object) =>
  Object.fromEntries(Object.entries(assignment).filter(([key]) => key !== 'workflowFingerprint'));

async function finish(fixture: Fixture, childWorkflow: string) {
  const view = (await fixture.service.get(workflowInstanceId(childWorkflow)))!;
  await fixture.service.acceptOutcome(
    {
      workflowInstanceId: view.workflowInstanceId,
      activationId: view.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    context(`outcome-${childWorkflow}`),
  );
}

/** Delegates, publishes one change per child and joins; returns the reservation children. */
async function delegate(
  fixture: Fixture,
  fingerprint: string,
  cohortId: string,
  entries: readonly {
    id: string;
    repo: string;
    revision: string;
    extra?: Record<string, unknown>;
  }[],
) {
  fixture.remote.refs.set('repo-a:main', sha('0'));
  fixture.remote.refs.set('repo-b:main', sha('0'));
  const reservation = await fixture.service['delegatedWork'].reserve(
    await callerOf(fixture),
    cohortId,
    entries.map((entry) => assignmentFor(fingerprint, entry.id, entry.repo, entry.extra)),
    context(`reserve-${cohortId}`),
    fixture.limits,
  );
  for (const [index, child] of reservation.children.entries()) {
    const entry = entries[index]!;
    fixture.remote.commits.add(`${entry.repo}:${entry.revision}`);
    fixture.remote.refs.set(`${entry.repo}:${child.workItemId}`, entry.revision);
    fixture.artifacts.changes.set(child.workItemId, {
      name: 'change',
      reference: {
        workItemId: child.workItemId,
        resourceId: `pr-${entry.id}`,
        repositoryResourceId: entry.repo,
        revision: entry.revision,
        branch: child.workItemId,
        pullRequestBase: 'main',
        runId: `run-${entry.id}`,
      },
    });
    fixture.artifacts.published.add(child.workItemId);
    await finish(fixture, child.workflowInstanceId);
  }
  await fixture.service.reconcileChildCompletions(context(`join-${cohortId}`));
  return reservation.children;
}

const select = (
  cohortId: string,
  entries: readonly { assignmentId: string; child: WorkItemId; replaces?: WorkItemId }[],
  expectedRevision = 0,
  requestId = `select-${expectedRevision + 1}`,
) => ({
  requestId,
  expectedRevision,
  entries: entries.map((entry) => ({
    cohortId,
    assignmentId: entry.assignmentId,
    output: { childWorkItemId: entry.child, outputName: 'change' },
    ...(entry.replaces === undefined
      ? {}
      : { replaces: { childWorkItemId: entry.replaces, outputName: 'change' } }),
  })),
});

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DeliveryRejectionError);
  return (error as DeliveryRejectionError).code;
}

const qa = (
  candidateId: string,
  revisions: Record<string, string>,
  overrides: Record<string, unknown> = {},
) => ({
  qaId: `qa-${candidateId}`,
  candidateId,
  verdict: 'pass' as const,
  revisions: Object.entries(revisions).map(([resourceId, revision]) => ({ resourceId, revision })),
  environment: { available: true },
  findings: [],
  ...overrides,
});

async function selectedTwoRepos(fixture: Fixture) {
  const fingerprint = await startParent(fixture);
  const children = await delegate(fixture, fingerprint, 'c1', [
    { id: 'a', repo: 'repo-a', revision: sha('a') },
    { id: 'b', repo: 'repo-b', revision: sha('b') },
  ]);
  const caller = await callerOf(fixture);
  await fixture.service.selectDelivery(
    caller,
    select('c1', [
      { assignmentId: 'a', child: children[0]!.workItemId },
      { assignmentId: 'b', child: children[1]!.workItemId },
    ]),
    context('select-1'),
  );
  return { fingerprint, children, caller };
}

const outputCandidate = (children: readonly { workItemId: WorkItemId }[], id = 'cand-1') => ({
  candidateId: id,
  selectionRevision: 1,
  repositories: [
    {
      resourceId: 'repo-a',
      source: {
        kind: 'output' as const,
        tip: { childWorkItemId: children[0]!.workItemId, outputName: 'change' },
      },
    },
    {
      resourceId: 'repo-b',
      source: {
        kind: 'output' as const,
        tip: { childWorkItemId: children[1]!.workItemId, outputName: 'change' },
      },
    },
  ],
});

it('runs QA against the exact multi-repository revisions and rejects any other revision set (DC-16)', async () => {
  const fixture = build();
  const { children, caller } = await selectedTwoRepos(fixture);
  const recorded = await fixture.service.recordDeliveryCandidate(
    caller,
    outputCandidate(children),
    context('candidate'),
  );
  expect(
    recorded.candidate.repositories.map((entry) => [entry.resourceId, entry.revision]),
  ).toEqual([
    ['repo-a', sha('a')],
    ['repo-b', sha('b')],
  ]);
  expect(recorded.candidate.criteria).toEqual(['Works with the other repository']);

  // Testing main, or one repository only, cannot satisfy the gate.
  expect(
    await rejection(
      fixture.service.recordDeliveryQa(
        caller,
        qa('cand-1', { 'repo-a': sha('0'), 'repo-b': sha('b') }),
        context('qa-main'),
      ),
    ),
  ).toBe('revision-mismatch');
  expect(
    await rejection(
      fixture.service.recordDeliveryQa(
        caller,
        qa('cand-1', { 'repo-a': sha('a') }),
        context('qa-one'),
      ),
    ),
  ).toBe('revision-mismatch');
  expect(
    await rejection(
      fixture.service.recordDeliveryQa(
        caller,
        qa('unknown', { 'repo-a': sha('a'), 'repo-b': sha('b') }),
        context('qa-unknown'),
      ),
    ),
  ).toBe('unknown-candidate');

  await fixture.service.recordDeliveryQa(
    caller,
    qa('cand-1', { 'repo-a': sha('a'), 'repo-b': sha('b') }),
    context('qa-pass'),
  );
  const view = (await fixture.service.inspectDelegation(caller, context('inspect'))).delivery!;
  expect(view.qaEffective).toBe(true);
  expect(view.completion).toEqual({ complete: true });
});

it('denies waiving a required assignment and compares the expected selection revision', async () => {
  const fixture = build();
  const fingerprint = await startParent(fixture);
  const children = await delegate(fixture, fingerprint, 'c1', [
    { id: 'a', repo: 'repo-a', revision: sha('a') },
    { id: 'b', repo: 'repo-b', revision: sha('b') },
  ]);
  const caller = await callerOf(fixture);
  expect(
    await rejection(
      fixture.service.selectDelivery(
        caller,
        select('c1', [{ assignmentId: 'a', child: children[0]!.workItemId }]),
        context('partial'),
      ),
    ),
  ).toBe('uncovered-requirement');
  expect(
    await rejection(
      fixture.service.selectDelivery(
        caller,
        select('c1', [
          { assignmentId: 'a', child: children[0]!.workItemId },
          { assignmentId: 'b', child: children[0]!.workItemId },
        ]),
        context('wrong-output'),
      ),
    ),
  ).toBe('replacement-conflict');
  expect(
    await rejection(
      fixture.service.selectDelivery(
        caller,
        select('c1', [{ assignmentId: 'unknown', child: children[0]!.workItemId }]),
        context('unknown-assignment'),
      ),
    ),
  ).toBe('unknown-requirement');
  expect(
    await rejection(
      fixture.service.selectDelivery(
        caller,
        select('c1', [{ assignmentId: 'a', child: children[0]!.workItemId }], 3),
        context('stale'),
      ),
    ),
  ).toBe('stale-selection');
  // A candidate cannot exist without a selection.
  expect(
    await rejection(
      fixture.service.recordDeliveryCandidate(caller, outputCandidate(children), context('early')),
    ),
  ).toBe('no-selection');
});

it('replays a duplicate selection, candidate and QA without a second fact', async () => {
  const fixture = build();
  const { children, caller } = await selectedTwoRepos(fixture);
  const events = async () =>
    (await fixture.journal.readAll(0)).filter((entry) =>
      entry.event.eventType.startsWith('orchestration.delivery-'),
    ).length;
  await fixture.service.recordDeliveryCandidate(caller, outputCandidate(children), context('c'));
  await fixture.service.recordDeliveryQa(
    caller,
    qa('cand-1', { 'repo-a': sha('a'), 'repo-b': sha('b') }),
    context('q'),
  );
  const before = await events();
  const replaySelection = await fixture.service.selectDelivery(
    caller,
    select(
      'c1',
      [
        { assignmentId: 'a', child: children[0]!.workItemId },
        { assignmentId: 'b', child: children[1]!.workItemId },
      ],
      0,
      'select-1',
    ),
    context('select-again'),
  );
  expect(replaySelection.replay).toBe(true);
  expect(
    (
      await fixture.service.recordDeliveryCandidate(
        caller,
        outputCandidate(children),
        context('c2'),
      )
    ).replay,
  ).toBe(true);
  expect(
    (
      await fixture.service.recordDeliveryQa(
        caller,
        qa('cand-1', { 'repo-a': sha('a'), 'repo-b': sha('b') }),
        context('q2'),
      )
    ).replay,
  ).toBe(true);
  expect(await events()).toBe(before);
  // Reusing an identity for different content is a conflict, not a silent overwrite.
  expect(
    await rejection(
      fixture.service.recordDeliveryCandidate(
        caller,
        { ...outputCandidate(children), recipe: 'different' },
        context('c3'),
      ),
    ),
  ).toBe('identity-conflict');
});

it('treats an unavailable environment as a blocker and never as a pass', async () => {
  const fixture = build();
  const { children, caller } = await selectedTwoRepos(fixture);
  await fixture.service.recordDeliveryCandidate(caller, outputCandidate(children), context('c'));
  const revisions = { 'repo-a': sha('a'), 'repo-b': sha('b') };
  expect(
    await rejection(
      fixture.service.recordDeliveryQa(
        caller,
        qa('cand-1', revisions, { environment: { available: false } }),
        context('fake-pass'),
      ),
    ),
  ).toBe('invalid-verdict');
  await fixture.service.recordDeliveryQa(
    caller,
    qa('cand-1', revisions, {
      qaId: 'qa-blocked',
      verdict: 'blocked',
      environment: { available: false },
      findings: ['Test database is not provisioned'],
    }),
    context('blocked'),
  );
  const view = (await fixture.service.inspectDelegation(caller, context('i'))).delivery!;
  expect(view.completion.complete).toBe(false);
  expect(view.completion.reason).toContain('blocked');
});

it('requires a fetchable retained ref for assembled independent changes and rejects missing or moved refs (DC-34)', async () => {
  const fixture = build();
  const fingerprint = await startParent(fixture);
  const children = await delegate(fixture, fingerprint, 'c1', [
    { id: 'a', repo: 'repo-a', revision: sha('a') },
    { id: 'b', repo: 'repo-a', revision: sha('b') },
  ]);
  const caller = await callerOf(fixture);
  await fixture.service.selectDelivery(
    caller,
    select('c1', [
      { assignmentId: 'a', child: children[0]!.workItemId },
      { assignmentId: 'b', child: children[1]!.workItemId },
    ]),
    context('select'),
  );
  const keys = children.map((child) => ({
    childWorkItemId: child.workItemId,
    outputName: 'change',
  }));
  // Independent changes in one repository cannot claim one of them as the combined tip.
  expect(
    await rejection(
      fixture.service.recordDeliveryCandidate(
        caller,
        {
          candidateId: 'asm',
          selectionRevision: 1,
          repositories: [{ resourceId: 'repo-a', source: { kind: 'output', tip: keys[0]! } }],
        },
        context('lone-tip'),
      ),
    ),
  ).toBe('candidate-coverage');
  const ref = `refs/wake/delivery/${workId('1')}/asm/repo-a`;
  const candidate = {
    candidateId: 'asm',
    selectionRevision: 1,
    repositories: [
      {
        resourceId: 'repo-a',
        source: { kind: 'retained-ref' as const, ref, revision: sha('c'), contributions: keys },
      },
    ],
  };
  // A local SHA is not a source: nothing is published yet.
  expect(
    await rejection(fixture.service.recordDeliveryCandidate(caller, candidate, context('missing'))),
  ).toBe('source-unavailable');
  expect(
    await rejection(
      fixture.service.recordDeliveryCandidate(
        caller,
        {
          ...candidate,
          repositories: [
            {
              ...candidate.repositories[0]!,
              source: { ...candidate.repositories[0]!.source, ref: 'refs/heads/main' },
            },
          ],
        },
        context('namespace'),
      ),
    ),
  ).toBe('source-unavailable');
  fixture.remote.refs.set(`repo-a:${ref}`, sha('d'));
  expect(
    await rejection(fixture.service.recordDeliveryCandidate(caller, candidate, context('moved'))),
  ).toBe('source-unavailable');
  fixture.remote.refs.set(`repo-a:${ref}`, sha('c'));
  await fixture.service.recordDeliveryCandidate(caller, candidate, context('ok'));

  // After the assembly workspace is gone and the process restarts, the same candidate is
  // reconstructed from the retained ref alone.
  const restarted = createOrchestrationService(
    fixture.journal,
    fixture.work,
    fixture.definitions,
    undefined,
    undefined,
    () => ({
      artifacts: fixture.artifacts,
      authority: { assertCaller: async () => undefined, repositories: async () => ['repo-a'] },
      repositories: { resolve: fixture.remote.resolve },
      runHasEnded: async () => true,
    }),
  );
  const revisions = { 'repo-a': sha('c') };
  await restarted.recordDeliveryQa(await callerOf(fixture), qa('asm', revisions), context('qa'));
  const view = (await restarted.inspectDelegation(caller, context('inspect'))).delivery!;
  expect(view.candidate?.repositories[0]).toMatchObject({ revision: sha('c') });

  // The ref moving after the candidate was recorded makes a passing verdict impossible.
  fixture.remote.refs.set(`repo-a:${ref}`, sha('e'));
  expect(
    await rejection(
      restarted.recordDeliveryQa(
        await callerOf(fixture),
        qa('asm', revisions, { qaId: 'qa-later' }),
        context('qa-moved'),
      ),
    ),
  ).toBe('source-unavailable');
});

it('replaces a defective terminal child, stales downstream consumers and keeps unrelated evidence (DC-17, DC-18)', async () => {
  const fixture = build();
  const fingerprint = await startParent(fixture);
  const children = await delegate(fixture, fingerprint, 'c1', [
    { id: 'a', repo: 'repo-a', revision: sha('a') },
    { id: 'b', repo: 'repo-b', revision: sha('b') },
    { id: 'c', repo: 'repo-b', revision: sha('c') },
  ]);
  const [a, b, c] = children;
  const caller = await callerOf(fixture);
  await fixture.service.selectDelivery(
    caller,
    select('c1', [
      { assignmentId: 'a', child: a!.workItemId },
      { assignmentId: 'b', child: b!.workItemId },
      { assignmentId: 'c', child: c!.workItemId },
    ]),
    context('select-1'),
  );
  // B was built on top of A's output (a recorded consumed input); C is unrelated.
  const stream = workflowInstanceStream(b!.workflowInstanceId as never);
  await fixture.journal.appendToStream(stream, (await fixture.journal.readStream(stream)).length, [
    createOrchestrationEventData({
      eventType: OrchestrationEventType.DelegationInputsResolved,
      eventId: 'inputs-b',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: correlationId('delivery-1'),
      causationId: 'inputs-b',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' } as never,
      payload: {
        childWorkItemId: b!.workItemId,
        consumed: [fixture.artifacts.changes.get(a!.workItemId)!],
      },
    }),
  ] as never);

  // Replacement must carry the original contribution and cannot be a fix-only PR.
  const replacement = (extra: Record<string, unknown>, repository?: object) =>
    ({
      ...assignmentFor(fingerprint, 'a2', 'repo-a', {
        replaces: { cohortId: 'c1', assignmentId: 'a' },
        ...extra,
      }),
      ...(repository === undefined ? {} : { repository }),
    }) as DelegatedAssignment;
  const attempt = (assignment: DelegatedAssignment) =>
    fixture.service.submitDelegation(
      caller,
      { cohortId: 'attempt', assignments: [submitted(assignment)] } as never,
      context('attempt'),
    );
  await expect(
    attempt(replacement({}, { resourceId: 'repo-a', sourceRef: 'main', pullRequestBase: 'main' })),
  ).rejects.toThrow('start from the unmerged contribution');
  await expect(
    attempt(
      replacement(
        { criteria: ['Something else'] },
        { resourceId: 'repo-a', sourceRef: a!.workItemId, pullRequestBase: 'main' },
      ),
    ),
  ).rejects.toThrow('preserve every original acceptance criterion');
  await expect(
    attempt(
      replacement({}, { resourceId: 'repo-a', sourceRef: a!.workItemId, pullRequestBase: 'topic' }),
    ),
  ).rejects.toThrow('intended integration branch');
  await expect(
    attempt(
      replacement(
        { replaces: { cohortId: 'c1', assignmentId: 'nothing' } },
        { resourceId: 'repo-a', sourceRef: a!.workItemId, pullRequestBase: 'main' },
      ),
    ),
  ).rejects.toThrow('original required assignment');

  const second = await delegate(fixture, fingerprint, 'c2', [
    {
      id: 'a2',
      repo: 'repo-a',
      revision: sha('f'),
      extra: {
        replaces: { cohortId: 'c1', assignmentId: 'a' },
        repository: { resourceId: 'repo-a', sourceRef: a!.workItemId, pullRequestBase: 'main' },
      },
    },
  ]);
  const next = await callerOf(fixture);
  // The replacement must name what it replaces; a competing guess is a conflict.
  expect(
    await rejection(
      fixture.service.selectDelivery(
        next,
        select(
          'c1',
          [
            { assignmentId: 'a', child: second[0]!.workItemId, replaces: b!.workItemId },
            { assignmentId: 'b', child: b!.workItemId },
            { assignmentId: 'c', child: c!.workItemId },
          ],
          1,
        ),
        context('bad-replaces'),
      ),
    ),
  ).toBe('replacement-conflict');
  const revised = await fixture.service.selectDelivery(
    next,
    select(
      'c1',
      [
        { assignmentId: 'a', child: second[0]!.workItemId, replaces: a!.workItemId },
        { assignmentId: 'b', child: b!.workItemId },
        { assignmentId: 'c', child: c!.workItemId },
      ],
      1,
    ),
    context('select-2'),
  );
  expect(revised.selection.revision).toBe(2);
  const view = (await fixture.service.inspectDelegation(next, context('inspect'))).delivery!;
  // Only B (the consumer of the replaced output) is stale; C remains effective.
  expect(view.stale).toEqual(['c1/b/change']);
  expect(
    await rejection(
      fixture.service.recordDeliveryCandidate(
        next,
        { ...outputCandidate([a!, b!]), selectionRevision: 2 },
        context('stale-candidate'),
      ),
    ),
  ).toBe('stale-output');
});

it('stops repair at the root descendant bound and exposes unresolved findings (DC-18)', async () => {
  const fixture = build({ descendants: 2 });
  const { children, caller } = await selectedTwoRepos(fixture);
  await fixture.service.recordDeliveryCandidate(caller, outputCandidate(children), context('c'));
  await fixture.service.recordDeliveryQa(
    caller,
    qa(
      'cand-1',
      { 'repo-a': sha('a'), 'repo-b': sha('b') },
      {
        verdict: 'fail',
        findings: ['Contract mismatch between the repositories'],
      },
    ),
    context('fail'),
  );
  const view = (await fixture.service.inspectDelegation(caller, context('i'))).delivery!;
  expect(view.repair).toEqual({
    failedRounds: 1,
    exhausted: true,
    unresolvedFindings: ['Contract mismatch between the repositories'],
  });
  expect(view.completion.complete).toBe(false);
  // No new child fits under the shared root bound: the escalation is not a loop.
  await expect(
    fixture.service['delegatedWork'].reserve(
      caller,
      'repair',
      [assignmentFor(await startedFingerprint(fixture), 'fix', 'repo-a')],
      context('repair'),
      fixture.limits,
    ),
  ).rejects.toThrow('Delegation root reservation limit exceeded');
});

async function startedFingerprint(fixture: Fixture) {
  const probe = (await fixture.service.get(workflowInstanceId('probe')))!;
  return probe.workflowDefinitionFingerprint!;
}

it('finishes a QA-approved parent without merge but keeps a merge-required parent incomplete (DC-24)', async () => {
  for (const completion of ['qa-approved', 'merge-required'] as const) {
    const fixture = build({ completion });
    const { children, caller } = await selectedTwoRepos(fixture);
    await fixture.service.recordDeliveryCandidate(caller, outputCandidate(children), context('c'));
    await fixture.service.recordDeliveryQa(
      caller,
      qa('cand-1', { 'repo-a': sha('a'), 'repo-b': sha('b') }),
      context('q'),
    );
    const decision = (await fixture.service.inspectDelegation(caller, context('i'))).delivery!
      .completion;
    expect(decision.complete).toBe(completion === 'qa-approved');
    if (completion === 'merge-required') expect(decision.reason).toContain('integration');
  }
});

it('does not support correcting a child that has not finished and says so explicitly', async () => {
  const fixture = build();
  const fingerprint = await startParent(fixture);
  const caller = await callerOf(fixture);
  fixture.remote.refs.set('repo-a:main', sha('0'));
  await fixture.service['delegatedWork'].reserve(
    caller,
    'c1',
    [assignmentFor(fingerprint, 'a', 'repo-a')],
    context('reserve'),
    fixture.limits,
  );
  const error = await fixture.service
    .submitDelegation(
      caller,
      {
        cohortId: 'fix',
        assignments: [
          submitted(
            assignmentFor(fingerprint, 'a2', 'repo-a', {
              replaces: { cohortId: 'c1', assignmentId: 'a' },
            }),
          ),
        ],
      } as never,
      context('fix'),
    )
    .catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code: 'replacement-unsupported' });
});

it('refuses delivery changes outside the parent current activation', async () => {
  const fixture = build();
  const { children, caller } = await selectedTwoRepos(fixture);
  await expect(
    fixture.service.recordDeliveryCandidate(
      { ...caller, activationId: 'other' as never },
      outputCandidate(children),
      context('wrong-activation'),
    ),
  ).rejects.toThrow('current active activation');
});
