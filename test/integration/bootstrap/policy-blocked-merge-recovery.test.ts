import { EventActorKind, correlationId } from '@atolis-hq/eventing';
import { InMemoryCheckpointStore, InMemoryProjectionStore } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ActivityEventType,
  ActivityOutcomeKind,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
} from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import { createOneShotRunnerAdvance } from '../../../src/bootstrap/runner-tick-adapter.js';
import { createWorkCancellationPolicy } from '../../../src/control-plane/index.js';
import {
  DurableFakeDeliveryProvider,
  ExternalWorkOutcome,
  concludeObservedWork,
} from '../../../src/integrations/index.js';
import {
  OrchestrationEventType,
  WorkflowStatus,
  orchestrationGroupId,
  selectWorkflowOrchestrationEvent,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import {
  BuiltInResourceCapability,
  ResourceCorrelationRole,
  resourceKind,
} from '../../../src/resources/index.js';
import { toWorkItemKey } from '../../../src/surfaces/index.js';
import { WorkStatus } from '../../../src/work/index.js';
import { resId, workId } from '../../support/identities.js';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});
let commandOrdinal = 0;

function command() {
  return {
    commandId: `test-${++commandOrdinal}`,
    correlationId: correlationId('test'),
    occurredAt: '2026-10-11T12:22:14.000Z',
    actor: { kind: EventActorKind.Operator, id: 'reviewer' },
  };
}

const workflow = {
  stages: {
    implement: {
      activity: 'agent',
      requiresApproval: false,
      with: { prompt: 'Implement' },
      on: { done: { then: 'review' } },
    },
    review: {
      requiresApproval: false,
      activity: 'agent',
      with: { prompt: 'Review' },
      on: { done: { then: 'merge' } },
    },
    merge: {
      activity: 'pr.merge',
      with: {
        target: 'primary',
        method: 'squash',
        requireChecks: true,
        requireApproval: false,
        autoMerge: true,
        blockedPaths: ['src/kernel/index.ts'],
        maxFilesChanged: 50,
      },
      on: {
        done: {
          then: 'wait',
          resourceTransitions: [
            { events: ['pr.state-changed'], where: { state: 'merged' }, then: 'complete-issue' },
          ],
        },
        blocked: { then: 'await-human' },
      },
    },
    'complete-issue': {
      activity: 'issue.complete',
      requiresApproval: false,
      with: { target: 'primary' },
      on: { done: { then: 'done' } },
    },
  },
};
const config = (definition: unknown = workflow) =>
  parseRootConfig({
    schemaVersion: 1,
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: { default: 'main', workflows: { main: definition } },
    integrations: { fake: { enabled: true } },
  });
const wid = workId('merge-recovery');
const pr = resId('merge-recovery');
const iid = workflowInstanceId('merge-recovery');
const group = orchestrationGroupId('merge-recovery');

async function setup(definition: unknown = workflow) {
  const path = await mkdtemp(join(tmpdir(), 'wake-merge-recovery-'));
  roots.push(path);
  const provider = new DurableFakeDeliveryProvider();
  const root = await createCompositionRoot(path, {
    config: config(definition),
    fakeDeliveryProvider: provider,
  });
  await root.work.create({ workItemId: wid, objective: 'Recover merge' }, command());
  for (const [resourceId, kind, capabilities] of [
    [
      pr,
      'pull-request',
      [
        BuiltInResourceCapability.Mergeable,
        BuiltInResourceCapability.Reviewable,
        BuiltInResourceCapability.Revisioned,
        BuiltInResourceCapability.ChangedFiles,
      ],
    ],
    [resId('issue-recovery'), 'issue', [BuiltInResourceCapability.Completable]],
  ] as const) {
    await root.resources.discover(
      {
        resourceId,
        kind: resourceKind(kind),
        externalKey: { adapter: 'fake', key: kind },
        capabilities,
      },
      command(),
    );
    await root.resources.correlate(resourceId, wid, ResourceCorrelationRole.Primary, command());
  }
  await observe(root, 'open');
  await root.orchestration.start(
    {
      workflowInstanceId: iid,
      workItemId: wid,
      workflowName: workflowName('main'),
      orchestrationGroupId: group,
    },
    command(),
  );
  return { root, path, provider };
}

type Root = Awaited<ReturnType<typeof createCompositionRoot>>;

async function observe(
  root: Root,
  state: 'open' | 'merged' | 'closed',
  mergeability?: 'unknown' | 'clean' | 'conflicting',
) {
  return root.pullRequests.observe(
    {
      resourceId: pr,
      workItemId: wid,
      state,
      ...(mergeability === undefined ? {} : { mergeability }),
      headRevision: 'head',
      baseRevision: 'base',
      checks: 'passing',
      changedFiles: ['src/kernel/index.ts'],
    },
    command(),
  );
}

