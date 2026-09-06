import {
  EventActorKind,
  EventSourceKind,
  correlationId,
  createEventData,
} from '@atolis-hq/eventing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import { z } from 'zod';
import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityRegistry,
  activationId,
  activityName,
} from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  createSelfUpdateApplication,
  createUpdateLedger,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import { createSelfUpdateQuiescePort } from '../../../src/bootstrap/surface-cli-applications.js';
import { ExecutionEventType, runId, runStream } from '../../../src/execution/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';
import { defineScenario } from '../support/scenario.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })),
  );
});

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-004',
    title: 'a retained failed maintenance lease blocks new activation dispatch',
    given: ['a composed source-mode root with a pending activation and a failed maintenance lease'],
    when: ['advance-once is invoked while the control plane is in maintenance'],
    then: ['the entire tick remains paused and the pending activation stays undispatched'],
  },
  async () => {
    const root = await createRoot(1);
    await start(root, 'pending');
    await root.maintenance.acquire('v2');
    await root.maintenance.fail(new Error('update failed'));

    expect(await root.advanceOnce({ maxProgress: 1 })).toEqual({ kind: 'paused' });
    expect(await root.execution.list()).toEqual([]);
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-005',
    title: 'a persisted updating lease recovers once and a newer tag proceeds without repeating it',
    given: [
      'a composed root whose durable ledger has healthy v1 and pending v2',
      'a persisted maintenance lease in updating for v2 and a pending Run',
    ],
    when: ['self-update resumes v2, then discovers candidates v2 and v3'],
    then: [
      'recovery restores v1 while the complete runtime remains paused',
      'v2 is durable-bad and has no second forward checkout',
      'v3 is checked out once, clears maintenance when healthy, and only then permits one runner effect',
    ],
  },
  async () => {
    const runnerCalls = { count: 0 };
    const root = await createRoot(1, runnerCalls);
    const ledger = createUpdateLedger(root.paths.wakeRoot);
    await ledger.write('v1');
    await ledger.begin('v2');
    await root.maintenance.acquire('v2');
    await root.maintenance.transition('updating');
    await start(root, 'pending');
    const checkouts: string[] = [];
    const application = createSelfUpdateApplication({
      ledger,
      source: {
        isClean: async () => true,
        latestTag: async () => 'v3',
        candidateTags: async () => ['v2', 'v3'],
        checkout: async (tag) => {
          checkouts.push(tag);
        },
        healthy: async () => true,
      },
      quiesce: createSelfUpdateQuiescePort(root),
      drainTimeoutMs: 0,
      cancellationTimeoutMs: 0,
    });

    expect(await root.advanceOnce({ maxProgress: 1 })).toEqual({ kind: 'paused' });
    await expect(application.update('v2')).resolves.toBe(false);
    expect(checkouts).toEqual(['v1']);
    expect(await ledger.isBad('v2')).toBe(true);
    expect(await root.maintenance.read()).toBeNull();
    expect(runnerCalls.count).toBe(0);

    await expect(application.updateLatest()).resolves.toEqual({ tag: 'v3', updated: true });
    expect(checkouts).toEqual(['v1', 'v3']);
    expect(await root.maintenance.read()).toBeNull();
    expect(runnerCalls.count).toBe(0);

    await root.advanceOnce({ maxProgress: 1 });
    expect(runnerCalls.count).toBe(1);
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-006',
    title: 'a persisted rolling-back lease verifies the prior source before it resumes the runtime',
    given: ['a composed root with healthy v1, pending v2, and a persisted rolling-back v2 lease'],
    when: ['self-update restarts'],
    then: [
      'the paused runtime prevents its pending Run from starting',
      'the prior v1 source is checked out and v2 is recorded bad',
      'only a healthy rollback recovery clears maintenance',
    ],
  },
  async () => {
    const runnerCalls = { count: 0 };
    const root = await createRoot(1, runnerCalls);
    const ledger = createUpdateLedger(root.paths.wakeRoot);
    await ledger.write('v1');
    await ledger.begin('v2');
    await root.maintenance.acquire('v2');
    await root.maintenance.transition('updating');
    await root.maintenance.transition('rolling-back');
    await start(root, 'pending');
    const checkouts: string[] = [];
    const application = createSelfUpdateApplication({
      ledger,
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          checkouts.push(tag);
        },
        healthy: async () => true,
      },
      quiesce: createSelfUpdateQuiescePort(root),
      drainTimeoutMs: 0,
      cancellationTimeoutMs: 0,
    });

    expect(await root.advanceOnce({ maxProgress: 1 })).toEqual({ kind: 'paused' });
    await expect(application.update('v2')).resolves.toBe(false);
    expect(checkouts).toEqual(['v1']);
    expect(await ledger.isBad('v2')).toBe(true);
    expect(await root.maintenance.read()).toBeNull();
    expect(runnerCalls.count).toBe(0);
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-007',
    title: 'concurrent composed self-updates have one owner and no duplicated runner effect',
    given: ['a composed root with a pending Run and two concurrent self-update callers'],
    when: ['the first caller is paused during its forward checkout'],
    then: [
      'the whole runtime remains paused and no runner effect starts',
      'only the owner performs the forward checkout',
      'the waiting caller cannot fail or clear the owner lease and becomes a healthy no-op',
    ],
  },
  async () => {
    const runnerCalls = { count: 0 };
    const root = await createRoot(1, runnerCalls);
    await start(root, 'pending');
    const ledger = createUpdateLedger(root.paths.wakeRoot);
    const checkouts: string[] = [];
    let releaseFirstCheckout: (() => void) | undefined;
    let signalFirstCheckout: (() => void) | undefined;
    const firstCheckout = new Promise<void>((resolve) => {
      signalFirstCheckout = resolve;
    });
    const source = {
      isClean: async () => true,
      latestTag: async () => 'v2',
      candidateTags: async () => ['v2'],
      checkout: async (tag: string) => {
        checkouts.push(tag);
        if (tag !== 'v2' || checkouts.filter((value) => value === 'v2').length !== 1) return;
        signalFirstCheckout?.();
        await new Promise<void>((resolve) => {
          releaseFirstCheckout = resolve;
        });
      },
      healthy: async () => true,
    };
    const createCaller = () =>
      createSelfUpdateApplication({
        ledger,
        source,
        quiesce: createSelfUpdateQuiescePort(root),
        drainTimeoutMs: 0,
        cancellationTimeoutMs: 0,
      });

    const first = createCaller().update('v2');
    await firstCheckout;
    const second = createCaller().update('v2');
    expect(await root.advanceOnce({ maxProgress: 1 })).toEqual({ kind: 'paused' });
    expect(runnerCalls.count).toBe(0);
    releaseFirstCheckout?.();

    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(checkouts).toEqual(['v2']);
    expect(await root.maintenance.read()).toBeNull();
    expect(runnerCalls.count).toBe(0);
    await root.advanceOnce({ maxProgress: 1 });
    expect(runnerCalls.count).toBe(1);
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-008',
    title: 'a completing Run drains without a maintenance cancellation request',
    given: ['a composed root with an active Run about to complete'],
    when: ['maintenance waits for the Run to complete'],
    then: ['Wake safely updates once the public Run view is empty'],
  },
  async () => {
    const root = await createRoot(5);
    await start(root, 'completing-during-cancel');
    const { active, advancing } = await waitForActiveRun(root);
    const calls: string[] = [];
    const realQuiesce = createSelfUpdateQuiescePort(root);
    const application = createSelfUpdateApplication({
      ledger: ledger(calls),
      source: source(calls, root),
      quiesce: realQuiesce,
      drainTimeoutMs: 0,
      cancellationTimeoutMs: 50,
    });

    await expect(application.update('v2')).resolves.toBe(true);
    await advancing;
    expect((await root.execution.list()).find((run) => run.runId === active.runId)).toMatchObject({
      status: 'succeeded',
    });
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'ledger:v2']);
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-002',
    title: 'maintenance blocks dispatch and waits for a real active Run to finish',
    given: ['a composed source-mode root with one pending and one completing active Run'],
    when: ['self-update enters its maintenance lease'],
    then: [
      'advance-once dispatches no new Run while quiescing',
      'the active Run completes without a maintenance cancellation request',
      'checkout does not occur until the active execution view is empty',
    ],
  },
  async () => {
    const root = await createRoot(5);
    await start(root, 'completing');
    await start(root, 'pending');
    const { active, advancing } = await waitForActiveRun(root);

    await root.maintenance.acquire('v2');
    expect(await root.advanceOnce({ maxProgress: 1 })).toEqual({ kind: 'paused' });
    expect(await root.execution.list()).toHaveLength(1);

    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger(calls),
      source: source(calls, root),
      quiesce: createSelfUpdateQuiescePort(root),
      drainTimeoutMs: 1,
      cancellationTimeoutMs: 50,
    });

    await expect(application.update('v2')).resolves.toBe(true);
    await advancing;
    expect((await root.execution.list()).find((run) => run.runId === active.runId)).toMatchObject({
      status: 'succeeded',
    });
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'ledger:v2']);
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-003',
    title: 'a completing Run drains during maintenance grace without cancellation',
    given: ['a composed source-mode root with a completing active Run'],
    when: ['self-update waits through its drain grace'],
    then: ['checkout follows an empty active execution view and no cancellation is recorded'],
  },
  async () => {
    // Keep the Run active long enough for this scenario to acquire its
    // maintenance lease under loaded CI scheduling.
    const root = await createRoot(100);
    await start(root, 'completing');
    const { active, advancing } = await waitForActiveRun(root);
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger(calls),
      source: source(calls, root),
      quiesce: createSelfUpdateQuiescePort(root),
      drainTimeoutMs: 250,
      cancellationTimeoutMs: 50,
    });

    await expect(application.update('v2')).resolves.toBe(true);
    await advancing;
    const completed = (await root.execution.list()).find((run) => run.runId === active.runId);
    expect(completed).toMatchObject({ status: 'succeeded' });
    expect(completed?.cancellation).toBeUndefined();
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'ledger:v2']);
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-009',
    title: 'an escalated ambiguous Run does not block self-update forever',
    given: ['a composed root with a Run that recovery already escalated to ambiguous'],
    when: ['self-update quiesces active Runs before checkout'],
    then: [
      'the ambiguous Run is excluded from the active-Run view',
      'checkout proceeds without waiting for an operator to resolve the Run',
    ],
  },
  async () => {
    const root = await createRoot();
    await appendAmbiguousRun(root, 'stuck');

    expect(await createSelfUpdateQuiescePort(root).activeRuns()).toEqual([]);

    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger(calls),
      source: source(calls, root),
      quiesce: createSelfUpdateQuiescePort(root),
      drainTimeoutMs: 0,
      cancellationTimeoutMs: 0,
    });

    await expect(application.update('v2')).resolves.toBe(true);
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'ledger:v2']);
    expect((await root.execution.list()).find((run) => run.runId === 'run-stuck')).toMatchObject({
      status: 'ambiguous',
      escalated: true,
    });
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-010',
    title: 'a Run with a long-expired, unrenewed lease is recovered during a maintenance quiesce',
    given: [
      'a composed root with a started Run whose lease expired and whose owner never renewed it',
    ],
    when: ['self-update quiesces active Runs before checkout'],
    then: [
      'recovery runs despite dispatch already being paused for maintenance',
      'the stale Run reaches a terminal status and checkout proceeds without an operator',
    ],
  },
  async () => {
    const root = await createRoot();
    await appendStaleStartedRun(root, 'stale');
    expect((await root.execution.list()).find((run) => run.runId === 'run-stale')).toMatchObject({
      status: 'started',
    });

    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger(calls),
      source: source(calls, root),
      quiesce: createSelfUpdateQuiescePort(root),
      drainTimeoutMs: 500,
      cancellationTimeoutMs: 50,
    });

    await expect(application.update('v2')).resolves.toBe(true);
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'ledger:v2']);
    expect((await root.execution.list()).find((run) => run.runId === 'run-stale')).toMatchObject({
      status: 'ambiguous',
      escalated: true,
    });
  },
  10_000,
);

