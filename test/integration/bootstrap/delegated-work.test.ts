import { correlationId } from '@atolis-hq/eventing';
import { InMemoryCheckpointStore, InMemoryProjectionStore } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createCompositionRoot,
  parseRootConfig,
  type CompositionRoot,
} from '../../../src/bootstrap/index.js';
import { createActivationScheduler } from '../../../src/control-plane/index.js';
import {
  isActiveRunStatus,
  ProviderQuotaExceededFailureKind,
  RunRepository,
  RunStatus,
  type Runner,
} from '../../../src/execution/index.js';
import { integrationStream } from '../../../src/integrations/contracts/streams.js';
import { applyReviewSignal } from '../../../src/integrations/github/application/inbound-review-signals.js';
import { applyWatchGateVerdictSignal } from '../../../src/integrations/github/application/inbound-watch-gate-signals.js';
import { createGitHubEventData } from '../../../src/integrations/github/contracts/event-factory.js';
import {
  GitHubEventType,
  selectGitHubAdapterEvent,
} from '../../../src/integrations/github/contracts/events.js';
import { GitHubAdapter } from '../../../src/integrations/github/contracts/vocabulary.js';
import {
  createOrchestrationEventData,
  OrchestrationEventType,
  orchestrationGroupId,
  signalName,
  TransitionTargetKind,
  WatchGateVerdictSignal,
  watchId,
  workflowInstanceId,
  workflowInstanceStream,
  workflowName,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import { SequentialIds } from '../../e2e/support/world.js';
import { FaultInjectingJournal } from '../../support/fault-injecting-journal.js';
import { resId, workId } from '../../support/identities.js';
import { ScriptedDelegationRunner } from '../../support/scripted-delegation-runner.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const context = (commandId: string) => ({
  commandId,
  correlationId: correlationId('delegation-composition'),
  occurredAt: '2026-10-18T12:00:00.000Z',
  actor: { kind: 'system' as const, id: 'test' },
});

async function fixture(simulateCompletedRuns = true, runner?: Runner) {
  const home = await mkdtemp(join(tmpdir(), 'wake-delegation-'));
  homes.push(home);
  const journal = new FaultInjectingJournal({ now: () => new Date() });
  const agent = {
    activity: 'agent',
    with: { prompt: 'Publish findings' },
    execution: { workspace: 'none' },
    requiresApproval: false,
    on: { done: { then: 'done' } },
  };
  const config = parseRootConfig({
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    controlPlane: { maxConcurrentRuns: 2, maxDispatches: 1 },
    orchestration: {
      default: 'parent',
      workflows: {
        parent: {
          stages: { seed: { ...agent, on: { done: { then: 'delegate' } } }, delegate: agent },
        },
        child: { stages: { work: agent } },
      },
    },
  });
  const restart = async () => {
    const root = await createCompositionRoot(home, {
      config,
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      ...(runner === undefined ? {} : { decorateRunner: () => runner }),
    });
    if (simulateCompletedRuns)
      vi.spyOn(
        root.orchestration['delegatedWork'] as unknown as {
          endedRun(id: string): Promise<boolean>;
        },
        'endedRun',
      ).mockResolvedValue(true);
    return root;
  };
  return { root: await restart(), restart, journal };
}

async function start(root: CompositionRoot, id: string, name = 'parent') {
  const workItemId = workId(id);
  await root.work.create({ workItemId, objective: id }, context('create-' + id));
  return root.orchestration.start(
    {
      workItemId,
      workflowInstanceId: workflowInstanceId(id),
      workflowName: workflowName(name),
      orchestrationGroupId: orchestrationGroupId(id),
    },
    context('start-' + id),
  );
}

async function publish(root: CompositionRoot, view: WorkflowInstanceView, revisionId: string) {
  await root.artifacts.stageRevision(
    { revisionId, path: 'findings.md', bytes: new TextEncoder().encode('findings') },
    {
      workItemId: view.workItemId,
      producer: view.workflowInstanceId + '/work',
      runId: 'run-' + revisionId,
      activationId: view.pendingActivation!.activationId,
    },
    context('publish-' + revisionId),
  );
  return { workItemId: view.workItemId, revisionId };
}