async function tick(root: Root) {
  await createOneShotRunnerAdvance(root)({ maxProgress: 1 });
}

async function until(root: Root, predicate: () => Promise<boolean>) {
  for (let i = 0; i < 20; i++) {
    if (await predicate()) return;
    await tick(root);
  }
  expect(await predicate(), JSON.stringify(await root.orchestration.get(iid))).toBe(true);
}

async function waiting(root: Root) {
  return (await root.orchestration.get(iid))?.status === WorkflowStatus.Waiting;
}

async function assertCompleted(root: Root, provider: DurableFakeDeliveryProvider) {
  await until(
    root,
    async () => (await root.orchestration.get(iid))?.status === WorkflowStatus.Completed,
  );

  // Final projection catch-up can enqueue publication after completion.
  await tick(root);
  const effectsAtCompletion = provider.effects.size;
  for (let i = 0; i < 3; i++) {
    await observe(root, 'merged');
    await tick(root);
  }
  const facts = await root.journal.readAll(0);
  expect(
    facts.filter((fact) => fact.event.eventType === ActivityEventType.IssueCompleteRequested),
  ).toHaveLength(1);
  expect(
    facts.filter((fact) => fact.event.eventType === ActivityEventType.PrMergeRequested),
  ).toHaveLength(0);
  expect(
    facts.filter((fact) => fact.event.eventType === OrchestrationEventType.InstanceCompleted),
  ).toHaveLength(1);
  expect(provider.effects.size).toBe(effectsAtCompletion);
  // Fake delivery confirms the effect; simulate the next provider close echo through the shared conclusion policy.
  await concludeObservedWork(
    {
      work: root.work,
      conclusion: createWorkCancellationPolicy(
        root.work,
        root.orchestration,
        root.execution,
        { now: () => new Date(command().occurredAt) },
        { next: () => command().commandId },
      ),
    },
    {
      workItemId: wid,
      outcome: ExternalWorkOutcome.Completed,
      reason: 'Provider observed completed issue',
    },
  );
  expect((await root.work.get(wid))?.state).toBe(WorkStatus.Closed);
}

it('reproduces protected-path denial, approval retry, manual merge, and one completion through production composition', async () => {
  const { root, provider } = await setup();
  await until(root, () => waiting(root));
  const denied = await root.orchestration.get(iid);
  expect(denied?.lastOutcome).toMatchObject({
    kind: ActivityOutcomeKind.Blocked,
    data: { reason: 'blocked-path-changed', policy: { matchedPaths: ['src/kernel/index.ts'] } },
  });
  const api = await createSurfaceApplications(root);
  const detail = await api.api.work.detail(toWorkItemKey(wid));
  expect(detail?.data.orchestration.primary?.mergePolicyBlock).toMatchObject({
    status: 'awaiting-human-merge',
    policy: { blockedPaths: ['src/kernel/index.ts'], matchedPaths: ['src/kernel/index.ts'] },
  });
  await root.pullRequests.acceptReviewSignal(
    {
      resourceId: pr,
      revision: 'head',
      actorId: 'reviewer',
      actorKind: 'human',
      acceptedEventId: 'review-accepted',
      resourceAuthorId: 'author',
      authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
    },
    command(),
  );
  await root.orchestration.acceptSignal(
    iid,
    {
      kind: denied!.waitingFor!.signalKind,
      actorId: 'reviewer',
      actorDecision: { authorized: true, evidenceId: 'review-accepted' },
      providerEventId: 'review-accepted',
      authority: { kind: 'human' },
    },
    command(),
  );
  await until(root, () => waiting(root));
  expect(
    (await root.pullRequests.factsFor(pr)).filter(
      (fact) => fact.event.eventType === ActivityEventType.PrMergeDenied,
    ),
  ).toHaveLength(2);
  await observe(root, 'merged');
  await tick(root);
  await assertCompleted(root, provider);
});