async function appendStaleStartedRun(
  root: Awaited<ReturnType<typeof createCompositionRoot>>,
  id: string,
): Promise<void> {
  const currentRunId = runId(`run-${id}`);
  const startedAt = '2020-01-01T00:00:00.000Z';
  const metadata = {
    correlationId: `group-${id}`,
    causationId: `activation-${id}`,
    actor: { kind: EventActorKind.System, id: 'test' } as const,
    source: { kind: EventSourceKind.Internal, id: 'test' } as const,
    stream: runStream(currentRunId),
  };
  await root.journal.appendToStream(runStream(currentRunId), 0, [
    createEventData({
      eventId: `${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: startedAt,
      ...metadata,
      payload: {
        activationId: activationId(`activation-${id}`),
        activity: activityName('slow'),
        workflowInstanceId: workflowInstanceId(`workflow-${id}`),
        orchestrationGroupId: orchestrationGroupId(`group-${id}`),
        attempt: 1,
        startedAt,
      },
    }),
  ]);
  await root.journal.appendToStream(runStream(currentRunId), 1, [
    createEventData({
      eventId: `${id}:lease-claimed`,
      eventType: ExecutionEventType.RunLeaseClaimed,
      occurredAt: startedAt,
      ...metadata,
      payload: { owner: 'gone', acquiredAt: startedAt, expiresAt: startedAt },
    }),
  ]);
  await root.journal.appendToStream(runStream(currentRunId), 2, [
    createEventData({
      eventId: `${id}:external`,
      eventType: ExecutionEventType.RunExternalExecutionReported,
      occurredAt: startedAt,
      ...metadata,
      payload: { kind: 'process', id: `process-${id}`, startedAt },
    }),
  ]);
}

async function appendAmbiguousRun(
  root: Awaited<ReturnType<typeof createCompositionRoot>>,
  id: string,
): Promise<void> {
  const currentRunId = runId(`run-${id}`);
  const startedAt = '2026-08-16T08:49:21.344Z';
  const metadata = {
    correlationId: `group-${id}`,
    causationId: `activation-${id}`,
    actor: { kind: EventActorKind.System, id: 'test' } as const,
    source: { kind: EventSourceKind.Internal, id: 'test' } as const,
    stream: runStream(currentRunId),
  };
  await root.journal.appendToStream(runStream(currentRunId), 0, [
    createEventData({
      eventId: `${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: startedAt,
      ...metadata,
      payload: {
        activationId: activationId(`activation-${id}`),
        activity: activityName('slow'),
        workflowInstanceId: workflowInstanceId(`workflow-${id}`),
        orchestrationGroupId: orchestrationGroupId(`group-${id}`),
        attempt: 1,
        startedAt,
      },
    }),
  ]);
  const finishedAt = '2026-08-16T08:52:20.525Z';
  await root.journal.appendToStream(runStream(currentRunId), 1, [
    createEventData({
      eventId: `${id}:ambiguous`,
      eventType: ExecutionEventType.RunAmbiguous,
      occurredAt: finishedAt,
      ...metadata,
      payload: {
        reason: 'External execution inspection is not configured for this runtime',
        finishedAt,
      },
    }),
  ]);
}

async function createRoot(completionDelayMs?: number, runnerCalls?: { count: number }) {
  const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-self-update-e2e-'));
  roots.push(wakeRoot);
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('slow'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      execute: (_, { signal }) => {
        if (runnerCalls !== undefined) runnerCalls.count += 1;
        return new Promise((resolve, reject) => {
          if (completionDelayMs !== undefined)
            setTimeout(() => resolve({ kind: 'done' }), completionDelayMs);
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    },
  });
  return createCompositionRoot(wakeRoot, {
    activities,
    config: parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      activities: {},
      integrations: {},
      surfaces: {},
      controlPlane: {},
      execution: { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      orchestration: {
        workflows: {
          default: {
            stages: {
              slow: {
                activity: 'slow',
                with: {},
                on: { done: { then: 'done' } },
                requiresApproval: false,
              },
            },
          },
        },
      },
      host: {
        development: { mode: 'source', repoRoot: wakeRoot },
        selfUpdate: { drainTimeoutMs: 1, cancellationTimeoutMs: 50 },
      },
    }),
  });
}

async function start(root: Awaited<ReturnType<typeof createRoot>>, id: string) {
  const context = {
    commandId: id,
    correlationId: correlationId(id),
    occurredAt: new Date().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
  const work = await root.work.create({ workItemId: workId(id), objective: id }, context);
  await root.orchestration.start(
    {
      workflowInstanceId: workflowInstanceId(id),
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId(id),
    },
    context,
  );
}

async function waitForActiveRun(root: Awaited<ReturnType<typeof createRoot>>) {
  const advancing = root.advanceOnce({ maxProgress: 1 });
  for (let index = 0; index < 1_000; index += 1) {
    const active = (await root.execution.list()).find((run) => run.status === 'started');
    if (active !== undefined) return { active, advancing };
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await advancing;
  throw new Error('Expected a slow active Run');
}

async function waitForRunStatus(
  root: Awaited<ReturnType<typeof createRoot>>,
  expectedRunId: string,
  expectedStatus: string,
) {
  for (let index = 0; index < 1_000; index += 1) {
    const run = (await root.execution.list()).find(
      (candidate) => candidate.runId === expectedRunId,
    );
    if (run?.status === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Expected Run ${expectedRunId} to reach ${expectedStatus}`);
}

function ledger(calls: string[]) {
  return {
    read: async () => 'v1',
    begin: async (tag: string) => {
      calls.push(`begin:${tag}`);
    },
    write: async (tag: string) => {
      calls.push(`ledger:${tag}`);
    },
    recover: async () => null,
    isBad: async () => false,
    recordBad: async () => {},
  };
}

function source(calls: string[], root: Awaited<ReturnType<typeof createRoot>>) {
  return {
    isClean: async () => true,
    latestTag: async () => 'v2',
    candidateTags: async () => ['v2'],
    checkout: async (tag: string) => {
      expect((await root.execution.list()).filter((run) => run.status === 'started')).toEqual([]);
      calls.push(`checkout:${tag}`);
    },
    healthy: async () => true,
  };
}