async function complete(root: CompositionRoot, view: WorkflowInstanceView) {
  return root.orchestration.acceptOutcome(
    {
      workflowInstanceId: view.workflowInstanceId,
      activationId: view.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    context('complete-' + view.pendingActivation!.activationId),
  );
}

function assignment(
  fingerprint: string,
  references: DelegatedAssignment['context'],
): DelegatedAssignment {
  return {
    assignmentId: 'child',
    objective: 'Investigate',
    criteria: ['Findings'],
    workflowName: workflowName('child'),
    workflowFingerprint: fingerprint,
    context: references,
    outputs: [{ name: 'findings', path: 'findings.md' }],
  };
}

it('production composition rejects unrelated accepted and draft context, accepts exact ancestor context, and recovers joins', async () => {
  const f = await fixture();
  const seed = await start(f.root, 'parent');
  const accepted = await publish(f.root, seed, 'parent-seed');
  const parent = await complete(f.root, seed);
  expect(
    await f.root.orchestration.isActivationAccepted(
      seed.pendingActivation!.activationId,
      seed.workItemId,
    ),
  ).toBe(true);
  expect(
    await f.root.orchestration.isActivationAccepted(
      seed.pendingActivation!.activationId,
      workId('another'),
    ),
  ).toBe(false);
  expect(
    await f.root.orchestration.isActivationAccepted(
      parent.pendingActivation!.activationId,
      parent.workItemId,
    ),
  ).toBe(false);
  const outsider = await start(f.root, 'outsider', 'child');
  const unrelated = await publish(f.root, outsider, 'unrelated');
  await complete(f.root, outsider);
  const fingerprint = outsider.workflowDefinitionFingerprint!;
  const caller = {
    workflowInstanceId: parent.workflowInstanceId,
    activationId: parent.pendingActivation!.activationId,
    runId: 'parent-run',
  };
  await expect(
    f.root.orchestration['delegatedWork'].reserve(
      caller,
      'bad',
      [assignment(fingerprint, [unrelated])],
      context('bad'),
    ),
  ).rejects.toThrow('outside the parent hierarchy');
  const draft = await publish(f.root, parent, 'draft-parent');
  await expect(
    f.root.orchestration['delegatedWork'].reserve(
      caller,
      'draft',
      [assignment(fingerprint, [draft])],
      context('draft'),
    ),
  ).rejects.toThrow('accepted artifact revisions');
  const top = await f.root.orchestration['delegatedWork'].reserve(
    caller,
    'top',
    [assignment(fingerprint, [accepted])],
    context('top'),
    { maxDepth: 2, maxDescendants: 3 },
  );
  const child = (await f.root.orchestration.get(top.children[0]!.workflowInstanceId))!;
  expect((await f.root.work.get(child.workItemId))!.delegation).toEqual({
    parentWorkItemId: parent.workItemId,
    rootWorkItemId: parent.workItemId,
    ancestors: [parent.workItemId],
  });
  const nestedCaller = {
    workflowInstanceId: child.workflowInstanceId,
    activationId: child.pendingActivation!.activationId,
    runId: 'nested-run',
  };
  const nested = await f.root.orchestration['delegatedWork'].reserve(
    nestedCaller,
    'nested',
    [assignment(fingerprint, [accepted])],
    context('nested'),
  );
  const root = await f.restart();
  const grandchild = (await root.orchestration.get(nested.children[0]!.workflowInstanceId))!;
  await publish(root, grandchild, 'grandchild-result');
  await complete(root, grandchild);
  const resumedChild = (await root.orchestration.get(child.workflowInstanceId))!;
  await publish(root, resumedChild, 'child-result');
  await complete(root, resumedChild);
  const restarted = await f.restart();
  await restarted.orchestration.reconcileChildCompletions(context('restart'));
  expect(
    await restarted.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'top'),
  ).toMatchObject([
    {
      childWorkItemId: child.workItemId,
      outputs: [{ name: 'findings', reference: { revisionId: 'child-result' } }],
    },
  ]);
  const resumedParent = (await restarted.orchestration.get(parent.workflowInstanceId))!;
  expect(resumedParent.pendingActivation!.input).toEqual(parent.pendingActivation!.input);
  // Accepted child findings are usable in a later cohort, with a new immutable grant.
  const next = await restarted.orchestration['delegatedWork'].reserve(
    { ...caller, activationId: resumedParent.pendingActivation!.activationId, runId: 'later-run' },
    'later',
    [assignment(fingerprint, [{ workItemId: child.workItemId, revisionId: 'child-result' }])],
    context('later'),
  );
  expect(next.children[0]!.grantId).not.toBe(top.children[0]!.grantId);
});