it.each(['before-wait', 'legacy-wait', 'restart'] as const)(
  'recovers %s from prior evidence without another operator signal',
  async (timing) => {
    const { path, provider, root: initialRoot } = await setup();
    let root = initialRoot;
    if (timing === 'before-wait') {
      // Run implementation and review normally, then merge before its blocked outcome is accepted.
      await until(root, async () => (await root.orchestration.get(iid))?.currentStage === 'merge');
      const view = (await root.orchestration.get(iid))!;
      const activation = view.pendingActivation!;
      const outcome = await root.activities.execute(
        {
          activationId: activation.activationId,
          activity: activation.activity,
          workItemId: wid,
          workflowInstanceId: activityWorkflowInstanceId(iid),
          orchestrationGroupId: activityOrchestrationGroupId(group),
          causationId: activation.activationId,
          input: activation.input,
          resources: [(await root.resources.get(pr))!],
        },
        {
          occurredAt: command().occurredAt,
          signal: new AbortController().signal,
          async reportExternalExecution() {},
        },
      );
      expect(outcome.kind).toBe(ActivityOutcomeKind.Blocked);
      await observe(root, 'merged');
      await root.orchestration.acceptOutcome(
        {
          workflowInstanceId: iid,
          activationId: activation.activationId,
          outcome: { kind: outcome.kind, data: { reason: 'blocked-path-changed' } },
        },
        command(),
      );
    } else {
      await until(root, () => waiting(root));
      await observe(root, 'merged');
      // Both waits have the legacy declaration: blocked routes never declared resource transitions.
      expect((await root.orchestration.get(iid))?.waitingFor?.resourceTransitions).toBeUndefined();
      await root.processorRuntime.catchUp('consume existing evidence');
      expect(await waiting(root)).toBe(true);
      if (timing === 'restart')
        root = await createCompositionRoot(path, {
          config: config(),
          fakeDeliveryProvider: provider,
          checkpoints: new InMemoryCheckpointStore(),
          projections: new InMemoryProjectionStore(),
        });
    }
    await assertCompleted(root, provider);
  },
);

it.each(['merged', 'closed', 'conflicting'] as const)(
  'does not release for unrelated %s PRs or unrelated human waits',
  async (problem) => {
    const { root } = await setup();
    await until(root, () => waiting(root));
    const otherWork = workId('other-merge');
    const otherPr = resId('other-merge');
    await root.work.create({ workItemId: otherWork, objective: 'Other work' }, command());
    await root.resources.discover(
      {
        resourceId: otherPr,
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'fake', key: 'other' },
        capabilities: [
          BuiltInResourceCapability.Mergeable,
          BuiltInResourceCapability.Reviewable,
          BuiltInResourceCapability.Revisioned,
        ],
      },
      command(),
    );
    await root.resources.correlate(otherPr, otherWork, ResourceCorrelationRole.Primary, command());
    await root.pullRequests.observe(
      {
        resourceId: otherPr,
        workItemId: otherWork,
        state: problem === 'conflicting' ? 'open' : problem,
        mergeability: problem === 'conflicting' ? 'conflicting' : 'unknown',
        headRevision: 'other',
        baseRevision: 'base',
        checks: 'passing',
      },
      command(),
    );
    await tick(root);
    expect(await waiting(root)).toBe(true);
    const view = (await root.orchestration.get(iid))!;
    await root.orchestration.waitForSignal(
      iid,
      { signalKind: 'unrelated-human-wait' as never },
      command(),
    );
    await observe(root, 'merged');
    await tick(root);
    expect((await root.orchestration.get(iid))?.waitingFor?.signalKind).toBe(
      'unrelated-human-wait',
    );
    expect((await root.orchestration.get(iid))?.acceptedOutcomes).toEqual(view.acceptedOutcomes);
  },
);

it('uses the pinned completion route after config changes and prioritizes prior merge evidence over a late approval', async () => {
  const { root: original, path, provider } = await setup();
  await until(original, () => waiting(original));
  const wait = (await original.orchestration.get(iid))!.waitingFor!;
  await observe(original, 'merged');
  const changedConfig = config();
  const changedWorkflow = {
    ...workflow,
    stages: {
      ...workflow.stages,
      'other-completion': workflow.stages['complete-issue'],
      merge: {
        ...workflow.stages.merge,
        on: {
          ...workflow.stages.merge.on,
          done: {
            then: 'complete-issue',
            resourceTransitions: [
              {
                events: ['pr.state-changed'],
                where: { state: 'merged' },
                then: 'other-completion',
              },
            ],
          },
        },
      },
    },
  };
  const root = await createCompositionRoot(path, {
    config: parseRootConfig({
      ...changedConfig,
      orchestration: { ...changedConfig.orchestration, workflows: { main: changedWorkflow } },
    }),
    fakeDeliveryProvider: provider,
  });
  await root.processorRuntime.catchUp('definition and evidence catch-up');
  await root.orchestration.acceptSignal(
    iid,
    {
      kind: wait.signalKind,
      actorId: 'reviewer',
      actorDecision: { authorized: true, evidenceId: 'late-approval' },
      providerEventId: 'late-approval',
      authority: { kind: 'human' },
    },
    command(),
  );
  expect((await root.orchestration.get(iid))?.currentStage).toBe('complete-issue');
  await assertCompleted(root, provider);
});