it.each(['failure', 'quota'])(
  'real dispatch and recovery retain a delegating Run %s without blocking its parent',
  async (failure) => {
    const runner = new ScriptedDelegationRunner();
    const f = await fixture(false, runner);
    const seed = await start(f.root, 'dispatch-parent');
    const parent = await complete(f.root, seed);
    const probe = await start(f.root, 'probe', 'child');
    let top: DelegationReservation | undefined;
    runner.scripts.push(async (request) => {
      top = await f.root.orchestration['delegatedWork'].reserve(
        {
          workflowInstanceId: parent.workflowInstanceId,
          activationId: parent.pendingActivation!.activationId,
          runId: request.runId,
        },
        'dispatch',
        [assignment(probe.workflowDefinitionFingerprint!, [])],
        context('reserve-dispatch'),
      );
      if (failure === 'failure') throw new Error('Runner failed after committing delegation');
      return {
        transport: RunStatus.Failed,
        runner: 'fake',
        output: '',
        failure: { kind: ProviderQuotaExceededFailureKind, message: 'Quota exhausted' },
      };
    });
    const synchronousDispatch = createActivationScheduler(
      f.root.orchestration,
      {
        ...f.root.execution,
        attempt: async (...args) => {
          const prepared = await f.root.execution.attempt(...args);
          return terminalRun(f.root, prepared.runId);
        },
      },
      f.root.resources,
      { now: () => new Date() },
      { ids: new SequentialIds(), maxConcurrentRuns: 2 },
    );
    const dispatched = await synchronousDispatch.runOnce({
      workItemId: parent.workItemId,
      maxProgress: 1,
    });
    expect(dispatched.kind).toBe('waiting');
    expect((await f.root.orchestration.get(parent.workflowInstanceId))!.status).toBe('waiting');
    expect(top).toBeDefined();
    const run = (await f.root.execution.list()).find(
      (entry) => entry.activationId === parent.pendingActivation!.activationId,
    )!;
    expect(run).toBeDefined();
    // Force the stale-candidate recovery boundary using the snapshot read before delegation committed.
    const service = f.root.orchestration;
    const scheduler = createActivationScheduler(
      {
        reconcileChildCompletions: service.reconcileChildCompletions.bind(service),
        listPendingActivations: async () => [
          { workflow: parent, activation: parent.pendingActivation! },
        ],
        listWaiting: service.listWaiting.bind(service),
        listAll: service.listAll.bind(service),
        get: service.get.bind(service),
        markActivationStarted: service.markActivationStarted.bind(service),
        acceptOutcome: service.acceptOutcome.bind(service),
        resolveExecutionFailure: service.resolveExecutionFailure.bind(service),
        retryRunnerQuotaFailure: service.retryRunnerQuotaFailure.bind(service),
        block: service.block.bind(service),
      },
      f.root.execution,
      f.root.resources,
      { now: () => new Date() },
      { ids: new SequentialIds(), maxConcurrentRuns: 2 },
    );
    expect(
      (await scheduler.dispatch!({ workItemId: parent.workItemId, maxProgress: 1 })).kind,
    ).toBe('waiting');
    expect((await service.get(parent.workflowInstanceId))!.status).toBe('waiting');
    expect((await f.root.execution.list()).find((entry) => entry.runId === run.runId)).toEqual(run);
    const child = (await service.get(top!.children[0]!.workflowInstanceId))!;
    await publish(f.root, child, 'dispatch-result');
    await complete(f.root, child);
    expect(
      await service['delegatedWork'].results(parent.workflowInstanceId, 'dispatch'),
    ).toHaveLength(1);
  },
);

it('production Run liveness prevents a continuation and second Run while the delegating runner is still active', async () => {
  const runner = new ScriptedDelegationRunner();
  const f = await fixture(false, runner);
  const parent = await complete(f.root, await start(f.root, 'live-parent'));
  const probe = await start(f.root, 'probe', 'child');
  const entered = deferred<void>();
  const release = deferred<void>();
  runner.scripts.push(async (request) => {
    const top = await f.root.orchestration['delegatedWork'].reserve(
      {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.pendingActivation!.activationId,
        runId: request.runId,
      },
      'live',
      [assignment(probe.workflowDefinitionFingerprint!, [])],
      context('reserve-live'),
    );
    const child = (await f.root.orchestration.get(top.children[0]!.workflowInstanceId))!;
    await publish(f.root, child, 'live-result');
    await complete(f.root, child);
    entered.resolve();
    await release.promise;
    return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
  });
  const attempt = await f.root.execution.attempt(parent.pendingActivation!, {
    workflowInstanceId: parent.workflowInstanceId,
    workItemId: parent.workItemId,
    orchestrationGroupId: parent.orchestrationGroupId,
    resources: [],
    awaitImmediateCompletion: true,
  });
  try {
    await vi.waitFor(() => expect(runner.requests).toHaveLength(1));
    await entered.promise;
    await f.root.orchestration.reconcileChildCompletions(context('still-active'));
    expect(
      await f.root.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'live'),
    ).toHaveLength(0);
    expect(await f.root.orchestration.listPendingActivations(parent.workItemId)).toHaveLength(0);
    await f.root.advanceOnce({ workItemId: parent.workItemId, maxProgress: 1 });
    expect(runner.requests).toHaveLength(1);
  } finally {
    release.resolve();
    await terminalRun(f.root, attempt.runId);
  }
  const restarted = await f.restart();
  await restarted.orchestration.reconcileChildCompletions(context('run-ended'));
  expect(
    await restarted.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'live'),
  ).toHaveLength(1);
  expect(await restarted.orchestration.listPendingActivations(parent.workItemId)).toHaveLength(1);
});

async function setWait(
  root: CompositionRoot,
  parent: WorkflowInstanceView,
  signalKind: ReturnType<typeof signalName>,
  fromWatch?: string,
  revision?: string,
) {
  const stream = workflowInstanceStream(parent.workflowInstanceId);
  const events = await root.journal.readStream(stream);
  const wait = {
    signalKind,
    ...(revision === undefined ? {} : { revision }),
    resume: { kind: TransitionTargetKind.Complete },
    ...(fromWatch === undefined
      ? {}
      : { from: [{ kind: 'watch' as const, watch: watchId(fromWatch) }] }),
  };
  await root.journal.appendToStream(stream, events.length, [
    createOrchestrationEventData({
      ...context('initial-wait'),
      eventId: 'initial-wait-' + parent.workflowInstanceId,
      causationId: 'test',
      source: { kind: 'internal', id: 'test' },
      eventType: OrchestrationEventType.SignalWaitStarted,
      payload: wait,
    }),
  ]);
  return wait;
}

async function comment(root: CompositionRoot, body: string) {
  const stream = integrationStream(GitHubAdapter);
  const prior = await root.journal.readStream(stream);
  await root.journal.appendToStream(stream, prior.length, [
    createGitHubEventData({
      ...context('comment'),
      eventId: 'github-comment-' + prior.length,
      causationId: 'test',
      source: { kind: 'adapter', id: 'github' },
      eventType: GitHubEventType.CommentObserved,
      payload: {
        reviewKind: 'issue',
        externalKey: 'org/repo#1',
        body,
        revision: '2026-10-18T12:00:00.000Z',
        actor: { id: 'reviewer', kind: 'human' },
        raw: {},
      },
    }),
  ]);
  const event = selectGitHubAdapterEvent((await root.journal.readStream(stream)).at(-1)!);
  if (event?.event.eventType !== GitHubEventType.CommentObserved)
    throw new Error('Expected comment');
  return { ...event, event: event.event };
}