it.each(['closed', 'conflicting'] as const)(
  'blocks a primary merge wait for %s evidence without a repair route',
  async (problem) => {
    const { root } = await setup();
    await until(root, () => waiting(root));
    await observe(
      root,
      problem === 'closed' ? 'closed' : 'open',
      problem === 'conflicting' ? 'conflicting' : undefined,
    );
    await tick(root);
    const view = await root.orchestration.get(iid);
    expect(view?.status).toBe(WorkflowStatus.Blocked);
    expect(view?.blockReason).toContain(
      problem === 'closed' ? 'pr-closed-unmerged' : 'pr-conflicting',
    );
  },
);

it('keeps unknown mergeability waiting and follows ordinary merged completion', async () => {
  const { root, provider } = await setup();
  await until(root, () => waiting(root));
  await observe(root, 'open', 'unknown');
  await tick(root);
  expect(await waiting(root)).toBe(true);
  await observe(root, 'merged', 'unknown');
  await assertCompleted(root, provider);
});

function repairWorkflow() {
  return {
    ...workflow,
    stages: {
      ...workflow.stages,
      review: { ...workflow.stages.review, on: { done: { then: 'merge', repeat: { max: 3 } } } },
      repair: {
        activity: 'agent',
        requiresApproval: false,
        with: {
          prompt: 'Rebase and revise the existing primary PR, preserving review and merge policy.',
        },
        on: { done: { then: 'review', repeat: { max: 2 } } },
      },
      merge: {
        ...workflow.stages.merge,
        on: {
          ...workflow.stages.merge.on,
          done: {
            then: 'wait',
            resourceTransitions: [
              ...workflow.stages.merge.on.done.resourceTransitions,
              {
                events: ['pr.state-changed'],
                where: { mergeability: 'conflicting' },
                then: 'repair',
                retry: { max: 2 },
              },
            ],
          },
        },
      },
    },
  };
}

it('routes conflicts through pinned repair and durably bounds attempts across restart', async () => {
  const definition = repairWorkflow();
  const { root: initial, path, provider } = await setup(definition);
  await until(initial, () => waiting(initial));
  await observe(initial, 'open', 'conflicting');
  await tick(initial);
  expect((await initial.orchestration.get(iid))?.retryCounts['pr.merge:conflicting']).toBe(1);
  // A changed current definition must not replace the pinned repair policy.
  const root = await createCompositionRoot(path, {
    config: config(),
    fakeDeliveryProvider: provider,
  });
  await until(
    root,
    async () => (await root.orchestration.get(iid))?.status === WorkflowStatus.Blocked,
  );
  const view = await root.orchestration.get(iid);
  expect(view?.retryCounts['pr.merge:conflicting']).toBe(2);
  expect(view?.blockReason).toContain('conflict-retry-exhausted');
  const facts = await root.journal.readAll(0);
  expect(
    facts
      .map(selectWorkflowOrchestrationEvent)
      .filter(
        (fact) =>
          fact?.event.eventType === OrchestrationEventType.StageEntered &&
          fact.event.payload.stage === 'repair',
      ),
  ).toHaveLength(2);
}, 60_000);

it.each(['ambiguous', 'unsafe'] as const)(
  'blocks %s configured conflict repair',
  async (problem) => {
    const definition = repairWorkflow();
    const routes = definition.stages.merge.on.done.resourceTransitions;
    const repair = routes.at(-1)!;
    if (problem === 'ambiguous') routes.push(repair);
    else
      Object.assign(definition.stages.repair, {
        activity: 'issue.complete',
        with: { target: 'primary' },
      });
    const { root } = await setup(definition);
    await until(root, () => waiting(root));
    await observe(root, 'open', 'conflicting');
    await tick(root);
    expect((await root.orchestration.get(iid))?.blockReason).toContain('pr-conflicting');
  },
);

it('reconciles a merge wait using its pinned explicit await signal', async () => {
  const definition = {
    ...workflow,
    stages: {
      ...workflow.stages,
      merge: {
        ...workflow.stages.merge,
        with: { ...workflow.stages.merge.with, blockedPaths: [] },
        on: {
          ...workflow.stages.merge.on,
          done: { then: 'complete-issue', await: { signal: 'merge-confirmed', from: ['human'] } },
        },
      },
    },
  };
  const { root } = await setup(definition);
  await until(
    root,
    async () => (await root.orchestration.get(iid))?.waitingFor?.signalKind === 'merge-confirmed',
  );
  await observe(root, 'closed');
  await tick(root);
  expect((await root.orchestration.get(iid))?.blockReason).toContain('pr-closed-unmerged');
});