it.each(['review', 'watch'])(
  'real GitHub %s signal caller durably defers fenced input and replays it once after join and restart',
  async (source) => {
    const f = await fixture();
    const parent = await complete(f.root, await start(f.root, 'signal-parent'));
    const probe = await start(f.root, 'probe', 'child');
    const top = await f.root.orchestration['delegatedWork'].reserve(
      {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.pendingActivation!.activationId,
        runId: 'signal-parent-run',
      },
      'signals',
      [assignment(probe.workflowDefinitionFingerprint!, [])],
      context('reserve-signals'),
    );
    let event;
    const wait = await setWait(
      f.root,
      parent,
      source === 'review' ? signalName('approved') : WatchGateVerdictSignal,
      source === 'watch' ? 'review' : undefined,
    );
    if (source === 'review') {
      const resource = await f.root.resources.discover(
        {
          resourceId: resId('signal-issue'),
          kind: BuiltInResourceKind.Issue,
          externalKey: { adapter: GitHubAdapter, key: 'org/repo#1' },
          capabilities: [],
        },
        context('resource'),
      );
      await f.root.resources.correlate(
        resource.resourceId,
        parent.workItemId,
        'primary',
        context('correlate'),
      );
      event = await comment(f.root, '/approved');
      const input = {
        event,
        journal: f.journal,
        resources: f.root.resources,
        work: f.root.work,
        lookup: f.root.lookup,
        pullRequests: f.root.pullRequests,
        ids: new SequentialIds(),
        adapter: GitHubAdapter,
        orchestration: f.root.orchestration,
      };
      await applyReviewSignal(input);
      await applyReviewSignal(input);
    } else {
      const watch = await f.root.orchestration.requestChild(
        {
          parentWorkflowInstanceId: parent.workflowInstanceId,
          watchId: 'review',
          triggerId: 'trigger',
          workflowName: workflowName('child'),
          causalCycleId: 'cycle',
          requestId: workflowInstanceId(
            parent.workflowInstanceId + ':watch:review:trigger:trigger',
          ),
          maxPerGroup: 1,
        },
        context('watch'),
      );
      if (!('workflowInstanceId' in watch)) throw new Error('Unexpected exhausted budget');
      const run = await f.root.execution.attempt(watch.pendingActivation!, {
        workflowInstanceId: watch.workflowInstanceId,
        workItemId: watch.workItemId,
        orchestrationGroupId: watch.orchestrationGroupId,
        resources: [],
        awaitImmediateCompletion: true,
      });
      await terminalRun(f.root, run.runId);
      event = await comment(
        f.root,
        '```json\n' +
          JSON.stringify({ wake: { watchGateVerdict: { runId: run.runId, outcome: 'DONE' } } }) +
          '\n```',
      );
      const input = {
        event,
        runs: new RunRepository(f.journal),
        orchestration: f.root.orchestration,
      };
      await applyWatchGateVerdictSignal(input);
      await applyWatchGateVerdictSignal(input);
    }
    expect(
      (await f.journal.readAll(0)).filter(
        (entry) => entry.event.eventType === OrchestrationEventType.SignalDeferred,
      ),
    ).toHaveLength(1);
    const root = await f.restart();
    const child = (await root.orchestration.get(top.children[0]!.workflowInstanceId))!;
    await publish(root, child, 'signal-child-result');
    await complete(root, child);
    await root.orchestration.block(
      parent.workflowInstanceId,
      'Re-establish original wait',
      context('prepare-wait'),
    );
    await root.orchestration.waitForSignal(parent.workflowInstanceId, wait, context('await-input'));
    await root.orchestration.reconcileChildCompletions(context('replay-duplicate'));
    const resumed = (await root.orchestration.get(parent.workflowInstanceId))!;
    expect(resumed.status).toBe('completed');
    expect(resumed.acceptedSignalIds.filter((id) => id === event.event.eventId)).toHaveLength(1);
  },
);

async function terminalRun(root: CompositionRoot, runId: string) {
  await vi.waitFor(
    async () => {
      const run = (await root.execution.list()).find((entry) => entry.runId === runId);
      expect(run).toBeDefined();
      expect(isActiveRunStatus(run!.status)).toBe(false);
    },
    { timeout: 5000 },
  );
  return (await root.execution.list()).find((entry) => entry.runId === runId)!;
}

it('retains a fenced resource transition and applies it only to the original revision wait', async () => {
  const f = await fixture();
  const parent = await complete(f.root, await start(f.root, 'resource-parent'));
  const probe = await start(f.root, 'probe', 'child');
  const top = await f.root.orchestration['delegatedWork'].reserve(
    {
      workflowInstanceId: parent.workflowInstanceId,
      activationId: parent.pendingActivation!.activationId,
      runId: 'resource-parent-run',
    },
    'resource',
    [assignment(probe.workflowDefinitionFingerprint!, [])],
    context('reserve-resource'),
  );
  const wait = await setWait(f.root, parent, signalName('pr-merged'), undefined, 'revision-1');
  await f.root.orchestration.applyResourceTransition(
    parent.workflowInstanceId,
    { kind: TransitionTargetKind.Complete },
    'merged-revision-1',
    context('merged'),
  );
  const root = await f.restart();
  const child = (await root.orchestration.get(top.children[0]!.workflowInstanceId))!;
  await publish(root, child, 'resource-child-result');
  await complete(root, child);
  await root.orchestration.block(
    parent.workflowInstanceId,
    'Re-establish wait',
    context('prepare-wait'),
  );
  await root.orchestration.waitForSignal(
    parent.workflowInstanceId,
    { ...wait, revision: 'revision-2' },
    context('new-revision'),
  );
  expect(
    (await root.orchestration.get(parent.workflowInstanceId))!.acceptedSignalIds,
  ).not.toContain('merged-revision-1');
  await root.orchestration.waitForSignal(
    parent.workflowInstanceId,
    wait,
    context('original-revision'),
  );
  const completed = (await root.orchestration.get(parent.workflowInstanceId))!;
  expect(completed.status).toBe('completed');
  expect(completed.acceptedSignalIds.filter((id) => id === 'merged-revision-1')).toHaveLength(1);
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

import type {
  DelegatedAssignment,
  DelegationReservation,
} from '../../../src/orchestration/contracts/delegation.js';
